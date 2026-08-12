import { BaseExecutor } from "./base.js";
import { PROVIDERS, PROVIDER_OAUTH } from "../config/providers.js";
import { HTTP_STATUS, CURSOR_AGENT_IDLE_TIMEOUT_MS, CURSOR_AGENT_EXEC_TAIL_IDLE_MS, CURSOR_AGENT_MAX_TURN_MS } from "../config/runtimeConfig.js";
import {
  generateCursorBody,
  encodeField,
  wrapConnectRPCFrame,
  decodeMessage,
  parseConnectRPCFrame,
  extractTextFromResponse,
  encodeMcpResultSuccess,
  decodeMcpArgs,
} from "../utils/cursorProtobuf.js";
import { buildCursorHeaders } from "../utils/cursorChecksum.js";
import { estimateUsage } from "../utils/usageTracking.js";
import { SSE_DONE, SSE_HEADERS } from "../utils/sseConstants.js";
import { chatChunkSse, sseChunk } from "../utils/sse.js";
import { FORMATS } from "../translator/formats.js";
import { extractTextContent } from "../translator/formats/gemini.js";
import { CLAUDE_BLOCK } from "../translator/schema/blocks.js";
import { proxyAwareFetch } from "../utils/proxyFetch.js";
import zlib from "zlib";
import crypto from "crypto";

// Detect cloud environment
const isCloudEnv = () => {
  if (typeof caches !== "undefined" && typeof caches === "object") return true;
  if (typeof EdgeRuntime !== "undefined") return true;
  return false;
};

// Lazy import http2 (only in Node.js environment)
let http2 = null;
if (!isCloudEnv()) {
  try {
    http2 = await import("http2");
  } catch {
    // http2 not available
  }
}

const COMPRESS_FLAG = {
  NONE: 0x00,
  GZIP: 0x01,
  TRAILER: 0x02,
  GZIP_TRAILER: 0x03
};

const AGENT_RUN_PATH = "/agent.v1.AgentService/Run";
const PROTOBUF_LEN = 2;
const PROTOBUF_VARINT = 0;
const GATEWAY_TOOL_ERROR = "Tool execution is not supported through the 9router gateway. Use the available-tools list and tool history text in the conversation.";
const NORMALIZABLE_CONTENT_TYPES = new Set([
  CLAUDE_BLOCK.TEXT,
  CLAUDE_BLOCK.TOOL_USE,
  CLAUDE_BLOCK.TOOL_RESULT,
  CLAUDE_BLOCK.THINKING,
  CLAUDE_BLOCK.REDACTED_THINKING,
  "text",
  "tool_use",
  "tool_result",
  "thinking",
  "redacted_thinking",
]);

function concatBuffers(...parts) {
  const length = parts.reduce((total, part) => total + part.length, 0);
  const result = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}

const agentString = (field, value) => encodeField(field, PROTOBUF_LEN, value);
const agentMessage = (field, value) => encodeField(field, PROTOBUF_LEN, value);
const agentBool = (field, value) => encodeField(field, PROTOBUF_VARINT, value ? 1 : 0);

function textFromContent(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part) => part?.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n");
}

export function isAgentCapableRequest(body) {
  // Cursor AgentService requests are normalized to plain text in-place (tools/MCP
  // stripped). Non-text modalities still use legacy ChatService paths.
  return Array.isArray(body?.messages) && body.messages.length > 0 && body.messages.every((message) => {
    if (!message || typeof message !== "object") return false;
    const content = message.content;
    if (typeof content === "string") return true;
    if (Array.isArray(content)) {
      return content.every((part) => part?.type && NORMALIZABLE_CONTENT_TYPES.has(part.type));
    }
    if (content === null || content === undefined) return true;
    return false;
  });
}

// Back-compat alias kept for callers that still reference the old name.
export const isAgentTextRequest = isAgentCapableRequest;

function toolDisplayName(name) {
  if (!name || typeof name !== "string") return "unknown";
  if (name.startsWith("mcp__")) return name.split("__").filter(Boolean).join("/");
  return name;
}

function formatToolArgs(args) {
  if (typeof args === "string") return args;
  if (args && typeof args === "object") return JSON.stringify(args);
  return "{}";
}

function extractToolResultContent(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((part) => part?.type === CLAUDE_BLOCK.TEXT || part?.type === "text")
      .map((part) => part.text || "")
      .join("\n") || extractTextContent(content) || JSON.stringify(content);
  }
  if (content && typeof content === "object") return JSON.stringify(content);
  return String(content ?? "");
}

function formatToolCallsUsed(toolCalls) {
  return toolCalls.map((call) => {
    const name = toolDisplayName(call?.function?.name || call?.name);
    const args = formatToolArgs(call?.function?.arguments ?? call?.arguments ?? call?.input);
    const id = call?.id || call?.tool_call_id;
    return id ? `${name}(${args}) [${id}]` : `${name}(${args})`;
  }).join(", ");
}

function formatAvailableToolsText(tools) {
  if (!tools?.length) return "";
  const parts = tools.map((tool) => {
    const name = toolDisplayName(tool?.function?.name || tool?.name);
    const desc = tool?.function?.description || tool?.description;
    return desc ? `${name} — ${desc}` : name;
  });
  return `Available tools:\n${parts.join("\n")}`;
}

function appendTextToLastUserMessage(messages, extraText) {
  if (!extraText) return messages;
  const result = messages.map((message) => ({ ...message }));
  for (let i = result.length - 1; i >= 0; i--) {
    if (result[i].role === "user") {
      const existing = textFromContent(result[i].content);
      result[i] = {
        role: "user",
        content: existing ? `${existing}\n\n${extraText}` : extraText,
      };
      return result;
    }
  }
  result.push({ role: "user", content: extraText });
  return result;
}

