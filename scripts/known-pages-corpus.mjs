#!/usr/bin/env node

/**
 * Live known-pages benchmark for the 0.5 capture stack.
 *
 * This intentionally writes under build/ and is not part of the release gate:
 * live documentation sites change, throttle, and sometimes challenge headless
 * browsers. The value is repeatable release evidence and category rollups, not
 * a deterministic CI assertion.
 */

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const VALID_CONTENT_CORPUS = [
  {
    name: "react-aria-combobox",
    url: "https://react-aria.adobe.com/ComboBox",
    category: "component-library-docs",
    focus: "combobox",
  },
  {
    name: "fluent-combobox-storybook",
    url: "https://storybooks.fluentui.dev/react/?path=/docs/components-combobox--docs",
    category: "storybook-spa",
    focus: "combobox",
  },
  {
    name: "carbon-dropdown",
    url: "https://carbondesignsystem.com/components/dropdown/accessibility/",
    category: "design-system-docs",
    focus: "dropdown",
  },
  {
    name: "uswds-combobox",
    url: "https://designsystem.digital.gov/components/combo-box/",
    category: "government-design-system",
    focus: "combobox",
  },
  {
    name: "govuk-accordion",
    url: "https://design-system.service.gov.uk/components/accordion/",
    category: "government-design-system",
    focus: "accordion",
  },
  {
    name: "shopify-polaris-button",
    url: "https://polaris-react.shopify.com/components/actions/button",
    category: "commercial-design-system",
    focus: "button",
  },
  {
    name: "mui-autocomplete",
    url: "https://mui.com/material-ui/react-autocomplete/",
    category: "component-library-docs",
    focus: "autocomplete",
  },
  {
    name: "radix-select",
    url: "https://www.radix-ui.com/primitives/docs/components/select",
    category: "headless-component-docs",
    focus: "select",
  },
  {
    name: "ariakit-combobox",
    url: "https://ariakit.com/components/combobox",
    category: "headless-component-docs",
    focus: "combobox",
  },
  {
    name: "headlessui-combobox",
    url: "https://headlessui.com/react/combobox",
    category: "headless-component-docs",
    focus: "combobox",
  },
  {
    name: "base-ui-combobox",
    url: "https://base-ui.com/react/components/combobox",
    category: "headless-component-docs",
    focus: "combobox",
  },
];

const CAPTURE_PROBES = [
  {
    name: "w3c-apg-combobox",
    url: "https://www.w3.org/WAI/ARIA/apg/patterns/combobox/examples/combobox-autocomplete-list/",
    category: "capture-quality-probe",
    focus: "combobox",
    captureQualityOnly: true,
  },
  {
    name: "w3c-apg-dialog",
    url: "https://www.w3.org/WAI/ARIA/apg/patterns/dialog-modal/examples/dialog/",
    category: "capture-quality-probe",
    focus: "dialog",
    captureQualityOnly: true,
  },
  {
    name: "apg-tr-combobox",
    url: "https://www.w3.org/TR/wai-aria-practices/examples/combobox/combobox-autocomplete-list.html",
    category: "capture-quality-probe",
    focus: "combobox",
    captureQualityOnly: true,
  },
  {
    name: "apg-tr-dialog",
    url: "https://www.w3.org/TR/wai-aria-practices/examples/dialog-modal/dialog.html",
    category: "capture-quality-probe",
    focus: "dialog",
    captureQualityOnly: true,
  },
];

const DEFAULTS = {
  build: false,
  cli: resolve("dist/cli/index.js"),
  out: "",
  limit: 0,
  includeCaptureProbes: false,
  timeout: 60000,
  waitTime: 1500,
  exploreDepth: 2,
  exploreBudget: 30,
  exploreTimeout: 45000,
  processTimeout: 180000,
  reportFrom: "",
};

const CATEGORY_ORDER = [
  "component-implementation",
  "composite-widget-interop",
  "docs-shell-navigation",
  "keyboard-order",
  "visual-mode",
  "capture-quality",
  "capture-helper",
  "other",
];

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  printHelp();
  process.exit(0);
}
if (args.list) {
  printCorpus(args);
  process.exit(0);
}

if (args.reportFrom) {
  const run = JSON.parse(await readFile(args.reportFrom, "utf-8"));
  const normalized = normalizeRun(run);
  const outDir = args.out || normalized.outDir || dirname(resolve(args.reportFrom));
  await mkdir(outDir, { recursive: true });
  const report = formatReport(normalized, outDir);
  await writeFile(resolve(outDir, "REPORT.md"), report, "utf-8");
  console.log(`Known-pages report written to ${resolve(outDir, "REPORT.md")}`);
  process.exit(0);
}

