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

function readFileRequestFrame(filePath, toolCallId = "call_read") {
  const readArgs = Buffer.concat([
    Buffer.from(encodeField(1, LEN, filePath)),
    Buffer.from(encodeField(2, LEN, toolCallId)),
  ]);
  const execServerMessage = Buffer.from(encodeField(7, LEN, readArgs));
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

function textFrame(text) {
  const textPart = Buffer.from(encodeField(1, LEN, text));
  const update = Buffer.from(encodeField(1, LEN, textPart));
  return Buffer.from(wrapConnectRPCFrame(encodeField(1, LEN, update)));
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

  executor.openAgentHttp2Stream = () => session;
  return { written, sessionState, session, enqueue: (...frames) => session.enqueue(...frames) };
}

const credentials = {
  accessToken: "test-token",
  providerSpecificData: { machineId: "a".repeat(64) },
};

const readTool = { type: "function", function: { name: "Read" } };

describe("CursorExecutor resume parked AgentService session", () => {
  beforeEach(() => {
    resetPendingAgentSessionRegistryForTests();
  });

  it("resumes after tool_result, replies exec_client, and returns final text", async () => {
    const executor = new CursorExecutor();
    const { written, sessionState, enqueue } = createResumableStub(executor);
    enqueue(readFileRequestFrame("src/main.ts", "call_read"));

    const turn1 = await executor.execute({
      model: "gpt-5.2",
      body: {
        messages: [{ role: "user", content: "read src/main.ts" }],
        tools: [readTool],
      },
      stream: false,
      credentials,
    });

    const turn1Body = await turn1.response.json();
    const toolCall = turn1Body.choices[0].message.tool_calls[0];
    expect(toolCall.function.name).toBe("Read");
    expect(getPendingAgentSessionRegistry().get(toolCall.id)).not.toBeNull();
    expect(sessionState.closed).toBe(false);
    const writesAfterPark = written.length;

    enqueue(textFrame("File contains exports."), turnEndedFrame());

    const turn2 = await executor.execute({
      model: "gpt-5.2",
      body: {
        messages: [
          { role: "user", content: "read src/main.ts" },
          {
            role: "user",
            content: [
              { type: "tool_result", tool_use_id: toolCall.id, content: "export const main = 1;" },
            ],
          },
        ],
        tools: [readTool],
      },
      stream: false,
      credentials,
    });

    expect(written.length).toBeGreaterThan(writesAfterPark);
    const execClientFrame = parseConnectRPCFrame(written[writesAfterPark]);
    const clientMessage = decodeMessage(execClientFrame.payload);
    const execClientMessage = decodeMessage(clientMessage.get(2)[0].value);
    expect(execClientMessage.has(7)).toBe(true);

    const turn2Body = await turn2.response.json();
    expect(turn2Body.choices[0].message.content).toContain("File contains exports");
    expect(turn2Body.choices[0].message.tool_calls || []).toHaveLength(0);
    expect(getPendingAgentSessionRegistry().size()).toBe(0);
    expect(sessionState.ended).toBe(true);
    expect(sessionState.closed).toBe(true);
  });

  it("parks again when resumed turn requests another mapped tool", async () => {
    const executor = new CursorExecutor();
    const { sessionState, enqueue } = createResumableStub(executor);
    const grepTool = { type: "function", function: { name: "Grep" } };

    enqueue(readFileRequestFrame("a.ts", "call_1"));
    const turn1 = await executor.execute({
      model: "gpt-5.2",
      body: {
        messages: [{ role: "user", content: "investigate" }],
        tools: [readTool, grepTool],
      },
      stream: false,
      credentials,
    });
    const firstCall = (await turn1.response.json()).choices[0].message.tool_calls[0];

    enqueue(mcpToolRequestFrame("Grep", "call_2"));
    const turn2 = await executor.execute({
      model: "gpt-5.2",
      body: {
        messages: [
          { role: "user", content: "investigate" },
          {
            role: "user",
            content: [{ type: "tool_result", tool_use_id: firstCall.id, content: "export {}" }],
          },
        ],
        tools: [readTool, grepTool],
      },
      stream: false,
      credentials,
    });

    const turn2Body = await turn2.response.json();
    const nextCalls = turn2Body.choices[0].message.tool_calls || [];
    expect(nextCalls).toHaveLength(1);
    expect(nextCalls[0].function.name).toBe("Grep");
    expect(getPendingAgentSessionRegistry().get(nextCalls[0].id)).not.toBeNull();
    expect(sessionState.closed).toBe(false);
  });
});
