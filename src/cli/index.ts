#!/usr/bin/env node

import { Command } from "commander";
import { getProfile, listProfiles } from "../profiles/index.js";
import { formatReport, type ReportFormat } from "../reporters/index.js";
import { analyze } from "../core/analyzer.js";
import { validateUrl } from "../core/url-validation.js";
import { loadConfig, mergeConfigWithFlags, configToFilter } from "../core/config.js";
import { getPreset, listPresets } from "../core/presets.js";
import { checkThreshold } from "../core/filter.js";
import { buildGraph } from "../core/graph-builder.js";
import { collectEntryPoints, computePathsFromEntries } from "../core/path-analysis.js";
import type { AnalysisResult, Finding } from "../core/types.js";
import { VERSION } from "../version.js";

function validateNum(value: number, flag: string): number {
  if (isNaN(value)) {
    console.error(`Invalid numeric value for ${flag}`);
    process.exit(1);
  }
  return value;
}

const program = new Command();

program
  .name("tactual")
  .description(
    "Screen-reader navigation cost analyzer. " +
      "Measures how hard it is for AT users to discover, reach, and operate web content.",
  )
  .version(VERSION, "-v, --version");

// ---- analyze-url ----

program
  .command("analyze-url")
  .description("Analyze a single URL for screen-reader navigation cost")
  .argument("<url>", "URL to analyze")
  // Output
  .option("-f, --format <format>", "Output format: json, markdown, console, sarif", "console")
  .option("-o, --output <path>", "Write output to file instead of stdout")
  // Profile & device
  .option("-p, --profile <id>", "AT profile to use")
  .option("-d, --device <name>", "Device to emulate (e.g., 'iPhone 14')")
  // Exploration
  .option("-e, --explore", "Explore hidden branches (menus, dialogs, tabs, disclosures)")
  .option("--explore-depth <n>", "Max exploration depth", "3")
  .option("--explore-budget <n>", "Max exploration actions", "50")
  .option("--explore-max-targets <n>", "Max accumulated targets before stopping exploration", "2000")
  .option("--allow-action <patterns...>", "Allow exploring controls matching these name/role patterns (overrides safety policy)")
  // Filtering
  .option("--exclude <patterns...>", "Exclude targets matching these name/role patterns")
  .option("--exclude-selector <selectors...>", "CSS selectors to exclude from capture")
  .option("--focus <landmarks...>", "Only analyze targets within these landmarks")
  .option("--suppress <codes...>", "Suppress these diagnostic codes")
  // Analysis
  .option("--probe", "Run keyboard probes on interactive targets (adds 30-60s but detects focus/keyboard issues)")
  .option("--probe-budget <n>", "Maximum targets to probe (default: 20, increase for deeper keyboard testing)")
  // Display
  .option("--top <n>", "Only show the worst N findings (default: 15)")
  .option("--min-severity <level>", "Minimum severity to report (severe|high|moderate|acceptable|strong)")
  .option("-q, --quiet", "Suppress info-level diagnostics")
  // CI
  .option("--threshold <n>", "Exit non-zero if average score is below this")
  .option("--preset <name>", "Use a scoring preset (ecommerce-checkout, docs-site, dashboard, form-heavy)")
  .option("--config <path>", "Path to tactual.json config file")
  // Browser
  .option("--no-headless", "Run browser in headed mode (helps with bot-blocked sites)")
  .option("--timeout <ms>", "Page load timeout in milliseconds", "30000")
  .option("--wait-for-selector <selector>", "CSS selector to wait for before capturing (essential for SPAs)")
  .option("--wait-time <ms>", "Additional milliseconds to wait after page load")
  .option("--storage-state <path>", "Playwright storageState JSON file for authenticated pages")
  .option("--summary-only", "Output only summary stats (~500 bytes)")
  .action(
    async (
      url: string,
      opts: {
        format: string;
        output?: string;
        profile?: string;
        device?: string;
        explore?: boolean;
        exploreDepth?: string;
        exploreBudget?: string;
        exploreMaxTargets?: string;
        allowAction?: string[];
        exclude?: string[];
        excludeSelector?: string[];
        focus?: string[];
        suppress?: string[];
        probe?: boolean;
        probeBudget?: string;
        top?: string;
        minSeverity?: string;
        quiet?: boolean;
        threshold?: string;
        preset?: string;
        config?: string;
        headless?: boolean;
        timeout?: string;
        waitForSelector?: string;
        waitTime?: string;
        storageState?: string;
        summaryOnly?: boolean;
      },
    ) => {
      // Load preset → config file → CLI flags (each layer overrides the previous)
      let baseConfig = {};
      if (opts.preset) {
        const preset = getPreset(opts.preset);
        if (!preset) {
          console.error(`Unknown preset: ${opts.preset}`);
          console.error(`Available: ${listPresets().map((p) => p.id).join(", ")}`);
          process.exit(1);
        }
        baseConfig = preset.config;
      }
      const fileConfig = loadConfig(opts.config);
      const merged = mergeConfigWithFlags(mergeConfigWithFlags(baseConfig, fileConfig), {
        profile: opts.profile,
        device: opts.device,
        explore: opts.explore,
        exclude: opts.exclude,
        excludeSelectors: opts.excludeSelector,
        focus: opts.focus,
        suppress: opts.suppress,
        threshold: opts.threshold ? validateNum(parseFloat(opts.threshold), "--threshold") : undefined,
        maxFindings: opts.top ? validateNum(parseInt(opts.top, 10), "--top") : undefined,
        minSeverity: opts.minSeverity as "severe" | "high" | "moderate" | "acceptable" | "strong" | undefined,
      });

      const profileId = merged.profile ?? "generic-mobile-web-sr-v0";
      const profile = getProfile(profileId);
      if (!profile) {
        console.error(`Unknown profile: ${profileId}`);
        console.error(`Available: ${listProfiles().join(", ")}`);
        process.exit(1);
      }

      const filter = configToFilter(merged);

      const urlCheck = validateUrl(url);
      if (!urlCheck.valid) {
        console.error(`Invalid URL: ${urlCheck.error}`);
        process.exit(1);
      }

      // Progress indicator
      const startTime = Date.now();
      const isTTY = process.stderr.isTTY;
      let dots = 0;
      const progress = isTTY ? setInterval(() => {
        dots = (dots + 1) % 4;
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
        process.stderr.write(`\r  Analyzing ${url}${".".repeat(dots)}${" ".repeat(3 - dots)} (${elapsed}s)`);
      }, 500) : null;
      const stopProgress = () => {
        if (progress) {
          clearInterval(progress);
          process.stderr.write("\r" + " ".repeat(80) + "\r");
        }
      };

      let browser;
      try {
        const pw = await import("playwright");
        const { captureState } = await import("../playwright/capture.js");

        const headless = opts.headless !== false;
        browser = await pw.chromium.launch({ headless });

        const contextOptions: Record<string, unknown> = {};
        if (opts.storageState) { contextOptions.storageState = opts.storageState; }
        const device = merged.device ?? opts.device;
        if (device) {
          const dev = pw.devices[device];
          if (!dev) {
            console.error(`Unknown device: ${device}`);
            process.exit(1);
          }
          Object.assign(contextOptions, dev);
        }

        const context = await browser.newContext(contextOptions);
        const page = await context.newPage();

        const timeout = parseInt(opts.timeout ?? "30000", 10);
        await page.goto(urlCheck.url!, {
          waitUntil: "domcontentloaded",
          timeout,
        });
        // Short wait before capture — SPA convergence in captureState handles content readiness
        await page.waitForTimeout(2000);
        if (opts.waitForSelector) {
          const found = await page.waitForSelector(opts.waitForSelector, { timeout }).catch(() => null);
          if (!found) process.stderr.write(`  Warning: waitForSelector "${opts.waitForSelector}" timed out\n`);
        }
        if (opts.waitTime) { await page.waitForTimeout(parseInt(opts.waitTime, 10)); }

        const rawState = await captureState(page, {
          device,
          provenance: "scripted",
          excludeSelectors: merged.excludeSelectors,
        });

        // Keyboard probes — opt-in via --probe flag (adds 30-60s)
        let targets = rawState.targets;
        if (opts.probe) {
          const { probeTargets } = await import("../playwright/probes.js");
          const probeBudget = opts.probeBudget ? parseInt(opts.probeBudget, 10) : undefined;
          targets = await probeTargets(page, rawState.targets, probeBudget);
        }
        const state = { ...rawState, targets };

        // SR announcement simulation — runs automatically (instant, non-invasive)
        // Catches landmarks that the AT tree reports but NVDA would not announce
        // (e.g., <header> inside <section> loses its implicit banner role)
        const { simulateScreenReader } = await import("../playwright/sr-simulator.js");
        const srSim = await simulateScreenReader(page, targets);
        // Store demoted landmarks as extra diagnostics for the analyzer
        const srDiagnostics = srSim.demotedLandmarks.map((d) => ({
          level: "warning" as const,
          code: "landmark-demoted" as const,
          message: `${d.targetId}: ${d.demotionReason}`,
        }));


        const snapshotText = await page.ariaSnapshot().catch(() => "");

        let states = [state];

        if (merged.explore || opts.explore) {
          const { explore: exploreState } = await import("../playwright/explorer.js");
          const depth = parseInt(opts.exploreDepth ?? "3", 10);
          const budget = parseInt(opts.exploreBudget ?? "50", 10);
          const maxTargets = parseInt(opts.exploreMaxTargets ?? "2000", 10);
          const allowPatterns = (opts.allowAction ?? []).map((p: string) => {
            const escaped = p.toLowerCase().replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
            return new RegExp(`^${escaped}$`, "i");
          });
          const exploreResult = await exploreState(page, state, {
            device,
            maxDepth: depth,
            maxActions: budget,
            maxTotalTargets: maxTargets,
            allowActionPatterns: allowPatterns.length > 0 ? allowPatterns : undefined,
          });
          states = exploreResult.states;
          if (exploreResult.skippedElements.length > 0 && isTTY) {
            process.stderr.write(`  Skipped ${exploreResult.skippedElements.length} unsafe element(s):\n`);
            for (const s of exploreResult.skippedElements.slice(0, 5)) {
              process.stderr.write(`    ${s.id} — ${s.reason}\n`);
            }
            if (exploreResult.skippedElements.length > 5) {
              process.stderr.write(`    ... and ${exploreResult.skippedElements.length - 5} more\n`);
            }
            process.stderr.write(`  Use --allow-action "<pattern>" to override.\n`);
          }
        }

        const result = analyze(states, profile, {
          name: url,
          requestedUrl: urlCheck.url!,
          snapshotText,
          filter,
        });

        // Append SR simulator diagnostics (demoted landmarks)
        if (srDiagnostics.length > 0) {
          result.diagnostics.push(...srDiagnostics);
        }

        stopProgress();
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

        let output: string;
        if (opts.summaryOnly) {
          const { summarize } = await import("../reporters/summarize.js");
          const s = summarize(result);
          output = JSON.stringify({ url, profile: s.profile, stats: s.stats, severityCounts: s.severityCounts, diagnostics: s.diagnostics, topIssues: s.issueGroups.slice(0, 3).map(g => ({ issue: g.issue, count: g.count, worstScore: g.worstScore })) }, null, 2);
        } else {
          const topN = opts.top ? parseInt(opts.top, 10) : undefined;
          output = formatReport(result, opts.format as ReportFormat, { maxDetailedFindings: topN });
        }

        // For console format, append timing
        if (opts.format === "console" && isTTY && !opts.summaryOnly) {
          console.error(`  ${"\x1b[90m"}Completed in ${elapsed}s${"\x1b[0m"}`);
        }

        if (opts.output) {
          const fs = await import("fs/promises");
          await fs.writeFile(opts.output, output, "utf-8");
          console.error(`Report written to ${opts.output}`);
        } else {
          console.log(output);
        }

        // Threshold check for CI
        const threshold = merged.threshold ?? (opts.threshold ? parseFloat(opts.threshold) : undefined);
        if (threshold !== undefined) {
          const check = checkThreshold(result.findings, threshold);
          if (!check.passed) {
            console.error(
              `FAIL: Average score ${check.average.toFixed(1)} is below threshold ${threshold}`,
            );
            process.exit(1);
          }
          console.error(
            `PASS: Average score ${check.average.toFixed(1)} meets threshold ${threshold}`,
          );
        }
      } catch (err) {
        stopProgress();
        if (
          err instanceof Error &&
          (err.message.includes("Cannot find module") || err.message.includes("Cannot find package"))
        ) {
          console.error(
            "Playwright is required for analyze-url. Install it: npm install playwright",
          );
          process.exit(1);
        }
        throw err;
      } finally {
        await browser?.close().catch(() => {});
      }
    },
  );

