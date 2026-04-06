#!/usr/bin/env node

const args = process.argv.slice(2);
const isHttp =
  args.includes("--http") ||
  process.env.TRANSPORT === "http";

async function main(): Promise<void> {
  if (isHttp) {
    const portStr =
      args.find((a) => a.startsWith("--port="))?.split("=")[1] ??
      process.env.PORT ??
      "8787";
    const port = parseInt(portStr, 10);
    const { startHttpServer } = await import("./http.js");
    await startHttpServer(port);
  } else {
    const { startMcpServer } = await import("./index.js");
    await startMcpServer();
  }
}

main().catch((err) => {
  console.error("Failed to start Tactual MCP server:", err);
  process.exit(1);
});
