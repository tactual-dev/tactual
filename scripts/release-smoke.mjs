#!/usr/bin/env node

/**
 * Release smoke runner.
 *
 * Deterministic local fixtures run on every release gate. Optional live URLs
 * can be supplied with TACTUAL_RELEASE_SMOKE_URLS as a comma/newline-separated
 * list; those results are written as evidence but should not be treated as a
 * stable CI corpus because public sites change.
 */

import { spawnSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const cli = resolve("dist/cli/index.js");
const outDir = resolve("build/release-smoke");

const localTargets = [
  {
    name: "good-page",
    url: pathToFileURL(resolve("fixtures/good-page.html")).href,
    args: ["--format", "json", "--summary-only", "--no-check-visibility"],
  },
  {
    name: "interactive-page",
    url: pathToFileURL(resolve("fixtures/interactive-page.html")).href,
    args: ["--format", "json", "--summary-only", "--probe", "--probe-mode", "fast", "--no-check-visibility"],
  },
  {
    name: "widget-contracts",
    url: pathToFileURL(resolve("fixtures/corpus-widget-contracts.html")).href,
    args: ["--format", "json", "--summary-only", "--probe", "--probe-mode", "fast", "--no-check-visibility"],
  },
];

const externalTargets = (process.env.TACTUAL_RELEASE_SMOKE_URLS ?? "")
  .split(/[\n,]+/)
  .map((url) => url.trim())
  .filter(Boolean)
  .map((url, index) => ({
    name: `external-${index + 1}`,
    url,
    args: [
      "--format",
      "json",
      "--summary-only",
      "--wait-time",
      "1000",
      "--detect-routes",
      "--auto-scroll",
      "--descend-frames",
      "--no-check-visibility",
      ...(process.env.TACTUAL_RELEASE_SMOKE_DISMISS_BANNERS === "1"
        ? ["--dismiss-banners"]
        : []),
    ],
  }));

const results = [];

await mkdir(outDir, { recursive: true });

for (const target of [...localTargets, ...externalTargets]) {
  console.log(`Smoke: ${target.name} ${target.url}`);
  const started = Date.now();
  const result = spawnSync(process.execPath, [cli, "analyze-url", target.url, ...target.args], {
    encoding: "utf-8",
    env: { ...process.env, NODE_NO_WARNINGS: "1" },
    timeout: 90_000,
  });
  const elapsedMs = Date.now() - started;
  if (result.status !== 0) {
    console.error(result.stderr || result.stdout);
    throw new Error(`Release smoke failed for ${target.name}`);
  }

  let parsed;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    parsed = { raw: result.stdout.trim() };
  }
  results.push({
    name: target.name,
    url: target.url,
    elapsedMs,
    stats: parsed.stats ?? parsed,
  });
}

await writeFile(
  resolve(outDir, "summary.json"),
  `${JSON.stringify({
    generatedAt: new Date().toISOString(),
    externalUrlCount: externalTargets.length,
    results,
  }, null, 2)}\n`,
  "utf-8",
);

console.log(`Release smoke passed (${results.length} target${results.length === 1 ? "" : "s"}).`);
console.log(`Evidence: ${resolve(outDir, "summary.json")}`);
