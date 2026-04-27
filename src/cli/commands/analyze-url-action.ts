import { listProfiles } from "../../profiles/index.js";
import { formatReport, type ReportFormat } from "../../reporters/index.js";
import { loadConfig, mergeConfigWithFlags, configToFilter } from "../../core/config.js";
import { getPreset, listPresets } from "../../core/presets.js";
import { checkThreshold } from "../../core/filter.js";
import { validateNum } from "../helpers/shared.js";
import { computeDiff } from "../helpers/diff.js";
import { runAnalyzeUrl, AnalyzeUrlError } from "../../pipeline/analyze-url.js";

export async function handleAnalyzeUrlCommand(
  url: string,
  opts: Record<string, unknown>,
): Promise<void> {
  const merged = loadMergedConfig(opts);
  const filter = configToFilter(merged);
  const progress = startProgress(url);

  try {
    const pipelineResult = await runAnalyzeUrl({
      url,
      profileId: merged.profile as string | undefined,
      device: (merged.device as string | undefined) ?? (opts.device as string | undefined),
      filter: filter as unknown as Record<string, unknown>,
      excludeSelector: merged.excludeSelectors as string[] | undefined,
      scopeSelector: merged.scopeSelectors as string[] | undefined,
      explore: (merged.explore as boolean | undefined) || (opts.explore as boolean | undefined),
      exploreDepth: parseInt((opts.exploreDepth as string) ?? "3", 10),
      exploreBudget: parseInt((opts.exploreBudget as string) ?? "50", 10),
      exploreTimeout: parseInt((opts.exploreTimeout as string) ?? "60000", 10),
      exploreMaxTargets: parseInt((opts.exploreMaxTargets as string) ?? "2000", 10),
      allowAction: opts.allowAction as string[] | undefined,
      probe: opts.probe as boolean | undefined,
      probeBudget: opts.probeBudget ? parseInt(opts.probeBudget as string, 10) : undefined,
      probeMode: opts.probeMode as "fast" | "standard" | "deep" | undefined,
      probeSelector: merged.probeSelectors as string[] | undefined,
      entrySelector: merged.entrySelector as string | undefined,
      goalTarget: merged.goalTarget as string | undefined,
      goalPattern: merged.goalPattern as string | undefined,
      probeStrategy: merged.probeStrategy as
        | "all"
        | "overlay"
        | "composite-widget"
        | "form"
        | "navigation"
        | "modal-return-focus"
        | "menu-pattern"
        | undefined,
      validate: opts.validate as boolean | undefined,
      validateMaxTargets: parseInt((opts.validateMaxTargets as string) ?? "10", 10),
      validateStrategy: (opts.validateStrategy as "linear" | "semantic" | undefined) ?? "semantic",
      // Resolver precedence (explicit beats defer-to-profile): CLI flag wins
      // over config, config wins over profile default. `undefined` at the
      // pipeline layer means "use profile.visualModes if declared".
      checkVisibility:
        (opts.checkVisibility as boolean | undefined) ??
        (merged.checkVisibility as boolean | undefined),
      headless: opts.headless !== false,
      channel: opts.channel as string | undefined,
      stealth: opts.stealth as boolean | undefined,
      userAgent: opts.userAgent as string | undefined,
      timeout: parseInt((opts.timeout as string) ?? "30000", 10),
      waitForSelector: opts.waitForSelector as string | undefined,
      waitTime: opts.waitTime ? parseInt(opts.waitTime as string, 10) : undefined,
      storageState: opts.storageState as string | undefined,
    });

    progress.stop();
    await emitAnalyzeUrlOutput(url, opts, merged, pipelineResult, progress.isTTY);
    await applyBaselineGate(opts, pipelineResult.result);
    await writeAlsoJson(opts, pipelineResult.result);
    applyScoreThreshold(opts, merged, pipelineResult.result);
  } catch (err) {
    progress.stop();
    handleAnalyzeUrlError(err);
  }
}

