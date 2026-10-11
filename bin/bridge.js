#!/usr/bin/env node

const { startBridgeServer } = require("../server/bridge-server.js");

console.log("==========================================");
console.log("⚡ Starting Job Form Filler Bridge Server");
console.log("==========================================");

startBridgeServer();
