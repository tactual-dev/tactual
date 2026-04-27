#!/usr/bin/env node

const args = process.argv.slice(2);
const isHttp =
  args.includes("--http") ||
  process.env.TRANSPORT === "http";

async function main(): Promise<void> {
  if (isHttp) {
    const { parseMcpHttpOptions } = await import("./cli-args.js");
    const { port, host } = parseMcpHttpOptions(args);
    const { startHttpServer } = await import("./http.js");
    await startHttpServer(port, host);
  } else {
    const { startMcpServer } = await import("./index.js");
    await startMcpServer();
  }
}

main().catch((err) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error("Failed to start Tactual MCP server:", message);
  process.exit(1);
});
