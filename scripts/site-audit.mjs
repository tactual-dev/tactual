/**
 * Run Tactual against a list of real-world sites and produce a comparison report.
 * Usage: node scripts/site-audit.mjs
 */

import { chromium } from "playwright";
import { captureState } from "../dist/playwright/index.js";
import { analyze } from "../dist/index.js";
import { getProfile } from "../dist/index.js";

const SITES = [
  // Known-good accessibility
  "https://www.gov.uk",
  "https://www.w3.org/WAI/",
  "https://designsystem.digital.gov/",
  "https://www.apple.com/accessibility/",
  // Major platforms
  "https://github.com",
  "https://en.wikipedia.org/wiki/Accessibility",
  "https://www.bbc.com",
  "https://www.nytimes.com",
  // Complex commercial
  "https://www.amazon.com",
  "https://www.youtube.com",
  // SPAs
  "https://nextjs.org",
  "https://twitter.com",
];

const profile = getProfile("generic-mobile-web-sr-v0");
const browser = await chromium.launch();
const results = [];

for (const url of SITES) {
  process.stderr.write(`Analyzing ${url}...`);
  try {
    const page = await browser.newPage();
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForLoadState("networkidle").catch(() => {});

    const state = await captureState(page, { provenance: "scripted" });
    const snapshotText = await page.ariaSnapshot().catch(() => "");
    await page.close();

    const result = analyze([state], profile, {
      name: url,
      requestedUrl: url,
      snapshotText,
    });

    const targets = result.metadata.targetCount;
    const headings = state.targets.filter((t) => t.kind === "heading").length;
    const landmarks = state.targets.filter((t) => t.kind === "landmark").length;
    const avg = targets > 0
      ? (result.findings.reduce((s, f) => s + f.scores.overall, 0) / targets).toFixed(1)
      : "N/A";
    const sev = {};
    result.findings.forEach((f) => (sev[f.severity] = (sev[f.severity] || 0) + 1));
    const diags = result.diagnostics.filter((d) => d.code !== "ok");
    const worst = result.findings.slice(0, 3);

    results.push({
      url,
      targets,
      headings,
      landmarks,
      avg: parseFloat(avg) || 0,
      sev,
      diags,
      worst,
      error: null,
    });

    process.stderr.write(` ${targets}T ${headings}H ${landmarks}L avg=${avg}\n`);
  } catch (err) {
    results.push({ url, targets: 0, headings: 0, landmarks: 0, avg: 0, sev: {}, diags: [], worst: [], error: err.message });
    process.stderr.write(` ERROR: ${err.message.slice(0, 60)}\n`);
  }
}

await browser.close();

// Print report
console.log("\n" + "=".repeat(90));
console.log("TACTUAL REAL-WORLD SITE AUDIT");
console.log("=".repeat(90));
console.log("");

// Ranking table
console.log("RANKING (by average score):");
console.log("-".repeat(90));
console.log("Score | Targets | H  | L  | Severity Distribution          | Site");
console.log("-".repeat(90));

const sorted = [...results].sort((a, b) => b.avg - a.avg);
for (const r of sorted) {
  if (r.error) {
    console.log(`  ERR | ${String(r.targets).padStart(7)} |    |    | ${r.error.slice(0, 30).padEnd(31)} | ${r.url}`);
    continue;
  }
  const sevStr = Object.entries(r.sev).map(([k, v]) => `${k[0]}:${v}`).join(" ");
  console.log(
    `${String(r.avg).padStart(5)} | ${String(r.targets).padStart(7)} | ${String(r.headings).padStart(2)} | ${String(r.landmarks).padStart(2)} | ${sevStr.padEnd(31)} | ${r.url}`
  );
}

console.log("");
console.log("DIAGNOSTICS:");
console.log("-".repeat(90));
for (const r of results) {
  if (r.diags.length > 0) {
    console.log(`${r.url}:`);
    for (const d of r.diags) {
      console.log(`  [${d.level}] ${d.code}: ${d.message.slice(0, 75)}`);
    }
  }
}

console.log("");
console.log("WORST FINDINGS PER SITE:");
console.log("-".repeat(90));
for (const r of sorted) {
  if (r.worst.length === 0) continue;
  console.log(`${r.url} (avg ${r.avg}):`);
  for (const f of r.worst) {
    console.log(`  ${f.scores.overall}/100 D:${f.scores.discoverability} R:${f.scores.reachability} O:${f.scores.operability} IR:${f.scores.interopRisk}`);
    for (const p of f.penalties.slice(0, 1)) {
      console.log(`    ${p}`);
    }
  }
}

console.log("\n" + "=".repeat(90));
console.log(`Audited ${results.length} sites. ${results.filter(r => !r.error).length} successful, ${results.filter(r => r.error).length} errors.`);
