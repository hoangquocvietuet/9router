import { describe, expect, it } from "vitest";

import { createDisconnectAwareStream } from "../../open-sse/utils/streamHandler.js";
import { buildAbortedClaudeTerminalBytes } from "../../open-sse/utils/claudeStreamHelpers.js";

// Minimal stream controller stub
function makeController() {
  let connected = true;
  return {
    signal: new AbortController().signal,
    startTime: Date.now(),
    isConnected: () => connected,
    handleComplete: () => { connected = false; },
    handleError: () => { connected = false; },
    handleDisconnect: () => { connected = false; },
    abort: () => { connected = false; },
  };
}

async function readAll(stream) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let text = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
  }
  text += decoder.decode();
  return text;
}

describe("Claude abort terminal synthesis", () => {
  it("synthesizes an error event + message_delta + message_stop terminal", () => {
    const text = new TextDecoder().decode(buildAbortedClaudeTerminalBytes());
    // Truncation signal: a Claude `error` event so the client knows it failed
    expect(text).toContain("event: error");
    expect(text).toContain('"type":"error"');
    // Closed with a protocol-valid terminal sequence
    expect(text).toContain("event: message_delta");
    expect(text).toContain("event: message_stop");
    expect(text).toContain('"type":"message_stop"');
  });

  it("uses only Anthropic-valid stop_reason values (never the literal 'error')", () => {
    const text = new TextDecoder().decode(buildAbortedClaudeTerminalBytes());
    const VALID = ["end_turn", "max_tokens", "tool_use", "stop_sequence"];
    const m = text.match(/"stop_reason":"([^"]+)"/);
    expect(m).not.toBeNull();
    expect(VALID).toContain(m[1]);
  });

  it("emits a Claude terminal when upstream errors mid-stream", async () => {
    // Upstream (already-translated Claude SSE) errors before message_stop
    const upstream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("event: message_start\ndata: {\"type\":\"message_start\"}\n\n"));
        controller.error(new Error("terminated"));
      },
    });

    const out = createDisconnectAwareStream(
      { readable: upstream, writable: { getWriter: () => ({ abort: () => Promise.resolve() }) } },
      makeController(),
      buildAbortedClaudeTerminalBytes
    );

    const text = await readAll(out);
    expect(text).toContain("event: message_stop");
  });

  it("emits a Claude terminal when upstream closes with zero events (silent empty 200)", async () => {
    // Upstream produces no bytes then closes gracefully — the empty-200 case
    const upstream = new ReadableStream({
      start(controller) {
        controller.close();
      },
    });

    const out = createDisconnectAwareStream(
      { readable: upstream, writable: { getWriter: () => ({ abort: () => Promise.resolve() }) } },
      makeController(),
      buildAbortedClaudeTerminalBytes
    );

    const text = await readAll(out);
    expect(text).toContain("event: message_stop");
  });

  it("emits a Claude terminal when upstream closes after partial events", async () => {
    const upstream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("event: message_start\ndata: {\"type\":\"message_start\"}\n\n"));
        controller.close();
      },
    });

    const out = createDisconnectAwareStream(
      { readable: upstream, writable: { getWriter: () => ({ abort: () => Promise.resolve() }) } },
      makeController(),
      buildAbortedClaudeTerminalBytes
    );

    const text = await readAll(out);
    expect(text.match(/event: message_stop/g)?.length).toBe(1);
  });

  it("does NOT synthesize a terminal when real events already flowed to EOF", async () => {
    const upstream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("event: message_start\ndata: {\"type\":\"message_start\"}\n\n"));
        controller.enqueue(new TextEncoder().encode("event: message_stop\ndata: {\"type\":\"message_stop\"}\n\n"));
        controller.close();
      },
    });

    const out = createDisconnectAwareStream(
      { readable: upstream, writable: { getWriter: () => ({ abort: () => Promise.resolve() }) } },
      makeController(),
      buildAbortedClaudeTerminalBytes
    );

    const text = await readAll(out);
    // Exactly one message_stop — the real one, no synthesized duplicate
    expect(text.match(/event: message_stop/g)?.length).toBe(1);
  });
});
