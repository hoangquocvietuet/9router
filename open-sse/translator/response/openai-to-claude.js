import { register } from "../index.js";
import { FORMATS } from "../formats.js";
import { ROLE, CLAUDE_BLOCK, MODEL_FALLBACK, OPENAI_FINISH, CLAUDE_STOP } from "../schema/index.js";
import { fromOpenAIFinish } from "../concerns/finishReason.js";
import { extractReasoningText } from "../concerns/reasoning.js";
import { estimateMessageStartInputTokens } from "../../utils/usageTracking.js";

// Legacy "proxy_" prefix used by older request translators. Response strips it
// defensively so tool names from such turns resolve back (e.g. proxy_Read → Read
// for arg sanitization). Current request translator emits no prefix ("") — strip
// is then a no-op. Kept intentionally; do NOT couple to request's empty prefix.
const CLAUDE_OAUTH_TOOL_PREFIX = "proxy_";

// Sanitize tool call arguments to fix bad params from non-Anthropic models
function sanitizeToolArgs(toolName, argsJson) {
  try {
    const args = JSON.parse(argsJson);
    const name = toolName.startsWith(CLAUDE_OAUTH_TOOL_PREFIX)
      ? toolName.slice(CLAUDE_OAUTH_TOOL_PREFIX.length)
      : toolName;
    if (name === "Read") sanitizeReadArgs(args);
    return JSON.stringify(args);
  } catch {
    return argsJson;
  }
}

function sanitizeReadArgs(args) {
  if (typeof args.limit === "string" && /^\d+$/.test(args.limit)) args.limit = Number(args.limit);
  if (typeof args.offset === "string" && /^-?\d+$/.test(args.offset)) args.offset = Number(args.offset);

  if (typeof args.limit === "number") {
    if (args.limit > 2000) args.limit = 2000;
    if (args.limit < 1) delete args.limit;
  }
  if (typeof args.offset === "number" && args.offset < 0) args.offset = 0;

  if ("pages" in args && !isValidPdfPagesArg(args.file_path, args.pages)) {
    delete args.pages;
  }
}

function isValidPdfPagesArg(filePath, pages) {
  return typeof filePath === "string" &&
    filePath.toLowerCase().endsWith(".pdf") &&
    typeof pages === "string" &&
    /^\d+(?:-\d+)?$/.test(pages);
}

// Helper: stop thinking block if started
function stopThinkingBlock(state, results) {
  if (!state.thinkingBlockStarted) return;
  results.push({
    type: "content_block_stop",
    index: state.thinkingBlockIndex
  });
  state.thinkingBlockStarted = false;
}

// Helper: stop text block if started
function stopTextBlock(state, results) {
  if (!state.textBlockStarted || state.textBlockClosed) return;
  state.textBlockClosed = true;
  results.push({
    type: "content_block_stop",
    index: state.textBlockIndex
  });
  state.textBlockStarted = false;
}

// Helper: close every open tool_use block, flushing its buffered + sanitized
// arguments as a single input_json_delta first (mirrors what the request stream
// buffers per idx). Shared by the finish path and the defensive flush so a
// stream that closes without finish_reason does not drop tool arguments and
// emit a tool_use block with empty input.
function stopToolBlocks(state, results) {
  for (const [idx, toolInfo] of state.toolCalls) {
    const buffered = state.toolArgBuffers?.get(idx);
    if (buffered) {
      results.push({
        type: "content_block_delta",
        index: toolInfo.blockIndex,
        delta: { type: "input_json_delta", partial_json: sanitizeToolArgs(toolInfo.name, buffered) }
      });
    }
    results.push({
      type: "content_block_stop",
      index: toolInfo.blockIndex
    });
  }
}

