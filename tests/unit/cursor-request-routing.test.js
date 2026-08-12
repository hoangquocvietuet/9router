import { describe, expect, it } from "vitest";

import { CursorExecutor } from "../../open-sse/executors/cursor.js";

const weatherTool = {
  type: "function",
  function: {
    name: "get_weather",
    description: "Get weather for a city",
    parameters: {
      type: "object",
      properties: { city: { type: "string" } },
      required: ["city"],
    },
  },
};

class RoutingProbeExecutor extends CursorExecutor {
  constructor() {
    super();
    this.route = null;
  }

  async executeAgent({ body }) {
    this.route = "agent-service";
    return {
      response: Response.json({ route: this.route }),
      transformedBody: body,
    };
  }

  buildUrl() {
    return "https://api2.cursor.sh/aiserver.v1.ChatService/StreamUnifiedChatWithTools";
  }

  buildHeaders() {
    return {};
  }

  transformRequest(_model, body) {
    return body;
  }

  async makeHttp2Request() {
    this.route = "legacy-chat-service";
    return { status: 429, body: Buffer.from("Update Required") };
  }
}

async function execute(messages, tools = []) {
  const executor = new RoutingProbeExecutor();
  const result = await executor.execute({
    model: "composer-2.5",
    body: { messages, tools },
    stream: false,
    credentials: {},
  });
  return { executor, result };
}

describe("Cursor request routing", () => {
  it("routes text-only history to AgentService", async () => {
    const { executor, result } = await execute([
      { role: "user", content: "Reply OK" },
    ]);

    expect(executor.route).toBe("agent-service");
    expect(result.response.status).toBe(200);
  });

  it("routes tool declarations to legacy ChatService (text-normalized)", async () => {
    const { executor, result } = await execute([
      { role: "user", content: "Reply OK without calling tools" },
    ], [weatherTool]);

    expect(executor.route).toBe("legacy-chat-service");
    expect(result.response.status).toBe(429);
  });

  it("routes assistant tool-call history to legacy ChatService", async () => {
    const { executor, result } = await execute([
      { role: "user", content: "Weather in Hanoi?" },
      {
        role: "assistant",
        content: null,
        tool_calls: [{
          id: "call_1",
          type: "function",
          function: { name: "get_weather", arguments: '{"city":"Hanoi"}' },
        }],
      },
      { role: "tool", tool_call_id: "call_1", content: "Sunny" },
      { role: "user", content: "Summarize the result" },
    ], [weatherTool]);

    expect(executor.route).toBe("legacy-chat-service");
    expect(result.response.status).toBe(429);
  });

  it("routes role:tool history to legacy ChatService", async () => {
    const { executor, result } = await execute([
      { role: "user", content: "Weather in Hanoi?" },
      { role: "tool", tool_call_id: "call_1", content: "Sunny" },
      { role: "user", content: "Summarize the result" },
    ], [weatherTool]);

    expect(executor.route).toBe("legacy-chat-service");
    expect(result.response.status).toBe(429);
  });
});
