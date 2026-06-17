#!/usr/bin/env node

/**
 * Guest-side NVDA smoke driver.
 *
 * Run this inside the Windows VM after starting NVDA with the isolated
 * `nvda-vm-guest-bootstrap.ps1 -StartNvda` path. In the canonical smoke flow,
 * `nvda-vm-host-smoke.ps1` calls this with `--prepare-only`, launches Edge as
 * a normal guest desktop app, and sends VirtualBox keyboard scancodes. That
 * path gives NVDA the same desktop accessibility events as real Tab presses.
 *
 * The direct Playwright mode remains useful for diagnosing browser/log setup,
 * but it is weaker calibration evidence because script-driven focus can miss
 * desktop events that NVDA normally consumes.
 */

import { chromium } from "playwright";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

const captureRoot = process.env.TACTUAL_NVDA_CAPTURE_ROOT ?? "C:\\TactualNvdaCapture";
const logPath = process.env.TACTUAL_NVDA_LOG ?? join(captureRoot, "nvda-io.log");
const outPath = process.env.TACTUAL_NVDA_SMOKE_OUT ?? join(captureRoot, "nvda-smoke-result.json");
const pagePath = join(captureRoot, "nvda-smoke.html");
const edgePath =
  process.env.TACTUAL_CHROMIUM_PATH ??
  firstExisting([
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
  ]);

if (!edgePath) {
  throw new Error("Could not find Chrome or Edge. Set TACTUAL_CHROMIUM_PATH.");
}

await mkdir(dirname(outPath), { recursive: true });
await writeFile(
  pagePath,
  `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <title>Tactual NVDA smoke</title>
    <style>
      body { font-family: system-ui, sans-serif; margin: 48px; }
      main { display: grid; gap: 18px; max-width: 520px; }
      label { display: grid; gap: 6px; }
      button, input, a { font-size: 18px; padding: 8px 10px; }
    </style>
  </head>
  <body>
    <main>
      <h1>Checkout smoke</h1>
      <button id="start" autofocus>Start order</button>
      <label for="email">Email address</label>
      <input id="email" autocomplete="email" value="tester@example.com">
      <a id="help" href="#help-panel">Help center</a>
      <section id="help-panel" tabindex="-1">Support content</section>
    </main>
  </body>
</html>
`,
  "utf-8",
);

if (process.argv.includes("--prepare-only")) {
  console.log(pagePath);
  process.exit(0);
}

const logOffset = await fileSize(logPath);
const browser = await chromium.launch({
  executablePath: edgePath,
  headless: false,
  args: ["--force-renderer-accessibility", "--new-window"],
});

const focusSteps = [];
try {
  const page = await browser.newPage({ viewport: { width: 1024, height: 768 } });
  await page.goto(pathToFileURL(pagePath).href);
  await page.bringToFront();
  await page.waitForTimeout(2000);

  for (let index = 0; index < 4; index += 1) {
    await page.keyboard.press("Tab");
    await page.waitForTimeout(1400);
    focusSteps.push(
      await page.evaluate(() => {
        const el = document.activeElement;
        return {
          tagName: el?.tagName ?? null,
          id: el?.id ?? null,
          text: el?.textContent?.trim() ?? "",
          value: "value" in el ? el.value : undefined,
        };
      }),
    );
  }

  await page.waitForTimeout(2500);
} finally {
  await browser.close();
}

await waitForLogGrowth(logPath, logOffset, 10_000);
const logDelta = await readLogDelta(logPath, logOffset);
const speechLines = logDelta
  .split(/\r?\n/)
  .filter((line) => /\b(speech|speak|Speaking|IO -)\b/i.test(line));

await writeFile(
  outPath,
  `${JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      pagePath,
      browserExecutable: edgePath,
      logPath,
      logOffset,
      focusSteps,
      speechLines,
      logDeltaTail: logDelta.slice(-4000),
    },
    null,
    2,
  )}\n`,
  "utf-8",
);

console.log(outPath);

function firstExisting(paths) {
  return paths.find((path) => existsSync(path));
}

async function fileSize(path) {
  try {
    return (await stat(path)).size;
  } catch {
    return 0;
  }
}

async function readLogDelta(path, offset) {
  try {
    const text = await readFile(path, "utf-8");
    return text.slice(offset);
  } catch {
    return "";
  }
}

async function waitForLogGrowth(path, offset, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if ((await fileSize(path)) > offset) return;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}