// Normalize whatever shape state.usage currently holds into Claude usage.
// Two writers populate state.usage: openaiToClaudeResponse (Claude-shaped, from
// a chunk that has choices[0]) and stream.js's extractUsage/mergeUsage
// (OpenAI-shaped, from a usage-only choices:[] trailing chunk that returns early
// here). At flush the OpenAI-shaped variant can be the live value, so a raw
// pass-through would emit prompt_tokens/completion_tokens that filterUsageForFormat
// then strips to {}. Convert defensively.
function toClaudeUsage(u) {
  if (!u || typeof u !== "object") return { input_tokens: 0, output_tokens: 0 };
  // Already Claude-shaped.
  if (typeof u.input_tokens === "number" || typeof u.output_tokens === "number") {
    const out = { input_tokens: u.input_tokens || 0, output_tokens: u.output_tokens || 0 };
    if (u.cache_read_input_tokens) out.cache_read_input_tokens = u.cache_read_input_tokens;
    if (u.cache_creation_input_tokens) out.cache_creation_input_tokens = u.cache_creation_input_tokens;
    return out;
  }
  // OpenAI-shaped → convert (mirrors the extraction at the top of openaiToClaudeResponse).
  const prompt = typeof u.prompt_tokens === "number" ? u.prompt_tokens : 0;
  const cacheRead = u.prompt_tokens_details?.cached_tokens || 0;
  const cacheCreate = u.prompt_tokens_details?.cache_creation_tokens || 0;
  const out = { input_tokens: prompt - cacheRead - cacheCreate, output_tokens: u.completion_tokens || 0 };
  if (cacheRead) out.cache_read_input_tokens = cacheRead;
  if (cacheCreate) out.cache_creation_input_tokens = cacheCreate;
  return out;
}

// Convert OpenAI stream chunk to Claude format
export function openaiToClaudeResponse(chunk, state) {
  // chunk === null/undefined is the flush signal from stream.js (upstream EOF).
  if (chunk == null) return openaiToClaudeFlush(state);
  // Usage-only trailing chunk (choices:[]). stream.js already captured its usage
  // via extractUsage before translating; nothing to emit here.
  if (!chunk.choices?.[0]) return null;

  const results = [];
  const choice = chunk.choices[0];
  const delta = choice.delta;

  // Track usage from OpenAI chunk if available
  if (chunk.usage && typeof chunk.usage === "object") {
    const promptTokens = typeof chunk.usage.prompt_tokens === "number" ? chunk.usage.prompt_tokens : 0;
    const outputTokens = typeof chunk.usage.completion_tokens === "number" ? chunk.usage.completion_tokens : 0;

    // Extract cache tokens from prompt_tokens_details
    const cachedTokens = chunk.usage.prompt_tokens_details?.cached_tokens;
    const cacheCreationTokens = chunk.usage.prompt_tokens_details?.cache_creation_tokens;
    const cacheReadTokens = typeof cachedTokens === "number" ? cachedTokens : 0;
    const cacheCreateTokens = typeof cacheCreationTokens === "number" ? cacheCreationTokens : 0;

    // input_tokens = prompt_tokens - cached_tokens - cache_creation_tokens
    // Because OpenAI's prompt_tokens includes all prompt-side tokens
    const inputTokens = promptTokens - cacheReadTokens - cacheCreateTokens;

    state.usage = {
      input_tokens: inputTokens,
      output_tokens: outputTokens
    };

    // Add cache_read_input_tokens if present
    if (cacheReadTokens > 0) {
      state.usage.cache_read_input_tokens = cacheReadTokens;
    }

    // Add cache_creation_input_tokens if present
    if (cacheCreateTokens > 0) {
      state.usage.cache_creation_input_tokens = cacheCreateTokens;
    }

    // Note: completion_tokens_details.reasoning_tokens is already included in output_tokens
    // No need to add separately as Claude expects total output_tokens
  }

  // First chunk - ALWAYS send message_start first
  if (!state.messageStartSent) {
    state.messageStartSent = true;
    state.messageId = chunk.id?.replace("chatcmpl-", "") || `msg_${Date.now()}`;
    if (!state.messageId || state.messageId === "chat" || state.messageId.length < 8) {
      state.messageId = chunk.extend_fields?.requestId ||
        chunk.extend_fields?.traceId ||
        `msg_${Date.now()}`;
    }
    state.model = chunk.model || MODEL_FALLBACK;
    state.nextBlockIndex = 0;
    results.push({
      type: "message_start",
      message: {
        id: state.messageId,
        type: "message",
        role: ROLE.ASSISTANT,
        model: state.model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: estimateMessageStartInputTokens(state), output_tokens: 0 }
      }
    });
  }

  // Handle reasoning (thinking) across vendor shapes - GLM/DeepSeek/Qwen/MiniMax/etc.
  const reasoningContent = extractReasoningText(delta);
  if (reasoningContent) {
    stopTextBlock(state, results);

    if (!state.thinkingBlockStarted) {
      state.thinkingBlockIndex = state.nextBlockIndex++;
      state.thinkingBlockStarted = true;
      results.push({
        type: "content_block_start",
        index: state.thinkingBlockIndex,
        content_block: { type: CLAUDE_BLOCK.THINKING, thinking: "" }
      });
    }

    results.push({
      type: "content_block_delta",
      index: state.thinkingBlockIndex,
      delta: { type: "thinking_delta", thinking: reasoningContent }
    });
  }

  // Handle regular content
  if (delta?.content) {
    stopThinkingBlock(state, results);

    if (!state.textBlockStarted) {
      state.textBlockIndex = state.nextBlockIndex++;
      state.textBlockStarted = true;
      state.textBlockClosed = false;
      results.push({
        type: "content_block_start",
        index: state.textBlockIndex,
        content_block: { type: CLAUDE_BLOCK.TEXT, text: "" }
      });
    }

    results.push({
      type: "content_block_delta",
      index: state.textBlockIndex,
      delta: { type: "text_delta", text: delta.content }
    });
  }

  // Tool calls
  if (delta?.tool_calls) {
    for (const tc of delta.tool_calls) {
      const idx = tc.index ?? 0;

      // GLM/fireworks repeats id+null-name on every arg chunk; open block once per idx
      if (tc.id && !state.toolCalls.has(idx)) {
        stopThinkingBlock(state, results);
        stopTextBlock(state, results);

        const toolBlockIndex = state.nextBlockIndex++;
        state.toolCalls.set(idx, { id: tc.id, name: tc.function?.name || "", blockIndex: toolBlockIndex });

        // Strip prefix from tool name for response
        let toolName = tc.function?.name || "";
        if (toolName.startsWith(CLAUDE_OAUTH_TOOL_PREFIX)) {
          toolName = toolName.slice(CLAUDE_OAUTH_TOOL_PREFIX.length);
        }

        results.push({
          type: "content_block_start",
          index: toolBlockIndex,
          content_block: {
            type: CLAUDE_BLOCK.TOOL_USE,
            id: tc.id,
            name: toolName,
            input: {}
          }
        });
      }

      if (tc.function?.arguments) {
        const toolInfo = state.toolCalls.get(idx);
        if (toolInfo) {
          // Buffer args instead of streaming — sanitize at finish to fix bad params
          if (!state.toolArgBuffers) state.toolArgBuffers = new Map();
          state.toolArgBuffers.set(idx, (state.toolArgBuffers.get(idx) || "") + tc.function.arguments);
        }
      }
    }
  }

  // Finish
  if (choice.finish_reason) {
    stopThinkingBlock(state, results);
    stopTextBlock(state, results);
    stopToolBlocks(state, results);

    // Mark finish for later usage injection in stream.js
    state.finishReason = choice.finish_reason;

    // Use tracked usage (will be estimated in stream.js if not valid).
    // Normalize to Claude shape — state.usage may have been written by
    // stream.js's extractUsage from a usage-only trailing chunk (OpenAI-shaped)
    // and never converted by the top-of-function code path that only runs for
    // chunks with choices[0].
    const finalUsage = toClaudeUsage(state.usage);
    results.push({
      type: "message_delta",
      delta: { stop_reason: convertFinishReason(choice.finish_reason) },
      usage: finalUsage
    });
    results.push({ type: "message_stop" });
  }

  return results.length > 0 ? results : null;
}

