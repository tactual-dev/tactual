#!/usr/bin/env node

import { Command } from "commander";
import { getProfile, listProfiles } from "../profiles/index.js";
import { formatReport, type ReportFormat } from "../reporters/index.js";
import { analyze } from "../core/analyzer.js";
import { validateUrl } from "../core/url-validation.js";
import { loadConfig, mergeConfigWithFlags, configToFilter } from "../core/config.js";
import { checkThreshold } from "../core/filter.js";
import type { AnalysisResult, Finding } from "../core/types.js";
import { VERSION } from "../version.js";

const program = new Command();

program
  .name("tactual")
  .description(
    "Screen-reader navigation cost analyzer. " +
      "Measures how hard it is for AT users to discover, reach, and operate web content.",
  )
  .version(VERSION);

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
  // Filtering
  .option("--exclude <patterns...>", "Exclude targets matching these name/role patterns")
  .option("--exclude-selector <selectors...>", "CSS selectors to exclude from capture")
  .option("--focus <landmarks...>", "Only analyze targets within these landmarks")
  .option("--suppress <codes...>", "Suppress these diagnostic codes")
  // Analysis
  .option("--probe", "Run keyboard probes on interactive targets (adds 30-60s but detects focus/keyboard issues)")
  // Display
  .option("--top <n>", "Only show the worst N findings")
  .option("--min-severity <level>", "Minimum severity to report (severe|high|moderate|acceptable|strong)")
  .option("-q, --quiet", "Suppress info-level diagnostics")
  // CI
  .option("--threshold <n>", "Exit non-zero if average score is below this")
  .option("--config <path>", "Path to tactual.json config file")
  // Browser
  .option("--no-headless", "Run browser in headed mode (helps with bot-blocked sites)")
  .option("--timeout <ms>", "Page load timeout in milliseconds", "30000")
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
        exclude?: string[];
        excludeSelector?: string[];
        focus?: string[];
        suppress?: string[];
        probe?: boolean;
        top?: string;
        minSeverity?: string;
        quiet?: boolean;
        threshold?: string;
        config?: string;
        headless?: boolean;
        timeout?: string;
      },
    ) => {
      // Load config file and merge with CLI flags
      const fileConfig = loadConfig(opts.config);
      const merged = mergeConfigWithFlags(fileConfig, {
        profile: opts.profile,
        device: opts.device,
        explore: opts.explore,
        exclude: opts.exclude,
        excludeSelectors: opts.excludeSelector,
        focus: opts.focus,
        suppress: opts.suppress as undefined,
        threshold: opts.threshold ? parseFloat(opts.threshold) : undefined,
        maxFindings: opts.top ? parseInt(opts.top, 10) : undefined,
        minSeverity: opts.minSeverity as undefined,
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

        const rawState = await captureState(page, {
          device,
          provenance: "scripted",
          excludeSelectors: merged.excludeSelectors,
        });

        // Keyboard probes — opt-in via --probe flag (adds 30-60s)
        let targets = rawState.targets;
        if (opts.probe) {
          const { probeTargets } = await import("../playwright/probes.js");
          targets = await probeTargets(page, rawState.targets);
        }
        const state = { ...rawState, targets };

        const snapshotText = await page.ariaSnapshot().catch(() => "");

        let states = [state];

        if (merged.explore || opts.explore) {
          const { explore: exploreState } = await import("../playwright/explorer.js");
          const depth = parseInt(opts.exploreDepth ?? "3", 10);
          const budget = parseInt(opts.exploreBudget ?? "50", 10);
          const maxTargets = parseInt(opts.exploreMaxTargets ?? "2000", 10);
          const exploreResult = await exploreState(page, state, {
            device,
            maxDepth: depth,
            maxActions: budget,
            maxTotalTargets: maxTargets,
          });
          states = exploreResult.states;
        }

        const result = analyze(states, profile, {
          name: url,
          requestedUrl: urlCheck.url!,
          snapshotText,
          filter,
        });


        stopProgress();
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
        const output = formatReport(result, opts.format as ReportFormat);

        // For console format, append timing
        if (opts.format === "console" && isTTY) {
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