function flattenContentBlocks(message) {
  const out = [];
  const role = message.role === "assistant" ? "assistant" : "user";
  const textParts = [];
  const toolUses = [];
  const toolResults = [];

  for (const block of message.content) {
    if (!block || typeof block !== "object") continue;
    if (block.type === CLAUDE_BLOCK.TEXT || block.type === "text") {
      if (block.text) textParts.push(block.text);
      continue;
    }
    if (block.type === CLAUDE_BLOCK.TOOL_USE || block.type === "tool_use") {
      toolUses.push(block);
      continue;
    }
    if (block.type === CLAUDE_BLOCK.TOOL_RESULT || block.type === "tool_result") {
      toolResults.push(block);
    }
    // thinking / redacted_thinking: omit from upstream Cursor payload
  }

  for (const block of toolResults) {
    out.push({
      role: "user",
      content: `User has used this tool (${block.tool_use_id || "unknown"}): ${extractToolResultContent(block.content)}`,
    });
  }

  if (toolUses.length) {
    const used = toolUses.map((block) => {
      const name = toolDisplayName(block.name);
      const args = formatToolArgs(block.input);
      const id = block.id;
      return id ? `${name}(${args}) [${id}]` : `${name}(${args})`;
    }).join(", ");
    const base = textParts.join("\n");
    out.push({
      role: "assistant",
      content: base
        ? `${base}\n\nUser has used these tools: ${used}`
        : `User has used these tools: ${used}`,
    });
    return out;
  }

  if (textParts.length) {
    out.push({ role, content: textParts.join("\n") });
  }
  return out;
}

function normalizeAgentMessages(messages, tools) {
  const normalized = [];

  for (const message of messages) {
    if (!message || typeof message !== "object") continue;

    if (message.role === "tool" || message.role === "function") {
      normalized.push({
        role: "user",
        content: `User has used this tool${message.tool_call_id ? ` (${message.tool_call_id})` : ""}: ${extractToolResultContent(message.content)}`,
      });
      continue;
    }

    if (message.role === "assistant" && Array.isArray(message.tool_results) && message.tool_results.length) {
      for (const result of message.tool_results) {
        normalized.push({
          role: "user",
          content: `User has used this tool (${result?.tool_call_id || "unknown"}): ${extractToolResultContent(result?.result_content ?? result?.content)}`,
        });
      }
      const base = textFromContent(message.content);
      if (base) normalized.push({ role: "assistant", content: base });
      continue;
    }

    if (message.role === "assistant" && Array.isArray(message.tool_calls) && message.tool_calls.length) {
      const base = textFromContent(message.content);
      const used = formatToolCallsUsed(message.tool_calls);
      normalized.push({
        role: "assistant",
        content: base
          ? `${base}\n\nUser has used these tools: ${used}`
          : `User has used these tools: ${used}`,
      });
      continue;
    }

    if (Array.isArray(message.content) && message.content.some((part) =>
      part?.type === CLAUDE_BLOCK.TOOL_USE
      || part?.type === CLAUDE_BLOCK.TOOL_RESULT
      || part?.type === "tool_use"
      || part?.type === "tool_result"
    )) {
      normalized.push(...flattenContentBlocks(message));
      continue;
    }

    if (message.role === "assistant" || message.role === "user" || message.role === "system") {
      const { tool_calls, tool_call_id, tool_results, ...rest } = message;
      if (Array.isArray(rest.content)) {
        const text = rest.content
          .filter((part) => part?.type === CLAUDE_BLOCK.TEXT || part?.type === "text")
          .map((part) => part.text || "")
          .join("\n");
        normalized.push({ ...rest, content: text });
      } else {
        normalized.push(rest);
      }
      continue;
    }

    normalized.push({ role: "user", content: textFromContent(message.content) || "" });
  }

  const declaration = formatAvailableToolsText(tools);
  return declaration ? appendTextToLastUserMessage(normalized, declaration) : normalized;
}

export function normalizeAgentServiceRequest(body) {
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  const tools = body?.tools || body?.functions || [];
  const messagesWithTools = normalizeAgentMessages(messages, tools);

  const {
    tools: _tools,
    functions: _functions,
    tool_choice: _toolChoice,
    parallel_tool_calls: _parallel,
    ...rest
  } = body || {};

  return {
    ...rest,
    messages: messagesWithTools,
    tools: [],
  };
}

/** True when the client sent tool declarations or tool-turn history (Claude Code / paseo). */
export function bodyHasToolSignals(body) {
  if (!body || typeof body !== "object") return false;
  if (Array.isArray(body.tools) && body.tools.length > 0) return true;
  if (Array.isArray(body.functions) && body.functions.length > 0) return true;
  if (!Array.isArray(body.messages)) return false;
  return body.messages.some((message) => {
    if (!message || typeof message !== "object") return false;
    if (message.role === "tool" || message.role === "function") return true;
    if (Array.isArray(message.tool_calls) && message.tool_calls.length > 0) return true;
    if (Array.isArray(message.tool_results) && message.tool_results.length > 0) return true;
    if (!Array.isArray(message.content)) return false;
    return message.content.some((part) =>
      part?.type === CLAUDE_BLOCK.TOOL_USE
      || part?.type === CLAUDE_BLOCK.TOOL_RESULT
      || part?.type === "tool_use"
      || part?.type === "tool_result"
    );
  });
}

/**
 * Cursor-only gateway shim: Claude Code / OpenAI clients keep their native tool
 * shapes on the wire to 9router; this converts tool/MCP history and declarations
 * to plain text before the Cursor upstream call and never emits mcp_tools on AgentService.
 */
export function prepareCursorGatewayRequest(body) {
  if (!bodyHasToolSignals(body)) return body;
  return normalizeAgentServiceRequest(body);
}

export function shouldUseCursorAgentService(body) {
  return isAgentCapableRequest(body);
}

/** Idle window before ending an AgentService turn when upstream stops sending frames. */
export function agentTurnIdleThresholdMs({ hadText, execStubs }) {
  if (hadText && execStubs > 0) return CURSOR_AGENT_EXEC_TAIL_IDLE_MS;
  return CURSOR_AGENT_IDLE_TIMEOUT_MS;
}

