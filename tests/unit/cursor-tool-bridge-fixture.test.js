import fs from "fs";
import path from "path";
import { describe, expect, it, beforeEach } from "vitest";

import {
  CursorExecutor,
  buildAgentRunFrame,
  normalizeAgentServiceRequest,
  prepareCursorGatewayRequest,
} from "../../open-sse/executors/cursor.js";
import {
  encodeField,
  decodeMessage,
  parseConnectRPCFrame,
  wrapConnectRPCFrame,
} from "../../open-sse/utils/cursorProtobuf.js";
import {
  getPendingAgentSessionRegistry,
  resetPendingAgentSessionRegistryForTests,
} from "../../open-sse/utils/cursorPendingAgentSessions.js";
import {
  DEFAULT_CAPTURE_PATH,
  DEFAULT_FIXTURE_PATH,
  claudeToolsToCursorToolMetadata,
  flattenHistoryIntoCurrentUserText,
  loadCapturedToolFixture,
  maybeCaptureToolRequest,
  openAIToolCallToClaudeToolUse,
  originalTaskRemainsInAgentPayload,
  translateAgentExecRequestToClaudeToolUse,
} from "../../open-sse/utils/cursorToolBridge.js";

const LEN = 2;

function requireFixture() {
  const loaded = loadCapturedToolFixture();
  if (!loaded) {
    throw new Error(
      `Missing real Claude Code tool fixture. Capture one live 169-tool request to ${DEFAULT_CAPTURE_PATH} (or copy it to ${DEFAULT_FIXTURE_PATH}).`,
    );
  }
  return loaded;
}

function mcpToolRequestFrame(name, toolCallId, args = {}) {
  const argEntries = Object.entries(args).map(([key, value]) => {
    const encodedValue = encodeField(1, LEN, JSON.stringify(value));
    return Buffer.from(encodeField(2, LEN, Buffer.concat([
      Buffer.from(encodeField(1, LEN, key)),
      Buffer.from(encodeField(2, LEN, encodedValue)),
    ])));
  });
  const mcpArgs = Buffer.concat([
    Buffer.from(encodeField(1, LEN, name)),
    ...argEntries,
    Buffer.from(encodeField(3, LEN, toolCallId)),
    Buffer.from(encodeField(5, LEN, name)),
  ]);
  const execServerMessage = Buffer.from(encodeField(11, LEN, mcpArgs));
  return Buffer.from(wrapConnectRPCFrame(encodeField(2, LEN, execServerMessage)));
}

function readFileRequestFrame(filePath, toolCallId = "call_read") {
  const readArgs = Buffer.concat([
    Buffer.from(encodeField(1, LEN, filePath)),
    Buffer.from(encodeField(2, LEN, toolCallId)),
  ]);
  const execServerMessage = Buffer.from(encodeField(7, LEN, readArgs));
  return Buffer.from(wrapConnectRPCFrame(encodeField(2, LEN, execServerMessage)));
}

function textFrame(text) {
  const textPart = Buffer.from(encodeField(1, LEN, text));
  const update = Buffer.from(encodeField(1, LEN, textPart));
  return Buffer.from(wrapConnectRPCFrame(encodeField(1, LEN, update)));
}

function decodeAgentUserText(frame) {
  const parsed = parseConnectRPCFrame(frame);
  const clientMessage = decodeMessage(parsed.payload);
  const runRequest = decodeMessage(clientMessage.get(1)[0].value);
  const conversationAction = decodeMessage(runRequest.get(2)[0].value);
  const userAction = decodeMessage(conversationAction.get(1)[0].value);
  const userMessage = decodeMessage(userAction.get(1)[0].value);
  const textBytes = userMessage.get(1)?.[0]?.value;
  return textBytes ? Buffer.from(textBytes).toString("utf8") : "";
}

function turnEndedFrame() {
  const update = Buffer.from(encodeField(14, LEN, new Uint8Array()));
  return Buffer.from(wrapConnectRPCFrame(encodeField(1, LEN, update)));
}

