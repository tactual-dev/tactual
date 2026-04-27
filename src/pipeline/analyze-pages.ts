/**
 * Pipeline: analyze a batch of URLs in a single browser session and
 * produce a site-level aggregation. Shared across CLI and MCP.
 *
 * Intentionally a stripped-down analyze pipeline — no probes, no
 * explore, no inline validation. These would multiply per-URL cost
 * dramatically and blow past reasonable CI time budgets. analyze-url
 * is the tool for deep per-page inspection.
 */

import type { BrowserContext } from "playwright";
import type { Finding, PageState as TactualPageState, Target } from "../core/types.js";
import { getProfile } from "../profiles/index.js";
import { validateUrl } from "../core/url-validation.js";
import { analyze } from "../core/analyzer.js";
import {
  acquireBrowser,
  buildContextOptions,
} from "../core/context-options.js";

export interface AnalyzePagesOptions {
  urls: string[];
  profileId?: string;
  waitForSelector?: string;
  waitTime?: number;
  timeout?: number;
  storageState?: string;
  restrictStorageStateToCwd?: boolean;
  /** Max URLs to accept. MCP sets 20; CLI leaves undefined. */
  maxUrls?: number;
  /** Long-lived MCP/server callers can opt into the shared browser pool. */
  useSharedBrowserPool?: boolean;
}

export interface PageAggregation {
  url: string;
  targets: number;
  p10: number;
  median: number;
  average: number;
  worst: number;
  severityCounts: Record<string, number>;
  diagnostics: string[];
  topIssue: string | null;
}

export interface RepeatedNavigationExample {
  url: string;
  targetId: string;
  score: number;
  linearSteps: number;
  penalty?: string;
}

export interface RepeatedNavigationGroup {
  signature: string;
  label: string;
  role: string;
  kind: string;
  pageCount: number;
  totalOccurrences: number;
  averageScore: number;
  worstScore: number;
  averageLinearSteps: number;
  totalLinearSteps: number;
  topPenalties: string[];
  examples: RepeatedNavigationExample[];
}

export interface RepeatedNavigationSummary {
  repeatedTargets: number;
  totalOccurrences: number;
  totalLinearSteps: number;
  worstGroups: RepeatedNavigationGroup[];
}

export interface SiteAggregation {
  pagesAnalyzed: number;
  totalTargets: number;
  p10: number;
  median: number;
  average: number;
  worst: number;
  severityCounts: Record<string, number>;
  repeatedNavigation?: RepeatedNavigationSummary;
}

export interface AnalyzePagesResult {
  site: SiteAggregation;
  pages: PageAggregation[];
}

export class AnalyzePagesError extends Error {
  constructor(
    public readonly code:
      | "unknown-profile"
      | "no-urls"
      | "too-many-urls"
      | "bad-input",
    message: string,
  ) {
    super(message);
    this.name = "AnalyzePagesError";
  }
}

