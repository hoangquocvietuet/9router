// Helpers for Claude SSE streaming termination
import { formatSSE } from "./streamHelpers.js";
import { FORMATS } from "../translator/formats.js";
import { CLAUDE_STOP } from "../translator/schema/finishReasons.js";

const sharedEncoder = new TextEncoder();

// Encoded terminal SSE for a Claude-target stream that aborted/stalled/closed
// before emitting a valid message_stop. Emits a Claude `error` event (so the
// client knows the response was truncated), then a protocol-valid
// message_delta + message_stop to close the stream cleanly. Without this, such
// a stream closes as a silent empty/incomplete HTTP 200.
export function buildAbortedClaudeTerminalBytes() {
  return sharedEncoder.encode(buildAbortedClaudeTerminal());
}

export function buildAbortedClaudeTerminal() {
  // Standalone Claude error event — the Messages streaming API's documented
  // channel for surfacing a mid-stream failure to the client.
  const errorEvent = formatSSE({
    type: "error",
    error: {
      type: "overloaded_error",
      message: "stream closed before completion (upstream truncated)",
    },
  }, FORMATS.CLAUDE);

  // stop_reason must be one of Anthropic's valid values; "error" is NOT valid,
  // so use end_turn to keep the terminal sequence well-formed for strict clients.
  const messageDelta = formatSSE({
    type: "message_delta",
    delta: {
      stop_reason: CLAUDE_STOP.END_TURN,
      stop_sequence: null,
    },
    usage: { input_tokens: 0, output_tokens: 0 },
  }, FORMATS.CLAUDE);

  const messageStop = formatSSE({
    type: "message_stop",
  }, FORMATS.CLAUDE);

  return errorEvent + messageDelta + messageStop;
}