// ---- trace-path ----

program
  .command("trace-path")
  .description("Trace the step-by-step screen-reader navigation path to a specific target")
  .argument("<url>", "URL of the page")
  .argument("<target>", "Target ID or glob pattern (e.g., '*search*', 'combobox:search')")
  .option("-p, --profile <id>", "AT profile to use")
  .option("-d, --device <name>", "Device to emulate")
  .option("-e, --explore", "Explore hidden branches before tracing")
  .option("--wait-for-selector <selector>", "CSS selector to wait for (SPAs)")
  .option("--timeout <ms>", "Page load timeout", "30000")
  .action(
    async (
      url: string,
      targetPattern: string,
      opts: {
        profile?: string;
        device?: string;
        explore?: boolean;
        waitForSelector?: string;
        timeout?: string;
      },
    ) => {
      const profileId = opts.profile ?? "generic-mobile-web-sr-v0";
      const profile = getProfile(profileId);
      if (!profile) {
        console.error(`Unknown profile: ${profileId}`);
        console.error(`Available: ${listProfiles().join(", ")}`);
        process.exit(1);
      }

      const urlCheck = validateUrl(url);
      if (!urlCheck.valid) {
        console.error(`Invalid URL: ${urlCheck.error}`);
        process.exit(1);
      }

      const startTime = Date.now();
      const isTTY = process.stderr.isTTY;
      let dots = 0;
      const progress = isTTY ? setInterval(() => {
        dots = (dots + 1) % 4;
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
        process.stderr.write(`\r  Tracing path to "${targetPattern}"${".".repeat(dots)}${" ".repeat(3 - dots)} (${elapsed}s)`);
      }, 500) : null;
      const stopProgress = () => {
        if (progress) {
          clearInterval(progress);
          process.stderr.write("\r" + " ".repeat(80) + "\r");
        }
      };

      let browser;
      try {
        const pw = await import("playwright");
        const { captureState } = await import("../playwright/capture.js");
        const { findMatchingTargets, modelAnnouncement } = await import("../mcp/trace-helpers.js");

        const timeout = parseInt(opts.timeout ?? "30000", 10);
        browser = await pw.chromium.launch();
        const context = await browser.newContext();
        const page = await context.newPage();

        await page.goto(urlCheck.url!, { waitUntil: "domcontentloaded", timeout });
        await page.waitForTimeout(2000);

        if (opts.waitForSelector) {
          const found = await page.waitForSelector(opts.waitForSelector, { timeout }).catch(() => null);
          if (!found) process.stderr.write(`  Warning: waitForSelector "${opts.waitForSelector}" timed out\n`);
        }

        const state = await captureState(page, { provenance: "scripted" });
        let states = [state];

        if (opts.explore) {
          const { explore: exploreState } = await import("../playwright/explorer.js");
          const result = await exploreState(page, state, { maxDepth: 2, maxActions: 30 });
          states = result.states;
        }

        await context.close();

        // Build graph and find targets
        const graph = buildGraph(states, profile);
        const matches = findMatchingTargets(states, targetPattern);

        stopProgress();

        if (matches.length === 0) {
          const available = states
            .flatMap((s) => s.targets)
            .filter((t) => t.kind !== "heading" && t.kind !== "landmark")
            .slice(0, 15)
            .map((t) => `  ${t.id} (${t.kind}: ${t.name || "(unnamed)"})`)
            .join("\n");
          console.error(`No targets matching "${targetPattern}" found.\n\nAvailable targets:\n${available}`);
          process.exit(1);
        }

        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
        if (isTTY) console.error(`  \x1b[90mCompleted in ${elapsed}s\x1b[0m`);

        // Trace each match
        for (const match of matches.slice(0, 5)) {
          const targetNodeId = `${match.stateId}:${match.target.id}`;
          if (!graph.hasNode(targetNodeId)) continue;

          const matchState = states.find((s) => s.id === match.stateId);
          if (!matchState) continue;

          const entryPoints = collectEntryPoints(matchState, graph);
          const paths = computePathsFromEntries(graph, entryPoints, targetNodeId);
          const bestPath = paths[0] ?? null;

          console.log("");
          console.log(`  \x1b[1mTrace: ${match.target.id}\x1b[0m`);
          console.log(`  \x1b[2m${match.target.role} "${match.target.name}"\x1b[0m`);
          if (match.target.selector) {
            console.log(`  \x1b[2m${match.target.selector}\x1b[0m`);
          }

          if (!bestPath) {
            console.log(`  \x1b[31mNo path found from any entry point.\x1b[0m`);
            continue;
          }

          console.log(`  \x1b[2mTotal cost: ${bestPath.totalCost.toFixed(1)} | Steps: ${bestPath.edges.length}\x1b[0m`);
          console.log("");

          for (let i = 0; i < bestPath.edges.length; i++) {
            const edge = bestPath.edges[i];
            const toNode = graph.getNode(edge.to);
            const toMeta = toNode?.metadata as { target?: import("../core/types.js").Target } | undefined;
            const toTarget = toMeta?.target;
            const cumCost = bestPath.edges.slice(0, i + 1).reduce((s: number, e) => s + e.cost, 0);

            const announcement = modelAnnouncement(
              edge.action,
              toTarget?.role ?? "unknown",
              toTarget?.name || "(unnamed)",
              toTarget?.headingLevel,
            );

            const isLast = i === bestPath.edges.length - 1;
            const arrow = isLast ? "\x1b[32m→\x1b[0m" : "\x1b[2m→\x1b[0m";
            const nameColor = isLast ? "\x1b[1m" : "";

            console.log(`  ${arrow}  \x1b[33m${edge.action}\x1b[0m  ${nameColor}${toTarget?.name || "(unnamed)"}\x1b[0m`);
            console.log(`     \x1b[2m${announcement}  (cost +${edge.cost}, total ${cumCost.toFixed(1)})\x1b[0m`);
          }
          console.log("");
        }
      } catch (err) {
        stopProgress();
        if (
          err instanceof Error &&
          (err.message.includes("Cannot find module") || err.message.includes("Cannot find package"))
        ) {
          console.error("Playwright is required. Install it: npm install playwright");
          process.exit(1);
        }
        throw err;
      } finally {
        await browser?.close().catch(() => {});
      }
    },
  );

