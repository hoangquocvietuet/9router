import { describe, it, expect, vi } from "vitest";
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
});