function writeGatewayMcpToolReply(session, mcpArgs, toolName) {
  const reply = encodeMcpResultSuccess({
    textItems: [GATEWAY_TOOL_ERROR],
    isError: true,
  });
  const execClientMessage = concatBuffers(
    agentMessage(2, reply),
    mcpArgs?.toolCallId ? agentString(3, mcpArgs.toolCallId) : new Uint8Array(),
  );
  session.write(wrapConnectRPCFrame(agentMessage(2, execClientMessage)));
  debugLog(`[CURSOR AGENT] Stubbed MCP/IDE tool ${toolName || mcpArgs?.toolName || mcpArgs?.name || "unknown"}`);
}

async function readAgentSessionChunk(session, idleMs, deadlineMs) {
  const remaining = deadlineMs - Date.now();
  if (remaining <= 0) return { idle: true };
  const waitMs = Math.min(idleMs, remaining);
  return await Promise.race([
    session.read(),
    new Promise((resolve) => setTimeout(() => resolve({ idle: true }), waitMs)),
  ]);
}

function writeGatewayExecStubReply(session, execRequest) {
  let toolCallId = "";
  for (const values of execRequest.values()) {
    for (const entry of values) {
      try {
        const nested = decodeMessage(entry.value);
        toolCallId = extractAgentString(nested, 3) || extractAgentString(nested, 35) || toolCallId;
      } catch {
        /* non-message payload */
      }
    }
  }
  const mcpArgs = toolCallId ? { toolCallId } : null;
  writeGatewayMcpToolReply(session, mcpArgs, "ide_tool");
}

function encodeHistoryMessage(message) {
  const content = textFromContent(message?.content);
  if (!content) return null;

  // ConversationHistoryMessage.user / .assistant -> repeated content -> text.
  const text = agentString(1, content);
  if (message.role === "assistant" || message.role === "tool") {
    return agentMessage(2, agentMessage(1, agentMessage(1, text)));
  }
  return agentMessage(1, agentMessage(1, agentMessage(1, text)));
}

export function buildAgentRunFrame(messages, model) {
  const system = messages
    .filter((message) => message?.role === "system")
    .map((message) => textFromContent(message.content))
    .filter(Boolean)
    .join("\n\n");
  const chatMessages = messages.filter((message) => message?.role !== "system");
  const currentIndex = [...chatMessages].map((message) => message?.role).lastIndexOf("user");
  const current = currentIndex >= 0 ? chatMessages[currentIndex] : chatMessages.at(-1);
  const history = chatMessages
    .slice(0, currentIndex >= 0 ? currentIndex : -1)
    .map(encodeHistoryMessage)
    .filter(Boolean);
  const userText = textFromContent(current?.content) || "Continue.";

  // agent.v1.UserMessageAction.user_message and its optional history.
  const userMessage = concatBuffers(
    agentString(1, userText),
    agentString(2, crypto.randomUUID()),
  );
  const conversationHistory = history.length
    ? concatBuffers(...history.map((entry) => agentMessage(1, entry)))
    : null;
  const userAction = concatBuffers(
    agentMessage(1, userMessage),
    ...(conversationHistory ? [agentMessage(7, conversationHistory)] : []),
  );
  const conversationAction = agentMessage(1, userAction);
  const requestedModel = concatBuffers(agentString(1, model), agentBool(7, true));
  const runRequest = concatBuffers(
    // An empty ConversationStateStructure starts a fresh local agent session.
    agentMessage(1, new Uint8Array()),
    agentMessage(2, conversationAction),
    ...(system ? [agentString(8, system)] : []),
    agentMessage(9, requestedModel),
  );

  // agent.v1.AgentClientMessage.run_request.
  return wrapConnectRPCFrame(agentMessage(1, runRequest));
}

function extractAgentString(message, field) {
  const value = message?.get(field)?.[0]?.value;
  return value ? Buffer.from(value).toString("utf8") : "";
}

function decodeAgentFrames(buffer, onFrame) {
  let pending = Buffer.from(buffer || []);
  while (pending.length >= 5) {
    const flags = pending[0];
    const length = pending.readUInt32BE(1);
    if (pending.length < 5 + length) break;
    let payload = pending.subarray(5, 5 + length);
    pending = pending.subarray(5 + length);
    if (flags & COMPRESS_FLAG.GZIP) {
      payload = zlib.gunzipSync(payload);
    }
    if (!(flags & COMPRESS_FLAG.TRAILER)) onFrame(payload);
  }
  return pending;
}

function createRequestContextResponse() {
  // AgentService asks every run for client context. 9router has no IDE file
  // context, so acknowledge with an empty RequestContext.
  const requestContextSuccess = agentMessage(1, new Uint8Array());
  const requestContextResult = agentMessage(1, requestContextSuccess);
  const execClientMessage = agentMessage(10, requestContextResult);
  return wrapConnectRPCFrame(agentMessage(2, execClientMessage));
}

const CURSOR_STREAM_DEBUG = process.env.CURSOR_STREAM_DEBUG === "1";
const debugLog = (...args) => {
  if (CURSOR_STREAM_DEBUG) console.log(...args);
};

function isComposerModel(model) {
  const modelId = String(model || "").split("/").pop();
  return /^composer(?:-|$)/i.test(modelId);
}

function visibleComposerContentFromThinking(thinking) {
  if (!thinking) return "";
  const endTag = "</think>";
  const endIdx = thinking.lastIndexOf(endTag);
  if (endIdx < 0) return "";
  return thinking.slice(endIdx + endTag.length).trimStart();
}

