#!/usr/bin/env node

/**
 * Bounded Vitest shard runner.
 *
 * The full browser-heavy suite is intentionally split by feature area so local
 * release runs, CI retries, and debugging all use the same stable shard names.
 */

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export const VITEST_SHARDS = [
  {
    name: "core",
    description: "Core graph/scoring/profile/report/calibration tests",
    patterns: ["src/core", "src/scoring", "src/profiles", "src/rules", "src/reporters", "src/calibration"],
  },
  {
    name: "capture",
    description: "Capture, iframe descent, and CDP AX serializer tests",
    patterns: [
      "src/playwright/capture.test.ts",
      "src/playwright/capture-frames.test.ts",
      "src/playwright/cdp-ax-serializer.test.ts",
    ],
  },
  {
    name: "playwright-platform",
    description: "Low-level Playwright platform and simulator tests",
    patterns: [
      "src/playwright/aria-validator.test.ts",
      "src/playwright/cvd-simulation.test.ts",
      "src/playwright/event-listener-registry.test.ts",
      "src/playwright/framework-detect.test.ts",
      "src/playwright/framework-settle.test.ts",
      "src/playwright/route-tracker.test.ts",
      "src/playwright/safety.test.ts",
      "src/playwright/sr-simulator.test.ts",
    ],
  },
  {
    name: "playwright-probes",
    description: "Runtime probe and popup-discovery tests",
    patterns: [
      "src/playwright/auto-scroll.test.ts",
      "src/playwright/banner-dismiss.test.ts",
      "src/playwright/capture-tooltips.test.ts",
      "src/playwright/hover-probe.test.ts",
      "src/playwright/menu-probe.test.ts",
      "src/playwright/modal-probe.test.ts",
      "src/playwright/modal-trigger-probe.test.ts",
      "src/playwright/probes.test.ts",
      "src/playwright/tab-order.test.ts",
      "src/playwright/visibility-probe.test.ts",
      "src/playwright/widget-probe.test.ts",
    ],
  },
  {
    name: "playwright-exploration",
    description: "Exploration, DOM-invader, form, and viewport tests",
    patterns: [
      "src/playwright/composite-widget-probe.test.ts",
      "src/playwright/dom-invader.test.ts",
      "src/playwright/dom-invader-taint.test.ts",
      "src/playwright/evo-explorer.test.ts",
      "src/playwright/explorer.test.ts",
      "src/playwright/explorer-custom-triggers.test.ts",
      "src/playwright/form-error-probe.test.ts",
      "src/playwright/form-fill-probe.test.ts",
      "src/playwright/viewport-diff.test.ts",
    ],
  },
  {
    name: "pipeline",
    description: "Pipeline, MCP, CLI, validation, benchmark, and integration tests",
    patterns: [
      "src/pipeline",
      "src/mcp",
      "src/cli",
      "src/validation",
      "src/benchmark",
      "src/integration.test.ts",
      "src/integration-corpus.test.ts",
      "src/integration-calibration-fixtures.test.ts",
      "src/integration-filter.test.ts",
      "src/integration-report-golden.test.ts",
    ],
  },
];

export function findShard(name) {
  return VITEST_SHARDS.find((shard) => shard.name === name);
}

export function vitestCommandForShard(shard) {
  return ["npx", ["vitest", "run", ...shard.patterns]];
}

if (isMainModule()) {
  runCli(process.argv.slice(2));
}

function runCli(args) {
  if (args.includes("--help") || args.includes("-h")) {
    console.log(helpText());
    return;
  }

  if (args.includes("--list")) {
    printShardList();
    return;
  }

  const requested =
    args.includes("--all")
      ? VITEST_SHARDS.map((shard) => shard.name)
      : args.filter((arg) => arg !== "--all");
  if (requested.length === 0) {
    printShardList();
    return;
  }

  for (const name of requested) {
    const shard = findShard(name);
    if (!shard) {
      console.error(`Unknown Vitest shard: ${name}`);
      console.error(`Known shards: ${VITEST_SHARDS.map((item) => item.name).join(", ")}`);
      process.exit(1);
    }

    const [command, commandArgs] = vitestCommandForShard(shard);
    const status = runCommand(command, commandArgs, `vitest shard ${shard.name}`);
    if (status !== 0) process.exit(status);
  }
}

function runCommand(command, args, label) {
  const useShell = process.platform === "win32";
  console.log(`\n==> ${label}`);
  const spawnOptions = {
    stdio: "inherit",
    env: { ...process.env, FORCE_COLOR: process.env.FORCE_COLOR ?? "1" },
  };
  const result = useShell
    ? spawnSync([command, ...args.map(shellQuote)].join(" "), {
        ...spawnOptions,
        shell: true,
      })
    : spawnSync(command, args, spawnOptions);
  if (result.error) {
    console.error(`Could not run ${label}: ${result.error.message}`);
    return 1;
  }
  return result.status ?? 1;
}

function helpText() {
  return `Vitest shard runner

Usage:
  node scripts/vitest-shards.mjs
  node scripts/vitest-shards.mjs --list
  node scripts/vitest-shards.mjs <shard> [<shard> ...]
  node scripts/vitest-shards.mjs --all

Known shards:
${VITEST_SHARDS.map((shard) => `  ${shard.name.padEnd(24)} ${shard.description}`).join("\n")}
`;
}

function printShardList() {
  for (const shard of VITEST_SHARDS) {
    console.log(`${shard.name}\t${shard.description}`);
  }
}

function isMainModule() {
  return process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1];
}

function shellQuote(value) {
  return `"${String(value).replace(/"/g, '\\"')}"`;
}
