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
    if (isNaN(port) || port < 1 || port > 65535) {
      console.error(`Invalid port: ${portStr}. Must be 1-65535.`);
      process.exit(1);
    }
    const host =
      args.find((a) => a.startsWith("--host="))?.split("=")[1] ??
      process.env.HOST ??
      "127.0.0.1";
    if (!host) {
      console.error("Invalid --host: value cannot be empty.");
      process.exit(1);
    }
    const { startHttpServer } = await import("./http.js");
    await startHttpServer(port, host);
  } else {
    const { startMcpServer } = await import("./index.js");
    await startMcpServer();
  }
}

main().catch((err) => {
  console.error("Failed to start Tactual MCP server:", err);
  process.exit(1);
});