function decompressPayload(payload, flags) {
  // Check if payload is JSON error (starts with {"error")
  if (payload.length > 10 && payload[0] === 0x7b && payload[1] === 0x22) {
    try {
      const text = payload.toString("utf-8");
      if (text.startsWith('{"error"')) {
        debugLog(`[DECOMPRESS] Detected JSON error, skipping decompression`);
        return payload;
      }
    } catch {}
  }

  if (
    flags === COMPRESS_FLAG.GZIP ||
    flags === COMPRESS_FLAG.TRAILER ||
    flags === COMPRESS_FLAG.GZIP_TRAILER
  ) {
    // Primary: try gzip decompression (standard gzip header 0x1f 0x8b)
    try {
      return zlib.gunzipSync(payload);
    } catch (gzipErr) {
      // Fallback: TRAILER and GZIP_TRAILER frames sometimes use raw zlib deflate format
      try {
        return zlib.inflateSync(payload);
      } catch (deflateErr) {
        // Last resort: try raw deflate (no zlib header)
        try {
          return zlib.inflateRawSync(payload);
        } catch (rawErr) {
          debugLog(
            `[DECOMPRESS ERROR] flags=${flags}, payloadSize=${payload.length}, gzip=${gzipErr.message}, deflate=${deflateErr.message}, raw=${rawErr.message}`
          );
          debugLog(
            `[DECOMPRESS ERROR] First 50 bytes (hex):`,
            payload.slice(0, 50).toString("hex")
          );
          return payload;
        }
      }
    }
  }
  return payload;
}

// Read one cursor protobuf frame: header + bounds + decompress. Returns status + payload + new offset.
function readCursorFrame(buffer, offset, frameNum, tag) {
  if (offset + 5 > buffer.length) {
    debugLog(`[CURSOR BUFFER${tag}] Reached end, offset=${offset}, remaining=${buffer.length - offset}`);
    return { status: "done" };
  }

  const flags = buffer[offset];
  const length = buffer.readUInt32BE(offset + 1);
  debugLog(`[CURSOR BUFFER${tag}] Frame ${frameNum + 1}: flags=0x${flags.toString(16).padStart(2, "0")}, length=${length}`);

  if (offset + 5 + length > buffer.length) {
    debugLog(`[CURSOR BUFFER${tag}] Incomplete frame, offset=${offset}, length=${length}, buffer.length=${buffer.length}`);
    return { status: "done" };
  }

  let payload = buffer.slice(offset + 5, offset + 5 + length);
  const newOffset = offset + 5 + length;
  payload = decompressPayload(payload, flags);
  if (!payload) {
    debugLog(`[CURSOR BUFFER${tag}] Frame ${frameNum + 1}: decompression failed, skipping`);
    return { status: "skip", offset: newOffset };
  }
  return { status: "ok", payload, offset: newOffset };
}

function createErrorResponse(jsonError) {
  const errorMsg = jsonError?.error?.details?.[0]?.debug?.details?.title
    || jsonError?.error?.details?.[0]?.debug?.details?.detail
    || jsonError?.error?.message
    || "API Error";
  
  const isRateLimit = jsonError?.error?.code === "resource_exhausted";
  
  return new Response(JSON.stringify({
    error: {
      message: errorMsg,
      type: isRateLimit ? "rate_limit_error" : "api_error",
      code: jsonError?.error?.details?.[0]?.debug?.error || "unknown"
    }
  }), {
    status: isRateLimit ? HTTP_STATUS.RATE_LIMITED : HTTP_STATUS.BAD_REQUEST,
    headers: { "Content-Type": "application/json" }
  });
}

export class CursorExecutor extends BaseExecutor {
  constructor() {
    super("cursor", PROVIDERS.cursor);
  }

  buildUrl() {
    return `${this.config.baseUrl}${this.config.chatPath}`;
  }

  buildHeaders(credentials) {
    const accessToken = credentials.accessToken;
    const machineId = credentials.providerSpecificData?.machineId;
    const ghostMode = credentials.providerSpecificData?.ghostMode !== false;

    if (!machineId) {
      throw new Error("Machine ID is required for Cursor API");
    }

    return buildCursorHeaders(accessToken, machineId, ghostMode);
  }

  transformRequest(model, body, stream, credentials) {
    // Messages are already translated by chatCore (claude→openai→cursor)
    // Do NOT call openaiToCursorRequest again — double-translation drops tool_results
    const messages = body.messages || [];
    const tools = body.tools || [];
    const reasoningEffort = body.reasoning_effort || null;
    // Detect Claude Code UA to force Agent mode (issue #643)
    const ua = credentials?.rawHeaders?.["user-agent"] || "";
    const forceAgentMode = ua.includes("claude-cli") || ua.includes("claude-code") || ua.includes("Claude Code");
    return generateCursorBody(messages, model, tools, reasoningEffort, forceAgentMode);
  }

  async makeFetchRequest(url, headers, body, signal, proxyOptions = null) {
    const response = await proxyAwareFetch(url, {
      method: "POST",
      headers,
      body,
      signal
    }, proxyOptions);

    return {
      status: response.status,
      headers: Object.fromEntries(response.headers.entries()),
      body: Buffer.from(await response.arrayBuffer())
    };
  }

  makeHttp2Request(url, headers, body, signal) {
    if (!http2) {
      throw new Error("http2 module not available");
    }

    const HTTP2_TIMEOUT_MS = 60000; // 60s max — prevent hung sessions

    return new Promise((resolve, reject) => {
      const urlObj = new URL(url);
      const client = http2.connect(`https://${urlObj.host}`);
      const chunks = [];
      let responseHeaders = {};
      let settled = false;

      // Ensure client is always closed on settle
      const finish = (fn) => (...args) => {
        if (settled) return;
        settled = true;
        clearTimeout(hangTimeout);
        client.close();
        fn(...args);
      };

      // Hard timeout: close session if server never responds
      const hangTimeout = setTimeout(finish(() => {
        reject(new Error("HTTP/2 request timed out"));
      }), HTTP2_TIMEOUT_MS);

      client.on("error", finish(reject));

      const req = client.request({
        ":method": "POST",
        ":path": urlObj.pathname,
        ":authority": urlObj.host,
        ":scheme": "https",
        ...headers
      });

      req.on("response", (hdrs) => { responseHeaders = hdrs; });
      req.on("data", (chunk) => { chunks.push(chunk); });
      req.on("end", finish(() => {
        resolve({
          status: responseHeaders[":status"],
          headers: responseHeaders,
          body: Buffer.concat(chunks)
        });
      }));
      req.on("error", finish(reject));

      if (signal) {
        const onAbort = finish(() => reject(new Error("Request aborted")));
        signal.addEventListener("abort", onAbort, { once: true });
      }

      req.write(body);
      req.end();
    });
  }