if (args.build) {
  const build = process.platform === "win32"
    ? spawnSync("npm run build", { stdio: "inherit", shell: true })
    : spawnSync("npm", ["run", "build"], { stdio: "inherit" });
  if (build.error || build.status !== 0) {
    console.error(`Build failed: ${build.error?.message ?? `exit ${build.status}`}`);
    process.exit(build.status ?? 1);
  }
}

const outDir = args.out || resolve("build", `known-pages-${timestamp()}`);
await mkdir(outDir, { recursive: true });

if (!existsSync(args.cli)) {
  console.error(
    `Built Tactual CLI not found at ${args.cli}. Run npm run build first, or use npm run benchmark:known-pages.`,
  );
  process.exit(1);
}

const entries = selectCorpus(args);
const run = {
  schema: "tactual-known-pages-corpus@1",
  generatedAt: new Date().toISOString(),
  outDir,
  options: {
    includeCaptureProbes: args.includeCaptureProbes,
    limit: args.limit,
    timeout: args.timeout,
    waitTime: args.waitTime,
    exploreDepth: args.exploreDepth,
    exploreBudget: args.exploreBudget,
    exploreTimeout: args.exploreTimeout,
    processTimeout: args.processTimeout,
  },
  results: [],
};

for (const entry of entries) {
  const started = Date.now();
  const outputPath = resolve(outDir, `${entry.name}.analysis.full.json`);
  process.stderr.write(`Analyzing ${entry.name}...`);
  const child = spawnSync(
    process.execPath,
    [
      args.cli,
      "analyze-url",
      entry.url,
      "--format",
      "json",
      "--full-json",
      "--output",
      outputPath,
      "--descend-frames",
      "--auto-scroll",
      "--dismiss-banners",
      "--probe-hover",
      "--walk-tab-order",
      "--diff-viewports",
      "--detect-routes",
      "--explore",
      "--explore-depth",
      String(args.exploreDepth),
      "--explore-budget",
      String(args.exploreBudget),
      "--explore-timeout",
      String(args.exploreTimeout),
      "--stealth",
      "--wait-time",
      String(args.waitTime),
      "--timeout",
      String(args.timeout),
    ],
    {
      encoding: "utf-8",
      timeout: args.processTimeout,
      env: { ...process.env, FORCE_COLOR: "0", NO_COLOR: "1" },
    },
  );

  const seconds = round((Date.now() - started) / 1000);
  if (child.error || child.status !== 0) {
    const message = child.error?.message ?? child.stderr?.trim() ?? child.stdout?.trim() ?? "unknown failure";
    run.results.push({
      ...entry,
      status: "failed",
      seconds,
      outputPath,
      error: message.slice(0, 1000),
    });
    process.stderr.write(` failed (${seconds}s)\n`);
    continue;
  }

  const analysis = JSON.parse(await readFile(outputPath, "utf-8"));
  const summary = summarizeAnalysis(analysis);
  run.results.push({
    ...entry,
    status: "completed",
    seconds,
    outputPath,
    summary,
  });
  process.stderr.write(
    ` ${summary.targets} targets, ${summary.findings} findings, ${summary.states} states (${seconds}s)\n`,
  );
}

const normalized = normalizeRun(run);
await writeFile(resolve(outDir, "run-results.json"), JSON.stringify(normalized, null, 2), "utf-8");
await writeFile(resolve(outDir, "summary.json"), JSON.stringify(summarizeRun(normalized), null, 2), "utf-8");
await writeFile(resolve(outDir, "REPORT.md"), formatReport(normalized, outDir), "utf-8");
console.log(`Known-pages corpus complete: ${resolve(outDir, "REPORT.md")}`);

