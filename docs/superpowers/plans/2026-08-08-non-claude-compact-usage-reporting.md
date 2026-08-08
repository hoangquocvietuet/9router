# Non-Claude models: report true accumulated context usage so the client auto-compacts — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every `X→claude` response path advertise a truthful, nonzero `message_start.usage.input_tokens` so Claude Code's context bar climbs and its native `/compact` fires around 400k for non-Claude models (deepseek, kimi, glm, mimo, codex-responses, kiro) exactly as it does for Claude models.

**Architecture:** Claude Code reads its context-bar % (and compaction trigger) from `usage.input_tokens` in the `message_start` SSE event only — it ignores the later `message_delta` usage. Upstream OpenAI-format providers send `usage: null` until the final chunk, so today the bar sits at 0 and compaction never fires. Fix: a shared `estimateMessageStartInputTokens(state)` helper (real upstream usage wins; else `estimateUsage(state.body, 0, FORMATS.CLAUDE)` → `chars/4` over the whole translated body, which grows monotonically with history). Used by both OpenAI-format (`openai-to-claude.js`, already shipped in commit `650073b` but never deployed) and kiro (`kiro-to-claude.js`, hardcodes 0 today). Claude-format passthrough (qwen3.7/minimax via `/messages`) already reports real usage and stays untouched. Client-side compaction is triggered by the client env settings (400k for Claude Code); 9Router owns no threshold.

**Tech Stack:** Node ESM, Vitest (`tests/` independent package), Next.js server (deploy = rebuild + restart).

## Global Constraints

- Context: `/root/9router-src`, branch `feat/per-model-thinking-combos`, working tree has an unrelated dirty snapshot file — do not touch it.
- NEVER edit/rewrite files through Bash (no heredocs, no `tee`, no `sed`/`awk`). Use Read/Edit/Write tools only.
- ESM imports everywhere (`import { X } from "../../utils/usageTracking.js"`).
- The shared helper MUST NOT be inside a `register(...)` call or any translator file — it lives in `open-sse/utils/usageTracking.js`.
- Do NOT touch `open-sse/translator/response/claude-to-openai.js` (out of scope) or the Claude native passthrough flow.
- Tests run from `tests/`: `cd tests && npx vitest run` (root deps must be installed first; tests have their own `package.json`).
- Commit messages follow conventional style used in this repo (`feat:`, `docs:`, `test:`).
- Spec: `docs/superpowers/specs/2026-08-08-non-claude-compact-usage-reporting-design.md` (gitignored dir — commit with `git add -f`).

---

### Task 1: Extract shared message_start-input-tokens helper and use it in kiro

**Files:**
- Modify: `open-sse/utils/usageTracking.js` (append export near `estimateUsage`, after line 399)
- Modify: `open-sse/translator/response/kiro-to-claude.js` (imports at lines 16-17; message_start at lines 88-100)
- Modify: `open-sse/translator/response/openai-to-claude.js` (lines 6-27: delete local `messageStartInputTokens`, import helper)
- Test: `tests/unit/kiro-to-claude-usage.test.js` (create)

**Interfaces:**
- Consumes: `estimateUsage(body, contentLength, targetFormat)` from `../../utils/usageTracking.js` (already exists, `open-sse/utils/usageTracking.js:393`), `FORMATS.CLAUDE` from `../formats.js`.
- Produces: `estimateMessageStartInputTokens(state)` exported from `open-sse/utils/usageTracking.js`. Returns `number` (integer): real `state.usage.input_tokens` when `state.usage?.input_tokens > 0`, else `Math.ceil(chars/4)` over `JSON.stringify(state.body)` when `state.body` exists, else `0`.

- [ ] **Step 1: Write the failing test**

Create `tests/unit/kiro-to-claude-usage.test.js`:

```js
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /root/9router-src/tests && npx vitest run unit/kiro-to-claude-usage.test.js`
Expected: FAIL — `input_tokens` is `0`, not the `estimateUsage` value.

- [ ] **Step 3: Add the shared helper to usageTracking.js**

In `open-sse/utils/usageTracking.js`, after the `estimateUsage` function (line 399), add:

```js
/**
 * Input-token count to advertise in message_start for X→claude response paths.
 * Claude Code reads its context-bar % from message_start.usage.input_tokens and
 * does NOT update it from the later message_delta. OpenAI-format upstreams only
 * send real usage with the final chunk, so message_start would otherwise carry 0
 * and the bar would sit at 0% (no client-side auto-compaction). Real usage from a
 * usage-bearing first chunk wins; otherwise estimate from the request body
 * (chars/4, monotonic with history). Cost tracking is unaffected: message_delta
 * still carries the real usage.
 * @param {object} state - Stream translator state (must expose .body and optionally .usage)
 * @returns {number} input_tokens to advertise
 */
export function estimateMessageStartInputTokens(state) {
  if (state?.usage && typeof state.usage.input_tokens === "number" && state.usage.input_tokens > 0) {
    return state.usage.input_tokens;
  }
  if (state?.body) {
    const estimated = estimateUsage(state.body, 0, FORMATS.CLAUDE);
    if (estimated && typeof estimated.input_tokens === "number" && estimated.input_tokens > 0) {
      return estimated.input_tokens;
    }
  }
  return 0;
}
```

`FORMATS` is already imported in `usageTracking.js` (used by `formatUsage`/`estimateUsage`). Verify with `grep -n "import.*FORMATS" open-sse/utils/usageTracking.js` — if missing, add `import { FORMATS } from "../translator/formats.js";`.

- [ ] **Step 4: Use the helper in kiro-to-claude.js**

In `open-sse/translator/response/kiro-to-claude.js`, after line 17 add:

```js
import { estimateMessageStartInputTokens } from "../../utils/usageTracking.js";
```

Replace lines 88-100 (`results.push({ type: "message_start", ... })` block) so the `usage` field becomes:

```js
        usage: { input_tokens: estimateMessageStartInputTokens(state), output_tokens: 0 },
```

- [ ] **Step 5: Use the helper in openai-to-claude.js**

In `open-sse/translator/response/openai-to-claude.js`, change line 6 to:

```js
import { estimateMessageStartInputTokens } from "../../utils/usageTracking.js";
```

Delete the local `messageStartInputTokens` function (lines 8-27) and the now-unused `estimateUsage`/`FORMATS` import (line 6), then replace its call site (line ~154, `usage: { input_tokens: messageStartInputTokens(state), output_tokens: 0 }`) with:

```js
        usage: { input_tokens: estimateMessageStartInputTokens(state), output_tokens: 0 },
```

- [ ] **Step 6: Run all response-translator and usage tests**

Run: `cd /root/9router-src/tests && npx vitest run unit/openai-to-claude.test.js unit/kiro-to-claude-usage.test.js`
Expected: the estimation tests PASS; note the pre-existing failure "omits empty Read pages tool argument before emitting Claude input deltas" (in `openai-to-claude.test.js`) FAILS both before and after this change — it is a stale test from commit `a98a136` that predates the finish-chunk arg-flush design and never passed. Do NOT try to fix it in this task; flag it to the user.

- [ ] **Step 7: Commit**

```bash
cd /root/9router-src && git add -A open-sse tests/unit/kiro-to-claude-usage.test.js && git commit -m "fix: report estimated input_tokens in message_start for kiro→claude; share helper with openai→claude"
```

---

### Task 2: Regression test — Claude-format passthrough preserves upstream input_tokens

**Files:**
- Test: `tests/unit/opencode-go-passthrough-usage.test.js` (create)

**Interfaces:**
- Consumes: nothing new — verifies existing passthrough behavior is NOT regressed (upstream `/messages`-format usage reaches the client unchanged).

- [ ] **Step 1: Write the test**

Create `tests/unit/opencode-go-passthrough-usage.test.js`:

```js
import { describe, expect, it } from "vitest";
import { claudeToClaudeResponse } from "../../open-sse/translator/response/claude-to-claude.js";

// The Claude-format upstream (opencode.ai/zen/go/v1/messages for qwen3.7/minimax)
// sends real usage in message_start. The passthrough must NOT zero it out.
describe("claude-format passthrough preserves upstream message_start usage", () => {
  it("passes message_start through with upstream input_tokens intact", () => {
    const chunk = {
      type: "message_start",
      message: {
        id: "msg_test",
        type: "message",
        role: "assistant",
        model: "qwen3.7-plus",
        content: [],
        usage: { input_tokens: 3006, output_tokens: 0 },
      },
    };
    const out = claudeToClaudeResponse(chunk, {});
    const ms = out.find((e) => e.type === "message_start");
    expect(ms.message.usage.input_tokens).toBe(3006);
  });
});
```