  /**
   * AgentService (agent.api5.cursor.sh) is HTTP/2-only. Node's fetch/undici speaks
   * HTTP/1.1 and fails with HTTPParserError on the h2 preface — use http2 duplex.
   */
  openAgentHttp2Stream(url, headers, signal) {
    if (!http2) {
      throw new Error("HTTP/2 is required for Cursor AgentService (endpoint is h2-only)");
    }

    const urlObj = new URL(url);
    const client = http2.connect(`https://${urlObj.host}`);
    const chunkQueue = [];
    let waiting = null;
    let ended = false;
    let streamError = null;
    let req = null;

    const wake = (result) => {
      if (!waiting) return;
      const resolve = waiting;
      waiting = null;
      resolve(result);
    };

    const fail = (error) => {
      if (streamError) return;
      streamError = error;
      ended = true;
      wake(null);
    };

    const close = () => {
      try { req?.destroy(); } catch {}
      try { client.close(); } catch {}
    };

    client.on("error", fail);

    req = client.request({
      ":method": "POST",
      ":path": urlObj.pathname,
      ":authority": urlObj.host,
      ":scheme": "https",
      ...headers,
    });

    req.on("error", fail);
    req.on("data", (chunk) => {
      if (waiting) wake({ value: chunk, done: false });
      else chunkQueue.push(chunk);
    });
    req.on("end", () => {
      ended = true;
      wake({ value: undefined, done: true });
    });

    if (signal) {
      const onAbort = () => {
        fail(new Error("Request aborted"));
        close();
      };
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    }

    const responseHeaders = new Promise((resolve, reject) => {
      const onEarlyError = (error) => reject(error);
      client.once("error", onEarlyError);
      req.once("error", onEarlyError);
      req.once("response", (hdrs) => {
        client.off("error", onEarlyError);
        req.off("error", onEarlyError);
        resolve(hdrs);
      });
    });

    return {
      responseHeaders,
      write(frame) {
        if (req && !req.destroyed) req.write(Buffer.from(frame));
      },
      end() {
        try { if (req && !req.destroyed) req.end(); } catch {}
      },
      close,
      async read() {
        if (chunkQueue.length) return { value: chunkQueue.shift(), done: false };
        if (ended) {
          if (streamError) throw streamError;
          return { value: undefined, done: true };
        }
        const result = await new Promise((resolve) => { waiting = resolve; });
        if (streamError) throw streamError;
        return result || { value: undefined, done: true };
      },
    };
  }