// ---- save-auth ----

program
  .command("save-auth")
  .description("Authenticate with a web app and save session state for later analysis")
  .argument("<url>", "Login page URL")
  .option("-o, --output <path>", "Output file for storageState JSON", "tactual-auth.json")
  .option("--click <text>", "Click a button/link with this text")
  .option("--fill <pairs...>", "Fill form fields: selector=value (e.g., '#email=user@test.com')")
  .option("--wait-for-url <pattern>", "Wait until URL contains this string")
  .option("--timeout <ms>", "Timeout per step in ms", "30000")
  .action(async (url: string, opts: {
    output: string;
    click?: string;
    fill?: string[];
    waitForUrl?: string;
    timeout?: string;
  }) => {
    const urlCheck = validateUrl(url);
    if (!urlCheck.valid) { console.error(`Invalid URL: ${urlCheck.error}`); process.exit(1); }

    let browser: import("playwright").Browser | undefined;
    try {
      const pw = await import("playwright");
      const fs = await import("fs/promises");
      const pathMod = await import("path");

      const timeout = parseInt(opts.timeout ?? "30000", 10);
      browser = await pw.chromium.launch();
      const context = await browser.newContext();
      const page = await context.newPage();

      await page.goto(urlCheck.url!, { waitUntil: "domcontentloaded", timeout });
      await page.waitForTimeout(2000);

      // Execute steps
      if (opts.fill) {
        for (const pair of opts.fill) {
          const [selector, value] = pair.split("=", 2);
          if (selector && value) await page.fill(selector, value);
        }
      }
      if (opts.click) {
        const target = page.getByRole("button", { name: opts.click })
          .or(page.getByRole("link", { name: opts.click }))
          .or(page.getByText(opts.click, { exact: false }));
        if (await target.count() > 0) {
          await target.first().click({ timeout });
        } else {
          await page.click(opts.click, { timeout });
        }
      }
      if (opts.waitForUrl) {
        await page.waitForURL(`**${opts.waitForUrl}**`, { timeout });
      }

      await page.waitForTimeout(2000);

      const state = await context.storageState();
      const resolved = pathMod.resolve(opts.output);
      await fs.writeFile(resolved, JSON.stringify(state, null, 2));

      console.log(`Auth state saved to ${resolved}`);
      console.log(`Use with: tactual analyze-url <url> --storage-state ${opts.output}`);

    } catch (err) {
      console.error(`Auth failed: ${err instanceof Error ? err.message : err}`);
      process.exit(1);
    } finally {
      await browser?.close().catch(() => {});
    }
  });

