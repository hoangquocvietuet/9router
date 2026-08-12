export const DEFAULT_PENDING_AGENT_TTL_MS = 5 * 60 * 1000;

/** @type {ReturnType<typeof createPendingAgentSessionRegistry> | null} */
let singleton = null;

/**
 * @typedef {object} PendingAgentSession
 * @property {string} toolCallId
 * @property {Map} execRequest
 * @property {object} session
 * @property {Buffer} pendingBytes
 * @property {object[]} clientTools
 * @property {string} model
 * @property {object} credentials
 * @property {number} createdAt
 * @property {number} expiresAt
 * @property {AbortController} [requestController]
 */

/**
 * @param {{ ttlMs?: number, now?: () => number }} [options]
 */
export function createPendingAgentSessionRegistry({
  ttlMs = DEFAULT_PENDING_AGENT_TTL_MS,
  now = Date.now,
} = {}) {
  /** @type {Map<string, PendingAgentSession>} */
  const entries = new Map();

  function closeSession(entry) {
    const session = entry?.session;
    if (!session) return;
    try {
      session.end?.();
    } catch {
      // ignore close errors
    }
    try {
      session.close?.();
    } catch {
      // ignore close errors
    }
  }

  function isExpired(entry) {
    return entry.expiresAt <= now();
  }

  function removeEntry(toolCallId, { close = true } = {}) {
    const entry = entries.get(toolCallId);
    if (!entry) return false;
    entries.delete(toolCallId);
    if (close) closeSession(entry);
    return true;
  }

  function sweep() {
    let removed = 0;
    for (const [toolCallId, entry] of entries) {
      if (isExpired(entry)) {
        removeEntry(toolCallId);
        removed++;
      }
    }
    return removed;
  }

  function lazySweep() {
    sweep();
  }

  return {
    set(toolCallId, entry) {
      lazySweep();
      if (entries.has(toolCallId)) {
        removeEntry(toolCallId);
      }
      const createdAt = now();
      /** @type {PendingAgentSession} */
      const stored = {
        ...entry,
        toolCallId,
        createdAt,
        expiresAt: createdAt + ttlMs,
      };
      entries.set(toolCallId, stored);
    },

    get(toolCallId) {
      lazySweep();
      const entry = entries.get(toolCallId);
      if (!entry) return null;
      if (isExpired(entry)) {
        removeEntry(toolCallId);
        return null;
      }
      return entry;
    },

    take(toolCallId) {
      const entry = this.get(toolCallId);
      if (!entry) return null;
      entries.delete(toolCallId);
      return entry;
    },

    delete(toolCallId) {
      return removeEntry(toolCallId);
    },

    sweep,

    size() {
      return entries.size;
    },
  };
}

export function getPendingAgentSessionRegistry() {
  if (!singleton) {
    singleton = createPendingAgentSessionRegistry();
  }
  return singleton;
}

/** @internal test-only */
export function resetPendingAgentSessionRegistryForTests() {
  singleton = null;
}