function createResumableStub(executor) {
  const written = [];
  const queue = [];
  const waiters = [];
  const sessionState = { ended: false, closed: false };
  let openCount = 0;

  const session = {
    responseHeaders: Promise.resolve({ ":status": 200 }),
    write: (frame) => written.push(Buffer.from(frame)),
    end() { sessionState.ended = true; },
    close() { sessionState.closed = true; },
    async read() {
      if (queue.length) return { value: queue.shift(), done: false };
      return new Promise((resolve) => {
        const timer = setTimeout(() => resolve({ value: undefined, done: true }), 5000);
        waiters.push((result) => {
          clearTimeout(timer);
          resolve(result);
        });
      });
    },
    enqueue(...frames) {
      for (const frame of frames) {
        if (waiters.length) {
          waiters.shift()({ value: frame, done: false });
        } else {
          queue.push(frame);
        }
      }
    },
  };

  executor.openAgentHttp2Stream = () => {
    openCount += 1;
    return session;
  };
  return {
    written,
    sessionState,
    session,
    enqueue: (...frames) => session.enqueue(...frames),
    openCount: () => openCount,
  };
}

function stubAgentSession(executor, frames) {
  const written = [];
  const queue = [...frames];
  executor.openAgentHttp2Stream = () => ({
    responseHeaders: Promise.resolve({ ":status": 200 }),
    write: (frame) => written.push(Buffer.from(frame)),
    end() {},
    close() {},
    async read() {
      if (queue.length) return { value: queue.shift(), done: false };
      return new Promise((resolve) => {
        setTimeout(() => resolve({ value: undefined, done: true }), 20);
      });
    },
  });
  return written;
}

function countAgentRunFrames(written) {
  return written.filter((frame) => {
    try {
      const parsed = parseConnectRPCFrame(frame);
      const clientMessage = decodeMessage(parsed.payload);
      return clientMessage.has(1);
    } catch {
      return false;
    }
  }).length;
}

function fixtureTools(data) {
  return data.tools.map((tool) => (
    tool.function
      ? tool
      : {
          type: "function",
          function: {
            name: tool.name,
            description: tool.description || "",
            parameters: tool.input_schema || { type: "object", properties: {} },
          },
        }
  ));
}

const credentials = {
  accessToken: "test-token",
  providerSpecificData: { machineId: "a".repeat(64) },
};

function parseSSE(text) {
  return text
    .split("\n\n")
    .filter((chunk) => chunk.startsWith("data: "))
    .map((chunk) => chunk.slice("data: ".length))
    .filter((data) => data !== "[DONE]")
    .map((data) => JSON.parse(data));
}

