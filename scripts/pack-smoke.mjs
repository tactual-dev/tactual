import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const npm = process.platform === "win32" ? "cmd.exe" : "npm";
const node = process.execPath;
let lastStdout = "";

const workDir = await mkdtemp(join(tmpdir(), "tactual-pack-smoke-"));
const packDir = join(workDir, "pack");
const projectDir = join(workDir, "project");

try {
  await mkdir(packDir, { recursive: true });
  await mkdir(projectDir, { recursive: true });
  runNpm(["pack", "--pack-destination", packDir], { cwd: repoRoot });
  const pkg = JSON.parse(await readFile(join(repoRoot, "package.json"), "utf-8"));
  const filename = (await readdir(packDir)).find((entry) => entry.endsWith(".tgz"));
  if (!filename) {
    throw new Error(`npm pack did not create a .tgz in ${packDir}`);
  }
  const tarballPath = join(packDir, filename);
  if (!existsSync(tarballPath)) {
    throw new Error(`npm pack did not create ${tarballPath}`);
  }

  runNpm(["init", "-y"], { cwd: projectDir });
  runNpm(["install", "--ignore-scripts", "--omit=dev", tarballPath], { cwd: projectDir });

  const smokeFile = join(projectDir, "smoke.mjs");
  await writeFile(
    smokeFile,
    `
      import { listProfiles, getProfile, formatReport } from "tactual";
      import { createMcpServer } from "tactual/mcp";
      import { validateFindings } from "tactual/validation";

      const profiles = listProfiles();
      if (!profiles.includes("generic-mobile-web-sr-v0")) {
        throw new Error("generic profile missing from package export");
      }
      if (!getProfile("nvda-desktop-v0")) {
        throw new Error("desktop profile missing from package export");
      }
      if (typeof formatReport !== "function") {
        throw new Error("formatReport export missing");
      }
      if (!createMcpServer()) {
        throw new Error("MCP server export did not create a server");
      }
      if (typeof validateFindings !== "function") {
        throw new Error("validation export missing");
      }
    `,
    "utf-8",
  );
  run(node, [smokeFile], { cwd: projectDir });

  const cliPath = join(projectDir, "node_modules", "tactual", "dist", "cli", "index.js");
  const mcpCliPath = join(projectDir, "node_modules", "tactual", "dist", "mcp", "cli.js");
  const cliVersion = run(node, [cliPath, "--version"], { cwd: projectDir }).trim();
  if (cliVersion !== pkg.version) {
    throw new Error(`CLI version ${cliVersion} did not match package ${pkg.version}`);
  }
  const cliHelp = run(node, [cliPath, "analyze-url", "--help"], { cwd: projectDir });
  const expectedAnalyzeFlags = [
    "--probe-strategy",
    "--summary-only",
    "--explore-timeout",
    "--scope-selector",
    "--entry-selector",
    "--goal-target",
    "--check-visibility",
    "--also-json",
  ];
  const missingAnalyzeFlags = expectedAnalyzeFlags.filter((flag) => !cliHelp.includes(flag));
  if (missingAnalyzeFlags.length > 0) {
    throw new Error(
      `Installed CLI help is missing expected analyze-url flags: ${missingAnalyzeFlags.join(", ")}`,
    );
  }
  const mcpInvalidPort = runExpectFailure(node, [mcpCliPath, "--http", "--port=0"], {
    cwd: projectDir,
  });
  if (!mcpInvalidPort.includes("Invalid port: 0")) {
    throw new Error("Installed MCP CLI did not execute its startup validation");
  }

  console.log(
    `Pack smoke passed: ${pkg.name}@${pkg.version} installed from ${filename}`,
  );
} finally {
  await rm(workDir, { recursive: true, force: true });
}

function run(command, args, options = {}) {
  const cwd = options.cwd ?? repoRoot;
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf-8",
    env: { ...process.env, NODE_NO_WARNINGS: "1" },
    shell: process.platform === "win32" && command.endsWith(".cmd"),
  });
  if (result.status !== 0) {
    const stdout = result.stdout?.trim() ?? "";
    const stderr = result.stderr?.trim() ?? "";
    throw new Error(
      [
        `Command failed: ${command} ${args.join(" ")}`,
        result.error?.message,
        stdout,
        stderr,
      ]
        .filter(Boolean)
        .join("\n"),
    );
  }
  lastStdout = result.stdout ?? "";
  return lastStdout;
}

function runExpectFailure(command, args, options = {}) {
  const cwd = options.cwd ?? repoRoot;
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf-8",
    env: { ...process.env, NODE_NO_WARNINGS: "1" },
    shell: process.platform === "win32" && command.endsWith(".cmd"),
  });
  if (result.status === 0) {
    throw new Error(`Command unexpectedly succeeded: ${command} ${args.join(" ")}`);
  }
  return `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
}

function runNpm(args, options = {}) {
  return run(npm, process.platform === "win32" ? ["/d", "/s", "/c", formatCmd("npm", args)] : args, options);
}

function formatCmd(command, args) {
  return [command, ...args.map(quoteCmdArg)].join(" ");
}

function quoteCmdArg(arg) {
  const value = String(arg);
  return /[\s&()^|<>"]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}
