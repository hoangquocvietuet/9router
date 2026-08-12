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
  encodeMcpResultError,
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

function encodeGrepSuccessEmpty(pattern = "", path = ".") {
  const success = concatBuffers(
    str(1, pattern),
    str(2, path),
    str(3, "content"),
  );
  return msg(1, success);
}

function encodeGrepError(error = GATEWAY_REJECT_REASON) {
  return msg(2, str(1, error));
}

function encodeLsRejected(path, reason = GATEWAY_REJECT_REASON) {
  return msg(3, concatBuffers(str(1, path), str(2, reason)));
}

function encodeShellSuccess({ command = "", workingDirectory = "", exitCode = 0, stdout = "" }) {
  const success = concatBuffers(
    str(1, command),
    str(2, workingDirectory),
    varint(3, exitCode),
    str(5, stdout),
    str(6, ""),
    varint(7, 0),
  );
  return msg(1, success);
}

function encodeShellRejected({ command = "", workingDirectory = "", reason = GATEWAY_REJECT_REASON }) {
  return msg(4, concatBuffers(
    str(1, command),
    str(2, workingDirectory),
    str(3, reason),
    varint(4, 0),
  ));
}

/** Field 14 is shell_stream (ShellStream), not ShellResult. */
function encodeShellStreamStart() {
  return msg(4, new Uint8Array());
}

function encodeShellStreamStdout(data = "") {
  return msg(1, str(1, data));
}

function encodeShellStreamExit({ code = 0, cwd = WORKSPACE_ROOTS[0] || process.cwd() }) {
  const exit = concatBuffers(varint(1, code), str(2, cwd));
  return msg(3, exit);
}

function encodeFetchSuccess(url, content = "") {
  const success = concatBuffers(
    str(1, url || ""),
    str(2, content),
    varint(3, 200),
    str(4, "text/plain"),
  );
  return msg(1, success);
}

function encodeFetchError(url, error = GATEWAY_REJECT_REASON) {
  return msg(2, concatBuffers(str(1, url || ""), str(2, error)));
}

function encodeExecuteHookResult() {
  const preCompact = msg(1, new Uint8Array());
  return msg(1, preCompact);
}

function encodeField28Ack() {
  const success = msg(1, new Uint8Array());
  return msg(1, success);
}

function buildExecClientControlFrame(execRequest, controlField, controlPayload) {
  const { id } = extractExecMeta(execRequest);
  const controlMessage = msg(controlField, controlPayload);
  const agentClientMessage = msg(5, controlMessage);
  return wrapConnectRPCFrame(agentClientMessage);
}

function buildExecStreamCloseFrame(execRequest) {
  const { id } = extractExecMeta(execRequest);
  const streamClose = varint(1, id);
  return buildExecClientControlFrame(execRequest, 1, streamClose);
}

function replyShellStream(execRequest, session, shellArgs) {
  const command = decodeString(shellArgs, 1);
  const workingDirectory = decodeString(shellArgs, 2) || WORKSPACE_ROOTS[0] || process.cwd();
  session.write(buildExecClientFrame(execRequest, 14, encodeShellStreamStart()));
  session.write(buildExecClientFrame(execRequest, 14, encodeShellStreamStdout(
    JSON.stringify({ note: "Simulated shell output via 9router gateway.", stdout: "", stderr: "" }),
  )));
  session.write(buildExecClientFrame(execRequest, 14, encodeShellStreamExit({ cwd: workingDirectory })));
  session.write(buildExecClientFrame(execRequest, 2, encodeShellSuccess({
    command,
    workingDirectory,
    stdout: "",
  })));
  session.write(buildExecStreamCloseFrame(execRequest));
}

function encodeEmptyRequestContextResult() {
  const requestContext = new Uint8Array();
  const requestContextSuccess = msg(1, requestContext);
  return msg(1, requestContextSuccess);
}

function encodeEmptyResult(resultField) {
  return msg(resultField, new Uint8Array());
}

function clientToolName(tool) {
  return tool?.function?.name || tool?.name || "";
}

function findClientTool(tools, names) {
  const requested = new Set(names.map((name) => name.toLowerCase()));
  return (tools || []).find((tool) => requested.has(clientToolName(tool).toLowerCase())) || null;
}