describe("real Claude Code tool fixture bridge", () => {
  beforeEach(() => {
    resetPendingAgentSessionRegistryForTests();
  });

  it("one-shot capture writes the next large tool request exactly once", () => {
    const tmp = path.join("/tmp", `cursor-tool-capture-${process.pid}.json`);
    try {
      if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
      const tools = Array.from({ length: 120 }, (_, i) => ({
        name: `Tool_${i}`,
        description: `desc ${i}`,
        input_schema: { type: "object", properties: { n: { type: "number" } } },
      }));
      const first = maybeCaptureToolRequest(
        { model: "claude-sonnet-4-6", messages: [{ role: "user", content: "task A" }], tools },
        { capturePath: tmp, minTools: 100 },
      );
      const second = maybeCaptureToolRequest(
        { model: "claude-sonnet-4-6", messages: [{ role: "user", content: "task B" }], tools },
        { capturePath: tmp, minTools: 100 },
      );
      expect(first.captured).toBe(true);
      expect(second.captured).toBe(false);
      expect(second.reason).toBe("already-captured");
      const saved = JSON.parse(fs.readFileSync(tmp, "utf8"));
      expect(saved.toolCount).toBe(120);
      expect(saved.task).toBe("task A");
      expect(saved.tools).toHaveLength(120);
    } finally {
      if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
    }
  });

  it("every declared Claude tool survives conversion to Cursor tool metadata", () => {
    const { data } = requireFixture();
    expect(data.toolCount).toBeGreaterThanOrEqual(100);
    expect(data.tools).toHaveLength(data.toolCount);

    const metadata = claudeToolsToCursorToolMetadata(data.tools);
    expect(metadata).toHaveLength(data.tools.length);

    const names = new Set();
    for (let i = 0; i < data.tools.length; i++) {
      const src = data.tools[i];
      const meta = metadata[i];
      const expectedName = src.function?.name || src.name;
      const expectedDesc = src.function?.description || src.description || "";
      const expectedSchema = src.function?.parameters || src.input_schema || src.inputSchema || {};
      expect(meta.name).toBe(expectedName);
      expect(meta.description).toBe(expectedDesc);
      expect(meta.inputSchema).toEqual(expectedSchema);
      expect(meta.serverName).toBe("9router");
      expect(Buffer.isBuffer(meta.encoded) || meta.encoded instanceof Uint8Array).toBe(true);
      expect(meta.encoded.length).toBeGreaterThan(0);
      expect(names.has(meta.name)).toBe(false);
      names.add(meta.name);
    }
  });

  it("Cursor exec requests become exact Claude tool_use blocks", async () => {
    const { data } = requireFixture();
    const tools = data.tools.map((tool) => (
      tool.function
        ? tool
        : {
            type: "function",
            function: {
              name: tool.name,
              description: tool.description || "",
              parameters: tool.input_schema || { type: "object", properties: {} },
            },
          }
    ));
    const readTool = tools.find((tool) => /^(Read|read_file|readFile)$/i.test(tool.function.name));
    expect(readTool, "fixture must include Claude Code Read (or alias)").toBeTruthy();

    const executor = new CursorExecutor();
    const written = stubAgentSession(executor, [
      readFileRequestFrame("open-sse/executors/cursor.js", "call_read_1"),
    ]);
    const result = await executor.executeAgent({
      model: "gpt-5.2",
      body: {
        messages: [{ role: "user", content: data.task || "inspect cursor.js" }],
        tools,
      },
      stream: true,
      credentials: {
        accessToken: "test-token",
        providerSpecificData: { machineId: "a".repeat(64) },
      },
      clientTools: tools,
    });

    const events = parseSSE(await result.response.text());
    const call = events.flatMap((event) => event.choices?.[0]?.delta?.tool_calls || [])[0];
    expect(written).toHaveLength(1);
    expect(call).toBeTruthy();

    const toolUse = openAIToolCallToClaudeToolUse(call);
    expect(toolUse).toEqual({
      type: "tool_use",
      id: call.id,
      name: readTool.function.name,
      input: { file_path: "open-sse/executors/cursor.js" },
    });

    // Direct exec→Claude helper matches the same declaration.
    const rawExec = decodeMessage(parseConnectRPCFrame(readFileRequestFrame("open-sse/executors/cursor.js")).payload);
    const execRequest = decodeMessage(rawExec.get(2)[0].value);
    const direct = translateAgentExecRequestToClaudeToolUse(execRequest, tools);
    expect(direct).toMatchObject({
      type: "tool_use",
      name: readTool.function.name,
      input: { file_path: "open-sse/executors/cursor.js" },
    });
  });

  it("multi-turn: 169-tool fixture parks Read, resumes twice on one AgentService Run", async () => {
    const { data } = requireFixture();
    const tools = fixtureTools(data);
    const readTool = tools.find((tool) => /^(Read|read_file|readFile)$/i.test(tool.function.name));
    const bashTool = tools.find((tool) => /^Bash$/i.test(tool.function.name));
    expect(readTool).toBeTruthy();
    expect(bashTool).toBeTruthy();

    const executor = new CursorExecutor();
    const { written, sessionState, enqueue, openCount } = createResumableStub(executor);
    enqueue(readFileRequestFrame("README.md", "call_1"));

    const turn1 = await executor.execute({
      model: "gpt-5.2",
      body: {
        messages: [{ role: "user", content: data.task || "read README" }],
        tools,
      },
      stream: false,
      credentials,
    });
    const firstCall = (await turn1.response.json()).choices[0].message.tool_calls[0];
    expect(firstCall.function.name).toBe(readTool.function.name);
    expect(getPendingAgentSessionRegistry().get(firstCall.id)).not.toBeNull();
    expect(sessionState.closed).toBe(false);
    const writesAfterPark1 = written.length;

    enqueue(mcpToolRequestFrame("Bash", "call_2"));
    const turn2 = await executor.execute({
      model: "gpt-5.2",
      body: {
        messages: [
          { role: "user", content: data.task || "read README" },
          {
            role: "user",
            content: [{ type: "tool_result", tool_use_id: firstCall.id, content: "# README\nfixture ok\n" }],
          },
        ],
        tools,
      },
      stream: false,
      credentials,
    });
    expect(written.length).toBeGreaterThan(writesAfterPark1);
    const execClient1 = parseConnectRPCFrame(written[writesAfterPark1]);
    const clientMessage1 = decodeMessage(execClient1.payload);
    expect(decodeMessage(clientMessage1.get(2)[0].value).has(7)).toBe(true);

    const turn2Body = await turn2.response.json();
    const secondCall = turn2Body.choices[0].message.tool_calls?.[0];
    expect(secondCall).toBeTruthy();
    expect(secondCall.function.name).toBe(bashTool.function.name);
    expect(getPendingAgentSessionRegistry().get(secondCall.id)).not.toBeNull();
    const writesAfterPark2 = written.length;

    enqueue(textFrame("Final answer from resumed Cursor turn."), turnEndedFrame());
    const turn3 = await executor.execute({
      model: "gpt-5.2",
      body: {
        messages: [
          { role: "user", content: data.task || "read README" },
          {
            role: "user",
            content: [{ type: "tool_result", tool_use_id: secondCall.id, content: "echo ok\n" }],
          },
        ],
        tools,
      },
      stream: false,
      credentials,
    });
    expect(written.length).toBeGreaterThan(writesAfterPark2);
    const turn3Body = await turn3.response.json();
    expect(turn3Body.choices[0].message.content).toContain("Final answer");
    expect(turn3Body.choices[0].message.tool_calls || []).toHaveLength(0);
    expect(getPendingAgentSessionRegistry().size()).toBe(0);
    expect(sessionState.ended).toBe(true);
    expect(sessionState.closed).toBe(true);
    expect(openCount()).toBe(1);
    expect(countAgentRunFrames(written)).toBe(1);
  });

  it("regression: original task remains after multiple tool-result turns", () => {
    const { data } = requireFixture();
    const originalTask = data.task || "Investigate go-kit reuse across inventory and user";
    const tools = data.tools;

    const body = {
      messages: [
        { role: "user", content: originalTask },
        {
          role: "assistant",
          content: [{ type: "tool_use", id: "tu_1", name: "Bash", input: { command: "ls" } }],
        },
        {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "tu_1", content: "Safety classifier unavailable" }],
        },
        {
          role: "assistant",
          content: [{ type: "tool_use", id: "tu_2", name: "Read", input: { file_path: "a.ts" } }],
        },
        {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "tu_2", content: "export {}" }],
        },
      ],
      tools,
    };

    const gateway = prepareCursorGatewayRequest(body);
    expect(gateway.tools).toEqual([]);
    const flat = flattenHistoryIntoCurrentUserText(gateway.messages);
    expect(originalTaskRemainsInAgentPayload(originalTask, flat)).toBe(true);

    const frame = buildAgentRunFrame(gateway.messages, "gpt-5.2");
    const agentUserText = decodeAgentUserText(frame);
    expect(originalTaskRemainsInAgentPayload(originalTask, agentUserText)).toBe(true);
    expect(agentUserText).toContain("tu_1");
    expect(agentUserText).toContain("tu_2");
  });
});
