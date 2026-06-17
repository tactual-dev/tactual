#!/usr/bin/env node

/**
 * Tiny static server for deterministic NVDA VM calibration fixtures.
 *
 * The host analyzes `http://127.0.0.1:<port>/...` while the guest opens the
 * same fixture through its NAT host alias, usually `http://10.0.2.2:<port>/...`.
 * Serving fixtures over HTTP avoids the Windows shared-folder/file-url path
 * where Edge can focus controls but NVDA logging has proven unreliable.
 */

import { createReadStream } from "node:fs";
import { createServer } from "node:http";
import { mkdir, stat, writeFile } from "node:fs/promises";
import { dirname, extname, resolve, sep } from "node:path";

const opts = parseArgs(process.argv.slice(2));
const root = resolve(opts.root ?? process.cwd());
const host = opts.host ?? "0.0.0.0";
const port = parsePort(opts.port ?? "41789");
const secondaryPort = opts.secondaryPort === undefined
  ? port + 1
  : parsePort(opts.secondaryPort);

const contentTypes = new Map([
  [".css", "text/css; charset=utf-8"],
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".svg", "image/svg+xml"],
  [".txt", "text/plain; charset=utf-8"],
]);

const servers = [];

const primaryServer = createStaticServer();
servers.push(primaryServer);
let secondaryServer = null;
if (secondaryPort !== port) {
  secondaryServer = createStaticServer();
  servers.push(secondaryServer);
}

primaryServer.listen(port, host, async () => {
  const address = primaryServer.address();
  const actualPort = typeof address === "object" && address ? address.port : port;
  const secondary = await listenSecondary();
  const ready = {
    schema: "tactual-nvda-vm-fixture-server@1",
    root,
    host,
    port: actualPort,
    secondaryPort: secondary?.port ?? null,
    pid: process.pid,
    startedAt: new Date().toISOString(),
  };
  if (opts.readyFile) {
    await mkdir(dirname(resolve(opts.readyFile)), { recursive: true });
    await writeFile(resolve(opts.readyFile), `${JSON.stringify(ready, null, 2)}\n`, "utf-8");
  }
  console.log(JSON.stringify(ready));
});

function createStaticServer() {
  return createServer(async (req, res) => {
  try {
    if (!req.url || req.method !== "GET") {
      respond(res, 405, "method not allowed");
      return;
    }

    const url = new URL(req.url, "http://tactual.local");
    const pathname = decodeURIComponent(url.pathname);
    const filePath = resolve(root, `.${pathname}`);
    if (!isInsideRoot(filePath, root)) {
      respond(res, 403, "forbidden");
      return;
    }

    const file = await stat(filePath).catch(() => null);
    if (!file?.isFile()) {
      respond(res, 404, "not found");
      return;
    }

    res.writeHead(200, {
      "content-type": contentTypes.get(extname(filePath).toLowerCase()) ?? "application/octet-stream",
      "cache-control": "no-store",
    });
    createReadStream(filePath).pipe(res);
  } catch (err) {
    respond(res, 500, err instanceof Error ? err.message : String(err));
  }
  });
}

async function listenSecondary() {
  if (!secondaryServer) return null;
  return new Promise((resolveListen, rejectListen) => {
    secondaryServer.once("error", rejectListen);
    secondaryServer.listen(secondaryPort, host, () => {
      secondaryServer.off("error", rejectListen);
      const address = secondaryServer.address();
      const actualPort = typeof address === "object" && address ? address.port : secondaryPort;
      resolveListen({ port: actualPort });
    });
  });
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    let pending = servers.length;
    for (const server of servers) {
      server.close(() => {
        pending -= 1;
        if (pending === 0) process.exit(0);
      });
    }
  });
}

function parseArgs(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith("--")) {
      throw new Error(`Unexpected positional argument: ${arg}`);
    }
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`Missing value for ${arg}`);
    }
    index += 1;
    parsed[toCamel(arg)] = value;
  }
  return parsed;
}

function toCamel(flag) {
  return flag.replace(/^--/, "").replace(/-([a-z])/g, (_, char) => char.toUpperCase());
}

function parsePort(value) {
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 65535) {
    throw new Error(`Invalid --port value: ${value}`);
  }
  return parsed;
}

function isInsideRoot(filePath, rootPath) {
  const normalizedRoot = rootPath.endsWith(sep) ? rootPath : `${rootPath}${sep}`;
  return filePath === rootPath || filePath.startsWith(normalizedRoot);
}

function respond(res, status, body) {
  res.writeHead(status, { "content-type": "text/plain; charset=utf-8" });
  res.end(`${body}\n`);
}