function parseArgs(argv) {
  const parsed = { ...DEFAULTS, help: false, list: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      parsed.help = true;
    } else if (arg === "--list") {
      parsed.list = true;
    } else if (arg === "--include-capture-probes") {
      parsed.includeCaptureProbes = true;
    } else if (arg === "--build") {
      parsed.build = true;
    } else if (arg === "--out") {
      parsed.out = resolve(requireValue(argv, ++i, arg));
    } else if (arg === "--cli") {
      parsed.cli = resolve(requireValue(argv, ++i, arg));
    } else if (arg === "--limit") {
      parsed.limit = parsePositiveInt(requireValue(argv, ++i, arg), arg);
    } else if (arg === "--timeout") {
      parsed.timeout = parsePositiveInt(requireValue(argv, ++i, arg), arg);
    } else if (arg === "--wait-time") {
      parsed.waitTime = parseNonNegativeInt(requireValue(argv, ++i, arg), arg);
    } else if (arg === "--explore-depth") {
      parsed.exploreDepth = parsePositiveInt(requireValue(argv, ++i, arg), arg);
    } else if (arg === "--explore-budget") {
      parsed.exploreBudget = parsePositiveInt(requireValue(argv, ++i, arg), arg);
    } else if (arg === "--explore-timeout") {
      parsed.exploreTimeout = parsePositiveInt(requireValue(argv, ++i, arg), arg);
    } else if (arg === "--process-timeout") {
      parsed.processTimeout = parsePositiveInt(requireValue(argv, ++i, arg), arg);
    } else if (arg === "--report-from") {
      parsed.reportFrom = resolve(requireValue(argv, ++i, arg));
    } else {
      console.error(`Unknown option: ${arg}`);
      printHelp();
      process.exit(1);
    }
  }
  return parsed;
}

function requireValue(argv, index, option) {
  const value = argv[index];
  if (!value || value.startsWith("--")) {
    console.error(`${option} requires a value.`);
    process.exit(1);
  }
  return value;
}

function parsePositiveInt(value, option) {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n) || n <= 0) {
    console.error(`${option} must be a positive integer.`);
    process.exit(1);
  }
  return n;
}

function parseNonNegativeInt(value, option) {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n) || n < 0) {
    console.error(`${option} must be a non-negative integer.`);
    process.exit(1);
  }
  return n;
}

function printHelp() {
  console.log(`Known-pages live benchmark for Tactual.

Usage:
  node scripts/known-pages-corpus.mjs [options]

Options:
  --out <dir>                   Output directory (default: build/known-pages-<timestamp>)
  --build                       Run npm run build before invoking the built CLI
  --cli <path>                  Built CLI path (default: dist/cli/index.js)
  --limit <n>                   Run only the first N content entries
  --include-capture-probes      Also run live APG/W3C capture-quality probes
  --timeout <ms>                Page-load timeout passed to analyze-url (default: 60000)
  --wait-time <ms>              Extra wait after load (default: 1500)
  --explore-depth <n>           Exploration depth (default: 2)
  --explore-budget <n>          Exploration action budget (default: 30)
  --explore-timeout <ms>        Exploration timeout (default: 45000)
  --process-timeout <ms>        Per-page process timeout (default: 180000)
  --report-from <json>          Regenerate REPORT.md from a saved run-results JSON
  --list                        Print the corpus entries and exit
  --help                        Show this help

This script exercises: --descend-frames, --auto-scroll, --dismiss-banners,
--probe-hover, --walk-tab-order, --diff-viewports, --detect-routes, --explore,
and --stealth. It is intentionally manual because live sites are not stable CI fixtures.`);
}

function printCorpus(options) {
  const rows = selectCorpus(options).map((entry) => ({
    name: entry.name,
    category: entry.category,
    focus: entry.focus,
    captureQualityOnly: entry.captureQualityOnly === true,
    url: entry.url,
  }));
  console.log(JSON.stringify(rows, null, 2));
}

function selectCorpus(options) {
  const content = options.limit > 0
    ? VALID_CONTENT_CORPUS.slice(0, options.limit)
    : VALID_CONTENT_CORPUS;
  return options.includeCaptureProbes ? [...content, ...CAPTURE_PROBES] : content;
}

function normalizeRun(run) {
  const results = (run.results ?? []).map((result) => {
    if (result.status !== "completed" || result.summary) return result;
    if (result.analysis) {
      return { ...result, summary: summarizeAnalysis(result.analysis) };
    }
    return result;
  });
  return { ...run, results };
}

