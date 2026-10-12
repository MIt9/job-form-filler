const http = require("http");
const fs = require("fs");
const { WebSocketServer } = require("ws");
const { loadProfiles, DEFAULT_RESUME_REPO_PATH } = require("./profile-loader");
const { saveApplication } = require("./app-saver");
const { getLearnedAnswers, saveLearnedAnswers } = require("./learned-answers");

const PORT = process.env.BRIDGE_PORT || 8765;

let activeWsClient = null;
const pendingRequests = new Map();

/**
 * Sends a command to the connected Chrome Extension and waits for reply
 */
function sendToExtension(command, payload = {}, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    if (!activeWsClient || activeWsClient.readyState !== 1) {
      return reject(new Error("No active Chrome Extension connected via WebSocket. Ensure extension is loaded and active."));
    }

    const requestId = "req_" + Date.now() + "_" + Math.random().toString(36).slice(2, 7);
    const timeout = setTimeout(() => {
      pendingRequests.delete(requestId);
      reject(new Error(`Timeout waiting for extension response to ${command}`));
    }, timeoutMs);

    pendingRequests.set(requestId, { resolve, reject, timeout });

    activeWsClient.send(
      JSON.stringify({
        command,
        requestId,
        payload
      })
    );
  });
}

// The bridge serves personal data and drives the browser, so only the extension and local
// processes (MCP server, curl: no Origin header) may call it — never a web page. The Host check
// blocks DNS-rebinding (a web page reaching 127.0.0.1 through its own domain name).
// The Chrome Web Store build is always trusted. A "Load unpacked" build has a different ID: add it via
// JFF_EXTENSION_IDS (comma-separated), or set JFF_ALLOW_ANY_EXTENSION=1 for local dev only (any installed
// extension could then read the profile, so it is warned once).
const STORE_EXTENSION_ID = "mldoeaodmjbjmkpnchkhaahpaphoffei";
const ALLOWED_EXTENSION_IDS = [STORE_EXTENSION_ID, ...(process.env.JFF_EXTENSION_IDS || "").split(",").map((s) => s.trim()).filter(Boolean)];
const ALLOW_ANY_EXTENSION = process.env.JFF_ALLOW_ANY_EXTENSION === "1";
if (ALLOW_ANY_EXTENSION) {
  console.error("[bridge] WARNING: JFF_ALLOW_ANY_EXTENSION=1 — accepting any chrome-extension:// origin. Dev only.");
}

function isTrustedRequest(req) {
  const origin = req.headers.origin;
  const host = (req.headers.host || "").replace(/:\d+$/, "");
  if (!["127.0.0.1", "localhost"].includes(host)) return false;
  if (!origin) return true;
  if (ALLOW_ANY_EXTENSION) return origin.startsWith("chrome-extension://");
  return ALLOWED_EXTENSION_IDS.some((id) => origin === `chrome-extension://${id}`);
}

