import type { PageState, AnalysisResult, Flow, Finding, EvidenceItem } from "./types.js";
import { buildGraph } from "./graph-builder.js";
import { buildFinding } from "./finding-builder.js";
import { diagnoseCapture, type CaptureDiagnostic } from "./diagnostics.js";
import {
  filterTargets,
  filterFindings,
  filterDiagnostics,
  type AnalysisFilter,
} from "./filter.js";
import { globToRegex } from "./glob.js";
import { summarizeEvidence } from "./evidence.js";
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

type AnalysisGraph = ReturnType<typeof buildGraph>;

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
  const diagnostics = collectCaptureDiagnostics(states, options, filter);
  const filteredStates = applyTargetFilter(states, filter);

  addFocusFilterWarning(diagnostics, states, filteredStates, filter);

  let graph: AnalysisGraph;
  try {
    graph = buildGraph(filteredStates, profile);
  } catch (err) {
    diagnostics.push({
      level: "error",
      code: "empty-page",
      message: `Graph construction failed: ${err instanceof Error ? err.message : "unknown error"}`,
    });
    return buildGraphFailureResult(startTime, filteredStates, diagnostics, profile, options);
  }

  const built = buildFindings(filteredStates, graph, profile, diagnostics);
  let findings = filterFindings(
    built.findings.sort((a, b) => a.scores.overall - b.scores.overall),
    filter,
  );

  addRedundantTabStopDiagnostics(diagnostics, filteredStates);
  addSharedCauseDiagnostics(diagnostics, findings);
  findings = addPageLevelFindingIfEmpty(findings, states, profile);

  return buildAnalysisResult(
    startTime,
    filteredStates,
    findings,
    diagnostics,
    built.stateIds,
    graph,
    profile,
    options,
  );
}

function collectCaptureDiagnostics(
  states: PageState[],
  options: AnalyzeOptions,
  filter: AnalysisFilter,
): CaptureDiagnostic[] {
  const allStateDiags = states.map((state) =>
    diagnoseCapture(
      state,
      options.requestedUrl ?? options.name ?? state.url,
      options.snapshotText ?? "",
    ),
  );

  const diagCounts = new Map<string, number>();
  for (const stateDiags of allStateDiags) {
    for (const diagnostic of stateDiags) {
      if (diagnostic.code === "ok") continue;
      const key = diagnosticKey(diagnostic);
      diagCounts.set(key, (diagCounts.get(key) ?? 0) + 1);
    }
  }

  const diagnostics: CaptureDiagnostic[] = [];
  const seenKeys = new Set<string>();
  for (const stateDiags of allStateDiags) {
    for (const diagnostic of stateDiags) {
      if (diagnostic.code === "ok") continue;
      const key = diagnosticKey(diagnostic);
      if (seenKeys.has(key)) continue;
      seenKeys.add(key);
      const count = diagCounts.get(key) ?? 1;
      diagnostics.push(
        count > 1
          ? { ...diagnostic, message: `${diagnostic.message} (${count} states)` }
          : diagnostic,
      );
    }
  }

  return filterDiagnostics(diagnostics, filter);
}

function diagnosticKey(diagnostic: CaptureDiagnostic): string {
  return `${diagnostic.code}:${diagnostic.message}`;
}

function applyTargetFilter(states: PageState[], filter: AnalysisFilter): PageState[] {
  return states.map((state) => ({
    ...state,
    targets: filterTargets(state.targets, filter),
  }));
}

function addFocusFilterWarning(
  diagnostics: CaptureDiagnostic[],
  states: PageState[],
  filteredStates: PageState[],
  filter: AnalysisFilter,
): void {
  if (!filter.focus || filter.focus.length === 0) return;

  const focusPatterns = filter.focus.map((p) => globToRegex(p));
  const hasMatch = states.some((state) =>
    state.targets.some(
      (target) =>
        (target.kind === "landmark" || target.kind === "search") &&
        focusPatterns.some(
          (re) =>
            re.test((target.name ?? "").toLowerCase()) ||
            re.test((target.role ?? "").toLowerCase()),
        ),
    ),
  );
  if (hasMatch) return;

  const totalAfter = filteredStates.reduce((n, state) => n + state.targets.length, 0);
  diagnostics.push({
    level: "warning",
    code: "no-landmarks",
    message: `Focus filter (${filter.focus.join(", ")}) had no effect — no matching landmarks found. All ${totalAfter} targets were analyzed.`,
  });
}