function summarizeAnalysis(analysis) {
  const states = analysis.states ?? [];
  const targets = states.flatMap((state) => state.targets ?? []);
  const findings = analysis.findings ?? [];
  const diagnostics = analysis.diagnostics ?? [];
  const severity = countBy(findings, (finding) => finding.severity ?? "unknown", {
    strong: 0,
    acceptable: 0,
    moderate: 0,
    high: 0,
    severe: 0,
  });
  const issueFindings = findings.filter((finding) =>
    (finding.penalties ?? []).some((penalty) => String(penalty).trim().length > 0),
  );
  const diagnosticCounts = countBy(diagnostics, (diagnostic) => diagnostic.code ?? "unknown");
  const diagnosticLevels = countBy(diagnostics, (diagnostic) => diagnostic.level ?? "unknown", {
    info: 0,
    warning: 0,
    error: 0,
  });
  const categoryCounts = countBy(issueFindings, classifyFinding, emptyCategoryCounts());
  const diagnosticCategoryCounts = countBy(diagnostics, classifyDiagnostic, emptyCategoryCounts());
  const highAndSevere = findings
    .filter((finding) => finding.severity === "high" || finding.severity === "severe")
    .sort((a, b) => score(a) - score(b))
    .slice(0, 25)
    .map((finding) => ({
      targetId: finding.targetId,
      severity: finding.severity,
      overall: score(finding),
      category: classifyFinding(finding),
      firstPenalty: finding.penalties?.[0] ?? "",
    }));

  return {
    states: states.length,
    targets: analysis.metadata?.targetCount ?? targets.length,
    findings: analysis.metadata?.findingCount ?? findings.length,
    severity,
    diagnostics: diagnostics.length,
    diagnosticLevels,
    diagnosticCounts,
    topDiagnostics: topCounts(diagnosticCounts, 8),
    categoryCounts,
    diagnosticCategoryCounts,
    highAndSevere,
    routeChanges: diagnostics.some((diagnostic) => diagnostic.code === "spa-route-changes"),
    frames:
      diagnostics.some((diagnostic) => diagnostic.code === "frames-descended") ||
      targets.some((target) => Boolean(target._frame)),
    captureQuality:
      diagnostics.some((diagnostic) =>
        diagnostic.code === "blocked-by-bot-protection" ||
        diagnostic.code === "possibly-degraded-content" ||
        diagnostic.code === "empty-page",
      ),
  };
}

function summarizeRun(run) {
  const completed = run.results.filter((result) => result.status === "completed");
  const valid = completed.filter((result) => result.captureQualityOnly !== true && !result.summary?.captureQuality);
  const captureProbes = completed.filter((result) => result.captureQualityOnly === true || result.summary?.captureQuality);
  return {
    schema: "tactual-known-pages-summary@1",
    generatedAt: run.generatedAt,
    completed: completed.length,
    failed: run.results.filter((result) => result.status !== "completed").length,
    validContentRuns: valid.length,
    captureQualityRuns: captureProbes.length,
    totals: rollup(valid),
    categoryTotals: rollupCategories(valid, "categoryCounts"),
    diagnosticCategoryTotals: rollupCategories(completed, "diagnosticCategoryCounts"),
    topDiagnostics: topCounts(
      mergeCountMaps(completed.map((result) => result.summary?.diagnosticCounts ?? {})),
      20,
    ),
  };
}

function rollup(results) {
  const totals = {
    pages: results.length,
    states: 0,
    targets: 0,
    findings: 0,
    strong: 0,
    acceptable: 0,
    moderate: 0,
    high: 0,
    severe: 0,
    diagnostics: 0,
    warnings: 0,
    errors: 0,
    routePages: 0,
    framePages: 0,
  };
  for (const result of results) {
    const summary = result.summary;
    if (!summary) continue;
    totals.states += summary.states;
    totals.targets += summary.targets;
    totals.findings += summary.findings;
    for (const key of ["strong", "acceptable", "moderate", "high", "severe"]) {
      totals[key] += summary.severity?.[key] ?? 0;
    }
    totals.diagnostics += summary.diagnostics;
    totals.warnings += summary.diagnosticLevels?.warning ?? 0;
    totals.errors += summary.diagnosticLevels?.error ?? 0;
    if (summary.routeChanges) totals.routePages++;
    if (summary.frames) totals.framePages++;
  }
  return totals;
}

function rollupCategories(results, field) {
  return mergeCountMaps(results.map((result) => result.summary?.[field] ?? {}));
}

