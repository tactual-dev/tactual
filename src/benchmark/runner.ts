import type { Browser } from "playwright";
import type { AnalysisResult } from "../core/types.js";
import { severityFromScore } from "../core/types.js";
import { analyze } from "../core/analyzer.js";
import { getProfile } from "../profiles/index.js";
import { captureState } from "../playwright/capture.js";
import { explore as exploreState } from "../playwright/explorer.js";
import type {
  BenchmarkSuite,
  BenchmarkCase,
  BenchmarkAssertion,
  BenchmarkComparison,
  BenchmarkSuiteResult,
  BenchmarkCaseResult,
  BenchmarkComparisonResult,
  AssertionResult,
} from "./types.js";
import { resolve } from "path";
import { pathToFileURL } from "url";

/** Severity rank used for threshold assertions. Higher = less severe. */
const SEVERITY_RANK: Record<string, number> = {
  severe: 1, high: 2, moderate: 3, acceptable: 4, strong: 5,
};

/**
 * Run a benchmark suite and return results.
 *
 * `concurrency` controls how many cases run in parallel against the shared
 * Browser (each case uses its own BrowserContext via `browser.newPage()`,
 * so isolation is preserved). Defaults to 1 for deterministic serial runs;
 * tests pass a higher value to cut wall time.
 */
export async function runBenchmarkSuite(
  suite: BenchmarkSuite,
  browser: Browser,
  onProgress?: (msg: string) => void,
  concurrency: number = 1,
): Promise<BenchmarkSuiteResult> {
  const suiteStart = Date.now();
  const analyses = new Map<string, AnalysisResult>();
  const caseResults: BenchmarkCaseResult[] = new Array(suite.cases.length);

  // Worker pool: each worker pulls the next case index off a shared counter.
  // Preserves input order in caseResults regardless of completion order.
  let nextIdx = 0;
  const workers = Array.from({ length: Math.max(1, concurrency) }, async () => {
    while (true) {
      const idx = nextIdx++;
      if (idx >= suite.cases.length) return;
      const benchCase = suite.cases[idx];
      onProgress?.(`Running case: ${benchCase.name}...`);
      const result = await runBenchmarkCase(benchCase, browser);
      caseResults[idx] = result;
      if (result.analysis) {
        analyses.set(benchCase.id, result.analysis);
      }
    }
  });
  await Promise.all(workers);

  // Run comparisons
  const comparisonResults: BenchmarkComparisonResult[] = [];
  for (const comparison of suite.comparisons) {
    onProgress?.(`Comparing: ${comparison.name}...`);
    const result = runComparison(comparison, analyses);
    comparisonResults.push(result);
  }

  const totalPassed =
    caseResults.filter((r) => r.passed).length +
    comparisonResults.filter((r) => r.passed).length;
  const totalFailed =
    caseResults.filter((r) => !r.passed).length +
    comparisonResults.filter((r) => !r.passed).length;

  return {
    suiteName: suite.name,
    cases: caseResults,
    comparisons: comparisonResults,
    totalPassed,
    totalFailed,
    durationMs: Date.now() - suiteStart,
  };
}

