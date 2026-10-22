const assert = require("assert");
const http = require("http");
const WebSocket = require("ws");

// Real scenario: Claude Desktop's bridge owned the port, this MCP process reused it, then Desktop quit.
// The next tool call must take the port over and wait for the extension to reconnect instead of failing
// with "Bridge server is not running" until the MCP client is restarted.
process.env.BRIDGE_PORT = "8769";
delete process.env.RESUME_REPO_PATH;
const mcp = require("../server/mcp-server");

console.log("▶ Testing MCP bridge takeover after the port owner exits...");

const listen = (srv) => new Promise((r) => srv.listen(8769, "127.0.0.1", r));

(async () => {
  // Stand-in for another client's bridge, started with a different resume folder.
  const other = http.createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(req.url === "/api/status" ? { status: "ok", resumeRepoPath: "/other/resumes" } : { data: { from: "other" } }));
  });
  await listen(other);

  const bridge = mcp.initBridge();
  await new Promise((r) => setTimeout(r, 200));
  assert.strictEqual(bridge.server.listening, false, "port is busy, so this process reuses the other bridge");

  const warning = await mcp.bridgeConfigWarning();
  assert.match(warning, /\/other\/resumes/);
  assert.match(warning, /RESUME_REPO_PATH/, "warning tells how to fix it");
  assert.doesNotMatch(warning, /restart this extension/, "the extension is not what needs restarting");
  assert.deepStrictEqual(await mcp.callBridge("GET_ACTIVE_FORM"), { from: "other" });

  // The other client quits. The extension reconnects on its own timer, a bit later.
  await new Promise((r) => other.close(r));
  setTimeout(function connectExtension() {
    const ws = new WebSocket("ws://127.0.0.1:8769/ws", { origin: "chrome-extension://mldoeaodmjbjmkpnchkhaahpaphoffei" });
    ws.on("error", () => setTimeout(connectExtension, 100));
    ws.on("message", (raw) => {
      const { requestId, command } = JSON.parse(raw);
      ws.send(JSON.stringify({ requestId, response: { success: true, data: { from: "taken-over", command } } }));
    });
  }, 300);

  const result = await mcp.callBridge("GET_ACTIVE_FORM");
  assert.deepStrictEqual(result, { from: "taken-over", command: "GET_ACTIVE_FORM" });
  assert.strictEqual(bridge.server.listening, true, "this process now owns the port");
  assert.strictEqual(await mcp.bridgeConfigWarning(), null, "own bridge uses own settings: no warning");

  console.log("✔ Bridge takeover tests passed!");
  process.exit(0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