function formatReport(run, outDir) {
  const summary = summarizeRun(run);
  const lines = [];
  lines.push("# Known Pages Corpus Run");
  lines.push("");
  lines.push(`Run folder: ${outDir}`);
  lines.push(`Generated: ${run.generatedAt ?? "(unknown)"}`);
  lines.push("");
  lines.push("## Valid Content Runs");
  lines.push("");
  lines.push("| Page | Category | Seconds | States | Targets | Findings | Strong | Acceptable | Moderate | High | Severe | Routes | Frames | Top Finding Categories | Top Diagnostics |");
  lines.push("|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|---|---|---|");
  for (const result of run.results.filter((r) => r.status === "completed" && r.captureQualityOnly !== true && !r.summary?.captureQuality)) {
    lines.push(formatResultRow(result));
  }
  lines.push("");
  lines.push("## Totals");
  lines.push("");
  for (const [key, value] of Object.entries(summary.totals)) {
    lines.push(`- ${key}: ${value}`);
  }
  lines.push("");
  lines.push("## Finding Category Rollup");
  lines.push("");
  for (const [category, count] of sortedCounts(summary.categoryTotals)) {
    lines.push(`- ${category}: ${count}`);
  }
  lines.push("");
  lines.push("## Diagnostic Category Rollup");
  lines.push("");
  for (const [category, count] of sortedCounts(summary.diagnosticCategoryTotals)) {
    lines.push(`- ${category}: ${count}`);
  }
  lines.push("");
  lines.push("## Top Diagnostic Codes");
  lines.push("");
  for (const [code, count] of summary.topDiagnostics) {
    lines.push(`- ${code}: ${count}`);
  }
  lines.push("");
  lines.push("## High And Severe Findings");
  lines.push("");
  const highSevere = run.results
    .filter((r) => r.status === "completed" && r.captureQualityOnly !== true && !r.summary?.captureQuality)
    .flatMap((result) =>
      (result.summary?.highAndSevere ?? []).map((finding) => ({
        page: result.name,
        ...finding,
      })),
    )
    .sort((a, b) => a.overall - b.overall)
    .slice(0, 40);
  if (highSevere.length === 0) {
    lines.push("No high or severe findings in valid content runs.");
  } else {
    for (const finding of highSevere) {
      lines.push(
        `- ${finding.page}: ${finding.severity} ${finding.targetId} ` +
          `overall=${finding.overall}; ${finding.category}; ${finding.firstPenalty}`,
      );
    }
  }
  const captureRuns = run.results.filter(
    (r) => r.status === "completed" && (r.captureQualityOnly === true || r.summary?.captureQuality),
  );
  if (captureRuns.length > 0) {
    lines.push("");
    lines.push("## Capture-Quality Runs");
    lines.push("");
    lines.push("| Page | Probe Only | Targets | Blocked | Degraded | Diagnostics |");
    lines.push("|---|---|---:|---|---|---|");
    for (const result of captureRuns) {
      const counts = result.summary?.diagnosticCounts ?? {};
      lines.push(
        `| ${result.name} | ${result.captureQualityOnly === true ? "yes" : "no"} | ` +
          `${result.summary?.targets ?? 0} | ${counts["blocked-by-bot-protection"] ? "yes" : "no"} | ` +
          `${counts["possibly-degraded-content"] ? "yes" : "no"} | ${formatCounts(counts, 8)} |`,
      );
    }
  }
  const failures = run.results.filter((r) => r.status !== "completed");
  if (failures.length > 0) {
    lines.push("");
    lines.push("## Failures");
    lines.push("");
    for (const failure of failures) {
      lines.push(`- ${failure.name}: ${failure.error ?? "unknown failure"}`);
    }
  }
  lines.push("");
  lines.push("## Interpretation Notes");
  lines.push("");
  lines.push("- Valid content runs exercise modern SPA/component documentation pages with the 0.5 capture helpers enabled.");
  lines.push("- Category rollups separate documentation-shell navigation cost from component implementation and composite-widget interop signals.");
  lines.push("- Capture-quality runs are evidence about headless reachability of the page, not accessibility quality of the intended reference widget.");
  lines.push("- Live-site scores are release evidence and regression prompts; stable gating should use local fixtures and the versioned calibration corpus.");
  lines.push("");
  return lines.join("\n");
}

function formatResultRow(result) {
  const s = result.summary;
  const sev = s.severity ?? {};
  return [
    result.name,
    result.category,
    result.seconds ?? "",
    s.states,
    s.targets,
    s.findings,
    sev.strong ?? 0,
    sev.acceptable ?? 0,
    sev.moderate ?? 0,
    sev.high ?? 0,
    sev.severe ?? 0,
    s.routeChanges ? "yes" : "no",
    s.frames ? "yes" : "no",
    formatCounts(s.categoryCounts ?? {}, 4),
    formatCounts(s.diagnosticCounts ?? {}, 6),
  ].map(escapeCell).join(" | ").replace(/^/, "| ").replace(/$/, " |");
}

