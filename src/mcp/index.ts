/**
 * Tactual MCP Server
 *
 * Exposes screen-reader navigation cost analysis as MCP tools
 * for consumption by AI agents and coding assistants.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { getProfile, listProfiles } from "../profiles/index.js";
import { analyze } from "../core/analyzer.js";
import { validateUrl } from "../core/url-validation.js";
import { formatReport, type ReportFormat } from "../reporters/index.js";
import type { Target } from "../core/types.js";
import { buildGraph } from "../core/graph-builder.js";
import {
  collectEntryPoints,
  computePathsFromEntries,
} from "../core/path-analysis.js";
import { VERSION } from "../version.js";
import { summarize } from "../reporters/summarize.js";
import { extractFindings, deduplicateFindings } from "./helpers.js";
import { findMatchingTargets, modelAnnouncement } from "./trace-helpers.js";

export { extractFindings, getOverallScore } from "./helpers.js";

// ---------------------------------------------------------------------------
// Browser pool — reuses a single Chromium instance across tool calls.
// Eliminates ~2s browser launch overhead per call. Each tool call
// creates an isolated BrowserContext (separate cookies/storage).
// ---------------------------------------------------------------------------

let _browserPromise: Promise<import("playwright").Browser> | null = null;

async function getSharedBrowser(): Promise<import("playwright").Browser> {
  if (!_browserPromise) {
    _browserPromise = import("playwright").then((pw) => pw.chromium.launch());
    // If the browser crashes or disconnects, reset so it relaunches
    _browserPromise.then((b) => {
      b.on("disconnected", () => { _browserPromise = null; });
    }).catch(() => { _browserPromise = null; });
  }
  return _browserPromise;
}

/** Close the shared browser pool (for clean HTTP server shutdown). */
export async function closeSharedBrowser(): Promise<void> {
  if (_browserPromise) {
    const p = _browserPromise;
    _browserPromise = null;
    try { (await p).close(); } catch { /* already closed */ }
  }
}

