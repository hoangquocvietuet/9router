import { describe, expect, it } from "vitest";
import { createSSEStream } from "../../open-sse/utils/stream.js";

// The Claude-format upstream (opencode.ai/zen/go/v1/messages for qwen3.7/minimax)
// sends real usage in message_start. The passthrough must NOT zero it out —
// the emitted event must carry the upstream input_tokens verbatim.
describe("claude-format passthrough preserves upstream message_start usage", () => {
  it("passes message_start through with upstream input_tokens intact", async () => {
    const stream = createSSEStream({ mode: "passthrough", provider: "opencode-go", model: "qwen3.7-plus" });
    const chunks = [];
    const reader = stream.readable.getReader();
    (async () => {
      try { while (true) { const { done, value } = await reader.read(); if (done) break; chunks.push(new TextDecoder().decode(value)); } } catch (e) { chunks.push("ERR:" + e.message); }
    })();
    const writer = stream.writable.getWriter();
    const encoder = new TextEncoder();
    const msg = { type: "message_start", message: { id: "msg_1", type: "message", role: "assistant", model: "qwen3.7-plus", content: [], usage: { input_tokens: 3006, output_tokens: 0 } } };
    await writer.write(encoder.encode("event: message_start\ndata: " + JSON.stringify(msg) + "\n\n"));
    await writer.write(encoder.encode("data: [DONE]\n\n"));
    await writer.close();
    await new Promise(r => setTimeout(r, 200));
    const out = chunks.join("");
    const parsed = JSON.parse(out.match(/data: (\{.*\})/)?.[1] || "{}");
    expect(parsed.message?.usage?.input_tokens).toBe(3006);
  });
});
