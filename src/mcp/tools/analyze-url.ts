import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { handleAnalyzeUrlTool } from "./analyze-url-handler.js";

export function registerAnalyzeUrl(server: McpServer): void {
  server.registerTool(
    "analyze_url",
    {
      description:
        "Analyze a web page for screen-reader navigation cost. Returns scored findings showing " +
        "how hard it is for AT users to discover, reach, and operate interactive targets. " +
        "Navigates to the URL in a sandboxed browser. Probes test keyboard behavior but do not submit forms or modify data.\n\n" +
        "**Recommended**: Use format='sarif' for concise, actionable output (~4KB). " +
        "SARIF auto-filters to findings that need attention (moderate and worse). " +
        "JSON/markdown include every target and can be 100x larger.\n\n" +
        "**SPAs (React, Next.js, etc.)**: Pass waitForSelector (e.g., '[data-testid=\"app\"]' " +
        "or 'main') so Tactual waits for the app to hydrate before capturing.",
      inputSchema: {
        url: z.string().describe("URL to analyze"),
        profile: z
          .string()
          .default("generic-mobile-web-sr-v0")
          .describe(
            "AT profile ID (generic-mobile-web-sr-v0, nvda-desktop-v0, jaws-desktop-v0, voiceover-ios-v0, talkback-android-v0)",
          ),
        device: z
          .string()
          .optional()
          .describe("Playwright device name for emulation (e.g., 'iPhone 14')"),
        explore: z
          .boolean()
          .default(false)
          .describe(
            "Explore hidden branches (menus, tabs, dialogs). Use with format='sarif' to avoid output overflow.",
          ),
        exploreDepth: z
          .number()
          .int()
          .min(1)
          .max(5)
          .default(2)
          .describe(
            "Max exploration depth (default: 2). How many levels of branches to walk when explore=true. " +
              "Higher = more thorough, but each level multiplies action count. CLI defaults to 3 for power-user runs; " +
              "MCP defaults to 2 for tighter agent-loop latency.",
          ),
        exploreBudget: z
          .number()
          .int()
          .min(1)
          .max(200)
          .optional()
          .describe(
            "Max total actions during exploration across all branches (default: 30). " +
              "Prevents pathological pages from exploding probe time. " +
              "CLI default is 50; MCP default is 30 for tighter agent-loop latency.",
          ),
        exploreTimeout: z
          .number()
          .int()
          .min(1000)
          .max(300000)
          .optional()
          .describe(
            "Total exploration timeout in ms; includes initial/revealed probe time when probe is enabled (default: 60000).",
          ),
        exploreMaxTargets: z
          .number()
          .int()
          .min(100)
          .max(5000)
          .optional()
          .describe("Max accumulated targets before exploration stops early (default: 2000)."),
        allowAction: z
          .array(z.string())
          .optional()
          .describe(
            "Glob patterns for controls that should be explorable despite the safety policy.",
          ),
        format: z
          .enum(["json", "markdown", "console", "sarif"])
          .default("sarif")
          .describe("Output format. 'sarif' (recommended) filters to actionable findings only."),
        minSeverity: z
          .enum(["severe", "high", "moderate", "acceptable", "strong"])
          .optional()
          .describe("Only include findings at this severity or worse. Reduces output size."),
        waitForSelector: z
          .string()
          .optional()
          .describe("CSS selector to wait for before capturing (essential for SPAs)."),
        waitTime: z.number().optional().describe("Additional ms to wait after page load."),
        timeout: z.number().default(30000).describe("Page load timeout in ms"),
        focus: z
          .array(z.string())
          .optional()
          .describe("Only analyze targets within these landmarks."),
        excludeSelector: z
          .array(z.string())
          .optional()
          .describe("CSS selectors to hide from analysis (set aria-hidden before capture)."),
        scopeSelector: z
          .array(z.string())
          .optional()
          .describe("CSS selectors that define the subtree(s) to capture, score, and probe."),
        exclude: z
          .array(z.string())
          .optional()
          .describe("Glob patterns to exclude targets by name/role/kind."),
        maxFindings: z.number().optional().describe("Maximum detailed findings to return."),
        probe: z
          .boolean()
          .default(false)
          .describe("Run keyboard probes on interactive targets. Adds ~30-60s."),
        probeBudget: z
          .number()
          .int()
          .min(1)
          .max(200)
          .optional()
          .describe(
            "Maximum number of targets for the generic probe. Overrides probeMode's generic budget.",
          ),
        probeMode: z
          .enum(["fast", "standard", "deep"])
          .default("standard")
          .describe(
            "Probe depth preset: fast=5/5/3/5, standard=20/20/10/20 (default), deep=50/40/20/40. Budgets are generic/menu/modal/widget.",
          ),
        probeSelector: z
          .array(z.string())
          .optional()
          .describe("CSS selectors that narrow probes without changing capture/scoring."),
        entrySelector: z
          .string()
          .optional()
          .describe(
            "Activate this trigger before capture/probe, then prioritize newly revealed targets.",
          ),
        goalTarget: z
          .string()
          .optional()
          .describe(
            "Exact-ish target id, name, role, kind, or selector hint for goal-directed probing.",
          ),
        goalPattern: z
          .string()
          .optional()
          .describe(
            "Glob pattern matched against target id/name/role/kind/selector for goal-directed probing.",
          ),
        probeStrategy: z
          .enum([
            "all",
            "overlay",
            "composite-widget",
            "form",
            "navigation",
            "modal-return-focus",
            "menu-pattern",
          ])
          .optional()
          .describe(
            "Probe family intent preset. Default all; use overlay, form, composite-widget, navigation, modal-return-focus, or menu-pattern to spend budget on one class of behavior.",
          ),
        summaryOnly: z
          .boolean()
          .default(false)
          .describe("Return compact summary stats. Use for quick page health checks."),
        includeStates: z
          .boolean()
          .default(false)
          .describe(
            "Include captured states in JSON output for passing to trace_path's statesJson parameter. " +
              "Uses compact format (~5KB).",
          ),
        storageState: z
          .string()
          .optional()
          .describe(
            "Path to Playwright storageState JSON (cookies + localStorage). Must be within cwd.",
          ),
        channel: z
          .string()
          .optional()
          .describe("Browser channel: chrome, chrome-beta, msedge. Bypasses shared pool."),
        stealth: z
          .boolean()
          .optional()
          .describe(
            "Apply anti-bot-detection defaults. Pair with channel for Cloudflare-protected sites.",
          ),
        checkVisibility: z
          .boolean()
          .optional()
          .describe(
            "Run the per-icon visibility probe across profile-declared " +
              "(colorScheme × forcedColors) modes. Emits hcm-icon-invisible, " +
              "low-contrast-icon, and hcm-substitution-risk findings. Undefined " +
              "defers to the profile default (desktop AT profiles declare the " +
              "full matrix; mobile/generic do not).",
          ),
      },
    },
    handleAnalyzeUrlTool,
  );
}