function makeClientToolCall(tool, args) {
  if (!tool) return null;
  return {
    id: `call_${crypto.randomUUID().replaceAll("-", "")}`,
    type: "function",
    function: {
      // Preserve the client-declared spelling (e.g. Claude Code's `Read`).
      name: clientToolName(tool),
      arguments: JSON.stringify(args),
    },
  };
}

/**
 * Translate Cursor AgentService's IDE request to a client-declared tool call.
 *
 * This intentionally does not access the filesystem or execute anything.  The
 * client (Claude Code/Paseo) owns tool execution and returns its result in the
 * next request turn.
 */
export function translateAgentExecRequestToClientTool(execRequest, clientTools = []) {
  if (execRequest.has(11)) {
    const argsBuffer = execRequest.get(11)[0]?.value || new Uint8Array();
    let mcpArgs;
    try { mcpArgs = decodeMcpArgs(argsBuffer); } catch { return null; }
    const name = mcpArgs?.toolName || mcpArgs?.name;
    return makeClientToolCall(findClientTool(clientTools, [name]), mcpArgs?.args || {});
  }

  if (execRequest.has(7)) {
    const args = decodeMessage(execRequest.get(7)[0].value);
    return makeClientToolCall(
      findClientTool(clientTools, ["Read", "read_file", "readFile"]),
      { file_path: decodeString(args, 1) },
    );
  }

  if (execRequest.has(3)) {
    const args = decodeMessage(execRequest.get(3)[0].value);
    return makeClientToolCall(
      findClientTool(clientTools, ["Write", "write_file", "writeFile"]),
      { file_path: decodeString(args, 1), content: decodeString(args, 2) },
    );
  }

  if (execRequest.has(4)) {
    const args = decodeMessage(execRequest.get(4)[0].value);
    return makeClientToolCall(
      findClientTool(clientTools, ["Bash", "bash", "shell", "run_command"]),
      { command: `rm -- ${JSON.stringify(decodeString(args, 1))}` },
    );
  }

  if (execRequest.has(5) || execRequest.has(28)) {
    const args = execRequest.has(5)
      ? decodeMessage(execRequest.get(5)[0].value)
      : new Map();
    return makeClientToolCall(
      findClientTool(clientTools, ["Grep", "grep", "search"]),
      {
        pattern: decodeString(args, 1),
        path: decodeString(args, 2) || ".",
      },
    );
  }

  if (execRequest.has(8)) {
    const args = decodeMessage(execRequest.get(8)[0].value);
    return makeClientToolCall(
      findClientTool(clientTools, ["Glob", "glob", "list_files", "ls"]),
      { pattern: "**/*", path: decodeString(args, 1) || "." },
    );
  }

  if (execRequest.has(2) || execRequest.has(14) || execRequest.has(16)) {
    const field = execRequest.has(14) ? 14 : (execRequest.has(2) ? 2 : 16);
    const args = decodeMessage(execRequest.get(field)[0].value);
    const command = decodeString(args, 1);
    const workingDirectory = decodeString(args, 2);
    return makeClientToolCall(
      findClientTool(clientTools, ["Bash", "bash", "shell", "run_command"]),
      {
        command: workingDirectory
          ? `cd -- ${JSON.stringify(workingDirectory)} && ${command}`
          : command,
      },
    );
  }

  return null;
}

/**
 * Send the client-owned tool output back to the exact AgentService exec request
 * that originated it. No filesystem or command execution occurs in 9router.
 */
