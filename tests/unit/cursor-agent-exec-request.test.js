import { describe, it, expect } from "vitest";

import { CursorExecutor } from "../../open-sse/executors/cursor.js";
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
  const execServerMessage = Buffer.from(encodeField(2, LEN, mcpArgs));
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
  executor.openAgentHttp2Stream = () => ({
    responseHeaders: Promise.resolve({ ":status": 200 }),
    write: (frame) => written.push(Buffer.from(frame)),
    end() {},
    close() {},
    async read() {
      if (queue.length) return { value: queue.shift(), done: false };
      return new Promise((resolve) => {
        setTimeout(() => resolve({ value: undefined, done: true }), 50);
      });
    },
  });
  return written;
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
  const written = stubAgentSession(executor, frames);
  const result = await executor.executeAgent({
    model: "gpt-5.2",
    body: { messages: [{ role: "user", content: "hi" }], tools },
    stream,
    credentials,
  });
  return { result, written };
}

describe("CursorExecutor AgentService exec_request handling", () => {
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

  it("replies to an MCP tool request with a simulated success so the turn continues", async () => {
    const { result, written } = await runAgent({
      frames: [mcpToolRequestFrame("not_declared", "call_1"), textFrame("hello")],
      stream: true,
    });

    const body = await result.response.text();
    expect(written.length).toBe(2); // run frame + MCP tool result
    const responseFrame = parseConnectRPCFrame(written[1]);
    const clientMessage = decodeMessage(responseFrame.payload);
    const execClientMessage = decodeMessage(clientMessage.get(2)[0].value);
    const resultMessage = decodeMessage(execClientMessage.get(2)[0].value);
    const success = decodeMessage(resultMessage.get(1)[0].value);
    expect(success.get(2)[0].value).toBe(0); // is_error=false
    expect(body).toContain("hello");
  });

  it("replies with simulated success for a declared tool", async () => {
    const { result, written } = await runAgent({
      frames: [mcpToolRequestFrame("declared_tool", "call_1"), textFrame("hello")],
      stream: true,
      tools: [{ type: "function", function: { name: "declared_tool" } }],
    });

    const body = await result.response.text();
    const responseFrame = parseConnectRPCFrame(written[1]);
    const clientMessage = decodeMessage(responseFrame.payload);
    const execClientMessage = decodeMessage(clientMessage.get(2)[0].value);
    const resultMessage = decodeMessage(execClientMessage.get(2)[0].value);
    const success = decodeMessage(resultMessage.get(1)[0].value);
    expect(success.get(2)[0].value).toBe(0);
    expect(body).toContain("hello");
  });

  it("continues streaming after multiple simulated tool exec replies", async () => {
    const { result } = await runAgent({
      frames: [
        mcpToolRequestFrame("read_file", "call_1"),
        textFrame("after tool "),
        mcpToolRequestFrame("grep", "call_2"),
        textFrame("done"),
      ],
      stream: true,
    });

    const body = await result.response.text();
    const content = parseSSE(body).map((e) => e.choices?.[0]?.delta?.content || "").join("");
    expect(content).toBe("after tool done");
  });

  it("stubs unsupported exec requests and keeps streaming assistant text", async () => {
    const { result } = await runAgent({
      frames: [textFrame("partial answer"), execRequestFrame(2)],
      stream: true,
    });

    const body = await result.response.text();
    expect(body).not.toContain("unsupported IDE tool");
    const events = parseSSE(body);
    const content = events.map((e) => e.choices?.[0]?.delta?.content || "").join("");
    expect(content).toBe("partial answer");
    expect(events.some((e) => e.error)).toBe(false);
    expect(events.some((e) => e.choices?.[0]?.finish_reason === "stop")).toBe(true);
  });

  it("continues after unsupported exec requests batched in the same read", async () => {
    const { result } = await runAgent({
      frames: [Buffer.concat([execRequestFrame(2), textFrame("late")])],
      stream: true,
    });

    const body = await result.response.text();
    expect(body).not.toContain("unsupported IDE tool");
    expect(body).toContain("late");
  });

  it("returns assistant text when not streaming after an unsupported exec stub", async () => {
    const { result } = await runAgent({
      frames: [textFrame("done"), execRequestFrame(11)],
      stream: false,
    });

    expect(result.response.status).toBe(200);
    const payload = await result.response.json();
    expect(payload.choices?.[0]?.message?.content).toBe("done");
  });
});