// ---- analyze-pages ----

program
  .command("analyze-pages")
  .description("Analyze multiple pages with site-level aggregation")
  .argument("<urls...>", "URLs to analyze (space-separated)")
  .option("-p, --profile <id>", "AT profile to use")
  .option("-f, --format <format>", "Output format: json, console", "console")
  .option("--wait-for-selector <selector>", "CSS selector to wait for on each page")
  .option("--wait-time <ms>", "Additional wait per page in ms")
  .option("--storage-state <path>", "Playwright storageState JSON for authenticated pages")
  .option("--timeout <ms>", "Page load timeout per URL", "30000")
  .action(async (urls: string[], opts: {
    profile?: string;
    format: string;
    waitForSelector?: string;
    waitTime?: string;
    storageState?: string;
    timeout?: string;
  }) => {
    const profileId = opts.profile ?? "generic-mobile-web-sr-v0";
    const profile = getProfile(profileId);
    if (!profile) { console.error(`Unknown profile: ${profileId}\nAvailable: ${listProfiles().join(", ")}`); process.exit(1); }

    try {
      const pw = await import("playwright");
      const { captureState } = await import("../playwright/capture.js");

      const timeout = parseInt(opts.timeout ?? "30000", 10);
      const browser = await pw.chromium.launch();
      const contextOptions: Record<string, unknown> = {};
      if (opts.storageState) contextOptions.storageState = opts.storageState;
      const context = await browser.newContext(contextOptions);

      const allScores: number[] = [];
      const allSeverity = { severe: 0, high: 0, moderate: 0, acceptable: 0, strong: 0 };
      const pageResults: Array<{ url: string; targets: number; p10: number; median: number; avg: number; worst: number; topIssue: string | null }> = [];

      for (const url of urls) {
        const urlCheck = validateUrl(url);
        if (!urlCheck.valid) {
          pageResults.push({ url, targets: 0, p10: 0, median: 0, avg: 0, worst: 0, topIssue: `Invalid URL: ${urlCheck.error}` });
          continue;
        }

        try {
          const page = await context.newPage();
          await page.goto(urlCheck.url!, { waitUntil: "domcontentloaded", timeout });
          await page.waitForTimeout(2000);
          if (opts.waitForSelector) {
            const found = await page.waitForSelector(opts.waitForSelector, { timeout: 10000 }).catch(() => null);
            if (!found) process.stderr.write(`  Warning: waitForSelector "${opts.waitForSelector}" timed out\n`);
          }
          if (opts.waitTime) await page.waitForTimeout(parseInt(opts.waitTime, 10));

          const state = await captureState(page, { provenance: "scripted", spaWaitTimeout: 15000 });
          await page.close();

          const result = analyze([state], profile, { name: url });
          const scores = result.findings.map(f => f.scores.overall);
          const sorted = [...scores].sort((a, b) => a - b);
          const avg = scores.length > 0 ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length * 10) / 10 : 0;
          const p10 = sorted.length >= 5 ? sorted[Math.max(0, Math.ceil(sorted.length * 0.1) - 1)] : sorted[0] ?? 0;
          const median = sorted.length > 0 ? sorted[Math.floor(sorted.length * 0.5)] : 0;
          const worst = sorted[0] ?? 0;

          for (const f of result.findings) {
            const sev = f.severity as keyof typeof allSeverity;
            if (allSeverity[sev] !== undefined) allSeverity[sev]++;
          }
          allScores.push(...scores);

          const worstFinding = result.findings.sort((a, b) => a.scores.overall - b.scores.overall)[0];
          pageResults.push({
            url, targets: result.findings.length, p10, median, avg, worst,
            topIssue: worstFinding ? `${worstFinding.targetId} (${worstFinding.scores.overall}/100)` : null,
          });
        } catch (err) {
          pageResults.push({ url, targets: 0, p10: 0, median: 0, avg: 0, worst: 0, topIssue: `Error: ${err instanceof Error ? err.message.slice(0, 60) : "unknown"}` });
        }
      }

      await browser.close();

      // Aggregate
      const allSorted = [...allScores].sort((a, b) => a - b);
      const siteP10 = allSorted.length >= 5 ? allSorted[Math.max(0, Math.ceil(allSorted.length * 0.1) - 1)] : allSorted[0] ?? 0;
      const siteMedian = allSorted.length > 0 ? allSorted[Math.floor(allSorted.length * 0.5)] : 0;
      const siteAvg = allScores.length > 0 ? Math.round(allScores.reduce((a, b) => a + b, 0) / allScores.length * 10) / 10 : 0;

      if (opts.format === "json") {
        console.log(JSON.stringify({
          site: { pagesAnalyzed: pageResults.length, totalTargets: allScores.length, p10: siteP10, median: siteMedian, average: siteAvg, worst: allSorted[0] ?? 0, severityCounts: allSeverity },
          pages: pageResults,
        }, null, 2));
      } else {
        // Console format
        const c = process.stdout.isTTY === true && !process.env.NO_COLOR;
        const bold = c ? "\x1b[1m" : "";
        const dim = c ? "\x1b[2m" : "";
        const green = c ? "\x1b[32m" : "";
        const yellow = c ? "\x1b[33m" : "";
        const red = c ? "\x1b[31m" : "";
        const reset = c ? "\x1b[0m" : "";

        console.log("");
        console.log(`  ${bold}Tactual Site Analysis${reset}  ${dim}${urls.length} pages · ${profileId}${reset}`);
        console.log(`  ${dim}P10${reset} ${siteP10}  ${dim}Median${reset} ${siteMedian}  ${dim}Avg${reset} ${siteAvg}  ${dim}Targets${reset} ${allScores.length}`);
        const sevParts: string[] = [];
        for (const [sev, count] of Object.entries(allSeverity)) {
          if (count > 0) {
            const color = sev === "severe" || sev === "high" ? red : sev === "moderate" ? yellow : green;
            sevParts.push(`${color}${count} ${sev}${reset}`);
          }
        }
        if (sevParts.length > 0) console.log(`  ${sevParts.join(`${dim}  ·  ${reset}`)}`);
        console.log("");

        for (const r of pageResults) {
          const scoreColor = r.p10 >= 75 ? green : r.p10 >= 60 ? yellow : red;
          console.log(`  ${scoreColor}P10:${r.p10}${reset}  ${dim}Med:${r.median} Avg:${r.avg}${reset}  ${r.url}`);
          if (r.topIssue) console.log(`  ${dim}       ↳ ${r.topIssue}${reset}`);
        }
        console.log("");
      }
    } catch (err) {
      if (err instanceof Error && (err.message.includes("Cannot find module") || err.message.includes("Cannot find package"))) {
        console.error("Playwright is required. Install it: npm install playwright");
        process.exit(1);
      }
      throw err;
    }
  });

