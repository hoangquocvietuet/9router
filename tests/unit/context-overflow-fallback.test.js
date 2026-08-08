import { describe, expect, it } from "vitest";
import { checkFallbackError } from "../../open-sse/services/accountFallback.js";
import { TRANSIENT_COOLDOWN_MS } from "../../open-sse/config/errorConfig.js";

describe("context-window overflow classification", () => {
  // Real upstream body from opencode-go/qwen: input exceeds the model context window.
  const qwenMsg =
    "Error from provider (Console Go): Upstream request failed: [invalid_parameter_error] <400> " +
    "InternalError.Algo.InvalidParameter: Range of input length should be [1, 983616]";

  it("treats the qwen 'range of input length' 400 as a no-cooldown fallback", () => {
    const { shouldFallback, cooldownMs } = checkFallbackError(400, qwenMsg);
    expect(shouldFallback).toBe(true);
    expect(cooldownMs).toBe(0);
  });

  it.each([
    "This model's maximum context length is 200000 tokens.",
    "Your input exceeds the context window of this model.",
    "context_length_exceeded",
    "Please reduce the length of the messages.",
    "prompt is too long: 250000 tokens > 200000 maximum",
  ])("classifies context-overflow message as cooldownMs 0: %s", (msg) => {
    const { shouldFallback, cooldownMs } = checkFallbackError(400, msg);
    expect(shouldFallback).toBe(true);
    expect(cooldownMs).toBe(0);
  });

  it("still applies backoff for genuine rate limits (regression guard)", () => {
    const { shouldFallback, cooldownMs } = checkFallbackError(429, "rate limit exceeded");
    expect(shouldFallback).toBe(true);
    expect(cooldownMs).toBeGreaterThan(0);
  });

  it("leaves unrelated 400 errors on the default transient cooldown", () => {
    const { shouldFallback, cooldownMs } = checkFallbackError(400, "some unrelated bad request");
    expect(shouldFallback).toBe(true);
    expect(cooldownMs).toBe(TRANSIENT_COOLDOWN_MS);
  });
});
