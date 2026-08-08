# Non-Claude models: report true accumulated context usage so the client auto-compacts

_Date: 2026-08-08 · Status: approved by user_

## Problem

With Claude models, Claude Code auto-compacts the conversation around 400k tokens (threshold from the client's env settings). Non-Claude models in the combos never trigger compaction and instead grow until they hit the hard context ceiling:

- `ocg/qwen3.7-plus(medium)` fails with `400 InternalError.Algo.InvalidParameter: Range of input length should be [1, 983616]` once the input exceeds ~983,616 tokens.
- The same prompt succeeds on `ocg/deepseek-v4-flash` because its effective window has more headroom.

## Root cause

Claude Code reads its context-bar % (and therefore its compaction trigger) from `usage.input_tokens` in the `message_start` SSE event of each response. 9Router only reports that value truthfully for two of its paths:

| Response path | Models | `message_start` `input_tokens` today |
|---|---|---|
| Claude native passthrough | cc/claude-opus-4-8 | real upstream usage | ✅ correct |
| Claude-format upstream (`/messages`) | ocg/qwen3.7*, ocg/minimax-* | upstream sends it; passthrough preserves it | ✅ correct |
| OpenAI-format upstream (`/chat/completions`) | ocg/deepseek*, ocg/kimi*, ocg/glm*, ocg/mimo* | `0` — upstream sends `usage: null` until the final chunk | ❌ broken |
| OpenAI-Responses | codex/gpt-5.6-sol | pivots through `openai→claude` | ❌ broken (same as above) |
| Kiro-format | kiro models (not in user combos) | hardcoded `0` at `kiro-to-claude.js:98` | ❌ broken |

Because deepseek answers most turns (first combo member), the bar resets to ~0 after every turn, never crosses 400k, and the conversation grows until a turn lands on qwen past its ceiling.

Commit `650073b` (HEAD, 2026-08-08 04:23) already fixes the main path: `openai-to-claude.js` estimates `input_tokens` for `message_start` from the request body (`state.body`, `estimateUsage`). The running production build predates it (built 04:21:56, started 04:22:36), so it is not deployed yet.

## Design

Direction chosen by the user: **the client auto-compacts (native `/compact`), 9Router only needs to report accumulated context usage truthfully for every non-Claude path.** This gives full parity with the Claude path — same 400k threshold, real summaries — with no server-side summarization.

### 1. Deploy `650073b`

Rebuild (`npm run build`) and restart the server so the existing `openai→claude` estimation ships. This alone fixes the deepseek/kimi/glm/mimo and codex-response paths (groups 3 and 4 above).

### 2. Share the message_start-input-tokens logic

Move `messageStartInputTokens(state)` out of `openai-to-claude.js` into a shared helper in `open-sse/utils/usageTracking.js` (e.g. `estimateMessageStartInputTokens(state)`), and use it in `kiro-to-claude.js` (currently hardcodes `0` at line 98). Rule: real upstream usage wins when present; otherwise estimate from `state.body`. This guarantees no `X→claude` path can emit `input_tokens: 0` in the future.

### 3. Leave Claude-format passthrough untouched

qwen/minimax via `/messages` already report real input_tokens (verified live: 3006 for a ~12k-char prompt). The native passthrough flow must keep sending upstream usage. Add a regression test asserting passthrough does not zero out `input_tokens`.

### 4. Estimation accuracy

Keep `chars/4` over the full request body (`estimateInputTokens` in `usageTracking.js:338`). The estimate is monotonic in history length and slightly biased high (JSON overhead), so the client compacts slightly before the true 400k — safe. Headroom is ample: client threshold 400k vs qwen hard ceiling ~983k (~2.4x), which absorbs worst-case CJK/Vietnamese content skew.

### 5. Verification

- Build and run a long multi-turn conversation through the router to a combo, confirm the context bar climbs consistently across both deepseek and qwen turns.
- Confirm native `/compact` triggers around 400k.
- Confirm no further `Range of input length should be [1, 983616]` 400s.

## Scope

- Code touched: `open-sse/utils/usageTracking.js` (new shared helper), `open-sse/translator/response/openai-to-claude.js` (use shared helper), `open-sse/translator/response/kiro-to-claude.js` (use shared helper), tests.
- Out of scope: server-side auto-compaction (rejected), 9router-side context threshold config (client owns the threshold), kiro not in the user's combos (covered incidentally by the shared helper, no extra behavior).

## Testing

- Existing tests in `tests/unit/openai-to-claude.test.js` continue to pass (estimation covered there).
- New unit test for `kiro-to-claude` message_start with `state.body` and no usage → nonzero `input_tokens`.
- New regression test for Claude-format passthrough preserving upstream `input_tokens`.
- Run `cd tests && npx vitest run` for the touched files.