// ---- suggest-remediations ----

program
  .command("suggest-remediations")
  .description("Extract top remediation suggestions from an analysis result")
  .argument("<file>", "Path to analysis JSON file")
  .option("-n, --max <n>", "Maximum suggestions to show", "10")
  .action(async (file: string, opts: { max: string }) => {
    const fs = await import("fs/promises");
    try {
      const data = JSON.parse(await fs.readFile(file, "utf-8"));
      // Handle both full AnalysisResult and summarized JSON
      const findings = data.findings ?? data.worstFindings ?? [];
      const scoreOf = (f: Record<string, unknown>): number =>
        (f.scores as Record<string, number>)?.overall ?? (f.overall as number) ?? 100;
      const sorted = [...findings].sort((a: Record<string, unknown>, b: Record<string, unknown>) => scoreOf(a) - scoreOf(b));
      const max = parseInt(opts.max, 10);
      const seenFixes = new Set<string>();

      console.log("");
      let count = 0;
      for (const f of sorted) {
        const fixes = f.suggestedFixes ?? [];
        for (const fix of fixes) {
          if (seenFixes.has(fix)) continue;
          seenFixes.add(fix);
          const score = f.scores?.overall ?? f.overall ?? "?";
          const id = f.targetId ?? "unknown";
          console.log(`  ${score}/100  ${id}`);
          console.log(`  \x1b[2m↳ ${fix}\x1b[0m`);
          console.log("");
          count++;
          if (count >= max) break;
        }
        if (count >= max) break;
      }
      if (count === 0) console.log("  No fix suggestions found.");
      console.log("");
    } catch (err) {
      console.error(`Error: ${err}`);
      process.exit(1);
    }
  });

