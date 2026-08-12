/**
 * Claude Code ↔ Cursor AgentService tool-bridge helpers.
 *
 * Capture fixtures and conversion stay outside the text-only gateway shim so
 * tests can assert the real tool-protocol mapping without inventing schemas.
 */
import fs from "fs";
import path from "path";
import { encodeMcpToolDefinition, decodeMessage } from "./cursorProtobuf.js";
import { translateAgentExecRequestToClientTool } from "./cursorAgentExec.js";

export const DEFAULT_CAPTURE_PATH =
  process.env.CURSOR_TOOL_CAPTURE_PATH ||
  "/root/.9router/captures/claude-code-169-tools.json";

export const DEFAULT_FIXTURE_PATH = path.resolve(
  process.cwd(),
  "tests/fixtures/cursor/claude-code-169-tools.json",
);

const MIN_TOOL_COUNT = Number(process.env.CURSOR_TOOL_CAPTURE_MIN || 100);

function toolName(tool) {
  return tool?.function?.name || tool?.name || "";
}

function toolDescription(tool) {
  return tool?.function?.description || tool?.description || "";
}

function toolInputSchema(tool) {
  return (
    tool?.function?.parameters ||
    tool?.input_schema ||
    tool?.inputSchema ||
    tool?.parameters ||
    { type: "object", properties: {} }
  );
}

/**
 * Normalize Claude or OpenAI tool declarations into Cursor tool metadata
 * (the fields encodeMcpToolDefinition / AgentService MCP catalogues consume).
 */
export function claudeToolsToCursorToolMetadata(tools = []) {
  return (tools || []).map((tool) => {
    const name = toolName(tool);
    const description = toolDescription(tool);
    const inputSchema = toolInputSchema(tool);
    return {
      name,
      description,
      inputSchema,
      serverName: "9router",
      // Keep the original declaration so round-trips can restore Claude spelling.
      source: tool?.type === "function" || tool?.function
        ? {
            type: "function",
            function: {
              name,
              description,
              parameters: inputSchema,
            },
          }
        : {
            name,
            description,
            input_schema: inputSchema,
          },
      // Encoded bytes prove the metadata is AgentService-encodable.
      encoded: Buffer.from(encodeMcpToolDefinition({
        function: { name, description, parameters: inputSchema },
      })),
    };
  });
}

/**
 * Cursor AgentService exec_request → Claude `tool_use` content block.
 * Uses the client-declared tool name/schema catalogue from the captured request.
 */
export function translateAgentExecRequestToClaudeToolUse(execRequest, clientTools = []) {
  const call = translateAgentExecRequestToClientTool(execRequest, clientTools);
  if (!call) return null;
  let input = {};
  try {
    input = JSON.parse(call.function?.arguments || "{}");
  } catch {
    input = {};
  }
  return {
    type: "tool_use",
    id: call.id,
    name: call.function?.name || "",
    input,
  };
}

/**
 * OpenAI-style tool_call (Cursor executor SSE) → Claude tool_use block.
 */
export function openAIToolCallToClaudeToolUse(toolCall) {
  if (!toolCall) return null;
  let input = {};
  const rawArgs = toolCall.function?.arguments ?? toolCall.arguments ?? toolCall.input;
  if (typeof rawArgs === "string") {
    try { input = JSON.parse(rawArgs || "{}"); } catch { input = {}; }
  } else if (rawArgs && typeof rawArgs === "object") {
    input = rawArgs;
  }
  return {
    type: "tool_use",
    id: toolCall.id,
    name: toolCall.function?.name || toolCall.name || "",
    input,
  };
}

/**
 * One-shot capture of a real Claude Code / OpenAI tool catalogue.
 * Writes once, then no-ops while the capture file exists (unless force=true).
 */
export function maybeCaptureToolRequest(body, {
  capturePath = DEFAULT_CAPTURE_PATH,
  minTools = MIN_TOOL_COUNT,
  force = false,
} = {}) {
  const tools = body?.tools || body?.functions;
  if (!Array.isArray(tools) || tools.length < minTools) {
    return { captured: false, reason: "below-threshold", toolCount: tools?.length || 0 };
  }
  if (!force && fs.existsSync(capturePath)) {
    return { captured: false, reason: "already-captured", toolCount: tools.length, path: capturePath };
  }

  fs.mkdirSync(path.dirname(capturePath), { recursive: true });

  const taskText = extractOriginalTaskText(body?.messages || []);
  const payload = {
    capturedAt: new Date().toISOString(),
    source: "claude-code-live-request",
    toolCount: tools.length,
    model: body?.model || null,
    task: taskText,
    tools,
    // Keep a compact message skeleton for multi-turn regression fixtures.
    messages: redactMessagesForFixture(body?.messages || []),
  };
  fs.writeFileSync(capturePath, JSON.stringify(payload, null, 2));
  return { captured: true, toolCount: tools.length, path: capturePath };
}

export function loadCapturedToolFixture({
  capturePath = DEFAULT_CAPTURE_PATH,
  fixturePath = DEFAULT_FIXTURE_PATH,
} = {}) {
  const candidates = [fixturePath, capturePath];
  for (const candidate of candidates) {
    if (candidate && fs.existsSync(candidate)) {
      return { path: candidate, data: JSON.parse(fs.readFileSync(candidate, "utf8")) };
    }
  }
  return null;
}