function classifyFinding(finding) {
  const primary = String(finding.penalties?.[0] ?? "");
  const all = `${primary} ${(finding.suggestedFixes ?? []).join(" ")}`.toLowerCase();
  if (/interop risk|combobox|listbox|menu:|dialog:|composite widget/.test(all)) {
    return "composite-widget-interop";
  }
  if (/accessible name|empty interactive|aria|autocomplete|nested interactive|duplicate id|iframe title|fake interactive/.test(all)) {
    return "component-implementation";
  }
  if (/tab stop|tabindex|focus order|focus trap|keyboard order/.test(all)) {
    return "keyboard-order";
  }
  if (/contrast|color|forced colors|target size|wcag 2\.5\.8|low-vision/.test(all)) {
    return "visual-mode";
  }
  if (/heading|landmark|skip|linear traversal|sequential items|controls precede|not efficiently reachable|requires opening a hidden branch/.test(all)) {
    return "docs-shell-navigation";
  }
  return "other";
}

function classifyDiagnostic(diagnostic) {
  const code = diagnostic.code ?? "";
  if (
    code === "blocked-by-bot-protection" ||
    code === "possibly-degraded-content" ||
    code === "empty-page" ||
    code === "sparse-content" ||
    code === "possible-login-wall" ||
    code === "redirect-detected"
  ) {
    return "capture-quality";
  }
  if (
    code === "auto-scrolled" ||
    code === "frames-descended" ||
    code === "spa-route-changes" ||
    code === "banners-dismissed" ||
    code === "framework-detected" ||
    code === "cdp-click-listeners"
  ) {
    return "capture-helper";
  }
  if (
    code === "no-landmarks" ||
    code === "no-main-landmark" ||
    code === "no-banner-landmark" ||
    code === "no-contentinfo-landmark" ||
    code === "no-nav-landmark" ||
    code === "no-headings" ||
    code === "heading-skip" ||
    code === "no-skip-link" ||
    code === "skip-link-not-first" ||
    code === "broken-skip-link" ||
    code === "structural-summary" ||
    code === "shared-structural-issue" ||
    code === "ambiguous-link-names" ||
    code === "redundant-tab-stops"
  ) {
    return "docs-shell-navigation";
  }
  if (code === "tab-order-walked" || code === "visual-order-divergence") {
    return "keyboard-order";
  }
  if (
    code === "low-contrast-text" ||
    code === "color-only-conveyance" ||
    code === "color-blindness-contrast-fail" ||
    code === "viewport-divergence"
  ) {
    return "visual-mode";
  }
  if (
    code === "fake-interactive-elements" ||
    code === "form-summary" ||
    code === "missing-autocomplete" ||
    code === "missing-image-alt" ||
    code === "suspicious-image-alt" ||
    code === "missing-iframe-title" ||
    code === "duplicate-id" ||
    code === "nested-interactive" ||
    code === "empty-interactive" ||
    code === "invalid-aria-role" ||
    code === "unknown-aria-attr" ||
    code === "invalid-aria-attr-value" ||
    code === "missing-required-aria-attr" ||
    code === "aria-naming-prohibited" ||
    code === "unsupported-aria-attr-for-role"
  ) {
    return "component-implementation";
  }
  return "other";
}

function countBy(items, keyFn, seed = {}) {
  const counts = { ...seed };
  for (const item of items) {
    const key = keyFn(item);
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

function emptyCategoryCounts() {
  return Object.fromEntries(CATEGORY_ORDER.map((category) => [category, 0]));
}

function mergeCountMaps(maps) {
  const merged = {};
  for (const map of maps) {
    for (const [key, value] of Object.entries(map)) {
      merged[key] = (merged[key] ?? 0) + Number(value);
    }
  }
  return merged;
}

function topCounts(counts, limit) {
  return sortedCounts(counts).slice(0, limit);
}

function sortedCounts(counts) {
  return Object.entries(counts)
    .filter(([, count]) => Number(count) > 0)
    .sort((a, b) => Number(b[1]) - Number(a[1]) || a[0].localeCompare(b[0]));
}

function formatCounts(counts, limit) {
  const entries = topCounts(counts, limit);
  if (entries.length === 0) return "";
  return entries.map(([key, count]) => `${key}:${count}`).join(", ");
}

function score(finding) {
  return Number(finding.scores?.overall ?? finding.overall ?? 0);
}

function escapeCell(value) {
  return String(value).replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

function timestamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

function round(value) {
  return Math.round(value * 10) / 10;
}
