// Stream handler with disconnect detection - shared for all providers
import { STREAM_STALL_TIMEOUT_MS } from "../config/runtimeConfig.js";
import { dbg, isDebugEnabled } from "./debugLog.js";

// Get HH:MM:SS timestamp
function getTimeString() {
  return new Date().toLocaleTimeString("en-US", { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

/**
 * Create stream controller with abort and disconnect detection
 * @param {object} options
 * @param {function} options.onDisconnect - Callback when client disconnects
 * @param {object} options.log - Logger instance
 * @param {string} options.provider - Provider name
 * @param {string} options.model - Model name
 */
export function createStreamController({ onDisconnect, onError, log, provider, model, reqTag = "" } = {}) {
  const abortController = new AbortController();
  const startTime = Date.now();
  let disconnected = false;
  let abortTimeout = null;

  // Only abnormal terminations are logged; normal completion is covered by "📊 done".
  // isError uses errorLine (always shown, ignores LOG_LEVEL) so failures survive quiet levels.
  const logStream = (symbol, status, isError = false) => {
    const duration = Date.now() - startTime;
    const emit = isError ? log?.errorLine : log?.line;
    if (emit) emit(reqTag, symbol, `${status} · ${provider}/${model} · ${duration}ms`);
    else console.log(`[${getTimeString()}] ${symbol} ${provider}/${model} · ${status} · ${duration}ms`);
  };

  return {
    signal: abortController.signal,
    startTime,

    isConnected: () => !disconnected,

    // Call when client disconnects
    handleDisconnect: (reason = "client_closed") => {
      if (disconnected) return;
      disconnected = true;

      logStream("⚡", `DISCONNECT: ${reason}`);
      dbg("CTRL", `${provider}/${model} | disconnect=${reason} | dur=${Date.now() - startTime}ms`);

      // Delay abort to allow cleanup
      abortTimeout = setTimeout(() => {
        abortController.abort();
      }, 500);

      onDisconnect?.({ reason, duration: Date.now() - startTime });
    },

    // Call when stream completes normally (no line here — "📊 done" is authoritative)
    handleComplete: () => {
      if (disconnected) return;
      disconnected = true;

      if (abortTimeout) {
        clearTimeout(abortTimeout);
        abortTimeout = null;
      }
    },

    // Call on error
    handleError: (error) => {
      if (disconnected) return;
      disconnected = true;

      if (abortTimeout) {
        clearTimeout(abortTimeout);
        abortTimeout = null;
      }

      if (error.name === "AbortError") {
        logStream("⚡", "ABORTED");
        return;
      }

      logStream("✗", `ERROR: ${error.message}${error.stack ? `\n    ${error.stack}` : ""}`, true);
      onError?.(error);
    },

    abort: () => abortController.abort()
  };
}

/**
 * Create transform stream with disconnect detection
 * Wraps existing transform stream and adds abort capability.
 *
 * Stall detection lives in pipeWithDisconnect (tied to upstream byte
 * activity), not here — output of the transform stream may be silent
 * for long periods while raw bytes still flow (e.g. Kiro EventStream
 * binary frames buffering, Claude reasoning streams).
 */
// Real terminal markers for the two current onAbortTerminal consumers: Claude
// translation ends in "message_stop"; Responses passthrough/translation ends
// in the "[DONE]" sentinel. A response.completed/failed event alone is not
// sufficient here: preserving the existing Responses abort behavior requires
// synthesizing its trailing [DONE] when that sentinel never arrives. Detected
// as raw substrings (not JSON-parsed) since this layer only sees encoded SSE
// bytes; each is written by stream.js as a single enqueue per event, so a
// marker is never split across the chunks read here.
const STREAM_TERMINAL_MARKERS = ["event: message_stop", "data: [DONE]"];

export function createDisconnectAwareStream(transformStream, streamController, onAbortTerminal = null, pipeStats = null, streamMeta = null) {
  const reader = transformStream.readable.getReader();
  const writer = transformStream.writable.getWriter();
  let terminalEmitted = false;
  let emittedChunks = 0; // translated SSE chunks forwarded to the client
  let sawRealTerminal = false;
  const terminalDecoder = onAbortTerminal ? new TextDecoder("utf-8", { fatal: false }) : null;

  // Emit a synthesized terminal payload (e.g. Responses response.failed + [DONE],
  // or a Claude error message_delta + message_stop) once.
  const emitTerminal = (controller, reason) => {
    if (terminalEmitted || !onAbortTerminal) return;
    terminalEmitted = true;
    if (pipeStats) {
      pipeStats.terminalEmitted = true;
      pipeStats.terminalSynthesized = true;
    }
    try {
      const bytes = onAbortTerminal();
      if (bytes) controller.enqueue(bytes);
    } catch { /* best-effort terminal */ }
    console.warn(
      `[STREAM] synthesized terminal | reason=${reason} | provider=${streamMeta?.provider || "unknown"} | model=${streamMeta?.model || "unknown"} | request=${streamMeta?.requestTag || "unknown"} | chunks=${pipeStats?.upstreamChunks || 0} bytes=${pipeStats?.upstreamBytes || 0} events=${pipeStats?.emittedChunks || 0}`
    );
  };

  return new ReadableStream({
    async pull(controller) {
      if (!streamController.isConnected()) {
        if (!sawRealTerminal) emitTerminal(controller, "disconnect");
        controller.close();
        return;
      }

      try {
        const { done, value } = await reader.read();

        if (done) {
          // Clean upstream EOF without a real terminal event is the silent
          // empty/truncated-200 case: either nothing valid reached the client,
          // or the stream stopped partway (e.g. after message_start but before
          // message_stop). Synthesize a terminal so the client sees a real
          // end-of-stream (or error) instead of an empty/incomplete body
          // committed as HTTP 200.
          if (!sawRealTerminal) emitTerminal(controller, "eof");
          streamController.handleComplete();
          controller.close();
          return;
        }
        emittedChunks++;
        if (pipeStats) pipeStats.emittedChunks = emittedChunks;
        if (terminalDecoder && !sawRealTerminal) {
          const text = terminalDecoder.decode(value, { stream: true });
          if (STREAM_TERMINAL_MARKERS.some(marker => text.includes(marker))) {
            sawRealTerminal = true;
            if (pipeStats) pipeStats.terminalEmitted = true;
          }
        }
        controller.enqueue(value);
      } catch (error) {
        const wasConnected = streamController.isConnected();
        // Controller already closed = downstream ended; not an upstream error, skip noisy log.
        const msg0 = error?.message || "";
        const isControllerClosed = msg0.includes("already closed") || msg0.includes("Invalid state");
        if (!isControllerClosed) streamController.handleError(error);
        reader.cancel().catch(() => {});
        writer.abort().catch(() => {});

        // Treat network resets / socket hang up / abort as graceful close
        const msg = error?.message || "";
        const code = error?.code || error?.cause?.code || "";
        const isNetworkClose =
          error.name === "AbortError" ||
          msg.includes("aborted") ||
          msg.includes("socket hang up") ||
          msg.includes("ECONNRESET") ||
          msg.includes("ETIMEDOUT") ||
          msg.includes("EPIPE") ||
          code === "ECONNRESET" ||
          code === "ETIMEDOUT" ||
          code === "EPIPE" ||
          code === "UND_ERR_SOCKET";

        // Graceful close on network/abort, or when a structured terminal is available
        // (Responses passthrough prefers response.failed + [DONE] over a raw transport error;
        //  Claude-target translation prefers error-shaped message_delta + message_stop.)
        try {
          if (!wasConnected || isNetworkClose || onAbortTerminal) {
            if (!sawRealTerminal) emitTerminal(controller, "error");
            controller.close();
          } else {
            controller.error(error);
          }
        } catch (e) { /* already closed or cancelled */ }
      }
    },

    cancel(reason) {
      streamController.handleDisconnect(reason || "cancelled");
      reader.cancel();
      writer.abort();
    }
  });
}

/**
 * Pipe provider response through transform with disconnect detection.
 *
 * Stall watchdog tracks raw upstream byte activity, not transform output.
 * Reasoning models (Claude thinking via Kiro, etc.) can produce zero SSE
 * output for long stretches while partial EventStream frames keep arriving.
 * Measuring stall on the transform output caused false stalls and the
 * "failed to pipe response" error in Next.
 *
 * Any upstream chunk resets the timer. If no bytes arrive for
 * STREAM_STALL_TIMEOUT_MS, abort the underlying fetch via the controller.
 *
 * @param {Response} providerResponse - Response from provider
 * @param {TransformStream} transformStream - Transform stream for SSE
 * @param {object} streamController - Stream controller from createStreamController
 */
export function pipeWithDisconnect(providerResponse, transformStream, streamController, onAbortTerminal = null, stallTimeoutMs = STREAM_STALL_TIMEOUT_MS, streamMeta = null) {
  let stallTimer = null;
  let chunkCount = 0;
  let totalBytes = 0;
  let lastChunkAt = Date.now();
  const t0 = Date.now();
  const tag = "STREAM";
  // Shared with createDisconnectAwareStream so the DONE/error line can report
  // translated-event count + whether a terminal was synthesized. Missing TTFT +
  // zero translated events is the fingerprint of a truncated/empty-200 stream.
  const pipeStats = { upstreamChunks: 0, upstreamBytes: 0, emittedChunks: 0, terminalEmitted: false, terminalSynthesized: false };
  const streamSummary = () =>
    `chunks=${chunkCount} bytes=${totalBytes} events=${pipeStats.emittedChunks} terminal=${pipeStats.terminalEmitted} terminalSynth=${pipeStats.terminalSynthesized} dur=${Date.now() - t0}ms`;
  const clearStall = () => {
    if (stallTimer) { clearTimeout(stallTimer); stallTimer = null; }
  };
  const armStall = () => {
    clearStall();
    stallTimer = setTimeout(() => {
      stallTimer = null;
      dbg(tag, `STALL TIMEOUT ${stallTimeoutMs}ms | chunks=${chunkCount} | bytes=${totalBytes} | sinceLast=${Date.now() - lastChunkAt}ms`);
      streamController.handleError?.(new Error("stream stall timeout"));
      streamController.abort?.();
    }, stallTimeoutMs);
  };

  // Wrap controller so every termination path clears the stall timer.
  // Without this, abort/cancel/downstream-error paths leave the timer armed
  // and a stale abort could fire after the request has already ended.
  const wrappedController = {
    signal: streamController.signal,
    startTime: streamController.startTime,
    isConnected: () => streamController.isConnected(),
    handleComplete: () => { dbg(tag, `complete | ${streamSummary()}`); clearStall(); streamController.handleComplete(); },
    handleError: (e) => { dbg(tag, `error: ${e?.message} | ${streamSummary()}`); clearStall(); streamController.handleError(e); },
    handleDisconnect: (r) => { dbg(tag, `disconnect: ${r} | ${streamSummary()}`); clearStall(); streamController.handleDisconnect(r); },
    abort: () => { clearStall(); streamController.abort(); }
  };

  armStall();
  dbg(tag, `pipe start | stallTimeout=${stallTimeoutMs}ms`);

  const upstreamTap = new TransformStream({
    transform(chunk, controller) {
      chunkCount++;
      const sz = chunk?.byteLength || chunk?.length || 0;
      totalBytes += sz;
      pipeStats.upstreamChunks = chunkCount;
      pipeStats.upstreamBytes = totalBytes;
      const now = Date.now();
      const gap = now - lastChunkAt;
      lastChunkAt = now;
      if (isDebugEnabled && (chunkCount <= 5 || chunkCount % 20 === 0 || gap > 5000)) {
        dbg(tag, `chunk #${chunkCount} | size=${sz}B | gap=${gap}ms | total=${totalBytes}B`);
      }
      armStall();
      controller.enqueue(chunk);
    },
    flush() { dbg(tag, `upstream EOF | chunks=${chunkCount} | bytes=${totalBytes} | dur=${Date.now() - t0}ms`); clearStall(); }
  });

  const transformedBody = providerResponse.body
    .pipeThrough(upstreamTap)
    .pipeThrough(transformStream);

  return createDisconnectAwareStream(
    { readable: transformedBody, writable: { getWriter: () => ({ abort: () => Promise.resolve() }) } },
    wrappedController,
    onAbortTerminal,
    pipeStats,
    streamMeta
  );
}