// Defensive flush: emit message_stop when the upstream stream ended cleanly
// (chunk=null, flush call) but never sent a finish_reason.
//
// Some providers (e.g. opencode-go/gpt-5.6-luna) close their SSE stream after
// content and usage-only chunks without emitting a finish_reason or [DONE].
// Without this, the translator emits no message_stop → sawRealTerminal stays
// false → createDisconnectAwareStream synthesize an error terminal, and the
// client sees "API Error: Server error mid-response" despite a complete response.
//
// Guard: only fire when message_start was sent (stream actually started).
// A stream that received no content at all (messageStartSent=false) gets no
// defensive terminal — the upstream-level synthesized terminal handles that.
export function openaiToClaudeFlush(state) {
  if (state.finishReason || !state.messageStartSent) return null;

  const results = [];
  stopThinkingBlock(state, results);
  stopTextBlock(state, results);
  stopToolBlocks(state, results);

  state.finishReason = OPENAI_FINISH.STOP;
  results.push({
    type: "message_delta",
    delta: { stop_reason: CLAUDE_STOP.END_TURN },
    usage: toClaudeUsage(state.usage),
  });
  results.push({ type: "message_stop" });
  return results.length > 0 ? results : null;
}

const convertFinishReason = (reason) => fromOpenAIFinish(reason, "claude");

// Register
register(FORMATS.OPENAI, FORMATS.CLAUDE, null, openaiToClaudeResponse);