export function createMcpServer(): McpServer {
  const server = new McpServer({
    name: "tactual",
    version: VERSION,
  });

  // ---- Tool: analyze_url ----
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
          .describe("AT profile ID (generic-mobile-web-sr-v0, nvda-desktop-v0, jaws-desktop-v0, voiceover-ios-v0, talkback-android-v0)"),
        device: z
          .string()
          .optional()
          .describe("Playwright device name for emulation (e.g., 'iPhone 14')"),
        explore: z
          .boolean()
          .default(false)
          .describe("Explore hidden branches (menus, tabs, dialogs). Use with format='sarif' to avoid output overflow."),
        allowAction: z
          .array(z.string())
          .optional()
          .describe("Glob patterns for controls that should be explorable despite the safety policy (e.g., 'button:checkout', 'submit:*'). Overrides unsafe→caution."),
        format: z
          .enum(["json", "markdown", "console", "sarif"])
          .default("sarif")
          .describe("Output format. 'sarif' (recommended) filters to actionable findings only. 'json' includes all targets."),
        minSeverity: z
          .enum(["severe", "high", "moderate", "acceptable", "strong"])
          .optional()
          .describe("Only include findings at this severity or worse. Reduces output size."),
        waitForSelector: z
          .string()
          .optional()
          .describe("CSS selector to wait for before capturing (essential for SPAs). E.g., 'main', '#app', '[data-hydrated]'"),
        waitTime: z
          .number()
          .optional()
          .describe("Additional milliseconds to wait after page load (default: 0). Use for slow-rendering SPAs."),
        timeout: z
          .number()
          .default(30000)
          .describe("Page load timeout in milliseconds"),
        focus: z
          .array(z.string())
          .optional()
          .describe("Only analyze targets within these landmarks (e.g., ['main', 'navigation']). Reduces noise in large pages."),
        excludeSelector: z
          .array(z.string())
          .optional()
          .describe("CSS selectors to hide from analysis (e.g., ['#notifications', '.cookie-banner']). Elements are set aria-hidden before capture."),
        exclude: z
          .array(z.string())
          .optional()
          .describe("Glob patterns to exclude targets by name/role/kind (e.g., ['*cookie*', '*notification*', 'banner']). Case-insensitive, supports * and ? wildcards."),
        maxFindings: z
          .number()
          .optional()
          .describe("Maximum detailed findings to return (default: 15 for JSON/markdown, 25 for SARIF). Use 3-5 for quick checks, higher for thorough audits."),
        probe: z
          .boolean()
          .default(false)
          .describe(
            "Run keyboard probes on interactive targets (focus, activation, Escape recovery, Tab trapping). " +
            "Adds ~30-60s but detects real focus management issues. Off by default — use for deep investigation, " +
            "not for triage or fix-verify loops. analyze_pages never probes.",
          ),
        summaryOnly: z
          .boolean()
          .default(false)
          .describe("Return only summary stats (severity counts, top issue groups, average score) without individual findings. ~500 bytes. Use for quick page health checks before diving deeper."),
        includeStates: z
          .boolean()
          .default(false)
          .describe(
            "Include captured states in JSON output for passing to trace_path's statesJson parameter. " +
            "Uses compact format (~5KB): state IDs, target IDs+selectors+roles, and provenance. " +
            "The 'states' key in the output is the value to pass as statesJson to trace_path.",
          ),
        storageState: z
          .string()
          .optional()
          .describe(
            "Path to a Playwright storageState JSON file containing cookies and localStorage. " +
            "Use save_auth to create this file, then pass the path here to analyze authenticated pages. " +
            "Example: 'tactual-auth.json'",
          ),
      },
    },
    async ({ url, profile: profileId, device, explore, allowAction, format, minSeverity, waitForSelector, waitTime, timeout, focus, excludeSelector, exclude, maxFindings, probe, summaryOnly, includeStates, storageState }) => {
      const profile = getProfile(profileId);
      if (!profile) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Unknown profile: ${profileId}. Available: ${listProfiles().join(", ")}`,
            },
          ],
          isError: true,
        };
      }

      const urlCheck = validateUrl(url);
      if (!urlCheck.valid) {
        return {
          content: [{ type: "text" as const, text: `Invalid URL: ${urlCheck.error}` }],
          isError: true,
        };
      }

      let context: import("playwright").BrowserContext | undefined;
      try {
        const pw = await import("playwright");
        const { captureState } = await import("../playwright/capture.js");

        const browser = await getSharedBrowser();
        const contextOptions: Record<string, unknown> = {};
        if (storageState) {
          const pathMod = await import("path");
          const resolved = pathMod.resolve(storageState);
          const rel = pathMod.relative(process.cwd(), resolved);
          if (rel.startsWith("..") || pathMod.isAbsolute(rel)) {
            return { content: [{ type: "text" as const, text: "storageState path must be within the current working directory" }], isError: true };
          }
          contextOptions.storageState = resolved;
        }
        if (device) {
          const dev = pw.devices[device];
          if (!dev) {
            return {
              content: [
                {
                  type: "text" as const,
                  text: `Unknown device: ${device}. See Playwright docs for available device names.`,
                },
              ],
              isError: true,
            };
          }
          Object.assign(contextOptions, dev);
        }

        context = await browser.newContext(contextOptions);
        const page = await context.newPage();
        await page.goto(urlCheck.url!, { waitUntil: "domcontentloaded", timeout });
        await page.waitForTimeout(2000);

        // SPA support: wait for a specific selector to appear before capturing
        const captureWarnings: string[] = [];
        if (waitForSelector) {
          const found = await page.waitForSelector(waitForSelector, { timeout: timeout }).catch(() => null);
          if (!found) {
            captureWarnings.push(`waitForSelector "${waitForSelector}" did not appear within ${timeout}ms. Analysis may reflect incomplete content.`);
          }
        }

        // Additional wait time for slow-rendering SPAs
        if (waitTime && waitTime > 0) {
          await page.waitForTimeout(waitTime);
        }

        const rawState = await captureState(page, {
          device,
          provenance: "scripted",
          spaWaitTimeout: 20000, // generous SPA wait for MCP
          excludeSelectors: excludeSelector,
        });

        // Keyboard probes — opt-in, adds ~30-60s but detects real focus issues
        let targets = rawState.targets;
        if (probe) {
          const { probeTargets } = await import("../playwright/probes.js");
          targets = await probeTargets(page, rawState.targets);
        }
        const state = { ...rawState, targets };

        // SR announcement simulation — detect demoted landmarks
        const { simulateScreenReader } = await import("../playwright/sr-simulator.js");
        const srSim = await simulateScreenReader(page, targets);
        for (const d of srSim.demotedLandmarks) {
          captureWarnings.push(`${d.targetId}: ${d.demotionReason}`);
        }

        let states = [state];

        if (explore) {
          const { explore: exploreState } = await import("../playwright/explorer.js");
          const allowPatterns = (allowAction ?? []).map((p: string) => {
            const escaped = p.toLowerCase().replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
            return new RegExp(`^${escaped}$`, "i");
          });
          const result = await exploreState(page, state, {
            device,
            maxDepth: 2,
            maxActions: 30,
            allowActionPatterns: allowPatterns.length > 0 ? allowPatterns : undefined,
          });
          states = result.states;
        }

        const filter: Record<string, unknown> = {};
        if (minSeverity) filter.minSeverity = minSeverity;
        if (focus) filter.focus = focus;
        if (exclude) filter.exclude = exclude;
        if (maxFindings) filter.maxFindings = maxFindings;
        const result = analyze(states, profile, { name: url, filter });

        // Inject capture warnings as diagnostics
        for (const w of captureWarnings) {
          result.diagnostics.push({ level: "warning", code: "timeout-during-render", message: w });
        }

        // Deduplicate findings with identical penalty signatures
        const deduped = deduplicateFindings(result);

        // Summary-only mode: return minimal stats for quick health checks
        if (summaryOnly) {
          const s = summarize(deduped);
          const summary = {
            url,
            profile: s.profile,
            stats: s.stats,
            severityCounts: s.severityCounts,
            diagnostics: s.diagnostics,
            topIssues: s.issueGroups.slice(0, 3).map((g) => ({
              issue: g.issue,
              count: g.count,
              worstScore: g.worstScore,
            })),
          };
          return {
            content: [{ type: "text" as const, text: JSON.stringify(summary, null, 2) }],
          };
        }

        let output = formatReport(deduped, format as ReportFormat);

        // Append states for trace_path passthrough (compact format to fit MCP limits)
        if (includeStates && format === "json") {
          const parsed = JSON.parse(output);
          // Compact states: only what trace_path needs to rebuild the graph
          parsed.states = deduped.states.map((s) => ({
            id: s.id,
            url: s.url,
            route: s.route,
            snapshotHash: s.snapshotHash,
            interactiveHash: s.interactiveHash,
            openOverlays: s.openOverlays,
            timestamp: s.timestamp,
            provenance: s.provenance,
            targets: s.targets.map((t) => ({
              id: t.id,
              kind: t.kind,
              role: t.role,
              name: t.name,
              selector: t.selector,
              requiresBranchOpen: t.requiresBranchOpen,
              headingLevel: t.headingLevel,
            })),
          }));
          output = JSON.stringify(parsed, null, 2);
        }

        return {
          content: [
            {
              type: "text" as const,
              text: output,
            },
          ],
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Error analyzing ${url}: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
          isError: true,
        };
      } finally {
        await context?.close().catch(() => {});
      }
    },
  );

  // ---- Tool: list_profiles ----
  server.registerTool(
    "list_profiles",
    {
      description:
        "List the assistive-technology (AT) profiles available for scoring. " +
        "Each profile models a specific screen reader and platform — e.g., NVDA on Windows, " +
        "VoiceOver on iOS — with its own navigation cost weights and action vocabulary. " +
        "Returns an array of {id, name, platform, description} for each profile.\n\n" +
        "Read-only, no parameters, static data. Call once to discover valid profile IDs, " +
        "then pass a profile ID to analyze_url, trace_path, or analyze_pages. " +
        "Default profile for all analysis tools is 'generic-mobile-web-sr-v0' if none is specified.",
      inputSchema: {},
    },
    async () => {
      const profiles = listProfiles();
      const details = profiles.map((id) => {
        const p = getProfile(id);
        return {
          id,
          name: p?.name ?? id,
          platform: p?.platform ?? "unknown",
          description: p?.description ?? "",
        };
      });

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(details, null, 2),
          },
        ],
      };
    },
  );

  // ---- Tool: diff_results ----
  server.registerTool(
    "diff_results",
    {
      description:
        "Compare two Tactual analysis results (before/after). Shows what improved, regressed, " +
        "which penalties were resolved or added, and severity band changes per target. " +
        "Returns a JSON array of {targetId, baselineScore, candidateScore, status, penalties}.\n\n" +
        "Read-only, no side effects. Use after fixing accessibility issues to verify improvements. " +
        "Both inputs must be JSON strings from analyze_url (format='json'). " +
        "Not useful for SARIF output — use analyze_url directly for before/after SARIF comparisons.",
      inputSchema: {
        baseline: z.string().describe("Baseline analysis result as JSON string"),
        candidate: z.string().describe("Candidate analysis result as JSON string"),
      },
    },
    async ({ baseline, candidate }) => {
      try {
        const baseFindings = extractFindings(JSON.parse(baseline));
        const candFindings = extractFindings(JSON.parse(candidate));

        const baseMap = new Map(baseFindings.map((f) => [f.targetId, f]));
        const candMap = new Map(candFindings.map((f) => [f.targetId, f]));
        const allIds = new Set([...baseMap.keys(), ...candMap.keys()]);

        const changes: Array<{
          targetId: string;
          baselineScore: number | null;
          candidateScore: number | null;
          delta: number;
          baselineSeverity: string | null;
          candidateSeverity: string | null;
          severityChanged: boolean;
          penaltiesResolved: string[];
          penaltiesAdded: string[];
          status: "improved" | "regressed" | "new" | "removed" | "unchanged";
        }> = [];

        let improved = 0;
        let regressed = 0;
        let added = 0;
        let removed = 0;

        for (const id of allIds) {
          const b = baseMap.get(id);
          const c = candMap.get(id);
          const bScore = b?.overall ?? null;
          const cScore = c?.overall ?? null;
          const delta = (cScore ?? 0) - (bScore ?? 0);

          const bPenalties = new Set(b?.penalties ?? []);
          const cPenalties = new Set(c?.penalties ?? []);
          const penaltiesResolved = [...bPenalties].filter((p) => !cPenalties.has(p));
          const penaltiesAdded = [...cPenalties].filter((p) => !bPenalties.has(p));

          let status: "improved" | "regressed" | "new" | "removed" | "unchanged";
          if (!b) { status = "new"; added++; }
          else if (!c) { status = "removed"; removed++; }
          else if (delta > 0) { status = "improved"; improved++; }
          else if (delta < 0) { status = "regressed"; regressed++; }
          else { status = "unchanged"; continue; } // skip unchanged

          changes.push({
            targetId: id,
            baselineScore: bScore,
            candidateScore: cScore,
            delta,
            baselineSeverity: b?.severity ?? null,
            candidateSeverity: c?.severity ?? null,
            severityChanged: (b?.severity ?? null) !== (c?.severity ?? null),
            penaltiesResolved,
            penaltiesAdded,
            status,
          });
        }

        // Sort: regressions first, then new, then removed, then improved
        const statusOrder = { regressed: 0, new: 1, removed: 2, improved: 3, unchanged: 4 };
        changes.sort((a, b) => statusOrder[a.status] - statusOrder[b.status] || a.delta - b.delta);

        // Summary of resolved and new penalty types
        const allResolved = changes.flatMap((c) => c.penaltiesResolved);
        const allAdded = changes.flatMap((c) => c.penaltiesAdded);
        const resolvedSummary = [...new Set(allResolved)].slice(0, 5);
        const addedSummary = [...new Set(allAdded)].slice(0, 5);

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                summary: { improved, regressed, added, removed },
                penaltiesResolved: resolvedSummary,
                penaltiesAdded: addedSummary,
                changes: changes.slice(0, 20), // cap for context window
              }, null, 2),
            },
          ],
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Error parsing results: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
          isError: true,
        };
      }
    },
  );

  // ---- Tool: suggest_remediations ----
  server.registerTool(
    "suggest_remediations",
    {
      description:
        "Extract the top unique remediation suggestions from a Tactual analysis result, " +
        "ranked by severity. Returns a JSON array of {targetId, severity, score, fix, penalties}.\n\n" +
        "Read-only, no side effects. Most useful with large JSON results where you want a prioritized " +
        "shortlist of what to fix first. For SARIF results, the findings already contain fix " +
        "suggestions inline — this tool is redundant in that case. " +
        "Input must be a JSON string from analyze_url (format='json').",
      inputSchema: {
        analysis: z.string().describe("Analysis result as JSON string"),
        maxSuggestions: z.number().default(10).describe("Maximum number of suggestions to return"),
      },
    },
    async ({ analysis, maxSuggestions }) => {
      try {
        const findings = extractFindings(JSON.parse(analysis));

        // Rank findings by severity (worst first) and collect unique fixes
        const sorted = [...findings].sort((a, b) => a.overall - b.overall);

        const suggestions: Array<{
          targetId: string;
          severity: string;
          score: number;
          fix: string;
          penalties: string[];
        }> = [];

        const seenFixes = new Set<string>();

        for (const finding of sorted) {
          for (const fix of finding.suggestedFixes) {
            if (seenFixes.has(fix)) continue;
            seenFixes.add(fix);
            suggestions.push({
              targetId: finding.targetId,
              severity: finding.severity,
              score: finding.overall,
              fix,
              penalties: finding.penalties,
            });
            if (suggestions.length >= maxSuggestions) break;
          }
          if (suggestions.length >= maxSuggestions) break;
        }

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(suggestions, null, 2),
            },
          ],
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Error: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
          isError: true,
        };
      }
    },
  );

  // ---- Tool: trace_path ----
  server.registerTool(
    "trace_path",
    {
      description:
        "Trace the exact screen-reader navigation path to a specific interactive target. " +
        "Returns step-by-step actions a screen-reader user would perform, with modeled " +
        "announcements, cumulative cost, and the target's role/name at each hop. " +
        "Read-only — navigates to the URL but does not modify the page.\n\n" +
        "Use this after analyze_url to understand *why* a target scored poorly.\n\n" +
        "**For auth-gated or explored targets**: Pass statesJson from a prior analyze_url " +
        "(use includeStates=true). This skips browser launch entirely and traces against " +
        "the captured state, including any explored states discovered behind auth boundaries. " +
        "Workflow: analyze_url(includeStates=true, explore=true) → extract result.states → " +
        "trace_path(statesJson=JSON.stringify(states), target='*search*').",
      inputSchema: {
        url: z.string().describe("URL of the page to trace"),
        target: z
          .string()
          .describe(
            "Target to trace to. Can be an exact target ID from an analysis result, " +
            "or a glob pattern to match target names (e.g., '*search*', 'Submit*'). " +
            "Case-insensitive.",
          ),
        profile: z
          .string()
          .default("generic-mobile-web-sr-v0")
          .describe("AT profile ID"),
        device: z
          .string()
          .optional()
          .describe("Playwright device name for emulation (e.g., 'iPhone 14')"),
        waitForSelector: z
          .string()
          .optional()
          .describe("CSS selector to wait for before capturing (essential for SPAs)"),
        explore: z
          .boolean()
          .default(false)
          .describe("Explore hidden branches (menus, tabs, dialogs) before tracing"),
        timeout: z.number().default(30000).describe("Page load timeout in milliseconds"),
        statesJson: z
          .string()
          .optional()
          .describe(
            "Pre-captured states from a prior analyze_url run. Pass the 'states' array from the " +
            "JSON output (use includeStates=true on analyze_url to include it). " +
            "When provided, trace_path skips browser launch and traces against the captured state. " +
            "Workflow: analyze_url(includeStates=true) → extract result.states → trace_path(statesJson=...).",
          ),
        storageState: z
          .string()
          .optional()
          .describe("Path to Playwright storageState JSON for authenticated pages. Use save_auth to create."),
      },
    },
    async ({ url, target: targetPattern, profile: profileId, device, waitForSelector, explore, timeout, statesJson, storageState }) => {
      const profile = getProfile(profileId);
      if (!profile) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Unknown profile: ${profileId}. Available: ${listProfiles().join(", ")}`,
            },
          ],
          isError: true,
        };
      }

      const urlCheck = validateUrl(url);
      if (!urlCheck.valid) {
        return {
          content: [{ type: "text" as const, text: `Invalid URL: ${urlCheck.error}` }],
          isError: true,
        };
      }

      let context: import("playwright").BrowserContext | undefined;
      const warnings: string[] = [];
      try {
        let states: import("../core/types.js").PageState[];

        if (statesJson) {
          // Use pre-captured states — no browser launch needed
          const { PageStateSchema } = await import("../core/types.js");
          const parsed = JSON.parse(statesJson);
          states = Array.isArray(parsed) ? parsed.map((s: unknown) => PageStateSchema.parse(s)) : [PageStateSchema.parse(parsed)];
        } else {
          // Live capture
          const pw = await import("playwright");
          const { captureState } = await import("../playwright/capture.js");

          const browser = await getSharedBrowser();
          const contextOptions: Record<string, unknown> = {};
          if (storageState) {
            const pathMod = await import("path");
            const resolved = pathMod.resolve(storageState);
            const rel = pathMod.relative(process.cwd(), resolved);
            if (rel.startsWith("..") || pathMod.isAbsolute(rel)) {
              return { content: [{ type: "text" as const, text: "storageState path must be within the current working directory" }], isError: true };
            }
            contextOptions.storageState = resolved;
          }
          if (device) {
            const dev = pw.devices[device];
            if (!dev) {
              return {
                content: [
                  {
                    type: "text" as const,
                    text: `Unknown device: ${device}. See Playwright docs for available device names.`,
                  },
                ],
                isError: true,
              };
            }
            Object.assign(contextOptions, dev);
          }

          context = await browser.newContext(contextOptions);
          const page = await context.newPage();
          await page.goto(urlCheck.url!, { waitUntil: "domcontentloaded", timeout });
          await page.waitForTimeout(2000);

          if (waitForSelector) {
            const found = await page.waitForSelector(waitForSelector, { timeout }).catch(() => null);
            if (!found) {
              warnings.push(`waitForSelector "${waitForSelector}" did not appear within ${timeout}ms.`);
            }
          }

          const state = await captureState(page, {
            device,
            provenance: "scripted",
            spaWaitTimeout: 20000,
          });

          states = [state];
          if (explore) {
            const { explore: exploreState } = await import("../playwright/explorer.js");
            const result = await exploreState(page, state, {
              device,
              maxDepth: 2,
              maxActions: 30,
            });
            states = result.states;
          }
        }

        // Build the navigation graph
        const graph = buildGraph(states, profile);

        // Find matching target(s) using exact ID or glob pattern
        const matches = findMatchingTargets(states, targetPattern);
        if (matches.length === 0) {
          // List available targets to help the user
          const available = states
            .flatMap((s) => s.targets)
            .filter((t) => t.kind !== "heading" && t.kind !== "landmark")
            .slice(0, 20)
            .map((t) => `  ${t.id} (${t.kind}: ${t.name || "(unnamed)"})`)
            .join("\n");
          return {
            content: [
              {
                type: "text" as const,
                text:
                  `No targets matching "${targetPattern}" found.\n\n` +
                  `Available interactive targets (first 20):\n${available}`,
              },
            ],
            isError: true,
          };
        }

        // Trace path for each matching target (cap at 5)
        const traces = [];
        for (const match of matches.slice(0, 5)) {
          const targetNodeId = `${match.stateId}:${match.target.id}`;
          if (!graph.hasNode(targetNodeId)) continue;

          const matchState = states.find((s) => s.id === match.stateId);
          if (!matchState) continue;

          const entryPoints = collectEntryPoints(matchState, graph);
          const paths = computePathsFromEntries(graph, entryPoints, targetNodeId);
          const bestPath = paths[0] ?? null;

          if (!bestPath) {
            traces.push({
              targetId: match.target.id,
              targetName: match.target.name || "(unnamed)",
              targetRole: match.target.role,
              targetKind: match.target.kind,
              reachable: false,
              steps: [],
              totalCost: -1,
              note: "Target exists but no navigation path found from any entry point.",
            });
            continue;
          }

          // Build per-step trace
          const steps = bestPath.edges.map((edge, i) => {
            const fromNode = graph.getNode(edge.from);
            const toNode = graph.getNode(edge.to);
            const fromMeta = fromNode?.metadata as
              | { target?: Target; url?: string }
              | undefined;
            const toMeta = toNode?.metadata as
              | { target?: Target; url?: string }
              | undefined;

            const fromTarget = fromMeta?.target;
            const toTarget = toMeta?.target;

            const cumulativeCost = bestPath.edges
              .slice(0, i + 1)
              .reduce((sum, e) => sum + e.cost, 0);

            return {
              step: i + 1,
              action: edge.action,
              cost: edge.cost,
              cumulativeCost,
              from: {
                id: edge.from,
                kind: fromNode?.kind ?? "unknown",
                name: fromTarget?.name || fromMeta?.url || "(page root)",
                role: fromTarget?.role ?? (fromNode?.kind === "state" ? "document" : "unknown"),
              },
              to: {
                id: edge.to,
                kind: toNode?.kind ?? "unknown",
                name: toTarget?.name || "(unnamed)",
                role: toTarget?.role ?? "unknown",
                targetKind: toTarget?.kind,
              },
              modeledAnnouncement: modelAnnouncement(
                edge.action,
                toTarget?.role ?? "unknown",
                toTarget?.name || "(unnamed)",
                toTarget?.headingLevel,
              ),
              reason: edge.reason || undefined,
            };
          });

          traces.push({
            targetId: match.target.id,
            targetName: match.target.name || "(unnamed)",
            targetRole: match.target.role,
            targetKind: match.target.kind,
            reachable: true,
            totalCost: bestPath.totalCost,
            stepCount: steps.length,
            steps,
            alternatePathCount: Math.max(0, paths.length - 1),
          });
        }

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  url,
                  profile: profileId,
                  matchCount: matches.length,
                  traces,
                },
                null,
                2,
              ),
            },
          ],
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Error tracing path on ${url}: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
          isError: true,
        };
      } finally {
        await context?.close().catch(() => {});
      }
    },
  );

  // ---- Tool: save_auth ----
  server.registerTool(
    "save_auth",
    {
      description:
        "Authenticate with a web application and save the session for subsequent analysis. " +
        "Navigates to the URL, executes login steps (click a button, fill a form, etc.), " +
        "waits for the authenticated page to load, then saves cookies and localStorage " +
        "to a JSON file. Overwrites the output file if it already exists.\n\n" +
        "**Side effects**: Writes a storageState JSON file to disk at `outputPath`. " +
        "Launches a headed browser that interacts with the page (clicks, fills inputs). " +
        "Not needed for public pages — only use when content is behind authentication.\n\n" +
        "Pass the output file path as `storageState` to analyze_url, trace_path, " +
        "or analyze_pages to analyze authenticated content.\n\n" +
        "**Steps format**: Array of actions to perform in order. Each step is an object:\n" +
        "- `{ click: 'button text or selector' }` — click a button/link\n" +
        "- `{ fill: ['input selector', 'value'] }` — fill an input field\n" +
        "- `{ wait: 2000 }` — wait N milliseconds\n" +
        "- `{ waitForUrl: '/dashboard' }` — wait until URL contains this string\n\n" +
        "Example for a dev login: `steps: [{ click: 'Dev Login' }, { waitForUrl: '/workspace' }]`\n" +
        "Example for form login: `steps: [{ fill: ['#email', 'user@test.com'] }, { fill: ['#password', 'pass'] }, { click: 'Sign In' }, { waitForUrl: '/dashboard' }]`",
      inputSchema: {
        url: z.string().describe("Login page URL"),
        steps: z
          .array(z.record(z.string(), z.unknown()))
          .describe("Login steps to execute (see description for format)"),
        outputPath: z
          .string()
          .default("tactual-auth.json")
          .describe("File path to save the storageState JSON"),
        timeout: z.number().default(30000).describe("Timeout per step in ms"),
      },
    },
    async ({ url, steps, outputPath, timeout }) => {
      const urlCheck = validateUrl(url);
      if (!urlCheck.valid) {
        return {
          content: [{ type: "text" as const, text: `Invalid URL: ${urlCheck.error}` }],
          isError: true,
        };
      }

      let context: import("playwright").BrowserContext | undefined;
      try {
        const fs = await import("fs/promises");

        const browser = await getSharedBrowser();
        context = await browser.newContext();
        const page = await context.newPage();

        await page.goto(urlCheck.url!, { waitUntil: "domcontentloaded", timeout });
        await page.waitForTimeout(2000);

        // Execute login steps
        for (const step of steps) {
          if ("click" in step && typeof step.click === "string") {
            // Try as button/link text first, then as selector
            const target = step.click;
            const byRole = page.getByRole("button", { name: target })
              .or(page.getByRole("link", { name: target }))
              .or(page.getByText(target, { exact: false }));
            const exists = await byRole.count() > 0;
            if (exists) {
              await byRole.first().click({ timeout });
            } else {
              await page.click(target, { timeout });
            }
          } else if ("fill" in step && Array.isArray(step.fill) && step.fill.length === 2) {
            await page.fill(String(step.fill[0]), String(step.fill[1]));
          } else if ("wait" in step && typeof step.wait === "number") {
            await page.waitForTimeout(Math.min(step.wait, 60000));
          } else if ("waitForUrl" in step && typeof step.waitForUrl === "string") {
            await page.waitForURL(`**${step.waitForUrl}**`, { timeout });
          } else {
            const keys = Object.keys(step as Record<string, unknown>).join(", ");
            return {
              content: [{ type: "text" as const, text: `Unknown step type with keys: ${keys}. Valid step types: click, fill, wait, waitForUrl.` }],
              isError: true,
            };
          }
        }

        // Wait for post-login page to settle
        await page.waitForTimeout(3000);

        // Save storage state
        const path = await import("path");
        const resolved = path.resolve(outputPath);
        const rel = path.relative(process.cwd(), resolved);
        if (rel.startsWith("..") || path.isAbsolute(rel)) {
          return {
            content: [{ type: "text" as const, text: `Invalid outputPath: must be within the current working directory (${process.cwd()}). Resolved: ${resolved}` }],
            isError: true,
          };
        }
        const state = await context.storageState();
        await fs.writeFile(resolved, JSON.stringify(state, null, 2), { mode: 0o600 });

        const cookieCount = state.cookies?.length ?? 0;
        const originCount = state.origins?.length ?? 0;

        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              saved: outputPath,
              cookies: cookieCount,
              origins: originCount,
              currentUrl: page.url(),
              message: `Auth state saved. Pass storageState="${outputPath}" to analyze_url, trace_path, or analyze_pages.`,
            }, null, 2),
          }],
        };
      } catch (err) {
        return {
          content: [{
            type: "text" as const,
            text: `Auth failed: ${err instanceof Error ? err.message : String(err)}`,
          }],
          isError: true,
        };
      } finally {
        await context?.close().catch(() => {});
      }
    },
  );

  // ---- Tool: analyze_pages ----
  server.registerTool(
    "analyze_pages",
    {
      description:
        "Analyze multiple pages and produce an aggregated site-level report. " +
        "Runs analyze_url on each URL in a single browser session and combines " +
        "results into a site score with per-page breakdown. " +
        "Read-only — navigates to each URL but does not modify pages.\n\n" +
        "Use this instead of calling analyze_url repeatedly when you need a site-level assessment. " +
        "Returns ~200 bytes per page plus a site-level summary. " +
        "If a single URL fails (timeout, bot protection), its entry shows the error and " +
        "remaining URLs still complete.",
      inputSchema: {
        urls: z.array(z.string()).describe("URLs to analyze (1-20 pages)"),
        profile: z
          .string()
          .default("generic-mobile-web-sr-v0")
          .describe("AT profile ID"),
        waitForSelector: z
          .string()
          .optional()
          .describe("CSS selector to wait for on each page (for SPAs)"),
        waitTime: z.number().optional().describe("Additional wait per page in ms"),
        timeout: z.number().default(30000).describe("Page load timeout per URL"),
        storageState: z
          .string()
          .optional()
          .describe("Path to Playwright storageState JSON for authenticated pages. Use save_auth to create."),
      },
    },
    async ({ urls, profile: profileId, waitForSelector, waitTime, timeout, storageState }) => {
      const profile = getProfile(profileId);
      if (!profile) {
        return {
          content: [{
            type: "text" as const,
            text: `Unknown profile: ${profileId}. Available: ${listProfiles().join(", ")}`,
          }],
          isError: true,
        };
      }

      if (urls.length === 0) {
        return {
          content: [{ type: "text" as const, text: "At least one URL is required." }],
          isError: true,
        };
      }
      if (urls.length > 20) {
        return {
          content: [{ type: "text" as const, text: "Maximum 20 URLs per call." }],
          isError: true,
        };
      }

      let context: import("playwright").BrowserContext | undefined;
      try {
        const { captureState } = await import("../playwright/capture.js");

        const browser = await getSharedBrowser();
        const contextOptions: Record<string, unknown> = {};
        if (storageState) {
          const pathMod = await import("path");
          const resolved = pathMod.resolve(storageState);
          const rel = pathMod.relative(process.cwd(), resolved);
          if (rel.startsWith("..") || pathMod.isAbsolute(rel)) {
            return { content: [{ type: "text" as const, text: "storageState path must be within the current working directory" }], isError: true };
          }
          contextOptions.storageState = resolved;
        }
        context = await browser.newContext(contextOptions);

        const pageResults: Array<{
          url: string;
          targets: number;
          p10: number;
          median: number;
          average: number;
          worst: number;
          severityCounts: Record<string, number>;
          diagnostics: string[];
          topIssue: string | null;
        }> = [];

        const allScores: number[] = [];
        const allSeverity: Record<string, number> = {
          severe: 0, high: 0, moderate: 0, acceptable: 0, strong: 0,
        };

        for (const url of urls) {
          try {
            const urlCheck = validateUrl(url);
            if (!urlCheck.valid) {
              pageResults.push({
                url, targets: 0, p10: 0, median: 0, average: 0, worst: 0,
                severityCounts: { severe: 0, high: 0, moderate: 0, acceptable: 0, strong: 0 },
                diagnostics: [`invalid-url: ${urlCheck.error}`],
                topIssue: null,
              });
              continue;
            }

            const pageWarnings: string[] = [];
            const page = await context.newPage();
            let state: import("../core/types.js").PageState;
            try {
              await page.goto(urlCheck.url!, { waitUntil: "domcontentloaded", timeout });
              await Promise.race([
                page.waitForLoadState("networkidle").catch(() => {}),
                new Promise((r) => setTimeout(r, 5000)),
              ]);
              if (waitForSelector) {
                const found = await page.waitForSelector(waitForSelector, { timeout: 10000 }).catch(() => null);
                if (!found) pageWarnings.push(`waitForSelector "${waitForSelector}" timed out`);
              }
              if (waitTime && waitTime > 0) {
                await page.waitForTimeout(waitTime);
              }
              state = await captureState(page, {
                provenance: "scripted",
                spaWaitTimeout: 15000,
              });
            } finally {
              await page.close().catch(() => {});
            }

            const result = analyze([state], profile, { name: url });
            const scores = result.findings.map((f) => f.scores.overall);
            const sorted = [...scores].sort((a, b) => a - b);

            const avg = scores.length > 0
              ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length * 10) / 10
              : 0;
            const p10 = sorted.length >= 5
              ? sorted[Math.max(0, Math.ceil(sorted.length * 0.1) - 1)]
              : sorted[0] ?? 0;
            const median = sorted.length > 0
              ? sorted[Math.floor(sorted.length * 0.5)]
              : 0;
            const worst = sorted[0] ?? 0;

            const sev: Record<string, number> = { severe: 0, high: 0, moderate: 0, acceptable: 0, strong: 0 };
            for (const f of result.findings) {
              sev[f.severity]++;
              allSeverity[f.severity]++;
            }
            allScores.push(...scores);

            const diags = result.diagnostics
              .filter((d) => d.level !== "info" && d.code !== "ok")
              .map((d) => d.code);

            const worstFinding = result.findings.sort((a, b) => a.scores.overall - b.scores.overall)[0];

            pageResults.push({
              url,
              targets: result.findings.length,
              p10, median, average: avg, worst,
              severityCounts: sev,
              diagnostics: diags,
              topIssue: worstFinding
                ? `${worstFinding.targetId} (${worstFinding.scores.overall}/100): ${worstFinding.penalties[0] ?? worstFinding.severity}`
                : null,
            });
          } catch (err) {
            pageResults.push({
              url,
              targets: 0, p10: 0, median: 0, average: 0, worst: 0,
              severityCounts: { severe: 0, high: 0, moderate: 0, acceptable: 0, strong: 0 },
              diagnostics: [`error: ${err instanceof Error ? err.message.slice(0, 80) : "unknown"}`],
              topIssue: null,
            });
          }
        }

        // Site-level aggregation
        const allSorted = [...allScores].sort((a, b) => a - b);
        const siteP10 = allSorted.length >= 5
          ? allSorted[Math.max(0, Math.ceil(allSorted.length * 0.1) - 1)]
          : allSorted[0] ?? 0;
        const siteMedian = allSorted.length > 0
          ? allSorted[Math.floor(allSorted.length * 0.5)]
          : 0;
        const siteAverage = allScores.length > 0
          ? Math.round(allScores.reduce((a, b) => a + b, 0) / allScores.length * 10) / 10
          : 0;

        const report = {
          site: {
            pagesAnalyzed: pageResults.length,
            totalTargets: allScores.length,
            p10: siteP10,
            median: siteMedian,
            average: siteAverage,
            worst: allSorted[0] ?? 0,
            severityCounts: allSeverity,
          },
          pages: pageResults,
        };

        return {
          content: [{ type: "text" as const, text: JSON.stringify(report, null, 2) }],
        };
      } catch (err) {
        return {
          content: [{
            type: "text" as const,
            text: `Error: ${err instanceof Error ? err.message : String(err)}`,
          }],
          isError: true,
        };
      } finally {
        await context?.close().catch(() => {});
      }
    },
  );

  return server;
}

/** Start the MCP server on stdio transport */
export async function startMcpServer(): Promise<void> {
  const server = createMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
