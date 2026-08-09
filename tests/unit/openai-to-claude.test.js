/**
 * Unit tests for open-sse/translator/request/openai-to-claude.js
 *
 * Tests cover:
 *  - openaiToClaudeRequest() - OpenAI to Claude request translation
 *  - Response format handling (json_schema, json_object)
 */

import { describe, it, expect } from "vitest";
import { openaiToClaudeRequest } from "../../open-sse/translator/request/openai-to-claude.js";
import { openaiToClaudeResponse } from "../../open-sse/translator/response/openai-to-claude.js";

describe("openaiToClaudeRequest", () => {
  describe("response_format handling", () => {
    it("should inject JSON schema instructions for json_schema type", () => {
      const body = {
        messages: [{ role: "user", content: "What is 2+2?" }],
        response_format: {
          type: "json_schema",
          json_schema: {
            name: "math_response",
            schema: {
              type: "object",
              properties: {
                answer: { type: "number" },
                explanation: { type: "string" }
              },
              required: ["answer", "explanation"]
            }
          }
        }
      };

      const result = openaiToClaudeRequest("claude-sonnet-4.5", body, false);

      // Should have system array with instructions
      expect(result.system).toBeDefined();
      expect(Array.isArray(result.system)).toBe(true);
      
      // Check that system prompt includes schema
      const systemText = result.system
        .filter(s => s.type === "text")
        .map(s => s.text)
        .join("\n");
      
      expect(systemText).toContain("You must respond with valid JSON");
      expect(systemText).toContain("\"answer\"");
      expect(systemText).toContain("\"explanation\"");
      expect(systemText).toContain("Respond ONLY with the JSON object");
    });

    it("should inject basic JSON instructions for json_object type", () => {
      const body = {
        messages: [{ role: "user", content: "Give me a JSON object" }],
        response_format: {
          type: "json_object"
        }
      };

      const result = openaiToClaudeRequest("claude-sonnet-4.5", body, false);

      // Should have system array with instructions
      expect(result.system).toBeDefined();
      expect(Array.isArray(result.system)).toBe(true);
      
      const systemText = result.system
        .filter(s => s.type === "text")
        .map(s => s.text)
        .join("\n");
      
      expect(systemText).toContain("You must respond with valid JSON");
      expect(systemText).toContain("Respond ONLY with a JSON object");
    });

    it("should not modify system prompt when response_format is missing", () => {
      const body = {
        messages: [{ role: "user", content: "Hello" }]
      };

      const result = openaiToClaudeRequest("claude-sonnet-4.5", body, false);

      // Should have system but without JSON instructions
      expect(result.system).toBeDefined();
      
      const systemText = result.system
        .filter(s => s.type === "text")
        .map(s => s.text)
        .join("\n");
      
      // Should NOT contain JSON-specific instructions
      expect(systemText).not.toContain("You must respond with valid JSON");
    });

    it("should preserve existing system messages when adding response_format", () => {
      const body = {
        messages: [
          { role: "system", content: "You are a helpful math tutor." },
          { role: "user", content: "What is 2+2?" }
        ],
        response_format: {
          type: "json_schema",
          json_schema: {
            schema: {
              type: "object",
              properties: {
                result: { type: "number" }
              }
            }
          }
        }
      };

      const result = openaiToClaudeRequest("claude-sonnet-4.5", body, false);

      // Should preserve original system message
      const systemText = result.system
        .filter(s => s.type === "text")
        .map(s => s.text)
        .join("\n");
      
      expect(systemText).toContain("You are a helpful math tutor");
      expect(systemText).toContain("You must respond with valid JSON");
    });
  });

  describe("tool_choice handling", () => {
    const baseBody = {
      messages: [{ role: "user", content: "add a todo" }],
      tools: [{
        type: "function",
        function: { name: "todo_write", description: "write todos", parameters: { type: "object", properties: {} } }
      }]
    };

    const choiceOf = (tc) =>
      openaiToClaudeRequest("claude-sonnet-4.5", { ...baseBody, tool_choice: tc }, false).tool_choice;

    it("converts OpenAI forced tool ({type:'function'}) to Claude {type:'tool'}", () => {
      // Must NOT leak the OpenAI "function" type — Claude only accepts auto|any|tool|none.
      expect(choiceOf({ type: "function", function: { name: "todo_write" } }))
        .toEqual({ type: "tool", name: "todo_write" });
    });

    it("maps string tool_choice values", () => {
      expect(choiceOf("auto")).toEqual({ type: "auto" });
      expect(choiceOf("none")).toEqual({ type: "auto" });
      expect(choiceOf("required")).toEqual({ type: "any" });
    });

    it("passes through Claude-native tool_choice objects unchanged", () => {
      expect(choiceOf({ type: "tool", name: "todo_write" })).toEqual({ type: "tool", name: "todo_write" });
      expect(choiceOf({ type: "any" })).toEqual({ type: "any" });
      expect(choiceOf({ type: "none" })).toEqual({ type: "none" });
    });

    it("never leaks an invalid type (falls back to auto)", () => {
      // Malformed forced choice with no tool name, and unknown types, must not
      // pass an invalid `type` through to Claude.
      expect(choiceOf({ type: "function", function: {} })).toEqual({ type: "auto" });
      expect(choiceOf({ type: "function" })).toEqual({ type: "auto" });
      expect(choiceOf({ type: "bogus" })).toEqual({ type: "auto" });
    });

    it("omits tool_choice entirely when the request has none", () => {
      const result = openaiToClaudeRequest("claude-sonnet-4.5", baseBody, false);
      expect(result.tool_choice).toBeUndefined();
    });
  });
});

