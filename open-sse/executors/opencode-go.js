import { BaseExecutor } from "./base.js";
import { PROVIDERS } from "../config/providers.js";
import { injectReasoningContent } from "../utils/reasoningContentInjector.js";
import { ANTHROPIC_API_VERSION } from "../providers/shared.js";

// Models that use /zen/go/v1/messages (Anthropic/Claude format + x-api-key auth)
const MESSAGES_FORMAT_MODELS = new Set([
  "minimax-m3",
  "minimax-m2.7",
  "minimax-m2.5",
  "qwen3.7-max",
  "qwen3.7-plus",
  "qwen3.6-plus",
]);

const BASE = "https://opencode.ai/zen/go/v1";

// Moonshot (kimi) flavored JSON Schema rejects anyOf/oneOf when the parent
// schema also declares `type`. Claude Code / MCP tools commonly emit schemas
// like { type: "array", anyOf: [...] }. Strip the parent `type` and inline the
// best non-null branch so Kimi accepts the tool schema.
function sanitizeMoonshotSchema(obj) {
  if (!obj || typeof obj !== "object") return obj;

  if ((obj.anyOf || obj.oneOf) && Array.isArray(obj.anyOf || obj.oneOf)) {
    const branches = (obj.anyOf || obj.oneOf).filter((b) => b && typeof b === "object");
    const nonNull = branches.filter((b) => b.type !== "null");
    if (nonNull.length > 0) {
      const selected = nonNull[0];
      delete obj.anyOf;
      delete obj.oneOf;
      // Parent `type` conflicts with Moonshot when anyOf is present.
      if (obj.type && selected.type) delete obj.type;
      Object.assign(obj, selected);
    } else if (branches.length > 0) {
      delete obj.anyOf;
      delete obj.oneOf;
      Object.assign(obj, branches[0]);
    }
  }

  // Flatten type arrays (e.g. ["string", "null"]) to a single concrete type.
  if (Array.isArray(obj.type)) {
    const nonNullTypes = obj.type.filter((t) => t !== "null");
    obj.type = nonNullTypes.length > 0 ? nonNullTypes[0] : "string";
  }

  // Recurse into nested schemas.
  for (const value of Object.values(obj)) {
    if (value && typeof value === "object") {
      if (Array.isArray(value)) {
        for (const item of value) sanitizeMoonshotSchema(item);
      } else {
        sanitizeMoonshotSchema(value);
      }
    }
  }

  return obj;
}

function sanitizeToolsForMoonshot(tools) {
  if (!Array.isArray(tools)) return;
  for (const tool of tools) {
    if (!tool || typeof tool !== "object") continue;
    const fn = tool.function || tool;
    if (fn?.parameters && typeof fn.parameters === "object") {
      fn.parameters = sanitizeMoonshotSchema(structuredClone(fn.parameters));
    }
  }
}

export class OpenCodeGoExecutor extends BaseExecutor {
  constructor() {
    super("opencode-go", PROVIDERS["opencode-go"]);
  }

  // buildUrl runs before buildHeaders in BaseExecutor.execute, cache model here
  buildUrl(model) {
    this._lastModel = model;
    return MESSAGES_FORMAT_MODELS.has(model)
      ? `${BASE}/messages`
      : `${BASE}/chat/completions`;
  }

  buildHeaders(credentials, stream = true) {
    const key = credentials?.apiKey || credentials?.accessToken;
    const headers = { "Content-Type": "application/json" };

    if (MESSAGES_FORMAT_MODELS.has(this._lastModel)) {
      headers["x-api-key"] = key;
      headers["anthropic-version"] = ANTHROPIC_API_VERSION;
    } else {
      headers["Authorization"] = `Bearer ${key}`;
    }

    if (stream) headers["Accept"] = "text/event-stream";
    return headers;
  }

  transformRequest(model, body) {
    const transformed = injectReasoningContent({ provider: this.provider, model, body });
    // Kimi/Moonshot chat/completions models reject schemas with anyOf/oneOf
    // alongside a parent type. Sanitize tools only for those models.
    if (!MESSAGES_FORMAT_MODELS.has(model) && Array.isArray(transformed?.tools)) {
      sanitizeToolsForMoonshot(transformed.tools);
    }
    return transformed;
  }
}
