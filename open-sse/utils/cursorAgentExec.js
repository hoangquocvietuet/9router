/**
 * agent.v1 AgentService exec_request / exec_client_message helpers.
 * Field numbers match agent.proto (see pi-cursor / Cursor IDE wire schema).
 */
import fs from "fs";
import path from "path";
import {
  decodeMessage,
  decodeMcpArgs,
  encodeField,
  encodeMcpResultSuccess,
  wrapConnectRPCFrame,
} from "./cursorProtobuf.js";

const LEN = 2;
const VARINT = 0;
const MAX_READ_BYTES = 256 * 1024;

const WORKSPACE_ROOTS = [
  "/root/personal-projects",
  "/root/projects",
  process.cwd(),
];

const GATEWAY_REJECT_REASON =
  "IDE tool execution is simulated by the 9router gateway. Use conversation context or MCP tools on the client.";

const msg = (field, value) => encodeField(field, LEN, value);
const str = (field, value) => encodeField(field, LEN, value);
const varint = (field, value) => encodeField(field, VARINT, value);

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

function decodeString(fields, field) {
  const value = fields.get(field)?.[0]?.value;
  return value ? Buffer.from(value).toString("utf8") : "";
}

export function extractExecMeta(execRequest) {
  return {
    id: Number(execRequest.get(1)?.[0]?.value ?? 0),
    execId: decodeString(execRequest, 15),
  };
}

function buildExecClientFrame(execRequest, resultField, resultPayload) {
  const { id, execId } = extractExecMeta(execRequest);
  const execClientMessage = concatBuffers(
    varint(1, id),
    ...(execId ? [str(15, execId)] : []),
    msg(resultField, resultPayload),
  );
  return wrapConnectRPCFrame(msg(2, execClientMessage));
}

