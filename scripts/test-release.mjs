#!/usr/bin/env node

/**
 * Release verification runner.
 *
 * The browser-heavy Vitest suite is reliable when split by feature area, but
 * can exceed local process timeouts when launched as one giant `npm test`.
 * This script is the repeatable release gate: it runs the same coverage in
 * bounded chunks, then builds, calibrates, and smoke-tests the packed package.
 */

import { spawnSync } from "node:child_process";
import { VITEST_SHARDS, vitestCommandForShard } from "./vitest-shards.mjs";

const steps = [
  ["npm", ["audit", "--omit=dev"]],
  ["npm", ["run", "typecheck"]],
  ["npm", ["run", "lint"]],
  ...VITEST_SHARDS.map(vitestCommandForShard),
  ["npm", ["run", "build"]],
  ["npm", ["run", "calibrate"]],
  ["npm", ["run", "calibration:corpus"]],
  ["npm", ["run", "calibration:matrix"]],
  ["npm", ["run", "smoke:pack"]],
  ["npm", ["run", "smoke:release"]],
];

for (const [command, args] of steps) {
  const useShell = process.platform === "win32";
  const label = `${command} ${args.join(" ")}`;
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
    console.error(`\nCould not run release verification step "${label}": ${result.error.message}`);
    process.exit(1);
  }
  if (result.status !== 0) {
    console.error(`\nRelease verification failed at: ${label}`);
    process.exit(result.status ?? 1);
  }
}

console.log("\nRelease verification passed.");

function shellQuote(value) {
  return `"${String(value).replace(/"/g, '\\"')}"`;
}