// ---- diff ----

program
  .command("diff")
  .description("Compare two analysis results and show score changes")
  .argument("<baseline>", "Path to baseline analysis JSON")
  .argument("<candidate>", "Path to candidate analysis JSON")
  .option("-f, --format <format>", "Output format: json, markdown, console, sarif", "console")
  .action(async (baseline: string, candidate: string, opts: { format: string }) => {
    const fs = await import("fs/promises");
    try {
      const baseData = JSON.parse(await fs.readFile(baseline, "utf-8")) as AnalysisResult;
      const candData = JSON.parse(await fs.readFile(candidate, "utf-8")) as AnalysisResult;
      const diff = computeDiff(baseData, candData);
      console.log(formatDiff(diff, opts.format as ReportFormat));
    } catch (err) {
      console.error(`Error: ${err}`);
      process.exit(1);
    }
  });

// ---- profiles ----

program
  .command("profiles")
  .description("List available AT profiles")
  .action(() => {
    const profiles = listProfiles();
    console.log("Available profiles:");
    for (const id of profiles) {
      const p = getProfile(id);
      console.log(`  ${id}  ${p?.platform ?? ""} — ${p?.description?.slice(0, 60) ?? ""}`);
    }
  });

// ---- presets ----

program
  .command("presets")
  .description("List available scoring presets")
  .action(() => {
    const presets = listPresets();
    console.log("Available presets:");
    console.log("");
    for (const p of presets) {
      console.log(`  ${p.id}`);
      console.log(`    ${p.description}`);
      if (p.config.focus) console.log(`    Focus: ${p.config.focus.join(", ")}`);
      const critical = Object.entries(p.config.priority ?? {}).filter(([, v]) => v === "critical").map(([k]) => k);
      if (critical.length > 0) console.log(`    Critical targets: ${critical.join(", ")}`);
      console.log("");
    }
    console.log("Usage: npx tactual analyze-url <url> --preset <name>");
  });

