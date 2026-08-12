import { describe, expect, it } from "vitest";

import {
  isAgentCapableRequest,
  normalizeAgentServiceRequest,
  bodyHasToolSignals,
  shouldUseCursorAgentService,
  buildSimulatedToolResult,
} from "../../open-sse/executors/cursor.js";

describe("normalizeAgentServiceRequest (Cursor gateway only)", () => {
  it("flattens Claude Code tool_use / tool_result blocks into text history", () => {
    const normalized = normalizeAgentServiceRequest({
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: "Weather in Hanoi?" }],
        },
        {
          role: "assistant",
          content: [
            { type: "tool_use", id: "tu_1", name: "mcp__paseo__browser_snapshot", input: { browserId: "b1" } },
          ],
        },
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "tu_1", content: "snapshot ok" },
            { type: "text", text: "Summarize." },
          ],
        },
      ],
      tools: [{ name: "mcp__paseo__browser_snapshot", description: "Browser snapshot", input_schema: { type: "object" } }],
      tool_choice: { type: "auto" },
      parallel_tool_calls: true,
    });

    expect(normalized.tools).toEqual([]);
    expect(normalized.tool_choice).toBeUndefined();
    expect(normalized.parallel_tool_calls).toBeUndefined();
    expect(normalized.messages.some((m) => m.content?.includes("User has used these tools"))).toBe(true);
    expect(normalized.messages.some((m) => m.content?.includes("paseo/browser_snapshot"))).toBe(true);
    expect(normalized.messages.some((m) => m.content?.includes("User has used this tool (tu_1)"))).toBe(true);
    expect(normalized.messages.some((m) => m.content?.includes("Summarize."))).toBe(true);
    // Tool catalogue is sent as RunRequest.mcp_tools, not as prompt text.
    expect(normalized.messages.some((m) => m.content?.includes("Available tools"))).toBe(false);
  });

  it("accepts Claude thinking blocks for AgentService routing", () => {
    expect(isAgentCapableRequest({
      messages: [{
        role: "assistant",
        content: [
          { type: "thinking", thinking: "internal" },
          { type: "text", text: "hello" },
        ],
      }],
    })).toBe(true);
  });

  it("still rejects image blocks so legacy routing can handle multimodal", () => {
    expect(isAgentCapableRequest({
      messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: "https://x.test/a.png" } }] }],
    })).toBe(false);
  });

  it("keeps AgentService for tool declarations (ChatService returns Update Required)", () => {
    const body = {
      messages: [{ role: "user", content: "hi" }],
      tools: [{ name: "read_file", input_schema: { type: "object" } }],
    };
    expect(bodyHasToolSignals(body)).toBe(true);
    expect(shouldUseCursorAgentService(body)).toBe(true);
  });

  it("builds simulated success payloads for common IDE tool names", () => {
    const read = JSON.parse(buildSimulatedToolResult("read_file", { args: { path: "/tmp/a.ts" } }));
    expect(read.path).toBe("/tmp/a.ts");
    expect(read.content).toBe("");

    const grep = JSON.parse(buildSimulatedToolResult("grep", { args: { pattern: "foo" } }));
    expect(grep.matches).toEqual([]);

    const generic = JSON.parse(buildSimulatedToolResult("mcp__paseo__browser_snapshot"));
    expect(generic.ok).toBe(true);
  });
});
