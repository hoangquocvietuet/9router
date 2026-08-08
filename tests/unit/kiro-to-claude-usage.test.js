import { describe, expect, it } from "vitest";
import { kiroToClaudeResponse } from "../../open-sse/translator/response/kiro-to-claude.js";
import { estimateUsage } from "../../open-sse/utils/usageTracking.js";
import { FORMATS } from "../../open-sse/translator/formats.js";

// Same shape translateRequest(claude→kiro) produces — flows through state.body
// in stream.js TRANSLATE mode (KiroExecutor emits OpenAI-shaped chunks; this
// translator converts them to Claude SSE directly).
const kiroBody = {
  model: "kiro-k2.6",
  max_tokens: 32000,
  systemPrompt: "You are a helpful assistant.",
  conversationState: { messages: [{ role: "user", content: "Say hi" }] },
  inferenceConfig: { maxTokens: 32000 },
};

function firstChunk(usage) {
  const chunk = {
    id: "chatcmpl-a",
    model: "kiro-k2.6",
    choices: [{ index: 0, delta: { role: "assistant", content: "Hi" }, finish_reason: null }],
  };
  if (usage) chunk.usage = usage;
  return chunk;
}

describe("kiroToClaudeResponse message_start input_tokens", () => {
  it("estimates input_tokens from state.body when upstream sends no usage", () => {
    const state = { provider: "kiro", model: "kiro-k2.6", body: kiroBody };
    const out = kiroToClaudeResponse(firstChunk(), state);
    const ms = out.find((e) => e.type === "message_start");
    // Matches the shared helper exactly: ceil(chars/4) + 2000 buffer.
    expect(ms.message.usage.input_tokens).toBe(estimateUsage(state.body, 0, FORMATS.CLAUDE).input_tokens);
    expect(ms.message.usage.input_tokens).toBeGreaterThan(0);
  });

  it("uses real usage from a usage-bearing first chunk when present", () => {
    const state = { provider: "kiro", model: "kiro-k2.6", body: kiroBody };
    const out = kiroToClaudeResponse(firstChunk({ prompt_tokens: 42, completion_tokens: 7 }), state);
    const ms = out.find((e) => e.type === "message_start");
    expect(ms.message.usage.input_tokens).toBe(42);
  });
});