// ---- init ----

program
  .command("init")
  .description("Create a tactual.json config file in the current directory")
  .action(async () => {
    const fs = await import("fs/promises");
    const { existsSync } = await import("fs");
    if (existsSync("tactual.json")) {
      console.error("tactual.json already exists.");
      process.exit(1);
    }
    const template = {
      profile: "nvda-desktop-v0",
      exclude: [],
      focus: [],
      suppress: [],
      threshold: 70,
    };
    await fs.writeFile("tactual.json", JSON.stringify(template, null, 2) + "\n", "utf-8");
    console.log("Created tactual.json");
  });

// ---- benchmark ----

program
  .command("benchmark")
  .description("Run benchmark suite against public fixtures")
  .option("-s, --suite <name>", "Benchmark suite to run", "public-fixtures")
  .action(async (opts: { suite: string }) => {
    try {
      const pw = await import("playwright");
      const { publicFixturesSuite } = await import("../benchmark/suites/public-fixtures.js");
      const { runBenchmarkSuite, formatBenchmarkResults } = await import("../benchmark/runner.js");

      const suite = opts.suite === "public-fixtures" ? publicFixturesSuite : null;
      if (!suite) {
        console.error(`Unknown suite: ${opts.suite}. Available: public-fixtures`);
        process.exit(1);
      }

      console.error(`Running benchmark suite: ${suite.name}...`);
      const browser = await pw.chromium.launch();

      const result = await runBenchmarkSuite(suite, browser, (msg) => {
        console.error(`  ${msg}`);
      });

      await browser.close();

      console.log(formatBenchmarkResults(result));

      if (result.totalFailed > 0) {
        process.exit(1);
      }
    } catch (err) {
      if (err instanceof Error && (err.message.includes("Cannot find module") || err.message.includes("Cannot find package"))) {
        console.error("Playwright is required for benchmarks. Install it: npm install playwright");
        process.exit(1);
      }
      throw err;
    }
  });