function startBridgeServer() {
  const server = http.createServer(async (req, res) => {
    if (!isTrustedRequest(req)) {
      res.writeHead(403, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Forbidden origin" }));
      return;
    }

    if (req.headers.origin) res.setHeader("Access-Control-Allow-Origin", req.headers.origin);
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    const url = new URL(req.url, `http://${req.headers.host}`);

    // Health check
    if (url.pathname === "/api/status" && req.method === "GET") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          status: "ok",
          version: "1.0.0",
          extensionConnected: !!(activeWsClient && activeWsClient.readyState === 1),
          timestamp: new Date().toISOString()
        })
      );
      return;
    }

    // Inspect active form on Chrome tab
    if (url.pathname === "/api/active-form" && req.method === "GET") {
      try {
        const result = await sendToExtension("GET_ACTIVE_FORM");
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(result));
      } catch (err) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err.message }));
      }
      return;
    }

    // Scan raw fields on active Chrome tab
    if (url.pathname === "/api/scan-fields" && req.method === "GET") {
      try {
        const result = await sendToExtension("SCAN_FIELDS");
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(result));
      } catch (err) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err.message }));
      }
      return;
    }

    // Check if application was submitted (reads page headline only, no form rescan)
    if (url.pathname === "/api/submission-status" && req.method === "GET") {
      try {
        const result = await sendToExtension("GET_SUBMISSION_STATUS");
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(result));
      } catch (err) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err.message }));
      }
      return;
    }

    // Trigger autofill static fields on active Chrome tab
    if (url.pathname === "/api/autofill-static" && req.method === "POST") {
      try {
        const result = await sendToExtension("AUTOFILL_STATIC");
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(result));
      } catch (err) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err.message }));
      }
      return;
    }

    // Open a job URL in a new active Chrome tab
    if (url.pathname === "/api/open-job-url" && req.method === "POST") {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", async () => {
        try {
          const payload = JSON.parse(body || "{}");
          const result = await sendToExtension("OPEN_JOB_URL", payload, 20000);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(result));
        } catch (err) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: err.message }));
        }
      });
      return;
    }

    // Focus an existing tab by ID or URL substring
    if (url.pathname === "/api/focus-tab" && req.method === "POST") {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", async () => {
        try {
          const payload = JSON.parse(body || "{}");
          const result = await sendToExtension("FOCUS_TAB", payload);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(result));
        } catch (err) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: err.message }));
        }
      });
      return;
    }

    // Generic command proxy: lets the MCP server (a separate OS process with its own
    // dead copy of activeWsClient) reach the real, in-process sendToExtension().
    if (url.pathname === "/api/command" && req.method === "POST") {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", async () => {
        try {
          const { command, payload } = JSON.parse(body || "{}");
          const timeoutMs = command === "OPEN_JOB_URL" ? 20000 : 15000;
          const result = await sendToExtension(command, payload || {}, timeoutMs);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(result));
        } catch (err) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: err.message }));
        }
      });
      return;
    }

    // List candidate profiles
    if (url.pathname === "/api/profiles" && req.method === "GET") {
      try {
        const data = loadProfiles();
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(data));
      } catch (err) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err.message }));
      }
      return;
    }

    // Save application to RESUME_REPO_PATH
    if (url.pathname === "/api/save-application" && req.method === "POST") {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", async () => {
        try {
          const payload = JSON.parse(body || "{}");
          const result = saveApplication(payload);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(result));
        } catch (err) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: err.message }));
        }
      });
      return;
    }

    // Get learned custom question answers
    if (url.pathname === "/api/learned-answers" && req.method === "GET") {
      try {
        const answers = getLearnedAnswers();
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ answers }));
      } catch (err) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err.message }));
      }
      return;
    }

    // Save learned custom answers into profile repo
    if (url.pathname === "/api/learned-answers" && req.method === "POST") {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", async () => {
        try {
          const payload = JSON.parse(body || "{}");
          const result = saveLearnedAnswers(payload.answers || {});
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(result));
        } catch (err) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: err.message }));
        }
      });
      return;
    }

    // Serve the role variant's resume PDF (only when RESUME_REPO_PATH is configured).
    // The extension prefers a resume uploaded in its popup; this is the fallback.
    if (url.pathname === "/api/resume-pdf" && req.method === "GET") {
      try {
        const profiles = loadProfiles().profiles;
        const profile = profiles[url.searchParams.get("profile")] || Object.values(profiles).find((p) => p.pdfPath);

        if (!profile?.pdfPath) {
          res.writeHead(404, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "PDF resume not found (set RESUME_REPO_PATH or upload a resume in the popup)" }));
          return;
        }

        const fileBuffer = fs.readFileSync(profile.pdfPath);
        if (url.searchParams.get("format") === "base64") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ fileName: profile.pdfFileName, mimeType: "application/pdf", base64: fileBuffer.toString("base64") }));
          return;
        }

        res.writeHead(200, {
          "Content-Type": "application/pdf",
          "Content-Disposition": `inline; filename="${encodeURIComponent(profile.pdfFileName)}"`,
          "Content-Length": fileBuffer.length
        });
        res.end(fileBuffer);
      } catch (err) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err.message }));
      }
      return;
    }

    // 404
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Not found" }));
  });

  // WebSocket Server
  const wss = new WebSocketServer({ server, path: "/ws", verifyClient: ({ req }) => isTrustedRequest(req) });
  // The http server re-emits its listen errors on the WebSocketServer; without a handler EADDRINUSE crashes the process
  // even though a running bridge on the port is exactly the supported case (handled on `server` below).
  wss.on("error", (err) => {
    if (err.code !== "EADDRINUSE") console.error("[Bridge WS] server error:", err.message);
  });

  wss.on("connection", (ws) => {
    console.error("[Bridge WS] Chrome Extension connected");
    activeWsClient = ws;

    ws.on("message", (data) => {
      try {
        const msg = JSON.parse(data.toString());
        // Ignore keepalive pings from the extension SW
        if (msg.type === "ping") return;
        if (msg.requestId && pendingRequests.has(msg.requestId)) {
          const { resolve, timeout } = pendingRequests.get(msg.requestId);
          clearTimeout(timeout);
          pendingRequests.delete(msg.requestId);
          resolve(msg.response);
        }
      } catch (err) {
        console.error("[Bridge WS] Error parsing message:", err);
      }
    });

    ws.on("close", () => {
      console.error("[Bridge WS] Chrome Extension disconnected");
      if (activeWsClient === ws) activeWsClient = null;
    });

    ws.on("error", (err) => {
      console.error("[Bridge WS] WebSocket error:", err.message);
    });

    // Send heartbeat ping every 25 seconds to keep connection alive in Chrome MV3
    const pingInterval = setInterval(() => {
      if (ws.readyState === 1) {
        ws.ping();
      } else {
        clearInterval(pingInterval);
      }
    }, 25000);
  });

  // Several MCP clients can each spawn this process; the first owns the port, the rest reuse it over HTTP.
  server.on("error", (err) => {
    if (err.code !== "EADDRINUSE") throw err;
    console.error(`[Bridge Server] Port ${PORT} already in use — reusing the running bridge`);
  });

  server.listen(PORT, "127.0.0.1", () => {
    console.error(`[Bridge Server] Running on http://127.0.0.1:${PORT} and http://localhost:${PORT}`);
    console.error(`[Bridge Server] WebSocket ready at ws://127.0.0.1:${PORT}/ws`);
    if (DEFAULT_RESUME_REPO_PATH) {
      console.error(`[Bridge Server] Resume repo path: ${DEFAULT_RESUME_REPO_PATH}`);
    } else {
      console.error("[Bridge Server] No resume repo configured; resume attach will fail");
    }
  });

  return { server, wss, sendToExtension };
}

module.exports = {
  startBridgeServer,
  sendToExtension
};