describe("openaiToClaudeResponse", () => {
  it("omits empty Read pages tool argument before emitting Claude input deltas", () => {
    const state = { toolCalls: new Map(), finishReason: null, messageStartSent: false };
    const chunk = {
      id: "chatcmpl-test",
      model: "gpt-test",
      choices: [{
        delta: {
          tool_calls: [{
            index: 0,
            id: "call_read",
            function: {
              name: "Read",
              arguments: JSON.stringify({
                file_path: "/tmp/example.txt",
                offset: 0,
                limit: 120,
                pages: ""
              })
            }
          }]
        }
      }]
    };

    const result = openaiToClaudeResponse(chunk, state);
    const inputDelta = result.find(event => event.delta?.type === "input_json_delta");

    expect(inputDelta).toBeDefined();
    expect(JSON.parse(inputDelta.delta.partial_json)).toEqual({
      file_path: "/tmp/example.txt",
      offset: 0,
      limit: 120
    });
  });

  it("estimates message_start.input_tokens from body while message_delta keeps real usage", () => {
    // Body threaded via state (as stream.js does) so the client context bar is
    // non-zero even though the OpenAI-format upstream only sends usage at finish.
    const body = {
      messages: [{ role: "user", content: "x".repeat(4000) }],
      system: "You are a helpful assistant."
    };
    const state = { toolCalls: new Map(), body };

    // First chunk (no usage yet) → message_start must carry an estimate > 0.
    const firstChunk = {
      id: "chatcmpl-abc",
      model: "gpt-test",
      choices: [{ delta: { content: "Hi" } }]
    };
    const firstEvents = openaiToClaudeResponse(firstChunk, state);
    const messageStart = firstEvents.find(e => e.type === "message_start");

    expect(messageStart).toBeDefined();
    expect(messageStart.message.usage.input_tokens).toBeGreaterThan(0);
    // Cache fields stay absent on message_start.
    expect(messageStart.message.usage.cache_read_input_tokens).toBeUndefined();
    expect(messageStart.message.usage.cache_creation_input_tokens).toBeUndefined();

    const estimatedInput = messageStart.message.usage.input_tokens;

    // Final chunk carries real usage → message_delta must reflect it, unchanged.
    const finishChunk = {
      id: "chatcmpl-abc",
      model: "gpt-test",
      choices: [{ delta: {}, finish_reason: "stop" }],
      usage: { prompt_tokens: 123, completion_tokens: 45 }
    };
    const finishEvents = openaiToClaudeResponse(finishChunk, state);
    const messageDelta = finishEvents.find(e => e.type === "message_delta");

    expect(messageDelta).toBeDefined();
    expect(messageDelta.usage.input_tokens).toBe(123);
    expect(messageDelta.usage.output_tokens).toBe(45);
    // The real count must NOT be the message_start estimate.
    expect(messageDelta.usage.input_tokens).not.toBe(estimatedInput);
  });
});

