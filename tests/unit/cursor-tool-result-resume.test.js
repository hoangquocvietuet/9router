import { describe, expect, it } from "vitest";

import {
  extractClientToolResults,
  listToolResultIds,
} from "../../open-sse/utils/cursorToolBridge.js";

describe("extractClientToolResults", () => {
  it("extracts Claude user tool_result with string content", () => {
    const body = {
      messages: [
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "toolu_abc", content: "result text" },
          ],
        },
      ],
    };
    expect(extractClientToolResults(body)).toEqual([
      { toolCallId: "toolu_abc", content: "result text", isError: false },
    ]);
  });

  it("extracts Claude tool_result with array content and is_error", () => {
    const body = {
      messages: [
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "toolu_err",
              content: [
                { type: "text", text: "error line 1" },
                { type: "text", text: "error line 2" },
              ],
              is_error: true,
            },
          ],
        },
      ],
    };
    expect(extractClientToolResults(body)).toEqual([
      { toolCallId: "toolu_err", content: "error line 1\nerror line 2", isError: true },
    ]);
  });

  it("extracts OpenAI role=tool messages with string content", () => {
    const body = {
      messages: [
        { role: "tool", tool_call_id: "call_xyz", content: "tool output" },
      ],
    };
    expect(extractClientToolResults(body)).toEqual([
      { toolCallId: "call_xyz", content: "tool output", isError: false },
    ]);
  });

  it("flattens OpenAI array content parts to string", () => {
    const body = {
      messages: [
        {
          role: "tool",
          tool_call_id: "call_arr",
          content: [
            { type: "text", text: "line1" },
            { type: "text", text: "line2" },
          ],
        },
      ],
    };
    expect(extractClientToolResults(body)).toEqual([
      { toolCallId: "call_arr", content: "line1\nline2", isError: false },
    ]);
  });

  it("returns mixed history newest-first", () => {
    const body = {
      messages: [
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "old_id", content: "first" },
          ],
        },
        { role: "tool", tool_call_id: "mid_id", content: "second" },
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "newest_id", content: "third" },
          ],
        },
      ],
    };
    expect(extractClientToolResults(body)).toEqual([
      { toolCallId: "newest_id", content: "third", isError: false },
      { toolCallId: "mid_id", content: "second", isError: false },
      { toolCallId: "old_id", content: "first", isError: false },
    ]);
  });

  it("ignores results without an id", () => {
    const body = {
      messages: [
        { role: "user", content: [{ type: "tool_result", content: "no id" }] },
        { role: "tool", content: "missing tool_call_id" },
        { role: "tool", tool_call_id: "valid", content: "ok" },
      ],
    };
    expect(extractClientToolResults(body)).toEqual([
      { toolCallId: "valid", content: "ok", isError: false },
    ]);
  });

  it("returns empty array for empty or missing body", () => {
    expect(extractClientToolResults(null)).toEqual([]);
    expect(extractClientToolResults({})).toEqual([]);
    expect(extractClientToolResults({ messages: [] })).toEqual([]);
  });
});

describe("listToolResultIds", () => {
  it("returns tool ids newest-first from mixed history", () => {
    const body = {
      messages: [
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "toolu_1", content: "a" },
          ],
        },
        { role: "tool", tool_call_id: "call_2", content: "b" },
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "toolu_3", content: "c" },
          ],
        },
      ],
    };
    expect(listToolResultIds(body)).toEqual(["toolu_3", "call_2", "toolu_1"]);
  });

  it("omits entries without ids", () => {
    const body = {
      messages: [
        { role: "tool", content: "orphan" },
        { role: "tool", tool_call_id: "only_one", content: "x" },
      ],
    };
    expect(listToolResultIds(body)).toEqual(["only_one"]);
  });

  it("returns empty array for empty body", () => {
    expect(listToolResultIds(null)).toEqual([]);
    expect(listToolResultIds({})).toEqual([]);
  });
});
