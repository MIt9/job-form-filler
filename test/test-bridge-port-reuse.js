const assert = require("assert");
const net = require("net");

// Real scenario that killed the MCP server: a bridge already owns the port (started separately), the MCP process then
// starts its own bridge, gets EADDRINUSE, and must reuse the running one instead of crashing on an unhandled
// 'error' event of the WebSocketServer.
process.env.BRIDGE_PORT = "8768";
const { startBridgeServer } = require("../server/bridge-server");

console.log("▶ Testing bridge start when the port is already in use...");

let uncaught = null;
process.on("uncaughtException", (e) => { uncaught = e; });

const first = startBridgeServer();
const listening = new Promise((resolve) => first.server.once("listening", resolve));

listening
  .then(async () => {
    const second = startBridgeServer(); // same port: must log "reusing the running bridge", not throw
    await new Promise((r) => setTimeout(r, 400));
    assert.strictEqual(uncaught, null, `second bridge on a busy port must not crash: ${uncaught && uncaught.message}`);
    assert.strictEqual(second.server.listening, false, "second server did not bind");
    assert.strictEqual(first.server.listening, true, "first bridge keeps serving");
    // a raw TCP probe confirms the first one still answers on the port
    await new Promise((resolve, reject) => {
      const s = net.connect(8768, "127.0.0.1", () => { s.end(); resolve(); });
      s.on("error", reject);
    });
    console.log("✔ Bridge port-reuse tests passed!");
    first.server.close();
    first.wss.close();
    process.exit(0);
  })
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