export async function runAnalyzePages(
  opts: AnalyzePagesOptions,
): Promise<AnalyzePagesResult> {
  if (opts.urls.length === 0) {
    throw new AnalyzePagesError("no-urls", "At least one URL is required.");
  }
  if (opts.maxUrls && opts.urls.length > opts.maxUrls) {
    throw new AnalyzePagesError(
      "too-many-urls",
      `Maximum ${opts.maxUrls} URLs per call.`,
    );
  }

  const profileId = opts.profileId ?? "generic-mobile-web-sr-v0";
  const profile = getProfile(profileId);
  if (!profile) {
    throw new AnalyzePagesError(
      "unknown-profile",
      `Unknown profile: ${profileId}`,
    );
  }

  const pw = await import("playwright");
  const { captureState } = await import("../playwright/capture.js");

  const { browser, owned } = await acquireBrowser(
    {},
    { useSharedPool: opts.useSharedBrowserPool === true },
  );
  const ctxBuild = buildContextOptions(
    {
      storageState: opts.storageState,
      restrictStorageStateToCwd: opts.restrictStorageStateToCwd,
    },
    pw,
  );
  if (ctxBuild.error) {
    if (owned) await browser.close().catch(() => {});
    throw new AnalyzePagesError("bad-input", ctxBuild.error);
  }

  let context: BrowserContext | undefined;
  try {
    context = await browser.newContext(ctxBuild.options);

    const timeout = opts.timeout ?? 30000;
    const pageResults: PageAggregation[] = [];
    const repeatedInputs: RepeatedNavigationPageInput[] = [];
    const allScores: number[] = [];
    const allSeverity: Record<string, number> = {
      severe: 0,
      high: 0,
      moderate: 0,
      acceptable: 0,
      strong: 0,
    };

    for (const url of opts.urls) {
      const urlCheck = validateUrl(url);
      if (!urlCheck.valid) {
        pageResults.push(
          emptyPageResult(url, [`invalid-url: ${urlCheck.error}`]),
        );
        continue;
      }

      const pageWarnings: string[] = [];
      try {
        const page = await context.newPage();
        let state: TactualPageState;
        try {
          await page.goto(urlCheck.url!, {
            waitUntil: "domcontentloaded",
            timeout,
          });
          await Promise.race([
            page.waitForLoadState("networkidle").catch(() => {}),
            new Promise((r) => setTimeout(r, 5000)),
          ]);
          if (opts.waitForSelector) {
            const found = await page
              .waitForSelector(opts.waitForSelector, { timeout })
              .catch(() => null);
            if (!found) {
              pageWarnings.push(
                `waitForSelector "${opts.waitForSelector}" did not appear within ${timeout}ms`,
              );
            }
          }
          if (opts.waitTime && opts.waitTime > 0) {
            await page.waitForTimeout(opts.waitTime);
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

        const avg =
          scores.length > 0
            ? Math.round(
                (scores.reduce((a, b) => a + b, 0) / scores.length) * 10,
              ) / 10
            : 0;
        const p10 =
          sorted.length >= 5
            ? sorted[Math.max(0, Math.ceil(sorted.length * 0.1) - 1)]
            : sorted[0] ?? 0;
        const median =
          sorted.length > 0 ? sorted[Math.floor(sorted.length * 0.5)] : 0;
        const worst = sorted[0] ?? 0;

        const sev: Record<string, number> = {
          severe: 0,
          high: 0,
          moderate: 0,
          acceptable: 0,
          strong: 0,
        };
        for (const f of result.findings) {
          sev[f.severity]++;
          allSeverity[f.severity]++;
        }
        allScores.push(...scores);

        const diags = [
          ...pageWarnings,
          ...result.diagnostics
            .filter((d) => d.level !== "info" && d.code !== "ok")
            .map((d) => d.code),
        ];

        const worstFinding = result.findings.sort(
          (a, b) => a.scores.overall - b.scores.overall,
        )[0];

        pageResults.push({
          url,
          targets: result.findings.length,
          p10,
          median,
          average: avg,
          worst,
          severityCounts: sev,
          diagnostics: diags,
          topIssue: worstFinding
            ? `${worstFinding.targetId} (${worstFinding.scores.overall}/100): ${
                worstFinding.penalties[0] ?? worstFinding.severity
              }`
            : null,
        });
        repeatedInputs.push({
          url,
          findings: result.findings,
          targets: state.targets,
        });
      } catch (err) {
        pageResults.push(
          emptyPageResult(url, [
            `error: ${err instanceof Error ? err.message.slice(0, 80) : "unknown"}`,
          ]),
        );
      }
    }

    const allSorted = [...allScores].sort((a, b) => a - b);
    const siteP10 =
      allSorted.length >= 5
        ? allSorted[Math.max(0, Math.ceil(allSorted.length * 0.1) - 1)]
        : allSorted[0] ?? 0;
    const siteMedian =
      allSorted.length > 0
        ? allSorted[Math.floor(allSorted.length * 0.5)]
        : 0;
    const siteAverage =
      allScores.length > 0
        ? Math.round(
            (allScores.reduce((a, b) => a + b, 0) / allScores.length) * 10,
          ) / 10
        : 0;

    return {
      site: {
        pagesAnalyzed: pageResults.length,
        totalTargets: allScores.length,
        p10: siteP10,
        median: siteMedian,
        average: siteAverage,
        worst: allSorted[0] ?? 0,
        severityCounts: allSeverity,
        repeatedNavigation: buildRepeatedNavigationSummary(repeatedInputs),
      },
      pages: pageResults,
    };
  } finally {
    await context?.close().catch(() => {});
    if (owned) await browser.close().catch(() => {});
  }
}

interface RepeatedNavigationPageInput {
  url: string;
  findings: Finding[];
  targets: Target[];
}

export function buildRepeatedNavigationSummary(
  pages: RepeatedNavigationPageInput[],
): RepeatedNavigationSummary {
  const groups = new Map<string, {
    label: string;
    role: string;
    kind: string;
    pages: Set<string>;
    examples: RepeatedNavigationExample[];
  }>();

  for (const page of pages) {
    const targetById = new Map(page.targets.map((t) => [t.id, t]));
    for (const finding of page.findings) {
      const target = targetById.get(finding.targetId);
      if (!target || !isRepeatedNavigationCandidate(target)) continue;
      const label = target.name?.trim() || target.id;
      const signature = `${target.kind}|${target.role}|${normalizeTargetName(label)}`;
      const group = groups.get(signature) ?? {
        label,
        role: target.role,
        kind: target.kind,
        pages: new Set<string>(),
        examples: [],
      };
      group.pages.add(page.url);
      group.examples.push({
        url: page.url,
        targetId: finding.targetId,
        score: finding.scores.overall,
        linearSteps: countLinearSteps(finding.bestPath),
        penalty: finding.penalties[0],
      });
      groups.set(signature, group);
    }
  }

  const repeatedGroups: RepeatedNavigationGroup[] = [];
  for (const [signature, group] of groups) {
    const pageCount = group.pages.size;
    if (pageCount < 2 || group.examples.length < 2) continue;
    const scores = group.examples.map((e) => e.score);
    const totalLinearSteps = group.examples.reduce((sum, e) => sum + e.linearSteps, 0);
    const penalties = new Map<string, number>();
    for (const example of group.examples) {
      if (!example.penalty) continue;
      penalties.set(example.penalty, (penalties.get(example.penalty) ?? 0) + 1);
    }
    repeatedGroups.push({
      signature,
      label: group.label,
      role: group.role,
      kind: group.kind,
      pageCount,
      totalOccurrences: group.examples.length,
      averageScore: Math.round(scores.reduce((sum, s) => sum + s, 0) / scores.length),
      worstScore: Math.min(...scores),
      averageLinearSteps: Math.round((totalLinearSteps / group.examples.length) * 10) / 10,
      totalLinearSteps,
      topPenalties: [...penalties.entries()]
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .slice(0, 3)
        .map(([penalty]) => penalty),
      examples: group.examples
        .sort((a, b) => a.score - b.score || b.linearSteps - a.linearSteps)
        .slice(0, 5),
    });
  }

  repeatedGroups.sort((a, b) =>
    b.totalLinearSteps - a.totalLinearSteps ||
    a.averageScore - b.averageScore ||
    b.totalOccurrences - a.totalOccurrences,
  );

  const worstGroups = repeatedGroups.slice(0, 10);
  return {
    repeatedTargets: repeatedGroups.length,
    totalOccurrences: repeatedGroups.reduce((sum, g) => sum + g.totalOccurrences, 0),
    totalLinearSteps: repeatedGroups.reduce((sum, g) => sum + g.totalLinearSteps, 0),
    worstGroups,
  };
}

function isRepeatedNavigationCandidate(target: Target): boolean {
  return new Set([
    "link",
    "button",
    "menuTrigger",
    "menuItem",
    "tab",
    "formField",
    "search",
    "pagination",
    "disclosure",
  ]).has(target.kind);
}

function normalizeTargetName(name: string): string {
  return name.toLowerCase().replace(/\s+/g, " ").trim();
}

function countLinearSteps(path: string[]): number {
  return path.filter((step) => step.startsWith("nextItem:")).length;
}

function emptyPageResult(url: string, diagnostics: string[]): PageAggregation {
  return {
    url,
    targets: 0,
    p10: 0,
    median: 0,
    average: 0,
    worst: 0,
    severityCounts: {
      severe: 0,
      high: 0,
      moderate: 0,
      acceptable: 0,
      strong: 0,
    },
    diagnostics,
    topIssue: null,
  };
}