function buildGraphFailureResult(
  startTime: number,
  filteredStates: PageState[],
  diagnostics: CaptureDiagnostic[],
  profile: ATProfile,
  options: AnalyzeOptions,
): AnalysisResult {
  return {
    flow: {
      id: `flow-${startTime}`,
      name: options.name ?? "Analysis",
      states: [],
      profile: profile.id,
      timestamp: startTime,
    },
    states: filteredStates,
    findings: [],
    diagnostics,
    metadata: {
      version: VERSION,
      profile: profile.id,
      duration: Date.now() - startTime,
      stateCount: filteredStates.length,
      targetCount: 0,
      findingCount: 0,
      edgeCount: 0,
    },
  };
}

function buildFindings(
  filteredStates: PageState[],
  graph: AnalysisGraph,
  profile: ATProfile,
  diagnostics: CaptureDiagnostic[],
): { findings: Finding[]; stateIds: string[] } {
  const stateIds: string[] = [];
  const bestByTargetId = new Map<string, Finding>();

  for (const state of filteredStates) {
    if (!graph.hasNode(state.id)) continue;
    stateIds.push(state.id);

    for (const target of state.targets) {
      const nodeId = `${state.id}:${target.id}`;
      if (!graph.hasNode(nodeId)) continue;
      try {
        const finding = buildFinding(graph, state, nodeId, target, profile);
        const existing = bestByTargetId.get(target.id);
        if (!existing || finding.scores.overall > existing.scores.overall) {
          bestByTargetId.set(target.id, finding);
        }
      } catch (err) {
        diagnostics.push({
          level: "warning",
          code: "possibly-degraded-content",
          message: `Failed to analyze target "${target.id}": ${err instanceof Error ? err.message : "unknown error"}`,
        });
      }
    }
  }

  return { findings: [...bestByTargetId.values()], stateIds };
}

function addRedundantTabStopDiagnostics(
  diagnostics: CaptureDiagnostic[],
  filteredStates: PageState[],
): void {
  const hrefGroups = groupLinksByHref(filteredStates);
  let redundantUrls = 0;
  let worstHref: string | undefined;
  let worstCount = 0;
  const worstTargetIds: string[] = [];

  for (const [href, info] of hrefGroups) {
    if (info.count <= 1) continue;
    redundantUrls++;
    if (info.count > worstCount) {
      worstCount = info.count;
      worstHref = href;
      worstTargetIds.splice(0, worstTargetIds.length, ...info.targetIds);
    }
  }
  if (redundantUrls === 0 || !worstHref) return;

  const savings = [...hrefGroups.values()].reduce(
    (sum, group) => sum + (group.count > 1 ? group.count - 1 : 0),
    0,
  );
  diagnostics.push({
    level: "warning",
    code: "redundant-tab-stops",
    message:
      `${savings} redundant tab stop${savings === 1 ? "" : "s"} across ${redundantUrls} duplicated link destination${redundantUrls === 1 ? "" : "s"}. ` +
      `Worst case: ${worstCount} links reach "${worstHref}". ` +
      `Consider adding tabindex="-1" to the redundant anchors, or consolidating into a single link — ` +
      `screen-reader users currently tab through ${savings} extra stop${savings === 1 ? "" : "s"} to reach the same destinations.`,
    affectedCount: savings,
    totalCount: redundantUrls,
    affectedTargetIds: worstTargetIds.slice(0, 5),
  });
}

function groupLinksByHref(
  filteredStates: PageState[],
): Map<string, { count: number; targetIds: string[] }> {
  const hrefGroups = new Map<string, { count: number; targetIds: string[] }>();
  for (const state of filteredStates) {
    for (const target of state.targets) {
      if (target.kind !== "link") continue;
      const href = (target as Record<string, unknown>)._href as string | undefined;
      if (!href) continue;
      const existing = hrefGroups.get(href);
      if (existing) {
        existing.count++;
        if (existing.targetIds.length < 5) existing.targetIds.push(target.id);
      } else {
        hrefGroups.set(href, { count: 1, targetIds: [target.id] });
      }
    }
  }
  return hrefGroups;
}