function extractOriginalTaskText(messages) {
  for (const message of messages) {
    if (message?.role !== "user") continue;
    const text = flattenMessageText(message);
    if (!text) continue;
    // Skip pure tool_result turns.
    if (Array.isArray(message.content) && message.content.every((part) =>
      part?.type === "tool_result" || part?.type === "tool_use"
    )) continue;
    if (/^User has used this tool/i.test(text)) continue;
    const cleaned = text
      .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/gi, "")
      .trim();
    return cleaned || text;
  }
  return "";
}

function flattenMessageText(message) {
  if (typeof message?.content === "string") return message.content;
  if (!Array.isArray(message?.content)) return "";
  return message.content
    .filter((part) => part?.type === "text" && part.text)
    .map((part) => part.text)
    .join("\n");
}

function flattenToolResultContent(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((part) => part?.type === "text" && part.text != null)
      .map((part) => String(part.text))
      .join("\n");
  }
  if (content == null) return "";
  return String(content);
}

/**
 * Extract tool result payloads from a Claude or OpenAI-shaped chat body.
 * @returns {{ toolCallId: string, content: string, isError: boolean }[]}
 */
export function extractClientToolResults(body) {
  const messages = body?.messages;
  if (!Array.isArray(messages)) return [];

  const results = [];
  for (const message of messages) {
    if (!message || typeof message !== "object") continue;

    if (message.role === "tool" && message.tool_call_id) {
      results.push({
        toolCallId: message.tool_call_id,
        content: flattenToolResultContent(message.content),
        isError: false,
      });
      continue;
    }

    if (Array.isArray(message.content)) {
      for (const part of message.content) {
        if (part?.type === "tool_result" && part.tool_use_id) {
          results.push({
            toolCallId: part.tool_use_id,
            content: flattenToolResultContent(part.content),
            isError: Boolean(part.is_error),
          });
        }
      }
    }
  }

  return results.reverse();
}

/**
 * @returns {string[]} tool_use / tool_call ids referenced by results, newest-first
 */
export function listToolResultIds(body) {
  return extractClientToolResults(body).map((result) => result.toolCallId);
}

function redactMessagesForFixture(messages) {
  return (messages || []).map((message) => {
    if (!message || typeof message !== "object") return message;
    if (typeof message.content === "string") {
      return {
        role: message.role,
        content: message.content.length > 4000
          ? `${message.content.slice(0, 4000)}\n…[truncated]`
          : message.content,
      };
    }
    if (!Array.isArray(message.content)) {
      return { role: message.role, content: message.content };
    }
    return {
      role: message.role,
      content: message.content.map((part) => {
        if (!part || typeof part !== "object") return part;
        if (part.type === "tool_result") {
          const raw = typeof part.content === "string"
            ? part.content
            : JSON.stringify(part.content ?? "");
          return {
            type: "tool_result",
            tool_use_id: part.tool_use_id,
            content: raw.length > 2000 ? `${raw.slice(0, 2000)}\n…[truncated]` : part.content,
            ...(part.is_error ? { is_error: true } : {}),
          };
        }
        if (part.type === "tool_use") {
          return {
            type: "tool_use",
            id: part.id,
            name: part.name,
            input: part.input,
          };
        }
        if (part.type === "text") {
          const text = String(part.text || "");
          return {
            type: "text",
            text: text.length > 4000 ? `${text.slice(0, 4000)}\n…[truncated]` : text,
          };
        }
        return { type: part.type };
      }),
    };
  });
}

/**
 * Flatten prior user/assistant/tool turns into the current Cursor user text so
 * AgentService cannot drop the original task when conversation-history protobuf
 * is ignored.
 */
export function flattenHistoryIntoCurrentUserText(messages = []) {
  const parts = [];
  for (const message of messages) {
    if (!message || typeof message !== "object") continue;
    if (message.role === "system") continue;
    const role = message.role || "user";
    const text = flattenMessageText(message);
    if (Array.isArray(message.content)) {
      for (const part of message.content) {
        if (part?.type === "tool_use") {
          parts.push(`assistant tool_use ${part.name} [${part.id}]: ${JSON.stringify(part.input || {})}`);
        } else if (part?.type === "tool_result") {
          const content = typeof part.content === "string"
            ? part.content
            : JSON.stringify(part.content ?? "");
          parts.push(`user tool_result [${part.tool_use_id}]: ${content}`);
        }
      }
    }
    if (message.role === "tool" || message.role === "function") {
      parts.push(`user tool_result [${message.tool_call_id || "unknown"}]: ${flattenMessageText(message) || String(message.content || "")}`);
      continue;
    }
    if (Array.isArray(message.tool_calls)) {
      for (const call of message.tool_calls) {
        parts.push(`assistant tool_use ${call.function?.name || call.name} [${call.id}]: ${call.function?.arguments || "{}"}`);
      }
    }
    if (text) parts.push(`${role}: ${text}`);
  }
  return parts.join("\n\n");
}

export function originalTaskRemainsInAgentPayload(originalTask, agentUserText) {
  if (!originalTask || !agentUserText) return false;
  const needle = originalTask.trim().slice(0, 80);
  return Boolean(needle) && String(agentUserText).includes(needle);
}

/** Decode helper exposed for tests that build raw exec frames. */
export function decodeExecRequestFields(execRequestBytes) {
  return decodeMessage(execRequestBytes);
}
