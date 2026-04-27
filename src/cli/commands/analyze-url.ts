import type { Command } from "commander";
import { handleAnalyzeUrlCommand } from "./analyze-url-action.js";

export function registerAnalyzeUrl(program: Command): void {
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
    .option(
      "--explore-timeout <ms>",
      "Total exploration timeout in milliseconds; includes probe time with --probe",
      "60000",
    )
    .option(
      "--explore-max-targets <n>",
      "Max accumulated targets before stopping exploration",
      "2000",
    )
    .option(
      "--allow-action <patterns...>",
      "Allow exploring controls matching these name/role patterns (overrides safety policy)",
    )
    // Filtering
    .option("--exclude <patterns...>", "Exclude targets matching these name/role patterns")
    .option("--exclude-selector <selectors...>", "CSS selectors to exclude from capture")
    .option(
      "--scope-selector <selectors...>",
      "CSS selectors that define the subtree(s) to capture, score, and probe",
    )
    .option("--focus <landmarks...>", "Only analyze targets within these landmarks")
    .option("--suppress <codes...>", "Suppress these diagnostic codes")
    // Analysis
    .option(
      "--probe",
      "Opt-in runtime keyboard probes for interactive targets (focus, activation, Escape, Tab)",
    )
    .option("--probe-budget <n>", "Maximum targets for generic probe (overrides --probe-mode)")
    .option("--probe-mode <mode>", "Probe depth: fast | standard | deep", "standard")
    .option(
      "--probe-selector <selectors...>",
      "CSS selectors that narrow probing without changing capture/scoring",
    )
    .option(
      "--entry-selector <selector>",
      "Activate this trigger before capture/probe, then prioritize newly revealed targets",
    )
    .option(
      "--goal-target <target>",
      "Exact-ish target id, name, role, kind, or selector hint for goal-directed probing",
    )
    .option(
      "--goal-pattern <pattern>",
      "Glob pattern matched against target id, name, role, kind, or selector for goal-directed probing",
    )
    .option(
      "--probe-strategy <strategy>",
      "Probe strategy: all | overlay | composite-widget | form | navigation | modal-return-focus | menu-pattern",
      "all",
    )
    .option(
      "--validate",
      "Run @guidepup/virtual-screen-reader on the captured DOM and include predicted-vs-actual comparison. Requires jsdom + @guidepup/virtual-screen-reader.",
    )
    .option("--validate-max-targets <n>", "Maximum findings to validate when --validate is set", "10")
    .option(
      "--validate-strategy <name>",
      "Navigation strategy for the virtual SR: linear | semantic",
      "semantic",
    )
    .option(
      "--check-visibility",
      "Force-enable per-icon visibility sampling across profile-declared color-scheme x forced-colors modes (overrides profile default)",
    )
    .option(
      "--no-check-visibility",
      "Disable visibility sampling even if the profile declares visualModes",
    )
    .option(
      "--baseline <path>",
      "Compare this run against a previously-saved analysis JSON. Pairs with --fail-on-regression for CI gating.",
    )
    .option(
      "--fail-on-regression [n]",
      "Exit non-zero when N or more findings regressed vs --baseline (default: 1). Implies --baseline.",
    )
    // Display
    .option("--top <n>", "Only show the worst N findings (default: 15)")
    .option(
      "--min-severity <level>",
      "Minimum severity to report (severe|high|moderate|acceptable|strong)",
    )
    .option("-q, --quiet", "Suppress info-level diagnostics")
    // CI
    .option("--threshold <n>", "Exit non-zero if average score is below this")
    .option(
      "--preset <name>",
      "Use a scoring preset (ecommerce-checkout, docs-site, dashboard, form-heavy)",
    )
    .option("--config <path>", "Path to tactual.json config file")
    // Browser
    .option("--no-headless", "Run browser in headed mode (helps with bot-blocked sites)")
    .option("--channel <name>", "Browser channel: chrome, chrome-beta, msedge")
    .option("--stealth", "Apply anti-bot-detection defaults")
    .option("--user-agent <ua>", "Override the User-Agent string")
    .option("--timeout <ms>", "Page load timeout in milliseconds", "30000")
    .option(
      "--wait-for-selector <selector>",
      "CSS selector to wait for before capturing (essential for SPAs)",
    )
    .option("--wait-time <ms>", "Additional milliseconds to wait after page load")
    .option("--storage-state <path>", "Playwright storageState JSON file for authenticated pages")
    .option("--also-json <path>", "Also write JSON output to this path")
    .option("--summary-only", "Output only compact summary stats")
    .action(handleAnalyzeUrlCommand);
}
