const http = require("http");
const fs = require("fs");
const path = require("path");
const { pathToFileURL } = require("url");

const origCreate = http.createServer.bind(http);

// One-shot capture of the next real Claude Code request with a large tool catalogue.
// Safe only on the h2c replay path (full body already buffered). HTTP/1.1 teeing
// breaks Next body parsing, so it is intentionally not used here.
const TOOL_CAPTURE_PATH = process.env.CURSOR_TOOL_CAPTURE_PATH
  || "/root/.9router/captures/claude-code-169-tools.json";
const TOOL_CAPTURE_MIN = Number(process.env.CURSOR_TOOL_CAPTURE_MIN || 100);
let toolCaptureArmed = process.env.CURSOR_TOOL_CAPTURE === "1"
  && !fs.existsSync(TOOL_CAPTURE_PATH);

function maybeCaptureToolBody(rawBuf) {
  if (!toolCaptureArmed || !rawBuf?.length) return;
  try {
    const body = JSON.parse(rawBuf.toString("utf8"));
    const tools = body?.tools || body?.functions;
    if (!Array.isArray(tools) || tools.length < TOOL_CAPTURE_MIN) return;
    fs.mkdirSync(path.dirname(TOOL_CAPTURE_PATH), { recursive: true });
    const task = extractCaptureTask(body?.messages || []);
    fs.writeFileSync(TOOL_CAPTURE_PATH, JSON.stringify({
      capturedAt: new Date().toISOString(),
      source: "claude-code-live-request",
      toolCount: tools.length,
      model: body?.model || null,
      task,
      tools,
      messages: body?.messages || [],
    }));
    toolCaptureArmed = false;
    console.log(`[TOOL-CAPTURE] wrote ${tools.length} tools → ${TOOL_CAPTURE_PATH}`);
  } catch (error) {
    console.error("[TOOL-CAPTURE] failed:", error && error.message ? error.message : error);
  }
}

function extractCaptureTask(messages) {
  for (const message of messages) {
    if (message?.role !== "user") continue;
    let text = "";
    if (typeof message.content === "string") text = message.content;
    else if (Array.isArray(message.content)) {
      text = message.content
        .filter((part) => part?.type === "text" && part.text)
        .map((part) => part.text)
        .join("\n");
    }
    if (!text.trim()) continue;
    const withoutReminders = text
      .split(/<\/system-reminder>/i)
      .map((part) => part.replace(/<system-reminder>[\s\S]*$/i, "").trim())
      .filter(Boolean);
    return withoutReminders.at(-1) || text.trim();
  }
  return "";
}

let backgroundRefreshStarted = false;

function startBackgroundTokenRefreshFromCustomServer() {
  if (backgroundRefreshStarted) return;
  backgroundRefreshStarted = true;
  // Prefer source path (repo / standalone that still has src). Fail-open if missing
  // — initializeApp also starts the same scheduler when the Next app boots.
  const modPath = path.join(__dirname, "src", "sse", "services", "backgroundTokenRefresh.js");
  import(pathToFileURL(modPath).href)
    .then((m) => {
      try {
        m.startBackgroundTokenRefresh();
      } catch (e) {
        console.error("[BackgroundTokenRefresh] start failed:", e && e.message ? e.message : e);
      }
      const stop = () => {
        try {
          m.stopBackgroundTokenRefresh();
        } catch {
          /* ignore */
        }
      };
      process.once("SIGINT", stop);
      process.once("SIGTERM", stop);
    })
    .catch((e) => {
      // Expected in published CLI standalone (src/ not on disk). App bootstrap covers it.
      if (process.env.DEBUG_BACKGROUND_TOKEN_REFRESH) {
        console.error("[BackgroundTokenRefresh] import failed:", e && e.message ? e.message : e);
      }
    });
}

// Wrap Next standalone HTTP server: derive client IP from the TCP socket
// (unspoofable) and strip client-supplied forwarding headers so downstream
// rate-limiting keys on the real peer address instead of attacker-controlled XFF.
http.createServer = (...args) => {
  const handler = args.find((a) => typeof a === "function");
  const rest = args.filter((a) => typeof a !== "function");
  if (!handler) return origCreate(...args);
  const wrapped = (req, res) => {
    const socketIp = req.socket && req.socket.remoteAddress ? req.socket.remoteAddress : "";
    const xff = req.headers["x-forwarded-for"];
    const xRealIp = req.headers["x-real-ip"];
    const viaProxy = !!(xff || xRealIp);
    const isLoopbackProxy = socketIp === "127.0.0.1" || socketIp === "::1" || socketIp === "::ffff:127.0.0.1";
    // Trust forwarding headers only when the TCP peer is a local reverse proxy.
    // Direct/public sockets remain keyed by the unspoofable peer address.
    const proxyIp = xRealIp || (xff ? String(xff).split(",")[0].trim() : "");
    const ip = isLoopbackProxy && proxyIp ? proxyIp : socketIp;
    delete req.headers["x-9r-real-ip"];
    delete req.headers["x-forwarded-for"];
    delete req.headers["x-9r-via-proxy"];
    req.headers["x-9r-real-ip"] = ip;
    if (viaProxy) req.headers["x-9r-via-proxy"] = "1";
    return handler(req, res);
  };
  const server = origCreate(...rest, wrapped);
  server.once("listening", () => {
    startBackgroundTokenRefreshFromCustomServer();
  });
  const origEmit = server.emit;
  // JBR 25 sends h2c upgrades that the HTTP/1.1 server would otherwise close.
  server.emit = function (event, ...eventArgs) {
    const [req, socket, head] = eventArgs;
    if (event !== "upgrade" || String(req.headers.upgrade || "").toLowerCase() !== "h2c") {
      return origEmit.call(this, event, ...eventArgs);
    }

    const contentLength = Number(req.headers["content-length"] || 0);
    if (!Number.isSafeInteger(contentLength) || contentLength < 0) {
      socket.destroy();
      return true;
    }
    const chunks = [head];
    let received = head.length;
    const serve = () => {
      // Replay the upgraded request through the existing HTTP/1.1 handler.
      const replay = new http.IncomingMessage(socket);
      Object.assign(replay, { method: req.method, url: req.url, headers: req.headers, complete: true });
      const bodyBuf = received
        ? Buffer.concat(chunks, received).subarray(0, contentLength)
        : Buffer.alloc(0);
      maybeCaptureToolBody(bodyBuf);
      if (bodyBuf.length) replay.push(bodyBuf);
      replay.push(null);
      const res = new http.ServerResponse(replay);
      res.shouldKeepAlive = false;
      res.assignSocket(socket);
      res.once("finish", () => socket.end());
      Promise.resolve().then(() => wrapped(replay, res)).catch((error) => {
        console.error("Failed to downgrade h2c request", error);
        socket.destroy();
      });
    };
    if (received >= contentLength) serve();
    else {
      socket.on("data", function readBody(chunk) {
        chunks.push(chunk);
        received += chunk.length;
        if (received < contentLength) return;
        socket.off("data", readBody);
        serve();
      });
      socket.resume();
    }
    delete req.headers.upgrade;
    delete req.headers["http2-settings"];
    req.headers.connection = "close";
    return true;
  };
  return server;
};

if (require.main === module) require("./server.js");
