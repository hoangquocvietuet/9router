import { describe, it, expect, vi } from "vitest";
import { getCapabilitiesForModel } from "../../open-sse/providers/capabilities.js";
import { handleComboChat } from "../../open-sse/services/combo.js";

describe("handleComboChat context-window filtering", () => {
  it("skips combo members whose context window is smaller than the estimated prompt", async () => {
    const handleSingleModel = vi.fn(async () => ({ ok: true, status: 200, statusText: "OK" }));
    const log = { info: vi.fn(), warn: vi.fn() };

    // ~1M chars / 4 = ~250k tokens estimate won't fit kimi 262k reliably, so use a larger body
    const hugeContent = "x".repeat(2_000_000);
    const body = { messages: [{ role: "user", content: hugeContent }] };

    await handleComboChat({
      body,
      models: ["ocg/kimi-k2.7-code(max)", "ocg/deepseek-v4-flash(max)"],
      handleSingleModel,
      log,
      comboName: "test",
      comboStrategy: "fallback",
    });

    // Kimi should be skipped; DeepSeek (1M) should be tried.
    expect(handleSingleModel).toHaveBeenCalledTimes(1);
    expect(handleSingleModel.mock.calls[0][1]).toBe("ocg/deepseek-v4-flash(max)");
  });

  it("tries the first member when the prompt fits", async () => {
    const handleSingleModel = vi.fn(async () => ({ ok: true, status: 200, statusText: "OK" }));
    const log = { info: vi.fn(), warn: vi.fn() };

    await handleComboChat({
      body: { messages: [{ role: "user", content: "hi" }] },
      models: ["ocg/kimi-k2.7-code(max)", "ocg/deepseek-v4-flash(max)"],
      handleSingleModel,
      log,
      comboName: "test",
      comboStrategy: "fallback",
    });

    expect(handleSingleModel).toHaveBeenCalledTimes(1);
    expect(handleSingleModel.mock.calls[0][1]).toBe("ocg/kimi-k2.7-code(max)");
  });

  it("strips thinking/effort suffixes before the context-window lookup", async () => {
    // Regression: combo members are stored as "cc/claude-opus-4-8(medium)". The
    // (medium) suffix must not break the exact-id capabilities lookup, which
    // declares a 1M context window for claude-opus-4-8 — otherwise a ~300k-token
    // prompt is "skipped" and Claude never gets routed to (the 9router skip log).
    const handleSingleModel = vi.fn(async () => ({ ok: true, status: 200, statusText: "OK" }));
    const log = { info: vi.fn(), warn: vi.fn() };

    // ~1.2M chars / 4 ≈ 300k estimated tokens — fits the 1M Claude window, not a 200k one.
    const hugeContent = "x".repeat(1_200_000);
    const body = { messages: [{ role: "user", content: hugeContent }] };

    await handleComboChat({
      body,
      models: ["cc/claude-opus-4-8(medium)"],
      handleSingleModel,
      log,
      comboName: "test",
      comboStrategy: "fallback",
    });

    expect(handleSingleModel).toHaveBeenCalledTimes(1);
    expect(handleSingleModel.mock.calls[0][1]).toBe("cc/claude-opus-4-8(medium)");
    expect(log.warn).not.toHaveBeenCalledWith(expect.stringContaining("No combo member"));
  });

  it("treats a suffixed claude model as 1M, not the 200k pattern fallback", () => {
    const caps = getCapabilitiesForModel("cc", "claude-opus-4-8(medium)");
    expect(caps.contextWindow).toBe(1_000_000);
  });
});
