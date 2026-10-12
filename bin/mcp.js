#!/usr/bin/env node

// An unset optional MCPB setting may arrive as the literal "${user_config.…}" placeholder: treat it as unset.
if (/^\$\{/.test(process.env.RESUME_REPO_PATH || "")) delete process.env.RESUME_REPO_PATH;

const { runMcpServer } = require("../server/mcp-server.js");

runMcpServer().catch((err) => {
  console.error("Fatal MCP server error:", err);
  process.exit(1);
});