function addSharedCauseDiagnostics(
  diagnostics: CaptureDiagnostic[],
  findings: Finding[],
): void {
  if (findings.length < 10) return;

  const penaltyFrequency = new Map<string, number>();
  for (const finding of findings) {
    for (const penalty of finding.penalties) {
      const key = normalizePenalty(penalty);
      penaltyFrequency.set(key, (penaltyFrequency.get(key) ?? 0) + 1);
    }
  }

  const threshold = findings.length * 0.5;
  const promotedKeys = new Set<string>();
  for (const [normalizedKey, count] of penaltyFrequency) {
    if (count <= threshold) continue;

    promotedKeys.add(normalizedKey);
    const representative = findRepresentativePenalty(findings, normalizedKey);
    diagnostics.push({
      level: "warning",
      code: "shared-structural-issue",
      message:
        `${count} of ${findings.length} targets share the same issue: ` +
        `"${representative}". This is a page-level structural problem — ` +
        `fixing the root cause will improve all affected targets.`,
      affectedCount: count,
      totalCount: findings.length,
      affectedTargetIds: collectAffectedTargetIds(findings, normalizedKey),
    });
  }

  if (promotedKeys.size > 0) {
    markSharedCauseFindings(findings, promotedKeys);
  }
}

function normalizePenalty(penalty: string): string {
  return penalty.replace(/(?<=\s|^)\d+(?=\s|$)/g, "N");
}

function findRepresentativePenalty(findings: Finding[], normalizedKey: string): string {
  for (const finding of findings) {
    for (const penalty of finding.penalties) {
      if (normalizePenalty(penalty) === normalizedKey) return penalty;
    }
  }
  return normalizedKey;
}

function collectAffectedTargetIds(findings: Finding[], normalizedKey: string): string[] {
  const affectedIds: string[] = [];
  for (const finding of findings) {
    for (const penalty of finding.penalties) {
      if (normalizePenalty(penalty) === normalizedKey) {
        if (affectedIds.length < 10) affectedIds.push(finding.targetId);
        break;
      }
    }
  }
  return affectedIds;
}

function markSharedCauseFindings(findings: Finding[], promotedKeys: Set<string>): void {
  for (const finding of findings) {
    const sharedPenalties = finding.penalties.filter((penalty) =>
      promotedKeys.has(normalizePenalty(penalty)),
    );
    if (sharedPenalties.length > 0) {
      (finding as Record<string, unknown>)._sharedCause = sharedPenalties;
    }
  }
}

function addPageLevelFindingIfEmpty(
  findings: Finding[],
  states: PageState[],
  profile: ATProfile,
): Finding[] {
  if (findings.length > 0 || states.length === 0) return findings;
  return [...findings, createPageLevelFinding(profile)];
}

function createPageLevelFinding(profile: ATProfile): Finding {
  const evidence: EvidenceItem[] = [
    {
      kind: "measured",
      source: "playwright-accessibility-tree",
      description: "Browser accessibility snapshot contained no navigable targets.",
      confidence: 1,
    },
    {
      kind: "heuristic",
      source: "page-level-empty-target-rule",
      description:
        "Tactual synthesized a page-level finding because no headings, landmarks, controls, or form fields were exposed.",
      confidence: 1,
    },
  ];

  return {
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
    confidence: 1,
    evidence,
    evidenceSummary: summarizeEvidence(evidence),
  };
}

function buildAnalysisResult(
  startTime: number,
  filteredStates: PageState[],
  findings: Finding[],
  diagnostics: CaptureDiagnostic[],
  stateIds: string[],
  graph: AnalysisGraph,
  profile: ATProfile,
  options: AnalyzeOptions,
): AnalysisResult {
  const flow: Flow = {
    id: `flow-${startTime}`,
    name: options.name ?? "Analysis",
    description: options.description,
    states: stateIds,
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
      stateCount: stateIds.length,
      targetCount: filteredStates.reduce((sum, state) => sum + state.targets.length, 0),
      findingCount: findings.length,
      edgeCount: graph.edgeCount,
    },
  };
}