program.parse();

// ---------------------------------------------------------------------------
// Diff helpers
// ---------------------------------------------------------------------------

interface DiffEntry {
  targetId: string;
  baseline: Finding | undefined;
  candidate: Finding | undefined;
  overallDelta: number;
}

interface DiffResult {
  entries: DiffEntry[];
  improved: number;
  regressed: number;
  unchanged: number;
}

function computeDiff(baseline: AnalysisResult, candidate: AnalysisResult): DiffResult {
  const baseMap = new Map(baseline.findings.map((f) => [f.targetId, f]));
  const candMap = new Map(candidate.findings.map((f) => [f.targetId, f]));
  const allIds = new Set([...baseMap.keys(), ...candMap.keys()]);

  const entries: DiffEntry[] = [];
  let improved = 0;
  let regressed = 0;
  let unchanged = 0;

  for (const id of allIds) {
    const b = baseMap.get(id);
    const c = candMap.get(id);
    const delta = (c?.scores.overall ?? 0) - (b?.scores.overall ?? 0);
    entries.push({ targetId: id, baseline: b, candidate: c, overallDelta: delta });
    if (delta > 0) improved++;
    else if (delta < 0) regressed++;
    else unchanged++;
  }

  entries.sort((a, b) => a.overallDelta - b.overallDelta);
  return { entries, improved, regressed, unchanged };
}

function formatDiff(diff: DiffResult, _format: ReportFormat): string {
  const lines: string[] = [];
  lines.push(
    `Diff: ${diff.improved} improved, ${diff.regressed} regressed, ${diff.unchanged} unchanged`,
  );
  lines.push("");

  for (const entry of diff.entries) {
    const sign = entry.overallDelta > 0 ? "+" : "";
    const base = entry.baseline?.scores.overall ?? "new";
    const cand = entry.candidate?.scores.overall ?? "removed";
    lines.push(`  ${entry.targetId}: ${base} -> ${cand} (${sign}${entry.overallDelta})`);
  }

  return lines.join("\n");
}