- [ ] **Step 2: Verify the passthrough file exists with the expected export**

Run: `ls /root/9router-src/open-sse/translator/response/claude-to-claude.js && grep -n "export function claudeToClaudeResponse" /root/9router-src/open-sse/translator/response/claude-to-claude.js`
Expected: file exists and exports `claudeToClaudeResponse`. (If the function name differs, adjust the import in the test to the actual export name and still assert `input_tokens` passes through unchanged.)

- [ ] **Step 3: Run test**

Run: `cd /root/9router-src/tests && npx vitest run unit/opencode-go-passthrough-usage.test.js`
Expected: PASS.

- [ ] **Step 4: Run the full response-translator suite**

Run: `cd /root/9router-src/tests && npx vitest run unit`
Expected: all PASS (no regressions in existing translator tests).

- [ ] **Step 5: Commit**

```bash
cd /root/9router-src && git add -A tests && git commit -m "test: claude-format passthrough preserves upstream input_tokens in message_start"
```

---

### Task 3: Verify locally with a long conversation through the router

**Files:** none (verification only)

**Interfaces:**
- Consumes: Tasks 1-2 code (running server build).
- Produces: verified evidence for the deploy (context bar climbs on non-Claude turns; no `Range of input length should be [1, 983616]` 400s; `/compact` fires).

- [ ] **Step 1: Rebuild and restart the router with the new code**

Run from `/root/9router-src`:
```bash
npm run build && PORT=20128 HOSTNAME=0.0.0.0 npm run start
```
(Reuse the exact env the running instance uses — `PORT=20128` per `restart.log`; adjust if the current process shows different env.) Confirm the server comes up: `curl -s http://localhost:20128/api/health` or the dashboard loads.

- [ ] **Step 2: Drive a multi-turn conversation against a combo**

Send a sequence of POST requests to `http://localhost:20128/v1/messages` (or the endpoint the client uses) with a combo containing both `ocg/deepseek-v4-flash` and `ocg/qwen3.7-plus(medium)` (e.g. `master-lite`), growing the history each turn (append a few KB of text per turn; 30+ turns or enough to reach ~400k estimated input). For each turn capture:
- the `message_start` SSE event → `usage.input_tokens` (must be nonzero and monotonically climbing across turns),
- the eventual turn outcome (200 vs 400).

- [ ] **Step 3: Confirm the fixes hold**

Expected: `message_start.usage.input_tokens` is nonzero and monotonically increasing across both deepseek and qwen turns; no turn returns the 400 `InternalError.Algo.InvalidParameter: Range of input length should be [1, 983616]`.

- [ ] **Step 4: Report evidence to the user**

Summarize: bar-climb values across turns, absence of the 400, and confirm the client-side `/compact` at 400k can now engage (client threshold is env-owned; if you can run one real Claude Code session on the combo, confirm `/compact` triggers around 400k).

- [ ] **Step 5: Commit any verification notes (optional)**

If you changed nothing, skip. No commit needed.

---

### Task 4: Deploy

**Files:** none (ops)

**Interfaces:**
- Consumes: all prior tasks verified.
- Produces: production server running the fixed build.

- [ ] **Step 1: Deploy the build**

Replicate the production startup exactly as the running instance does (check `ps` for the exact `node ... next-server` command and env, e.g. `PORT=20128 HOSTNAME=0.0.0.0`). Stop the old process, start the new build, confirm startup logs match `🚀 9router v0.5.50` style output and health check passes.

- [ ] **Step 2: Confirm the fix is live**

Run: `grep -c "range of input length" /root/9router-src/.next/server/chunks/*.js` — expect ≥1 hit (the errorConfig rule) AND confirm the new usage helper string is present in the compiled chunks (`grep -rn "estimateMessageStartInputTokens" /root/9router-src/.next/server/chunks/ | head -3`). Then run one real request through the combo to confirm `message_start.usage.input_tokens` is nonzero.

- [ ] **Step 3: Report deploy status**

State plainly: deployed version, evidence of the fix live, and what to watch (context bar climbing on non-Claude turns; `/compact` engaging ~400k).