function loadMergedConfig(opts: Record<string, unknown>): Record<string, unknown> {
  let baseConfig: Record<string, unknown> = {};
  if (opts.preset) {
    const preset = getPreset(opts.preset as string);
    if (!preset) {
      console.error(`Unknown preset: ${opts.preset}`);
      console.error(
        `Available: ${listPresets()
          .map((p) => p.id)
          .join(", ")}`,
      );
      process.exit(1);
    }
    baseConfig = preset.config as Record<string, unknown>;
  }

  const fileConfig = loadConfig(opts.config as string | undefined);
  return mergeConfigWithFlags(mergeConfigWithFlags(baseConfig, fileConfig), {
    profile: opts.profile as string | undefined,
    device: opts.device as string | undefined,
    explore: opts.explore as boolean | undefined,
    exclude: opts.exclude as string[] | undefined,
    excludeSelectors: opts.excludeSelector as string[] | undefined,
    scopeSelectors: opts.scopeSelector as string[] | undefined,
    probeSelectors: opts.probeSelector as string[] | undefined,
    focus: opts.focus as string[] | undefined,
    suppress: opts.suppress as string[] | undefined,
    entrySelector: opts.entrySelector as string | undefined,
    goalTarget: opts.goalTarget as string | undefined,
    goalPattern: opts.goalPattern as string | undefined,
    probeStrategy: opts.probeStrategy as
      | "all"
      | "overlay"
      | "composite-widget"
      | "form"
      | "navigation"
      | "modal-return-focus"
      | "menu-pattern"
      | undefined,
    threshold: opts.threshold
      ? validateNum(parseFloat(opts.threshold as string), "--threshold")
      : undefined,
    maxFindings: opts.top ? validateNum(parseInt(opts.top as string, 10), "--top") : undefined,
    minSeverity: opts.minSeverity as
      | "severe"
      | "high"
      | "moderate"
      | "acceptable"
      | "strong"
      | undefined,
    checkVisibility: opts.checkVisibility as boolean | undefined,
  });
}

function startProgress(url: string): { isTTY: boolean; stop: () => void } {
  const isTTY = process.stderr.isTTY;
  const startTime = Date.now();
  let dots = 0;
  const interval = isTTY
    ? setInterval(() => {
        dots = (dots + 1) % 4;
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
        process.stderr.write(
          `\r  Analyzing ${url}${".".repeat(dots)}${" ".repeat(3 - dots)} (${elapsed}s)`,
        );
      }, 500)
    : null;

  return {
    isTTY,
    stop: () => {
      if (interval) {
        clearInterval(interval);
        process.stderr.write("\r" + " ".repeat(80) + "\r");
      }
    },
  };
}

async function emitAnalyzeUrlOutput(
  url: string,
  opts: Record<string, unknown>,
  merged: Record<string, unknown>,
  pipelineResult: Awaited<ReturnType<typeof runAnalyzeUrl>>,
  isTTY: boolean,
): Promise<void> {
  const { result, elapsedMs, skippedElements } = pipelineResult;
  if (skippedElements.length > 0 && isTTY) {
    process.stderr.write(`  Skipped ${skippedElements.length} unsafe element(s):\n`);
    for (const s of skippedElements.slice(0, 5)) {
      process.stderr.write(`    ${s.id} - ${s.reason}\n`);
    }
    if (skippedElements.length > 5) {
      process.stderr.write(`    ... and ${skippedElements.length - 5} more\n`);
    }
    process.stderr.write(`  Use --allow-action "<pattern>" to override.\n`);
  }

  const output = opts.summaryOnly
    ? await formatSummaryOnly(url, result)
    : formatReport(result, opts.format as ReportFormat, {
        maxDetailedFindings: opts.top ? parseInt(opts.top as string, 10) : undefined,
      });

  if (opts.format === "console" && isTTY && !opts.summaryOnly) {
    const elapsed = (elapsedMs / 1000).toFixed(1);
    const deviceNote = merged.device ? ` (device: ${merged.device})` : "";
    console.error(`  ${"\x1b[90m"}Completed in ${elapsed}s${deviceNote}${"\x1b[0m"}`);
  }

  if (opts.output) {
    const fs = await import("fs/promises");
    await fs.writeFile(opts.output as string, output, "utf-8");
    console.error(`Report written to ${opts.output}`);
  } else {
    console.log(output);
  }
}

async function formatSummaryOnly(
  url: string,
  result: Awaited<ReturnType<typeof runAnalyzeUrl>>["result"],
): Promise<string> {
  const { summarize } = await import("../../reporters/summarize.js");
  const s = summarize(result);
  return JSON.stringify(
    {
      url,
      profile: s.profile,
      stats: s.stats,
      severityCounts: s.severityCounts,
      diagnostics: s.diagnostics,
      topIssues: s.issueGroups.slice(0, 3).map((g) => ({
        issue: g.issue,
        count: g.count,
        worstScore: g.worstScore,
        averageScore: g.averageScore,
        estimatedScoreUplift: g.estimatedScoreUplift,
      })),
    },
    null,
    2,
  );
}