  async executeAgent({ model, body, stream, credentials, signal }) {
    const agentEndpoint = PROVIDER_OAUTH.cursor?.agentEndpoint;
    if (!agentEndpoint) throw new Error("Cursor AgentService endpoint is not configured");

    const url = `${agentEndpoint}${AGENT_RUN_PATH}`;
    const headers = this.buildHeaders(credentials);
    const requestController = new AbortController();
    if (signal?.addEventListener) {
      signal.addEventListener("abort", () => requestController.abort(signal.reason), { once: true });
    }

    const agentBody = normalizeAgentServiceRequest(body);

    let session;
    try {
      session = this.openAgentHttp2Stream(url, headers, requestController.signal);
      session.write(buildAgentRunFrame(agentBody.messages || [], model));
    } catch (error) {
      throw new Error(`Cursor AgentService request failed: ${error.message}`);
    }

    let responseHeaders;
    try {
      responseHeaders = await session.responseHeaders;
    } catch (error) {
      session.close();
      throw new Error(`Cursor AgentService request failed: ${error.message}`);
    }

    const status = Number(responseHeaders[":status"] || 0);
    if (status !== 200) {
      let errorText = "";
      try {
        while (true) {
          const { done, value } = await session.read();
          if (done) break;
          errorText += Buffer.from(value).toString("utf8");
        }
      } catch {}
      session.close();
      return {
        response: new Response(JSON.stringify({
          error: { message: `Cursor AgentService ${status}: ${errorText || "request failed"}`, type: "api_error" },
        }), { status: status || HTTP_STATUS.SERVER_ERROR, headers: { "Content-Type": "application/json" } }),
        url,
        headers,
        transformedBody: body,
        responseFormat: FORMATS.OPENAI,
      };
    }

    // The Claude SSE translator derives Anthropic's message ID by stripping
    // `chatcmpl-`. Keep the remaining ID in Anthropic's required `msg_` form
    // so strict clients such as Claude Code accept the completed stream.
    const responseId = `chatcmpl-msg_${Date.now()}`;
    const created = Math.floor(Date.now() / 1000);
    let pending = Buffer.alloc(0);
    let finished = false;

    const consume = async (onEvent) => {
      const turnStartedAt = Date.now();
      const turnDeadline = turnStartedAt + CURSOR_AGENT_MAX_TURN_MS;
      let hadText = false;
      let execStubs = 0;
      let lastFrameAt = turnStartedAt;

      const finishTurn = (reason) => {
        if (finished) return;
        debugLog(`[CURSOR AGENT] Ending turn (${reason}) text=${hadText} stubs=${execStubs}`);
        finished = true;
        onEvent({ type: "done" });
      };

      try {
        while (!finished) {
          const idleMs = agentTurnIdleThresholdMs({ hadText, execStubs });
          const readResult = await readAgentSessionChunk(
            session,
            idleMs,
            turnDeadline,
          );

          if (readResult.idle) {
            const sinceFrameMs = Date.now() - lastFrameAt;
            if ((hadText || execStubs > 0) && sinceFrameMs >= idleMs) {
              finishTurn(`idle ${sinceFrameMs}ms since last frame (threshold ${idleMs}ms)`);
              break;
            }
            if (Date.now() >= turnDeadline) {
              finishTurn("max turn time");
              break;
            }
            continue;
          }

          const { done, value } = readResult;
          if (done) break;
          lastFrameAt = Date.now();
          pending = Buffer.concat([pending, Buffer.from(value)]);
          pending = decodeAgentFrames(pending, (payload) => {
            // A single read can carry several frames; once the turn is over the
            // rest of the batch must not reach the already-closed controller.
            if (finished) return;
            const serverMessage = decodeMessage(payload);

            // agent.v1.AgentServerMessage.interaction_update
            if (serverMessage.has(1)) {
              const update = decodeMessage(serverMessage.get(1)[0].value);
              if (update.has(1)) {
                const textDelta = extractAgentString(decodeMessage(update.get(1)[0].value), 1);
                if (textDelta) {
                  hadText = true;
                  onEvent({ type: "text", value: textDelta });
                }
              }
              // Cursor's AgentService emits internal reasoning without the
              // cryptographic signature required by Anthropic thinking blocks.
              // Forwarding it makes strict Anthropic clients (Claude Code)
              // discard or wait on an otherwise complete response. Keep the
              // reasoning upstream-only and emit the normal answer text.
              if (update.has(14)) {
                finished = true;
                onEvent({ type: "done" });
              }
            }

            // AgentService requests IDE context before producing a response.
            // Return an empty context; 9router is not coupled to an editor.
            if (serverMessage.has(2)) {
              const execRequest = decodeMessage(serverMessage.get(2)[0].value);
              if (execRequest.has(10)) {
                session.write(createRequestContextResponse());
              } else if (execRequest.has(2)) {
                execStubs++;
                const argsBuffer = execRequest.get(2)[0]?.value || new Uint8Array();
                let mcpArgs;
                try { mcpArgs = decodeMcpArgs(argsBuffer); } catch { mcpArgs = null; }
                const toolName = mcpArgs?.toolName || mcpArgs?.name;
                writeGatewayMcpToolReply(session, mcpArgs, toolName);
              } else {
                execStubs++;
                debugLog(`[CURSOR AGENT] Stubbing unsupported exec request fields: ${[...execRequest.keys()].join(",")}`);
                writeGatewayExecStubReply(session, execRequest);
              }
            }
          });
        }
      } finally {
        try { session.end(); } catch {}
        try { session.close(); } catch {}
        if (!finished) onEvent({ type: "done" });
      }
    };

    if (stream === false) {
      let content = "";
      let reasoning = "";
      let agentError = null;
      await consume((event) => {
        if (event.type === "text") content += event.value;
        else if (event.type === "thinking") reasoning += event.value;
        else if (event.type === "error") agentError = event.value;
      });
      if (agentError) {
        return {
          response: new Response(JSON.stringify({ error: { message: agentError, type: "api_error" } }), {
            status: HTTP_STATUS.BAD_REQUEST,
            headers: { "Content-Type": "application/json" },
          }),
          url,
          headers,
          transformedBody: body,
          responseFormat: FORMATS.OPENAI,
        };
      }
      return {
        response: new Response(JSON.stringify({
          id: responseId,
          object: "chat.completion",
          created,
          model,
          choices: [{ index: 0, message: { role: "assistant", content: content || null, ...(reasoning ? { reasoning_content: reasoning } : {}) }, finish_reason: "stop" }],
          usage: estimateUsage(body, content.length, FORMATS.OPENAI),
        }), { headers: { "Content-Type": "application/json" } }),
        url,
        headers,
        transformedBody: body,
        responseFormat: FORMATS.OPENAI,
      };
    }

    const encoder = new TextEncoder();
    const responseStream = new ReadableStream({
      start(controller) {
        consume((event) => {
          if (event.type === "text") {
            controller.enqueue(encoder.encode(chatChunkSse({ id: responseId, created, model, delta: { content: event.value } })));
          } else if (event.type === "thinking") {
            controller.enqueue(encoder.encode(chatChunkSse({ id: responseId, created, model, delta: { reasoning_content: event.value } })));
          } else if (event.type === "error") {
            // An SSE error frame, not a content delta: a protocol failure must not
            // be rendered to the user as the assistant's reply, and downstream
            // usage tracking must not record the turn as a success.
            controller.enqueue(encoder.encode(sseChunk({ error: { message: event.value, type: "api_error" } })));
            controller.enqueue(encoder.encode(SSE_DONE));
            controller.close();
          } else if (event.type === "done") {
            controller.enqueue(encoder.encode(chatChunkSse({ id: responseId, created, model, delta: {}, finishReason: "stop" })));
            controller.enqueue(encoder.encode(SSE_DONE));
            controller.close();
          }
        }).catch((error) => controller.error(error));
      },
      cancel() {
        requestController.abort();
      },
    });

    return {
      response: new Response(responseStream, { headers: SSE_HEADERS }),
      url,
      headers,
      transformedBody: body,
      responseFormat: FORMATS.OPENAI,
    };
  }

  async execute({ model, body, stream, credentials, signal, log, proxyOptions = null }) {
    const gatewayBody = prepareCursorGatewayRequest(body);

    if (shouldUseCursorAgentService(body)) {
      try {
        return await this.executeAgent({ model, body: gatewayBody, stream, credentials, signal });
      } catch (error) {
        return {
          response: new Response(JSON.stringify({
            error: { message: error.message, type: "connection_error", code: "" },
          }), { status: HTTP_STATUS.SERVER_ERROR, headers: { "Content-Type": "application/json" } }),
          url: `${PROVIDER_OAUTH.cursor?.agentEndpoint || ""}${AGENT_RUN_PATH}`,
          headers: {},
          transformedBody: body,
        };
      }
    }

    const url = this.buildUrl();
    const headers = this.buildHeaders(credentials);
    const transformedBody = this.transformRequest(model, gatewayBody, stream, credentials);

    try {
      const shouldForceFetch = proxyOptions?.enabled === true || proxyOptions?.connectionProxyEnabled === true || !!proxyOptions?.vercelRelayUrl;
      const response = (http2 && !shouldForceFetch)
        ? await this.makeHttp2Request(url, headers, transformedBody, signal)
        : await this.makeFetchRequest(url, headers, transformedBody, signal, proxyOptions);

      if (response.status !== 200) {
        const errorText = response.body?.toString() || "Unknown error";
        const errorResponse = new Response(JSON.stringify({
          error: {
            message: `[${response.status}]: ${errorText}`,
            type: "invalid_request_error",
            code: ""
          }
        }), {
          status: response.status,
          headers: { "Content-Type": "application/json" }
        });
        return { response: errorResponse, url, headers, transformedBody: body };
      }

      const transformedResponse = stream !== false
        ? this.transformProtobufToSSE(response.body, model, body)
        : this.transformProtobufToJSON(response.body, model, body);

      return { response: transformedResponse, url, headers, transformedBody: body };
    } catch (error) {
      const errorResponse = new Response(JSON.stringify({
        error: {
          message: error.message,
          type: "connection_error",
          code: ""
        }
      }), {
        status: HTTP_STATUS.SERVER_ERROR,
        headers: { "Content-Type": "application/json" }
      });
      return { response: errorResponse, url, headers, transformedBody: body };
    }
  }

