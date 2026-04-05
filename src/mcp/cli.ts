#!/usr/bin/env node

import { startMcpServer } from "./index.js";

startMcpServer().catch((err) => {
  console.error("Failed to start Tactual MCP server:", err);
  process.exit(1);
});
