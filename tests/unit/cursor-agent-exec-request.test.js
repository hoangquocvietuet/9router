import { describe, it, expect, beforeEach } from "vitest";

import { CursorExecutor } from "../../open-sse/executors/cursor.js";
import {
  getPendingAgentSessionRegistry,
  resetPendingAgentSessionRegistryForTests,
} from "../../open-sse/utils/cursorPendingAgentSessions.js";
import {
  decodeMessage,
  encodeField,
  parseConnectRPCFrame,
  wrapConnectRPCFrame,
} from "../../open-sse/utils/cursorProtobuf.js";

const LEN = 2;

// agent.v1.AgentServerMessage.exec_request (field 2) carrying one ExecServerMessage variant.
function execRequestFrame(execField) {
  const execServerMessage = Buffer.from(encodeField(execField, LEN, new Uint8Array()));
  return Buffer.from(wrapConnectRPCFrame(encodeField(2, LEN, execServerMessage)));
}

function mcpToolRequestFrame(name, toolCallId) {
  const mcpArgs = Buffer.concat([
    Buffer.from(encodeField(1, LEN, name)),
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

// agent.v1.AgentServerMessage.interaction_update (field 1) → text delta.
function textFrame(text) {
  const textPart = Buffer.from(encodeField(1, LEN, text));
  const update = Buffer.from(encodeField(1, LEN, textPart));
  return Buffer.from(wrapConnectRPCFrame(encodeField(1, LEN, update)));
}

function stubAgentSession(executor, frames) {
  const written = [];
  const queue = [...frames];
  const sessionState = { ended: false, closed: false };
  executor.openAgentHttp2Stream = () => ({
    responseHeaders: Promise.resolve({ ":status": 200 }),
    write: (frame) => written.push(Buffer.from(frame)),
    end() { sessionState.ended = true; },
    close() { sessionState.closed = true; },
    async read() {
      if (queue.length) return { value: queue.shift(), done: false };
      return new Promise((resolve) => {
        setTimeout(() => resolve({ value: undefined, done: true }), 50);
      });
    },
  });
  return { written, sessionState };
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

async function runAgent({ frames, stream, tools = [] }) {
  const executor = new CursorExecutor();
  const { written, sessionState } = stubAgentSession(executor, frames);
  const result = await executor.executeAgent({
    model: "gpt-5.2",
    body: { messages: [{ role: "user", content: "hi" }], tools },
    stream,
    credentials,
  });
  return { result, written, sessionState };
}

describe("CursorExecutor AgentService exec_request handling", () => {
  beforeEach(() => {
    resetPendingAgentSessionRegistryForTests();
  });
  it("acknowledges a request-context exec request without ending the turn", async () => {
    const { result, written } = await runAgent({
      frames: [execRequestFrame(10), textFrame("hello")],
      stream: true,
    });

    const events = parseSSE(await result.response.text());
    expect(written.length).toBe(2); // run frame + request-context reply
    const content = events.map((e) => e.choices?.[0]?.delta?.content || "").join("");
    expect(content).toBe("hello");
  });

  it("rejects an MCP request when the caller did not declare it", async () => {
    const { result, written } = await runAgent({
      frames: [mcpToolRequestFrame("not_declared", "call_1"), textFrame("hello")],
      stream: true,
    });

    const body = await result.response.text();
    expect(written.length).toBe(1); // run frame only; 9router never runs tools
    expect(body).toContain("matching client-declared tool");
  });

  it("returns a declared MCP tool call without replying to Cursor", async () => {
    const { result, written, sessionState } = await runAgent({
      frames: [mcpToolRequestFrame("declared_tool", "call_1"), textFrame("hello")],
      stream: true,
      tools: [{ type: "function", function: { name: "declared_tool" } }],
    });

    const body = await result.response.text();
    const events = parseSSE(body);
    const call = events.flatMap((event) => event.choices?.[0]?.delta?.tool_calls || [])[0];
    expect(written.length).toBe(1); // run frame only
    expect(call.function.name).toBe("declared_tool");
    expect(events.at(-1).choices[0].finish_reason).toBe("tool_calls");
    expect(sessionState.ended).toBe(false);
    expect(sessionState.closed).toBe(false);
    const parked = getPendingAgentSessionRegistry().get(call.id);
    expect(parked).not.toBeNull();
    expect(parked.toolCallId).toBe(call.id);
    expect(parked.execRequest.has(11)).toBe(true);
  });

  it("returns the first tool call and ends the upstream turn", async () => {
    const { result } = await runAgent({
      frames: [
        mcpToolRequestFrame("read_file", "call_1"),
        textFrame("after tool "),
        mcpToolRequestFrame("grep", "call_2"),
        textFrame("done"),
      ],
      stream: true,
      tools: [{ type: "function", function: { name: "read_file" } }],
    });

    const body = await result.response.text();
    const events = parseSSE(body);
    expect(events.flatMap((event) => event.choices?.[0]?.delta?.tool_calls || [])).toHaveLength(1);
    expect(body).not.toContain("after tool");
  });

  it("maps Cursor read requests to Claude Code's declared Read tool", async () => {
    const { result, written, sessionState } = await runAgent({
      frames: [readFileRequestFrame("open-sse/executors/cursor.js"), textFrame("summary")],
      stream: true,
      tools: [{ type: "function", function: { name: "Read" } }],
    });

    const body = await result.response.text();
    const events = parseSSE(body);
    const call = events.flatMap((event) => event.choices?.[0]?.delta?.tool_calls || [])[0];
    expect(written).toHaveLength(1);
    expect(call.function.name).toBe("Read");
    expect(JSON.parse(call.function.arguments)).toEqual({ file_path: "open-sse/executors/cursor.js" });
    expect(sessionState.ended).toBe(false);
    expect(sessionState.closed).toBe(false);
    const parked = getPendingAgentSessionRegistry().get(call.id);
    expect(parked).not.toBeNull();
    expect(parked.toolCallId).toBe(call.id);
    expect(parked.execRequest.has(7)).toBe(true);
  });

  it("does not simulate shell exec requests without a declared Bash tool", async () => {
    const { result } = await runAgent({
      frames: [textFrame("partial answer"), execRequestFrame(2)],
      stream: true,
    });

    const body = await result.response.text();
    expect(body).toContain("matching client-declared tool");
    const events = parseSSE(body);
    const content = events.map((e) => e.choices?.[0]?.delta?.content || "").join("");
    expect(content).toBe("partial answer");
    expect(events.some((e) => e.error)).toBe(true);
  });

  it("does not consume a later frame after an unmatched exec request", async () => {
    const { result } = await runAgent({
      frames: [Buffer.concat([execRequestFrame(2), textFrame("late")])],
      stream: true,
    });

    const body = await result.response.text();
    expect(body).toContain("matching client-declared tool");
    expect(body).not.toContain("late");
  });

  it("returns an API error when a non-streaming request has no matching tool", async () => {
    const { result } = await runAgent({
      frames: [textFrame("done"), execRequestFrame(11)],
      stream: false,
    });

    expect(result.response.status).toBe(400);
    const payload = await result.response.json();
    expect(payload.error.message).toContain("matching client-declared tool");
  });
});
