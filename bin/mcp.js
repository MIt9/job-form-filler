#!/usr/bin/env node

const { runMcpServer } = require("../server/mcp-server.js");

runMcpServer().catch((err) => {
  console.error("Fatal MCP server error:", err);
  process.exit(1);
});