export function replyAgentExecWithClientResult(execRequest, session, resultContent = "", { isError = false } = {}) {
  const content = typeof resultContent === "string" ? resultContent : JSON.stringify(resultContent);
  if (execRequest.has(7)) {
    const args = decodeMessage(execRequest.get(7)[0].value);
    const requestPath = decodeString(args, 1);
    const readResult = isError
      ? encodeReadFileNotFound(requestPath)
      : encodeReadSuccess({
        path: requestPath,
        content,
        totalLines: content.split("\n").length,
        fileSize: Buffer.byteLength(content),
        truncated: false,
      });
    session.write(buildExecClientFrame(execRequest, 7, readResult));
    return "read";
  }
  if (execRequest.has(11)) {
    session.write(buildExecClientFrame(execRequest, 11, isError
      ? encodeMcpResultError(content)
      : encodeMcpResultSuccess({
        textItems: [content],
        isError: false,
      })));
    return "mcp";
  }
  if (execRequest.has(14)) {
    const args = decodeMessage(execRequest.get(14)[0].value);
    const command = decodeString(args, 1);
    const workingDirectory = decodeString(args, 2) || WORKSPACE_ROOTS[0] || process.cwd();
    session.write(buildExecClientFrame(execRequest, 14, encodeShellStreamStart()));
    session.write(buildExecClientFrame(execRequest, 14, encodeShellStreamStdout(content)));
    session.write(buildExecClientFrame(execRequest, 14, encodeShellStreamExit({ cwd: workingDirectory })));
    session.write(buildExecClientFrame(execRequest, 2, encodeShellSuccess({ command, workingDirectory, stdout: content })));
    session.write(buildExecStreamCloseFrame(execRequest));
    return "shellStream";
  }
  if (execRequest.has(2) || execRequest.has(16)) {
    const field = execRequest.has(2) ? 2 : 16;
    const args = decodeMessage(execRequest.get(field)[0].value);
    session.write(buildExecClientFrame(execRequest, field, encodeShellSuccess({
      command: decodeString(args, 1),
      workingDirectory: decodeString(args, 2),
      stdout: content,
    })));
    return "shell";
  }
  if (execRequest.has(5) || execRequest.has(28)) {
    const field = execRequest.has(5) ? 5 : 28;
    const args = execRequest.has(5) ? decodeMessage(execRequest.get(5)[0].value) : new Map();
    session.write(buildExecClientFrame(execRequest, field, encodeGrepSuccessEmpty(
      decodeString(args, 1),
      decodeString(args, 2) || ".",
    )));
    return "search";
  }
  throw new Error("Unsupported Cursor exec result type");
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

  if (execRequest.has(14)) {
    const shellArgs = decodeMessage(execRequest.get(14)[0].value);
    replyShellStream(execRequest, session, shellArgs);
    return "shellStream";
  }

  if (execRequest.has(2)) {
    const shellArgs = decodeMessage(execRequest.get(2)[0].value);
    const shellResult = encodeShellRejected({
      command: decodeString(shellArgs, 1),
      workingDirectory: decodeString(shellArgs, 2),
    });
    session.write(buildExecClientFrame(execRequest, 2, shellResult));
    return "shell";
  }

  if (execRequest.has(5)) {
    const grepArgs = decodeMessage(execRequest.get(5)[0].value);
    const grepResult = encodeGrepSuccessEmpty(decodeString(grepArgs, 1), decodeString(grepArgs, 2) || ".");
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

  if (execRequest.has(20)) {
    const fetchArgs = decodeMessage(execRequest.get(20)[0].value);
    const fetchResult = encodeFetchSuccess(decodeString(fetchArgs, 1));
    session.write(buildExecClientFrame(execRequest, 20, fetchResult));
    return "fetch";
  }

  if (execRequest.has(21)) {
    session.write(buildExecClientFrame(execRequest, 21, msg(2, str(1, GATEWAY_REJECT_REASON))));
    return "recordScreen";
  }

  if (execRequest.has(22)) {
    session.write(buildExecClientFrame(execRequest, 22, msg(2, str(1, GATEWAY_REJECT_REASON))));
    return "computerUse";
  }

  if (execRequest.has(23)) {
    session.write(buildExecClientFrame(execRequest, 23, msg(2, str(1, GATEWAY_REJECT_REASON))));
    return "writeShellStdin";
  }

  if (execRequest.has(28)) {
    const simulated = buildSimulatedToolResult("search", { args: { query: "workspace search" } });
    const ack = encodeMcpResultSuccess({ textItems: [simulated], isError: false });
    session.write(buildExecClientFrame(execRequest, 28, ack));
    return "exec28";
  }

  if (execRequest.has(27)) {
    session.write(buildExecClientFrame(execRequest, 27, encodeExecuteHookResult()));
    return "executeHook";
  }

  if (execRequest.has(17) || execRequest.has(18)) {
    const resultField = execRequest.has(17) ? 17 : 18;
    session.write(buildExecClientFrame(execRequest, resultField, encodeEmptyResult(resultField)));
    return "mcpResource";
  }

  console.warn(`[CURSOR AGENT] Unhandled exec_request fields: ${fields}`);
  session.write(buildExecClientFrame(execRequest, 9, new Uint8Array()));
  return `fallback:${fields}`;
}