async function runBenchmarkCase(
  benchCase: BenchmarkCase,
  browser: Browser,
): Promise<BenchmarkCaseResult> {
  const start = Date.now();

  try {
    const profile = getProfile(benchCase.profile);
    if (!profile) {
      return {
        caseId: benchCase.id,
        caseName: benchCase.name,
        passed: false,
        analysis: null,
        assertionResults: [],
        error: `Unknown profile: ${benchCase.profile}`,
        durationMs: Date.now() - start,
      };
    }

    const page = await browser.newPage();
    const url = resolveSource(benchCase.source);
    await page.goto(url, { waitUntil: "domcontentloaded" });
    await page.waitForLoadState("networkidle").catch(() => {});

    const state = await captureState(page, { provenance: "scripted" });
    let states = [state];

    if (benchCase.explore) {
      const result = await exploreState(page, state, {
        maxDepth: 2,
        maxActions: 30,
      });
      states = result.states;
    }

    await page.close();

    const analysis = analyze(states, profile, { name: benchCase.name });

    // Validate assertions
    const assertionResults = benchCase.assertions.map((assertion) =>
      validateAssertion(assertion, analysis),
    );

    const passed = assertionResults.every((r) => r.passed);

    return {
      caseId: benchCase.id,
      caseName: benchCase.name,
      passed,
      analysis,
      assertionResults,
      durationMs: Date.now() - start,
    };
  } catch (err) {
    return {
      caseId: benchCase.id,
      caseName: benchCase.name,
      passed: false,
      analysis: null,
      assertionResults: [],
      error: err instanceof Error ? err.message : String(err),
      durationMs: Date.now() - start,
    };
  }
}

function resolveSource(source: BenchmarkCase["source"]): string {
  if (source.type === "url") return source.url;
  return pathToFileURL(resolve(source.path)).href;
}

function validateAssertion(
  assertion: BenchmarkAssertion,
  result: AnalysisResult,
): AssertionResult {
  switch (assertion.type) {
    case "averageScoreInRange": {
      if (result.findings.length === 0) {
        return { assertion, passed: false, message: "No findings to average" };
      }
      const avg =
        result.findings.reduce((s, f) => s + f.scores.overall, 0) /
        result.findings.length;
      const passed = avg >= assertion.min && avg <= assertion.max;
      return {
        assertion,
        passed,
        message: `Average score: ${avg.toFixed(1)} (expected ${assertion.min}-${assertion.max})`,
      };
    }

    case "targetCountInRange": {
      const count = result.metadata.targetCount;
      const passed = count >= assertion.min && count <= assertion.max;
      return {
        assertion,
        passed,
        message: `Target count: ${count} (expected ${assertion.min}-${assertion.max})`,
      };
    }

    case "noSeverityWorseThan": {
      const threshold = SEVERITY_RANK[assertion.severity] ?? 0;
      const violations = result.findings.filter((f) => {
        const sev = severityFromScore(f.scores.overall);
        return (SEVERITY_RANK[sev] ?? 0) < threshold;
      });
      return {
        assertion,
        passed: violations.length === 0,
        message:
          violations.length === 0
            ? `No findings worse than ${assertion.severity}`
            : `${violations.length} findings worse than ${assertion.severity}`,
      };
    }

    case "minFindingsAtSeverity": {
      const threshold = SEVERITY_RANK[assertion.severity] ?? 0;
      const matching = result.findings.filter((f) => {
        const sev = severityFromScore(f.scores.overall);
        return (SEVERITY_RANK[sev] ?? 0) >= threshold;
      });
      const passed = matching.length >= assertion.count;
      return {
        assertion,
        passed,
        message: `${matching.length} findings at ${assertion.severity} or better (need ${assertion.count})`,
      };
    }

    case "hasTargetKinds": {
      const kinds = new Set(
        result.states.flatMap((s) => s.targets.map((t) => t.kind)),
      );
      const missing = assertion.kinds.filter((k) => !kinds.has(k as typeof kinds extends Set<infer T> ? T : never));
      return {
        assertion,
        passed: missing.length === 0,
        message:
          missing.length === 0
            ? `Found all expected target kinds: ${assertion.kinds.join(", ")}`
            : `Missing target kinds: ${missing.join(", ")}`,
      };
    }

    case "hasEdges": {
      const passed = result.metadata.edgeCount > 0;
      return {
        assertion,
        passed,
        message: `Edge count: ${result.metadata.edgeCount}`,
      };
    }

    case "hasTargetWithName": {
      const pattern = new RegExp(assertion.pattern, "i");
      const found = result.states.some((s) =>
        s.targets.some((t) => pattern.test(t.name)),
      );
      return {
        assertion,
        passed: found,
        message: found
          ? `Found target matching "${assertion.pattern}"`
          : `No target matching "${assertion.pattern}"`,
      };
    }
  }
}

