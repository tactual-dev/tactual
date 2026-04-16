/**
 * Tactual MCP Server — Streamable HTTP transport
 *
 * Session-based HTTP endpoint for hosted platforms (Smithery, Glama, etc.)
 * and any client that prefers HTTP over stdio.
 *
 * POST   /mcp     — MCP JSON-RPC requests (initialize, tools/list, tools/call, etc.)
 * GET    /mcp     — SSE stream for server-initiated notifications (optional)
 * DELETE /mcp     — Terminate a session
 * GET    /health  — Readiness probe
 *
 * Each client gets an isolated session with its own MCP server instance.
 * The browser pool is shared across all sessions for performance.
 * Idle sessions are cleaned up after 10 minutes.
 */

import http from "node:http";
import { randomUUID } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createMcpServer, closeSharedBrowser } from "./index.js";
import { VERSION } from "../version.js";

interface Session {
  transport: StreamableHTTPServerTransport;
  server: McpServer;
  lastActivity: number;
}

const SESSION_TTL_MS = 10 * 60 * 1000; // 10 minutes

const MAX_BODY_SIZE = 1024 * 1024; // 1 MB

const BODY_TIMEOUT_MS = 30_000; // 30 seconds

function parseBody(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let data = "";
    const timer = setTimeout(() => {
      req.destroy();
      reject(new Error("Request body timeout"));
    }, BODY_TIMEOUT_MS);
    req.on("data", (chunk: Buffer) => {
      data += chunk.toString();
      if (data.length > MAX_BODY_SIZE) {
        req.destroy();
        reject(new Error("Request body too large"));
      }
    });
    req.on("end", () => {
      clearTimeout(timer);
      try {
        resolve(JSON.parse(data));
      } catch (e) {
        reject(e);
      }
    });
    req.on("error", (e) => { clearTimeout(timer); reject(e); });
  });
}

function jsonError(
  res: http.ServerResponse,
  status: number,
  code: number,
  message: string,
): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ jsonrpc: "2.0", error: { code, message }, id: null }));
}

export async function startHttpServer(port: number, host = "127.0.0.1"): Promise<http.Server> {
  const sessions = new Map<string, Session>();

  // Cleanup stale sessions every minute
  const cleanup = setInterval(() => {
    const now = Date.now();
    for (const [id, session] of sessions) {
      if (now - session.lastActivity > SESSION_TTL_MS) {
        try { session.transport.close(); } catch { /* ignore */ }
        try { session.server.close(); } catch { /* ignore */ }
        sessions.delete(id);
      }
    }
  }, 60_000);
  cleanup.unref();

  const httpServer = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);

    // Health check
    if (url.pathname === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          status: "ok",
          version: VERSION,
          sessions: sessions.size,
        }),
      );
      return;
    }

    // Only /mcp from here
    if (url.pathname !== "/mcp") {
      res.writeHead(404).end();
      return;
    }

    // --- POST /mcp ---
    if (req.method === "POST") {
      try {
        const body = await parseBody(req);
        const sessionId = req.headers["mcp-session-id"] as string | undefined;

        // Existing session
        if (sessionId && sessions.has(sessionId)) {
          const session = sessions.get(sessionId)!;
          session.lastActivity = Date.now();
          await session.transport.handleRequest(req, res, body);
          return;
        }

        // Unknown session ID
        if (sessionId) {
          jsonError(res, 404, -32000, "Session not found. Send initialize to start a new session.");
          return;
        }

        // No session ID — must be an initialize request
        const isInit = Array.isArray(body)
          ? body.some((msg) => isInitializeRequest(msg))
          : isInitializeRequest(body);
        if (!isInit) {
          jsonError(res, 400, -32600, "Missing session ID. Send initialize first to create a session.");
          return;
        }

        // Create new session
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (newSessionId: string) => {
            sessions.set(newSessionId, {
              transport,
              server,
              lastActivity: Date.now(),
            });
          },
        });

        transport.onclose = () => {
          if (transport.sessionId) {
            sessions.delete(transport.sessionId);
          }
        };

        const server = createMcpServer();
        await server.connect(transport);
        await transport.handleRequest(req, res, body);
      } catch (err) {
        if (!res.headersSent) {
          jsonError(res, 400, -32700, err instanceof Error ? err.message : "Parse error");
        }
      }
      return;
    }

    // --- GET /mcp --- SSE stream for server-initiated notifications
    if (req.method === "GET") {
      const sessionId = req.headers["mcp-session-id"] as string | undefined;
      if (sessionId && sessions.has(sessionId)) {
        const session = sessions.get(sessionId)!;
        session.lastActivity = Date.now();
        await session.transport.handleRequest(req, res);
        return;
      }
      jsonError(res, 400, -32000, "Invalid or missing session ID.");
      return;
    }

    // --- DELETE /mcp --- Session termination
    if (req.method === "DELETE") {
      const sessionId = req.headers["mcp-session-id"] as string | undefined;
      if (sessionId && sessions.has(sessionId)) {
        const session = sessions.get(sessionId)!;
        try { await session.transport.close(); } catch { /* ignore */ }
        try { await session.server.close(); } catch { /* ignore */ }
        sessions.delete(sessionId);
        res.writeHead(204).end();
        return;
      }
      jsonError(res, 404, -32000, "Session not found.");
      return;
    }

    res.writeHead(405).end();
  });

  // Close browser pool and sessions on server shutdown
  httpServer.on("close", () => {
    clearInterval(cleanup);
    for (const [, session] of sessions) {
      try { session.transport.close(); } catch { /* ignore */ }
      try { session.server.close(); } catch { /* ignore */ }
    }
    sessions.clear();
    closeSharedBrowser();
  });

  return new Promise((resolve) => {
    httpServer.listen(port, host, () => {
      console.error(
        `Tactual MCP server v${VERSION} (HTTP) listening on http://${host}:${port}/mcp`,
      );
      resolve(httpServer);
    });
  });
}
