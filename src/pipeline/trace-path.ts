/**
 * Pipeline: trace the step-by-step screen-reader navigation path to a
 * specific interactive target. Shared across CLI (`tactual trace-path`)
 * and MCP (`trace_path`).
 *
 * MCP uniquely supports passing `statesJson` from a prior analyze_url
 * (avoids re-launching the browser). CLI always captures fresh.
 */

import type { PageState, Target } from "../core/types.js";
import { getProfile } from "../profiles/index.js";
import { validateUrl } from "../core/url-validation.js";
import { buildGraph } from "../core/graph-builder.js";
import {
  collectEntryPoints,
  computePathsFromEntries,
} from "../core/path-analysis.js";
import { findMatchingTargets, modelAnnouncement } from "../core/trace-helpers.js";
import {
  acquireBrowser,
  buildContextOptions,
} from "../core/context-options.js";

export interface TracePathOptions {
  url: string;
  targetPattern: string;
  profileId?: string;
  device?: string;
  explore?: boolean;
  waitForSelector?: string;
  timeout?: number;
  storageState?: string;
  restrictStorageStateToCwd?: boolean;
  /** Long-lived MCP/server callers can opt into the shared browser pool. */
  useSharedBrowserPool?: boolean;
  /** Pre-captured states (MCP only). When set, skip browser launch. */
  states?: PageState[];
}

export interface TraceStep {
  step: number;
  action: string;
  cost: number;
  cumulativeCost: number;
  from: {
    id: string;
    kind: string;
    name: string;
    role: string;
  };
  to: {
    id: string;
    kind: string;
    name: string;
    role: string;
    targetKind?: string;
  };
  modeledAnnouncement: string;
  reason?: string;
}

export interface TraceEntry {
  targetId: string;
  targetName: string;
  targetRole: string;
  targetKind: string;
  reachable: boolean;
  totalCost: number;
  stepCount?: number;
  steps: TraceStep[];
  alternatePathCount?: number;
  /** Present when reachable=false. */
  note?: string;
  /** DOM selector for the matched target, when known. */
  selector?: string;
}

export interface TracePathResult {
  url: string;
  profile: string;
  matchCount: number;
  traces: TraceEntry[];
  warnings: string[];
}

export class TracePathError extends Error {
  constructor(
    public readonly code:
      | "invalid-url"
      | "unknown-profile"
      | "unknown-device"
      | "bad-input"
      | "no-matches"
      | "runtime",
    message: string,
    public readonly availableTargets?: string[],
  ) {
    super(message);
    this.name = "TracePathError";
  }
}

export async function runTracePath(
  opts: TracePathOptions,
): Promise<TracePathResult> {
  const profileId = opts.profileId ?? "generic-mobile-web-sr-v0";
  const profile = getProfile(profileId);
  if (!profile) {
    throw new TracePathError("unknown-profile", `Unknown profile: ${profileId}`);
  }

  const urlCheck = validateUrl(opts.url);
  if (!urlCheck.valid && !opts.states) {
    throw new TracePathError("invalid-url", `Invalid URL: ${urlCheck.error}`);
  }

  const warnings: string[] = [];
  let states: PageState[];
  let browserHandle:
    | { browser: import("playwright").Browser; owned: boolean }
    | undefined;
  let context: import("playwright").BrowserContext | undefined;

  try {
    if (opts.states && opts.states.length > 0) {
      states = opts.states;
    } else {
      const pw = await import("playwright");
      const { captureState } = await import("../playwright/capture.js");

      browserHandle = await acquireBrowser(
        {},
        { useSharedPool: opts.useSharedBrowserPool === true },
      );
      const ctxBuild = buildContextOptions(
        {
          storageState: opts.storageState,
          restrictStorageStateToCwd: opts.restrictStorageStateToCwd,
          device: opts.device,
        },
        pw,
      );
      if (ctxBuild.error) {
        const code = ctxBuild.error.startsWith("Unknown device:")
          ? "unknown-device"
          : "bad-input";
        throw new TracePathError(code, ctxBuild.error);
      }

      context = await browserHandle.browser.newContext(ctxBuild.options);
      const page = await context.newPage();
      const timeout = opts.timeout ?? 30000;
      await page.goto(urlCheck.url!, {
        waitUntil: "domcontentloaded",
        timeout,
      });
      await page.waitForTimeout(2000);

      if (opts.waitForSelector) {
        const found = await page
          .waitForSelector(opts.waitForSelector, { timeout })
          .catch(() => null);
        if (!found) {
          warnings.push(
            `waitForSelector "${opts.waitForSelector}" did not appear within ${timeout}ms`,
          );
        }
      }

      const state = await captureState(page, {
        device: opts.device,
        provenance: "scripted",
        spaWaitTimeout: 20000,
      });
      states = [state];

      if (opts.explore) {
        const { explore: exploreState } = await import(
          "../playwright/explorer.js"
        );
        const result = await exploreState(page, state, {
          device: opts.device,
          maxDepth: 2,
          maxActions: 30,
        });
        states = result.states;
      }
    }

    const graph = buildGraph(states, profile);
    const matches = findMatchingTargets(states, opts.targetPattern);
    if (matches.length === 0) {
      const available = states
        .flatMap((s) => s.targets)
        .filter((t) => t.kind !== "heading" && t.kind !== "landmark")
        .slice(0, 20)
        .map((t) => `${t.id} (${t.kind}: ${t.name || "(unnamed)"})`);
      throw new TracePathError(
        "no-matches",
        `No targets matching "${opts.targetPattern}" found.`,
        available,
      );
    }

    const traces: TraceEntry[] = [];
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
          totalCost: -1,
          steps: [],
          note: "Target exists but no navigation path found from any entry point.",
          selector: match.target.selector,
        });
        continue;
      }

      const steps: TraceStep[] = bestPath.edges.map((edge, i) => {
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
            role:
              fromTarget?.role ??
              (fromNode?.kind === "state" ? "document" : "unknown"),
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
        selector: match.target.selector,
      });
    }

    return {
      url: opts.url,
      profile: profileId,
      matchCount: matches.length,
      traces,
      warnings,
    };
  } finally {
    await context?.close().catch(() => {});
    if (browserHandle?.owned) {
      await browserHandle.browser.close().catch(() => {});
    }
  }
}