function resolveReadablePath(requestPath) {
  if (!requestPath || typeof requestPath !== "string") return null;
  const normalized = requestPath.replace(/^\.\//, "");
  if (path.isAbsolute(normalized) && fs.existsSync(normalized)) return normalized;
  for (const root of WORKSPACE_ROOTS) {
    const candidate = path.join(root, normalized);
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

function readFileForAgent(requestPath) {
  const resolved = resolveReadablePath(requestPath);
  if (!resolved) return null;
  try {
    const stat = fs.statSync(resolved);
    if (!stat.isFile()) return null;
    const buf = fs.readFileSync(resolved);
    const truncated = buf.length > MAX_READ_BYTES;
    const content = (truncated ? buf.subarray(0, MAX_READ_BYTES) : buf).toString("utf8");
    return {
      path: requestPath,
      content,
      totalLines: content.split("\n").length,
      fileSize: buf.length,
      truncated,
    };
  } catch {
    return null;
  }
}

function encodeReadSuccess({ path, content, totalLines, fileSize, truncated }) {
  const success = concatBuffers(
    str(1, path),
    str(2, content),
    varint(3, totalLines),
    varint(4, fileSize),
    varint(6, truncated ? 1 : 0),
  );
  return msg(1, success);
}

function encodeReadRejected(path, reason = GATEWAY_REJECT_REASON) {
  return msg(3, concatBuffers(str(1, path), str(2, reason)));
}

function encodeReadFileNotFound(path) {
  return msg(4, str(1, path));
}

function encodeGrepError(error = GATEWAY_REJECT_REASON) {
  return msg(2, str(1, error));
}

function encodeLsRejected(path, reason = GATEWAY_REJECT_REASON) {
  return msg(3, concatBuffers(str(1, path), str(2, reason)));
}

function encodeShellRejected({ command = "", workingDirectory = "", reason = GATEWAY_REJECT_REASON }) {
  return msg(3, concatBuffers(
    str(1, command),
    str(2, workingDirectory),
    str(3, reason),
    varint(4, 0),
  ));
}

function encodeEmptyRequestContextResult() {
  const requestContext = new Uint8Array();
  const requestContextSuccess = msg(1, requestContext);
  return msg(1, requestContextSuccess);
}

function encodeEmptyResult(resultField) {
  return msg(resultField, new Uint8Array());
}

/**
 * Handle one AgentServerMessage.exec_request and write the matching exec_client reply.
 * Returns a short label for debug logging.
 */
export function handleAgentExecRequest(execRequest, session, { buildSimulatedToolResult }) {
  const fields = [...execRequest.keys()].join(",");

  if (execRequest.has(10)) {
    session.write(buildExecClientFrame(execRequest, 10, encodeEmptyRequestContextResult()));
    return "requestContext";
  }

  if (execRequest.has(7)) {
    const readArgs = decodeMessage(execRequest.get(7)[0].value);
    const requestPath = decodeString(readArgs, 1);
    const file = readFileForAgent(requestPath);
    const readResult = file
      ? encodeReadSuccess(file)
      : (requestPath ? encodeReadFileNotFound(requestPath) : encodeReadRejected(requestPath || "unknown"));
    session.write(buildExecClientFrame(execRequest, 7, readResult));
    return `read:${requestPath || "?"}`;
  }

  if (execRequest.has(11)) {
    const argsBuffer = execRequest.get(11)[0]?.value || new Uint8Array();
    let mcpArgs;
    try { mcpArgs = decodeMcpArgs(argsBuffer); } catch { mcpArgs = null; }
    const toolName = mcpArgs?.toolName || mcpArgs?.name;
    const simulated = buildSimulatedToolResult(toolName, mcpArgs);
    const mcpSuccess = encodeMcpResultSuccess({ textItems: [simulated], isError: false });
    session.write(buildExecClientFrame(execRequest, 11, mcpSuccess));
    return `mcp:${toolName || "?"}`;
  }

  if (execRequest.has(2) || execRequest.has(14)) {
    const shellArgs = decodeMessage((execRequest.get(2) || execRequest.get(14))?.[0]?.value || new Uint8Array());
    const shellResult = encodeShellRejected({
      command: decodeString(shellArgs, 1),
      workingDirectory: decodeString(shellArgs, 2),
    });
    const resultField = execRequest.has(14) ? 14 : 2;
    session.write(buildExecClientFrame(execRequest, resultField, shellResult));
    return "shell";
  }

  if (execRequest.has(5)) {
    const grepResult = encodeGrepError();
    session.write(buildExecClientFrame(execRequest, 5, grepResult));
    return "grep";
  }

  if (execRequest.has(8)) {
    const lsArgs = decodeMessage(execRequest.get(8)[0].value);
    const lsResult = encodeLsRejected(decodeString(lsArgs, 1));
    session.write(buildExecClientFrame(execRequest, 8, lsResult));
    return "ls";
  }

  if (execRequest.has(3)) {
    const writeArgs = decodeMessage(execRequest.get(3)[0].value);
    const writeResult = msg(3, concatBuffers(
      str(1, decodeString(writeArgs, 1)),
      str(2, GATEWAY_REJECT_REASON),
    ));
    session.write(buildExecClientFrame(execRequest, 3, writeResult));
    return "write";
  }

  if (execRequest.has(4)) {
    const deleteArgs = decodeMessage(execRequest.get(4)[0].value);
    const deleteResult = msg(3, concatBuffers(
      str(1, decodeString(deleteArgs, 1)),
      str(2, GATEWAY_REJECT_REASON),
    ));
    session.write(buildExecClientFrame(execRequest, 4, deleteResult));
    return "delete";
  }

  if (execRequest.has(9)) {
    session.write(buildExecClientFrame(execRequest, 9, new Uint8Array()));
    return "diagnostics";
  }

  if (execRequest.has(16)) {
    session.write(buildExecClientFrame(execRequest, 16, encodeShellRejected({})));
    return "backgroundShell";
  }

  if (execRequest.has(17) || execRequest.has(18)) {
    const resultField = execRequest.has(17) ? 17 : 18;
    session.write(buildExecClientFrame(execRequest, resultField, encodeEmptyResult(resultField)));
    return "mcpResource";
  }

  session.write(buildExecClientFrame(execRequest, 9, new Uint8Array()));
  return `fallback:${fields}`;
}
