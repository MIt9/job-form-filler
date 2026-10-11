const assert = require("assert");

// Use a dedicated port so this never collides with a real running bridge-server.
process.env.BRIDGE_PORT = "8766";
const { startBridgeServer } = require("../server/bridge-server");

console.log("▶ Testing POST /api/command (generic bridge proxy used by mcp-server.js)...");

(async () => {
  const { server } = startBridgeServer();

  try {
    const res = await fetch("http://127.0.0.1:8766/api/command", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ command: "GET_ACTIVE_FORM", payload: {} })
    });
    const data = await res.json();

    // No extension connected in this test process, so the route must relay
    // sendToExtension's real error (proving IPC wiring works) instead of 404ing.
    assert.strictEqual(res.status, 500, "Should relay sendToExtension's rejection as HTTP 500");
    assert(
      /No active Chrome Extension connected/.test(data.error),
      "Should surface the real 'extension not connected' error, not a routing 404"
    );

    console.log("✔ /api/command tests passed!");

    // A web page must never reach the bridge (it serves personal data and drives the browser).
    const evil = await fetch("http://127.0.0.1:8766/api/status", { headers: { Origin: "https://evil.example" } });
    assert.strictEqual(evil.status, 403, "Web-page origins must be rejected");
    const ext = await fetch("http://127.0.0.1:8766/api/status", { headers: { Origin: "chrome-extension://abc" } });
    assert.strictEqual(ext.status, 200, "Extension origin must be allowed");
    assert.strictEqual(ext.headers.get("access-control-allow-origin"), "chrome-extension://abc");
    console.log("✔ Origin restriction tests passed!");

    // Test open_job_url and focus_tab tool calls and bridge routing
    const { callTool } = require("../server/mcp-server");

    await assert.rejects(
      () => callTool("open_job_url", { url: "chrome://settings" }),
      /Only http: and https: URLs are allowed/
    );
    await assert.rejects(
      () => callTool("open_job_url", { url: "file:///etc/passwd" }),
      /Only http: and https: URLs are allowed/
    );
    await assert.rejects(
      () => callTool("open_job_url", { url: "javascript:alert(1)" }),
      /Only http: and https: URLs are allowed/
    );
    await assert.rejects(
      () => callTool("focus_tab", {}),
      /Either tabId or urlSubstring must be provided/
    );

    // Relay to bridge (IPC wiring check)
    await assert.rejects(
      () => callTool("open_job_url", { url: "https://jobs.lever.co/example/123" }),
      /No active Chrome Extension connected/
    );
    await assert.rejects(
      () => callTool("focus_tab", { urlSubstring: "lever.co" }),
      /No active Chrome Extension connected/
    );

    // Test dedicated HTTP routes
    const openRes = await fetch("http://127.0.0.1:8766/api/open-job-url", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: "https://jobs.lever.co/example/123" })
    });
    assert.strictEqual(openRes.status, 500);

    const focusRes = await fetch("http://127.0.0.1:8766/api/focus-tab", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ urlSubstring: "lever.co" })
    });
    assert.strictEqual(focusRes.status, 500);

    console.log("✔ open_job_url and focus_tab validation and bridge routing tests passed!");
  } finally {
    server.close();
  }
})();