  transformProtobufToJSON(buffer, model, body) {
    const responseId = `chatcmpl-cursor-${Date.now()}`;
    const created = Math.floor(Date.now() / 1000);

    let offset = 0;
    let totalContent = "";
    let totalThinking = "";
    const toolCalls = [];
    const toolCallsMap = new Map(); // Track streaming tool calls by ID
    const finalizedIds = new Set();
    let frameCount = 0;

    debugLog(`[CURSOR BUFFER] Total length: ${buffer.length} bytes`);

    while (offset < buffer.length) {
      const frame = readCursorFrame(buffer, offset, frameCount, "");
      if (frame.status === "done") break;
      offset = frame.offset;
      frameCount++;
      if (frame.status === "skip") continue;
      const payload = frame.payload;

      // Check for JSON error frames (byte guard: skip toString on non-JSON frames)
      if (payload.length > 0 && payload[0] === 0x7b) {
        try {
          const text = payload.toString("utf-8");
          if (text.includes('"error"')) {
            const hasContent = totalContent || toolCallsMap.size > 0;
            debugLog(
              `[CURSOR BUFFER] Error frame (hasContent=${hasContent}): ${text.slice(0, 500)}`
            );
            if (hasContent) {
              break;
            }
            return createErrorResponse(JSON.parse(text));
          }
        } catch {}
      }

      const result = extractTextFromResponse(new Uint8Array(payload));
      debugLog(`[CURSOR DECODED] Frame ${frameCount}:`, result);

      if (result.error) {
        const hasContent = totalContent || toolCallsMap.size > 0;
        debugLog(`[CURSOR BUFFER] Decoded error (hasContent=${hasContent}): ${result.error}`);
        if (hasContent) {
          break;
        }
        return new Response(
          JSON.stringify({
            error: {
              message: result.error,
              type: "rate_limit_error",
              code: "rate_limited"
            }
          }),
          {
            status: HTTP_STATUS.RATE_LIMITED,
            headers: { "Content-Type": "application/json" }
          }
        );
      }

      if (result.toolCall) {
        const tc = result.toolCall;

        if (toolCallsMap.has(tc.id)) {
          // Accumulate arguments for existing tool call
          const existing = toolCallsMap.get(tc.id);
          existing.function.arguments += tc.function.arguments;
          existing.isLast = tc.isLast;
        } else {
          // New tool call
          toolCallsMap.set(tc.id, { ...tc });
        }

        // Push to final array when isLast is true
        if (tc.isLast) {
          const finalToolCall = toolCallsMap.get(tc.id);
          finalizedIds.add(tc.id);
          toolCalls.push({
            id: finalToolCall.id,
            type: finalToolCall.type,
            function: {
              name: finalToolCall.function.name,
              arguments: finalToolCall.function.arguments
            }
          });
        }
      }

      if (result.text) totalContent += result.text;
      if (result.thinking) totalThinking += result.thinking;
    }

    const visibleComposerContent = isComposerModel(model)
      ? visibleComposerContentFromThinking(totalThinking)
      : "";
    const finalContent = totalContent || visibleComposerContent;

    debugLog(
      `[CURSOR BUFFER] Parsed ${frameCount} frames, toolCallsMap size: ${toolCallsMap.size}, finalized toolCalls: ${toolCalls.length}`
    );

    // Finalize all remaining tool calls in map (in case stream ended without isLast=true)
    for (const [id, tc] of toolCallsMap.entries()) {
      // Check if already in final array
      if (!finalizedIds.has(id)) {
        debugLog(`[CURSOR BUFFER] Finalizing incomplete tool call: ${id}, isLast=${tc.isLast}`);
        toolCalls.push({
          id: tc.id,
          type: tc.type,
          function: {
            name: tc.function.name,
            arguments: tc.function.arguments
          }
        });
      }
    }

    debugLog(`[CURSOR BUFFER] Final toolCalls count: ${toolCalls.length}`);


    const message = {
      role: "assistant",
      content: finalContent || null
    };

    if (toolCalls.length > 0) {
      message.tool_calls = toolCalls;
    }

    const usage = estimateUsage(body, finalContent.length, FORMATS.OPENAI);

    const completion = {
      id: responseId,
      object: "chat.completion",
      created,
      model,
      choices: [{
        index: 0,
        message,
        finish_reason: toolCalls.length > 0 ? "tool_calls" : "stop"
      }],
      usage
    };

    return new Response(JSON.stringify(completion), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });
  }

  transformProtobufToSSE(buffer, model, body) {
    const responseId = `chatcmpl-cursor-${Date.now()}`;
    const created = Math.floor(Date.now() / 1000);

    const chunks = [];
    let offset = 0;
    let totalContent = "";
    let totalThinking = "";
    let emittedComposerThinkingContentLength = 0;
    const toolCalls = [];
    const toolCallsMap = new Map(); // Track streaming tool calls by ID
    const finalizedIds = new Set();
    const emittedToolCallIds = new Set();
    let frameCount = 0;

    debugLog(`[CURSOR BUFFER SSE] Total length: ${buffer.length} bytes`);

    while (offset < buffer.length) {
      const frame = readCursorFrame(buffer, offset, frameCount, " SSE");
      if (frame.status === "done") break;
      offset = frame.offset;
      frameCount++;
      if (frame.status === "skip") continue;
      const payload = frame.payload;

      // Check for JSON error frames (byte-guard: only decode if starts with '{')
      if (payload[0] === 0x7b) {
        try {
          const text = payload.toString("utf-8");
          if (text.includes('"error"')) {
            const hasContent = chunks.length > 0 || totalContent || toolCallsMap.size > 0;
            debugLog(
              `[CURSOR BUFFER SSE] Error frame (hasContent=${hasContent}): ${text.slice(0, 500)}`
            );
            if (hasContent) {
              break;
            }
            return createErrorResponse(JSON.parse(text));
          }
        } catch {}
      }

      const result = extractTextFromResponse(new Uint8Array(payload));
      debugLog(`[CURSOR DECODED SSE] Frame ${frameCount}:`, result);

      if (result.error) {
        const hasContent = chunks.length > 0 || totalContent || toolCallsMap.size > 0;
        debugLog(`[CURSOR BUFFER SSE] Decoded error (hasContent=${hasContent}): ${result.error}`);
        if (hasContent) {
          break;
        }
        return new Response(
          JSON.stringify({
            error: {
              message: result.error,
              type: "rate_limit_error",
              code: "rate_limited"
            }
          }),
          {
            status: HTTP_STATUS.RATE_LIMITED,
            headers: { "Content-Type": "application/json" }
          }
        );
      }

      if (result.toolCall) {
        const tc = result.toolCall;

        if (chunks.length === 0) {
          chunks.push(chatChunkSse({ id: responseId, created, model, delta: { role: "assistant", content: "" } }));
        }

        if (toolCallsMap.has(tc.id)) {
          // Accumulate arguments for existing tool call
          const existing = toolCallsMap.get(tc.id);
          const oldArgsLen = existing.function.arguments.length;
          existing.function.arguments += tc.function.arguments;
          existing.isLast = tc.isLast;

          // Stream the delta arguments
          if (tc.function.arguments) {
            emittedToolCallIds.add(tc.id);
            chunks.push(chatChunkSse({
              id: responseId, created, model,
              delta: {
                tool_calls: [
                  {
                    index: existing.index,
                    id: tc.id,
                    type: "function",
                    function: {
                      name: tc.function.name,
                      arguments: tc.function.arguments
                    }
                  }
                ]
              }
            }));
          }
        } else {
          // New tool call - assign index and add to map
          const toolCallIndex = toolCalls.length;
          finalizedIds.add(tc.id);
          toolCalls.push({ ...tc, index: toolCallIndex });
          toolCallsMap.set(tc.id, { ...tc, index: toolCallIndex });

          // Stream initial tool call with name
          emittedToolCallIds.add(tc.id);
          chunks.push(chatChunkSse({
            id: responseId, created, model,
            delta: {
              tool_calls: [
                {
                  index: toolCallIndex,
                  id: tc.id,
                  type: "function",
                  function: {
                    name: tc.function.name,
                    arguments: tc.function.arguments
                  }
                }
              ]
            }
          }));
        }
      }

      if (result.text) {
        totalContent += result.text;
        chunks.push(chatChunkSse({
          id: responseId, created, model,
          delta:
            chunks.length === 0 && toolCalls.length === 0
              ? { role: "assistant", content: result.text }
              : { content: result.text }
        }));
      }

      if (isComposerModel(model) && result.thinking) {
        totalThinking += result.thinking;
        const visibleContent = visibleComposerContentFromThinking(totalThinking);
        if (visibleContent.length > emittedComposerThinkingContentLength) {
          const deltaContent = visibleContent.slice(emittedComposerThinkingContentLength);
          emittedComposerThinkingContentLength = visibleContent.length;
          totalContent += deltaContent;
          chunks.push(chatChunkSse({
            id: responseId, created, model,
            delta:
              chunks.length === 0 && toolCalls.length === 0
                ? { role: "assistant", content: deltaContent }
                : { content: deltaContent }
          }));
        }
      }
    }

    debugLog(
      `[CURSOR BUFFER SSE] Parsed ${frameCount} frames, toolCallsMap size: ${toolCallsMap.size}, toolCalls array: ${toolCalls.length}`
    );

    // Finalize all remaining tool calls in map (stream may have ended without isLast=true)
    for (const [id, tc] of toolCallsMap.entries()) {
      if (!finalizedIds.has(id)) {
        debugLog(`[CURSOR BUFFER SSE] Finalizing incomplete tool call: ${id}, isLast=${tc.isLast}`);
        const toolCallIndex = toolCalls.length;
        toolCalls.push({
          id: tc.id,
          type: tc.type,
          index: toolCallIndex,
          function: {
            name: tc.function.name,
            arguments: tc.function.arguments
          }
        });

        // Emit SSE chunk for the finalized tool call if not already emitted
        if (!emittedToolCallIds.has(tc.id)) {
          chunks.push(chatChunkSse({
            id: responseId, created, model,
            delta: {
              tool_calls: [
                {
                  index: toolCallIndex,
                  id: tc.id,
                  type: "function",
                  function: {
                    name: tc.function.name,
                    arguments: tc.function.arguments
                  }
                }
              ]
            }
          }));
        }
      }
    }

    if (chunks.length === 0 && toolCalls.length === 0) {
      chunks.push(chatChunkSse({ id: responseId, created, model, delta: { role: "assistant", content: "" } }));
    }

    const usage = estimateUsage(body, totalContent.length, FORMATS.OPENAI);

    chunks.push(
      `data: ${JSON.stringify({
        id: responseId,
        object: "chat.completion.chunk",
        created,
        model,
        choices: [
          {
            index: 0,
            delta: {},
            finish_reason: toolCalls.length > 0 ? "tool_calls" : "stop"
          }
        ],
        usage
      })}\n\n`
    );
    chunks.push(SSE_DONE);

    return new Response(chunks.join(""), {
      status: 200,
      headers: { ...SSE_HEADERS }
    });
  }

  async refreshCredentials() {
    return null;
  }
}

export default CursorExecutor;
