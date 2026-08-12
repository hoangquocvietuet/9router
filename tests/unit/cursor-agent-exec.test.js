import { describe, expect, it } from "vitest";
import { handleAgentExecRequest, extractExecMeta } from "../../open-sse/utils/cursorAgentExec.js";
import { buildSimulatedToolResult } from "../../open-sse/executors/cursor.js";
import { decodeMessage, encodeField, parseConnectRPCFrame } from "../../open-sse/utils/cursorProtobuf.js";

const LEN = 2;

function execFrame(fields) {
  const execServerMessage = Buffer.concat(fields);
  return Buffer.from(encodeField(2, LEN, execServerMessage));
}

describe("cursorAgentExec", () => {
  it("extracts exec id and exec_id from server messages", () => {
    const execRequest = decodeMessage(execFrame([
      Buffer.from(encodeField(1, 0, 42)),
      Buffer.from(encodeField(15, LEN, "exec-abc")),
      Buffer.from(encodeField(7, LEN, Buffer.from(encodeField(1, LEN, "README.md")))),
    ]));
    expect(extractExecMeta(execRequest)).toEqual({ id: 42, execId: "exec-abc" });
  });

  it("replies to read_args with read_result on field 7", () => {
    const written = [];
    const execRequest = decodeMessage(execFrame([
      Buffer.from(encodeField(1, 0, 7)),
      Buffer.from(encodeField(15, LEN, "exec-read")),
      Buffer.from(encodeField(7, LEN, Buffer.concat([
        Buffer.from(encodeField(1, LEN, "open-sse/executors/cursor.js")),
        Buffer.from(encodeField(2, LEN, "call_1")),
      ]))),
    ]));
    const kind = handleAgentExecRequest(execRequest, { write: (f) => written.push(Buffer.from(f)) }, { buildSimulatedToolResult });
    expect(kind).toBe("read:open-sse/executors/cursor.js");
    const frame = parseConnectRPCFrame(written[0]);
    const clientMessage = decodeMessage(frame.payload);
    const execClientMessage = decodeMessage(clientMessage.get(2)[0].value);
    expect(execClientMessage.has(7)).toBe(true);
    expect(extractExecMeta(execClientMessage)).toEqual({ id: 7, execId: "exec-read" });
  });
});