describe("openaiToClaudeResponse flush (defensive terminal)", () => {
  // Simulate opencode-go behavior: content + usage arrive, then stream closes
  // without a finish_reason. The translator receives chunk=null on flush.
  it("emits message_delta + message_stop on flush when content was received but finish_reason is missing", () => {
    // Minimal state matching initState(OPENAI) shape — only the fields openaiToClaudeResponse reads
    const state = { toolCalls: new Map(), finishReason: null, messageStartSent: false };
    // Feed a content chunk first to start a message
    openaiToClaudeResponse(
      { id: "chatcmpl-flush-test", model: "gpt-5.6-luna", choices: [{ delta: { content: "Hello" } }] },
      state,
    );
    expect(state.finishReason).toBeNull();
    expect(state.messageStartSent).toBe(true);

    // Now simulate flush (chunk=null)
    const result = openaiToClaudeResponse(null, state);

    expect(result).not.toBeNull();
    expect(result.length).toBeGreaterThanOrEqual(3); // content_block_stop + message_delta + message_stop
    const messageDelta = result.find((e) => e.type === "message_delta");
    const messageStop = result.find((e) => e.type === "message_stop");
    expect(messageDelta).toBeDefined();
    expect(messageDelta.delta.stop_reason).toBe("end_turn");
    expect(messageStop).toBeDefined();
    // state.finishReason should be set to prevent duplicate flush
    expect(state.finishReason).toBe("stop");
  });

  it("returns null on flush when no content was received (empty stream)", () => {
    const state = { toolCalls: new Map(), finishReason: null, messageStartSent: false };
    // messageStartSent never became true
    const result = openaiToClaudeResponse(null, state);
    expect(result).toBeNull();
  });

  it("returns null on flush when finish_reason was already received", () => {
    const state = { toolCalls: new Map(), finishReason: null, messageStartSent: false };
    // Feed a normal finish chunk first
    openaiToClaudeResponse(
      { id: "chatcmpl-test", model: "gpt-test", choices: [{ delta: {}, finish_reason: "stop" }] },
      state,
    );
    expect(state.finishReason).toBe("stop");

    // Flush should be a no-op
    const result = openaiToClaudeResponse(null, state);
    expect(result).toBeNull();
  });

  it("emits buffered tool-call arguments on flush even without finish_reason", () => {
    const state = {
      toolCalls: new Map(),
      toolArgBuffers: new Map(),
      finishReason: null,
      messageStartSent: false,
      nextBlockIndex: 0,
    };

    // Feed a tool-call chunk (like the real flow) to register a tool with buffered args.
    const toolCallChunk = {
      id: "chatcmpl-tool-test",
      model: "gpt-5.6-luna",
      choices: [{
        delta: {
          tool_calls: [{
            index: 0,
            id: "call_read",
            function: {
              name: "Read",
              arguments: JSON.stringify({
                file_path: "/tmp/notes.md",
                offset: 1,
                limit: 50,
              })
            }
          }]
        }
      }]
    };
    openaiToClaudeResponse(toolCallChunk, state);
    // Tool call was registered and args buffered.
    expect(state.toolCalls.has(0)).toBe(true);
    expect(state.toolArgBuffers.get(0)).toBeDefined();
    // message_stop should NOT have been emitted yet.
    expect(state.finishReason).toBeFalsy();

    // Now flush (simulating clean EOF without finish_reason).
    const result = openaiToClaudeResponse(null, state);

    // Should contain an input_json_delta for the buffered args.
    const inputDelta = result.find((e) => e.delta?.type === "input_json_delta");
    expect(inputDelta).toBeDefined();
    expect(JSON.parse(inputDelta.delta.partial_json)).toEqual({
      file_path: "/tmp/notes.md",
      offset: 1,
      limit: 50,
    });
    // ... and a content_block_stop for the tool.
    const toolStop = result.find((e) => e.type === "content_block_stop" && e.index === 0);
    expect(toolStop).toBeDefined();
  });

  it("handles usage-only chunk before flush (exact opencode-go probe pattern)", () => {
    const body = { messages: [{ role: "user", content: "Say ACK" }] };
    const state = { toolCalls: new Map(), finishReason: null, messageStartSent: false, body };

    // Chunk 1: content — message_start fires, messageDelta usage stays absent.
    openaiToClaudeResponse(
      { id: "chatcmpl-abc", model: "gpt-5.6-luna", choices: [{ delta: { content: "ACK" } }] },
      state,
    );
    expect(state.messageStartSent).toBe(true);

    // Chunk 2: usage-only trailing chunk (choices:[]). In the real flow this comes from
    // stream.js's extractUsage/mergeUsage before translateResponse is called.
    // We simulate it by directly injecting OpenAI-shaped usage into state.usage,
    // which is what happens when stream.js processes this chunk upstream.
    state.usage = { prompt_tokens: 21, completion_tokens: 5 };

    // Flush: should produce Claude-shaped usage on message_delta.
    const result = openaiToClaudeResponse(null, state);
    expect(result).not.toBeNull();
    const messageDelta = result.find((e) => e.type === "message_delta");
    expect(messageDelta).toBeDefined();
    // Must be Claude shape with input_tokens / output_tokens, NOT prompt_tokens.
    expect(messageDelta.usage.input_tokens).toBe(21);
    expect(messageDelta.usage.output_tokens).toBe(5);
  });

  it("emits message_delta + message_stop on thinking-only flush (no text delta)", () => {
    const state = { toolCalls: new Map(), finishReason: null, messageStartSent: false, nextBlockIndex: 0 };

    // Feed only a reasoning/thinking delta
    openaiToClaudeResponse(
      {
        id: "chatcmpl-reason",
        model: "gpt-test",
        choices: [{ delta: { reasoning_content: "Let me think..." } }]
      },
      state,
    );
    expect(state.thinkingBlockStarted).toBe(true);
    expect(state.textBlockStarted).toBeFalsy();

    const result = openaiToClaudeResponse(null, state);
    expect(result).not.toBeNull();
    // thinking block should be closed
    expect(result.filter((e) => e.type === "content_block_stop").length).toBeGreaterThanOrEqual(1);
    expect(result.find((e) => e.type === "message_delta")).toBeDefined();
    expect(result.find((e) => e.type === "message_stop")).toBeDefined();
  });
});
