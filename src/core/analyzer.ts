import type { PageState, AnalysisResult, Flow } from "./types.js";
import { buildGraph } from "./graph-builder.js";
import { buildFinding } from "./finding-builder.js";
import { diagnoseCapture, type CaptureDiagnostic } from "./diagnostics.js";
import {
  filterTargets,
  filterFindings,
  filterDiagnostics,
  type AnalysisFilter,
} from "./filter.js";
import type { ATProfile } from "../profiles/types.js";
import { VERSION } from "../version.js";

export interface AnalyzeOptions {
  /** Name for this analysis run */
  name?: string;
  /** Description */
  description?: string;
  /** The original URL requested (for redirect detection) */
  requestedUrl?: string;
  /** Raw snapshot text for diagnostic analysis */
  snapshotText?: string;
  /** Filtering and configuration */
  filter?: AnalysisFilter;
}

/**
 * Run the full analysis pipeline:
 * states -> filter -> graph -> diagnostics -> scoring -> rules -> findings -> result
 */
export function analyze(
  states: PageState[],
  profile: ATProfile,
  options: AnalyzeOptions = {},
): AnalysisResult {
  const startTime = Date.now();
  const filter = options.filter ?? {};

  // Run diagnostics on captured states, deduplicating across explored states
  let diagnostics: CaptureDiagnostic[] = [];
  const allStateDiags = states.map((state) =>
    diagnoseCapture(
      state,
      options.requestedUrl ?? options.name ?? state.url,
      options.snapshotText ?? "",
    ),
  );
  // Count occurrences of each diagnostic across states
  const diagCounts = new Map<string, number>();
  for (const stateDiags of allStateDiags) {
    for (const d of stateDiags) {
      if (d.code === "ok") continue;
      const key = `${d.code}:${d.message}`;
      diagCounts.set(key, (diagCounts.get(key) ?? 0) + 1);
    }
  }
  // Emit each unique diagnostic once, with count if it appeared in multiple states
  const seenCodes = new Set<string>();
  for (const stateDiags of allStateDiags) {
    for (const d of stateDiags) {
      if (d.code === "ok") continue;
      const key = `${d.code}:${d.message}`;
      if (seenCodes.has(key)) continue;
      seenCodes.add(key);
      const count = diagCounts.get(key) ?? 1;
      if (count > 1) {
        diagnostics.push({ ...d, message: `${d.message} (${count} states)` });
      } else {
        diagnostics.push(d);
      }
    }
  }
  diagnostics = filterDiagnostics(diagnostics, filter);

  // Apply target filtering before graph construction
  const filteredStates: PageState[] = states.map((state) => ({
    ...state,
    targets: filterTargets(state.targets, filter),
  }));

  let graph: ReturnType<typeof buildGraph>;
  try {
    graph = buildGraph(filteredStates, profile);
  } catch (e) {
    diagnostics.push({
      level: "error",
      code: "empty-page",
      message: `Graph construction failed: ${e instanceof Error ? e.message : "unknown error"}`,
    });
    return {
      flow: { id: `flow-${startTime}`, name: options.name ?? "Analysis", states: [], profile: profile.id, timestamp: startTime },
      states: filteredStates,
      findings: [],
      diagnostics,
      metadata: { version: VERSION, profile: profile.id, duration: Date.now() - startTime, stateCount: filteredStates.length, targetCount: 0, findingCount: 0, edgeCount: 0 },
    };
  }

  let findings: ReturnType<typeof buildFinding>[] = [];
  const allStateIds: string[] = [];
  // Track best finding per target ID across states to prevent
  // duplicates when the same target appears in multiple explored states
  const bestByTargetId = new Map<string, typeof findings[0]>();

  for (const state of filteredStates) {
    if (!graph.hasNode(state.id)) continue;
    allStateIds.push(state.id);

    for (const target of state.targets) {
      const nodeId = `${state.id}:${target.id}`;
      if (!graph.hasNode(nodeId)) continue;
      try {
        const finding = buildFinding(graph, state, nodeId, target, profile);
        // Keep the best (highest) score per target ID
        const existing = bestByTargetId.get(target.id);
        if (!existing || finding.scores.overall > existing.scores.overall) {
          bestByTargetId.set(target.id, finding);
        }
      } catch (e) {
        // Degrade gracefully — emit diagnostic rather than crash entire analysis
        diagnostics.push({
          level: "warning",
          code: "possibly-degraded-content",
          message: `Failed to analyze target "${target.id}": ${e instanceof Error ? e.message : "unknown error"}`,
        });
      }
    }
  }
  findings = [...bestByTargetId.values()];

  findings.sort((a, b) => a.scores.overall - b.scores.overall);
  findings = filterFindings(findings, filter);

  // --- Shared-cause deduplication ---
  // When >50% of findings share the same penalty, promote it to a
  // page-level diagnostic instead of repeating it on every finding.
  if (findings.length >= 10) {
    const penaltyFrequency = new Map<string, number>();
    for (const f of findings) {
      for (const p of f.penalties) {
        const key = p.replace(/(?<=\s|^)\d+(?=\s|$)/g, "N");
        penaltyFrequency.set(key, (penaltyFrequency.get(key) ?? 0) + 1);
      }
    }

    const threshold = findings.length * 0.5;
    const promotedKeys = new Set<string>();
    for (const [normalizedKey, count] of penaltyFrequency) {
      if (count > threshold) {
        promotedKeys.add(normalizedKey);
        // Find a representative un-normalized penalty
        let representative = normalizedKey;
        for (const f of findings) {
          for (const p of f.penalties) {
            if (p.replace(/(?<=\s|^)\d+(?=\s|$)/g, "N") === normalizedKey) {
              representative = p;
              break;
            }
          }
          if (representative !== normalizedKey) break;
        }
        diagnostics.push({
          level: "warning",
          code: "shared-structural-issue",
          message:
            `${count} of ${findings.length} targets share the same issue: ` +
            `"${representative}". This is a page-level structural problem — ` +
            `fixing the root cause will improve all affected targets.`,
        });
      }
    }

    // Strip promoted penalties from individual findings to reduce noise
    if (promotedKeys.size > 0) {
      for (const f of findings) {
        const sharedPenalties = f.penalties.filter(
          (p) => promotedKeys.has(p.replace(/(?<=\s|^)\d+(?=\s|$)/g, "N")),
        );
        if (sharedPenalties.length > 0) {
          (f as Record<string, unknown>)._sharedCause = sharedPenalties;
        }
      }
    }
  }

  // Synthesize a page-level finding when no targets are found.
  // This ensures users always get actionable output, even for the worst pages.
  if (findings.length === 0 && states.length > 0) {
    findings.push({
      targetId: "page-level",
      profile: profile.id,
      scores: {
        discoverability: 0,
        reachability: 0,
        operability: 0,
        recovery: 0,
        interopRisk: 0,
        overall: 0,
      },
      severity: "severe",
      bestPath: [],
      alternatePaths: [],
      penalties: [
        "No accessibility targets found — screen-reader users cannot navigate this page",
        "Page contains no headings, landmarks, links, buttons, or form fields visible to assistive technology",
      ],
      suggestedFixes: [
        "Add semantic HTML elements: <h1>-<h6> headings, <nav>/<main>/<header>/<footer> landmarks",
        "Replace <div onclick> patterns with <button> or <a> elements",
        "Add ARIA roles and accessible names where semantic HTML is not possible",
        "Ensure interactive elements have role, tabindex, and keyboard event handlers",
      ],
      confidence: 1.0,
    });
  }

  const flow: Flow = {
    id: `flow-${startTime}`,
    name: options.name ?? "Analysis",
    description: options.description,
    states: allStateIds,
    profile: profile.id,
    timestamp: startTime,
  };

  return {
    flow,
    states: filteredStates,
    findings,
    diagnostics,
    metadata: {
      version: VERSION,
      profile: profile.id,
      duration: Date.now() - startTime,
      stateCount: allStateIds.length,
      targetCount: filteredStates.reduce((sum, s) => sum + s.targets.length, 0),
      findingCount: findings.length,
      edgeCount: graph.edgeCount,
    },
  };
}