async function applyBaselineGate(
  opts: Record<string, unknown>,
  result: Awaited<ReturnType<typeof runAnalyzeUrl>>["result"],
): Promise<void> {
  if (!opts.baseline && !opts.failOnRegression) return;

  const baselinePath = opts.baseline as string | undefined;
  if (!baselinePath) {
    console.error("Error: --fail-on-regression requires --baseline <path>.");
    process.exit(1);
  }

  const fs = await import("fs/promises");
  let baselineData: Record<string, unknown>;
  try {
    baselineData = JSON.parse(await fs.readFile(baselinePath, "utf-8")) as Record<
      string,
      unknown
    >;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      console.error(`Error: baseline file not found: ${baselinePath}`);
    } else if (err instanceof SyntaxError) {
      console.error(`Error: baseline file is not valid JSON: ${baselinePath}`);
    } else {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`Error reading baseline (${baselinePath}): ${msg}`);
    }
    process.exit(1);
  }

  const diff = computeDiff(
    baselineData,
    JSON.parse(formatReport(result, "json")) as Record<string, unknown>,
  );
  const regressionList = diff.entries.filter((e) => e.overallDelta < 0).slice(0, 5);
  console.error("");
  console.error(
    `  Baseline diff: ${diff.improved} improved, ${diff.regressed} regressed, ${diff.unchanged} unchanged`,
  );
  for (const r of regressionList) {
    console.error(
      `    ${r.targetId}  ${r.baseline?.overall ?? "new"} -> ${r.candidate?.overall ?? "removed"}  (delta ${r.overallDelta})`,
    );
  }
  if (diff.regressed > regressionList.length) {
    console.error(`    ... and ${diff.regressed - regressionList.length} more regressed`);
  }

  const regressionThreshold =
    typeof opts.failOnRegression === "string"
      ? parseInt(opts.failOnRegression, 10)
      : opts.failOnRegression === true
        ? 1
        : Infinity;
  if (diff.regressed >= regressionThreshold) {
    console.error(
      `  Regression gate: ${diff.regressed} findings regressed (threshold ${regressionThreshold}). Failing.`,
    );
    process.exit(1);
  }
}

async function writeAlsoJson(
  opts: Record<string, unknown>,
  result: Awaited<ReturnType<typeof runAnalyzeUrl>>["result"],
): Promise<void> {
  if (!opts.alsoJson || opts.format === "json") return;

  const fs = await import("fs/promises");
  const jsonOutput = formatReport(result, "json");
  try {
    await fs.writeFile(opts.alsoJson as string, jsonOutput, "utf-8");
    console.error(`JSON also written to ${opts.alsoJson}`);
  } catch (err) {
    console.error(
      `Error: --also-json write failed for ${opts.alsoJson}: ${err instanceof Error ? err.message : err}`,
    );
    process.exit(1);
  }
}

function applyScoreThreshold(
  opts: Record<string, unknown>,
  merged: Record<string, unknown>,
  result: Awaited<ReturnType<typeof runAnalyzeUrl>>["result"],
): void {
  const threshold =
    (merged.threshold as number | undefined) ??
    (opts.threshold ? parseFloat(opts.threshold as string) : undefined);
  if (threshold === undefined) return;

  const check = checkThreshold(result.findings, threshold);
  if (!check.passed) {
    console.error(`FAIL: Average score ${check.average.toFixed(1)} is below threshold ${threshold}`);
    process.exit(1);
  }
  console.error(`PASS: Average score ${check.average.toFixed(1)} meets threshold ${threshold}`);
}

function handleAnalyzeUrlError(err: unknown): never {
  if (err instanceof AnalyzeUrlError) {
    if (err.code === "unknown-profile") {
      console.error(err.message);
      console.error(`Available: ${listProfiles().join(", ")}`);
    } else {
      console.error(err.message);
    }
    process.exit(1);
  }
  if (
    err instanceof Error &&
    (err.message.includes("Cannot find module") || err.message.includes("Cannot find package"))
  ) {
    console.error("Playwright is required for analyze-url. Install it: npm install playwright");
    process.exit(1);
  }
  throw err;
}
