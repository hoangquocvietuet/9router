import { describe, expect, it, beforeEach, vi } from "vitest";
import {
  DEFAULT_PENDING_AGENT_TTL_MS,
  createPendingAgentSessionRegistry,
  getPendingAgentSessionRegistry,
  resetPendingAgentSessionRegistryForTests,
} from "../../open-sse/utils/cursorPendingAgentSessions.js";

function mockSession() {
  return {
    end: vi.fn(),
    close: vi.fn(),
    write: vi.fn(),
    read: vi.fn(),
  };
}

function makeEntry(overrides = {}) {
  return {
    toolCallId: "call_1",
    execRequest: new Map(),
    session: mockSession(),
    pendingBytes: Buffer.alloc(0),
    clientTools: [],
    model: "claude-sonnet",
    credentials: {},
    ...overrides,
  };
}

describe("cursorPendingAgentSessions", () => {
  it("exports DEFAULT_PENDING_AGENT_TTL_MS as 5 minutes", () => {
    expect(DEFAULT_PENDING_AGENT_TTL_MS).toBe(5 * 60 * 1000);
  });

  describe("createPendingAgentSessionRegistry", () => {
    let now;
    let registry;

    beforeEach(() => {
      now = vi.fn(() => 1_000_000);
      registry = createPendingAgentSessionRegistry({ ttlMs: 60_000, now });
    });

    it("set/get round-trips an entry with timestamps", () => {
      const entry = makeEntry();
      registry.set("call_1", entry);
      const stored = registry.get("call_1");
      expect(stored).not.toBeNull();
      expect(stored.toolCallId).toBe("call_1");
      expect(stored.createdAt).toBe(1_000_000);
      expect(stored.expiresAt).toBe(1_060_000);
      expect(stored.session).toBe(entry.session);
    });

    it("get returns null for unknown toolCallId", () => {
      expect(registry.get("missing")).toBeNull();
    });

    it("take returns entry and removes it without closing session", () => {
      const entry = makeEntry();
      registry.set("call_1", entry);
      const taken = registry.take("call_1");
      expect(taken).not.toBeNull();
      expect(taken.session).toBe(entry.session);
      expect(entry.session.end).not.toHaveBeenCalled();
      expect(entry.session.close).not.toHaveBeenCalled();
      expect(registry.get("call_1")).toBeNull();
      expect(registry.take("call_1")).toBeNull();
    });

    it("delete closes session.end and session.close", () => {
      const entry = makeEntry();
      registry.set("call_1", entry);
      registry.delete("call_1");
      expect(entry.session.end).toHaveBeenCalledOnce();
      expect(entry.session.close).toHaveBeenCalledOnce();
      expect(registry.get("call_1")).toBeNull();
    });

    it("expired get deletes entry and closes session", () => {
      const entry = makeEntry();
      registry.set("call_1", entry);
      now.mockReturnValue(1_070_000);
      expect(registry.get("call_1")).toBeNull();
      expect(entry.session.end).toHaveBeenCalledOnce();
      expect(entry.session.close).toHaveBeenCalledOnce();
    });

    it("sweep removes expired entries and closes sessions", () => {
      const stale = makeEntry({ toolCallId: "call_stale" });
      registry.set("call_stale", stale);
      now.mockReturnValue(1_050_000);
      const fresh = makeEntry({ toolCallId: "call_fresh" });
      registry.set("call_fresh", fresh);
      now.mockReturnValue(1_070_000);
      expect(registry.sweep()).toBe(1);
      expect(registry.get("call_stale")).toBeNull();
      expect(registry.get("call_fresh")).not.toBeNull();
      expect(stale.session.end).toHaveBeenCalledOnce();
      expect(stale.session.close).toHaveBeenCalledOnce();
      expect(fresh.session.end).not.toHaveBeenCalled();
    });

    it("lazy-sweeps on set", () => {
      const stale = makeEntry();
      registry.set("call_stale", stale);
      now.mockReturnValue(1_070_000);
      registry.set("call_new", makeEntry({ toolCallId: "call_new" }));
      expect(registry.size()).toBe(1);
      expect(stale.session.close).toHaveBeenCalledOnce();
    });

    it("lazy-sweeps on take", () => {
      const stale = makeEntry();
      registry.set("call_stale", stale);
      now.mockReturnValue(1_070_000);
      registry.take("call_missing");
      expect(stale.session.close).toHaveBeenCalledOnce();
      expect(registry.size()).toBe(0);
    });

    it("replacing an entry closes the previous session", () => {
      const first = makeEntry();
      const second = makeEntry();
      registry.set("call_1", first);
      registry.set("call_1", second);
      expect(first.session.close).toHaveBeenCalledOnce();
      expect(registry.get("call_1").session).toBe(second.session);
    });

    it("size reflects live entries", () => {
      expect(registry.size()).toBe(0);
      registry.set("a", makeEntry({ toolCallId: "a" }));
      registry.set("b", makeEntry({ toolCallId: "b" }));
      expect(registry.size()).toBe(2);
      registry.take("a");
      expect(registry.size()).toBe(1);
    });
  });

  describe("getPendingAgentSessionRegistry", () => {
    beforeEach(() => {
      resetPendingAgentSessionRegistryForTests();
    });

    it("returns the same singleton instance", () => {
      const a = getPendingAgentSessionRegistry();
      const b = getPendingAgentSessionRegistry();
      expect(a).toBe(b);
    });
  });
});