function runComparison(
  comparison: BenchmarkComparison,
  analyses: Map<string, AnalysisResult>,
): BenchmarkComparisonResult {
  const betterResult = analyses.get(comparison.better);
  const worseResult = analyses.get(comparison.worse);

  if (!betterResult || !worseResult) {
    return {
      comparisonId: comparison.id,
      comparisonName: comparison.name,
      passed: false,
      betterScore: 0,
      worseScore: 0,
      gap: 0,
      message: `Missing analysis for ${!betterResult ? comparison.better : comparison.worse}`,
    };
  }

  if (comparison.compareBy === "targetCount") {
    const betterCount = betterResult.metadata.targetCount;
    const worseCount = worseResult.metadata.targetCount;
    const gap = betterCount - worseCount;
    const minGap = comparison.minGap ?? 1;
    const passed = gap >= minGap;

    return {
      comparisonId: comparison.id,
      comparisonName: comparison.name,
      passed,
      betterScore: betterCount,
      worseScore: worseCount,
      gap,
      message: passed
        ? `${comparison.better} (${betterCount} targets) > ${comparison.worse} (${worseCount} targets) by ${gap}`
        : `Expected ${comparison.better} to have ${minGap}+ more targets than ${comparison.worse}, but gap was ${gap}`,
    };
  }

  const betterAvg = avgScore(betterResult);
  const worseAvg = avgScore(worseResult);
  const gap = betterAvg - worseAvg;
  const minGap = comparison.minGap ?? 0;
  const passed = gap >= minGap;

  return {
    comparisonId: comparison.id,
    comparisonName: comparison.name,
    passed,
    betterScore: Math.round(betterAvg * 10) / 10,
    worseScore: Math.round(worseAvg * 10) / 10,
    gap: Math.round(gap * 10) / 10,
    message: passed
      ? `${comparison.better} (${betterAvg.toFixed(1)}) > ${comparison.worse} (${worseAvg.toFixed(1)}) by ${gap.toFixed(1)} points`
      : `Expected ${comparison.better} > ${comparison.worse} by ${minGap}+ but gap was ${gap.toFixed(1)}`,
  };
}

function avgScore(result: AnalysisResult): number {
  if (result.findings.length === 0) return 0;
  return (
    result.findings.reduce((s, f) => s + f.scores.overall, 0) /
    result.findings.length
  );
}

/**
 * Format benchmark results for console output.
 */
export function formatBenchmarkResults(result: BenchmarkSuiteResult): string {
  const lines: string[] = [];
  lines.push(`Benchmark Suite: ${result.suiteName}`);
  lines.push(`Duration: ${(result.durationMs / 1000).toFixed(1)}s`);
  lines.push("");

  // Cases
  lines.push("Cases:");
  for (const c of result.cases) {
    const icon = c.passed ? "[PASS]" : "[FAIL]";
    lines.push(`  ${icon} ${c.caseName}`);
    if (c.error) {
      lines.push(`    Error: ${c.error}`);
    }
    for (const a of c.assertionResults) {
      const aIcon = a.passed ? "  ok" : "  FAIL";
      lines.push(`    ${aIcon}: ${a.message}`);
    }
  }
  lines.push("");

  // Comparisons
  if (result.comparisons.length > 0) {
    lines.push("Comparisons:");
    for (const c of result.comparisons) {
      const icon = c.passed ? "[PASS]" : "[FAIL]";
      lines.push(`  ${icon} ${c.comparisonName}: ${c.message}`);
    }
    lines.push("");
  }

  // Summary
  lines.push(
    `Results: ${result.totalPassed} passed, ${result.totalFailed} failed`,
  );

  return lines.join("\n");
}
