import type { PageState, Target, Finding, EvidenceItem } from "./types.js";
import { severityFromScore } from "./types.js";
import type { NavigationGraph } from "./graph.js";
import { summarizeEvidence } from "./evidence.js";
import { computeScores } from "../scoring/index.js";
import { computeInteropRisk } from "../scoring/interop.js";
import type { ATProfile } from "../profiles/types.js";
import {
  collectEntryPoints,
  computePathsFromEntries,
  computeAlternatePaths,
  findNearestHeading,
  findNearestLandmark,
  formatPath,
  median,
} from "./path-analysis.js";
import { assembleScoreInputs, classifyActionType, isControlKind } from "./finding-scoring.js";
import { generatePenalties } from "./finding-penalties.js";

/**
 * Build a scored Finding for a single target within a state.
 *
 * Orchestrator: pulls structural context from the state, computes paths,
 * delegates score-input assembly to finding-scoring, delegates penalty
 * generation to finding-penalties, and assembles the final Finding.
 */
export function buildFinding(
  graph: NavigationGraph,
  state: PageState,
  nodeId: string,
  target: Target,
  profile: ATProfile,
): Finding {
  // Structural context
  const headings = state.targets.filter((t) => t.kind === "heading");
  const landmarks = state.targets.filter((t) => t.kind === "landmark");
  const controls = state.targets.filter((t) => isControlKind(t.kind));

  // --- Path analysis ---
  const entryPoints = collectEntryPoints(state, graph);
  const paths = computePathsFromEntries(graph, entryPoints, nodeId);
  const bestPath = paths.length > 0 ? paths[0] : null;
  const shortestCost = bestPath?.totalCost ?? Infinity;
  const allCosts = paths.map((p) => p.totalCost);
  const medianCost = allCosts.length > 0 ? median(allCosts) : Infinity;
  const linearSteps = bestPath ? bestPath.edges.filter((e) => e.action === "nextItem").length : 0;
  const hasContextSwitch =
    bestPath?.edges.some((e) => e.action === "groupEntry" || e.action === "groupExit") ?? false;

  const alternatePaths = computeAlternatePaths(graph, state, nodeId, bestPath);

  // --- Structural context ---
  const nearestHeading = findNearestHeading(state, target);
  const nearestLandmark = findNearestLandmark(state, target);
  const controlIndex = controls.findIndex((c) => c.id === target.id);
  const isControl = controlIndex >= 0;
  const headingPath = paths.find((p) => p.edges.some((e) => e.action === "nextHeading"));
  const landmarkPath = paths.find((p) => p.edges.some((e) => e.action === "groupEntry"));

  // --- Extract ARIA attributes for scoring ---
  const targetAttrs = (target as Record<string, unknown>)._attributes as string[] | undefined;

  // --- Assemble score inputs ---
  const usesSkipNav = !!headingPath || !!landmarkPath;
  const totalTargets = state.targets.length;
  const scoreInputs = assembleScoreInputs(
    target,
    headings,
    landmarks,
    nearestHeading,
    nearestLandmark,
    isControl,
    totalTargets,
    usesSkipNav,
    shortestCost,
    medianCost,
    linearSteps,
    hasContextSwitch,
    targetAttrs,
  );

  // --- Interop risk (with ARIA APG conformance check) ---
  const nativeSelect = (target as Record<string, unknown>)._nativeHtmlControl === "select";
  const interop =
    nativeSelect && (target.role === "combobox" || target.role === "listbox")
      ? { risk: 0, issues: [] }
      : computeInteropRisk(target.role, targetAttrs);
  scoreInputs.interopRisk = interop.risk;

  const scores = computeScores(scoreInputs, profile);

  // --- Penalties and fixes ---
  const { penalties, suggestedFixes } = generatePenalties(
    target,
    state,
    graph,
    profile,
    interop,
    linearSteps,
    isControl,
    controlIndex,
    headingPath,
    landmarkPath,
    headings,
  );

  // --- Format paths (truncate to keep output manageable) ---
  const bestPathDesc = truncatePath(formatPath(graph, bestPath), 8);
  const altPathDescs = alternatePaths
    .slice(0, 3) // at most 3 alternate paths
    .map((p) => truncatePath(formatPath(graph, p), 5));

  // --- Confidence ---
  // Base 0.8 with penalties for uncertain analysis contexts.
  // Current max deduction: 0.1 + 0.15 + 0.25 = 0.5 → worst case 0.3.
  // Floor of 0.1 ensures future penalties can't drive confidence to zero.
  let confidence = 0.8;
  if (!nearestHeading && !nearestLandmark) confidence -= 0.1; // no structural context
  if (target.requiresBranchOpen) confidence -= 0.15; // hidden branch may not be explored
  if (shortestCost === Infinity) confidence -= 0.25; // unreachable target
  confidence = Math.max(0.1, confidence);
  const roundedConfidence = Math.round(confidence * 100) / 100;
  const evidence = buildEvidence(target, roundedConfidence, shortestCost);

  return {
    targetId: target.id,
    selector: target.selector,
    profile: profile.id,
    scores,
    severity: severityFromScore(scores.overall),
    actionType: classifyActionType(penalties, interop, target),
    bestPath: bestPathDesc,
    alternatePaths: altPathDescs,
    penalties: [...new Set(penalties)],
    suggestedFixes: [...new Set(suggestedFixes)],
    confidence: roundedConfidence,
    evidence,
    evidenceSummary: summarizeEvidence(evidence),
  };
}

function buildEvidence(target: Target, confidence: number, shortestCost: number): EvidenceItem[] {
  const evidence: EvidenceItem[] = [
    {
      kind: "measured",
      source: "playwright-accessibility-tree",
      description:
        "Target role, name, and structural position came from the browser accessibility snapshot.",
      confidence: 1,
    },
    {
      kind: "modeled",
      source: "navigation-graph",
      description: Number.isFinite(shortestCost)
        ? "Best path and navigation cost were computed from captured targets and AT profile action weights."
        : "No finite path was found in the computed navigation graph.",
      confidence,
    },
    {
      kind: "heuristic",
      source: "tactual-scoring-rules",
      description:
        "Scores, severity, action type, penalties, and fixes were derived from Tactual scoring heuristics.",
      confidence,
    },
  ];

  if (hasSuccessfulProbe(target, "_probe")) {
    evidence.push({
      kind: "measured",
      source: "keyboard-probe",
      description:
        "Runtime keyboard probe measured focusability, activation behavior, Escape recovery, Tab trapping, and focus visibility signals.",
      confidence: 0.95,
    });
  }

  if (hasSuccessfulProbe(target, "_menuProbe")) {
    const sampled = (
      (target as Record<string, unknown>)._menuProbe as { sampledFromExemplar?: boolean }
    )?.sampledFromExemplar;
    evidence.push({
      kind: "measured",
      source: sampled ? "menu-pattern-probe-sampled" : "menu-pattern-probe",
      description: sampled
        ? "Menu behavior was inferred from a same-structure exemplar to bound probe cost on repeated components."
        : "Runtime menu-pattern probe measured open behavior, arrow-key movement, Escape recovery, and outside-click dismissal.",
      confidence: sampled ? 0.75 : 0.95,
    });
  }

  if (hasSuccessfulProbe(target, "_modalProbe")) {
    evidence.push({
      kind: "measured",
      source: "modal-dialog-probe",
      description:
        "Runtime dialog probe measured focus containment, Shift+Tab wrapping, Escape close behavior, and empty-dialog focusability.",
      confidence: 0.95,
    });
  }

  if (hasSuccessfulProbe(target, "_modalTriggerProbe")) {
    const sampled = (
      (target as Record<string, unknown>)._modalTriggerProbe as { sampledFromExemplar?: boolean }
    )?.sampledFromExemplar;
    evidence.push({
      kind: "measured",
      source: sampled ? "modal-trigger-probe-sampled" : "modal-trigger-probe",
      description: sampled
        ? "Dialog trigger behavior was inferred from a same-structure exemplar to bound probe cost on repeated components."
        : "Runtime dialog-trigger probe measured open behavior, focus placement, Tab containment, Escape close behavior, and focus return.",
      confidence: sampled ? 0.75 : 0.95,
    });
  }

  if (hasSuccessfulProbe(target, "_tabProbe")) {
    evidence.push({
      kind: "measured",
      source: "tab-pattern-probe",
      description:
        "Runtime tabs probe measured arrow-key movement, activation state, and visible tabpanel linkage.",
      confidence: 0.9,
    });
  }

  if (hasSuccessfulProbe(target, "_disclosureProbe")) {
    evidence.push({
      kind: "measured",
      source: "disclosure-pattern-probe",
      description:
        "Runtime disclosure probe measured aria-expanded toggling, controlled-region visibility, and focus retention.",
      confidence: 0.9,
    });
  }

  if (hasSuccessfulProbe(target, "_comboboxProbe")) {
    evidence.push({
      kind: "measured",
      source: "combobox-contract-probe",
      description:
        "Runtime combobox probe measured ArrowDown open behavior, active option exposure, and Escape dismissal.",
      confidence: 0.9,
    });
  }

  if (hasSuccessfulProbe(target, "_listboxProbe")) {
    evidence.push({
      kind: "measured",
      source: "listbox-contract-probe",
      description:
        "Runtime listbox probe measured arrow-key option movement and selected option exposure.",
      confidence: 0.9,
    });
  }

  if (hasSuccessfulProbe(target, "_formErrorProbe")) {
    evidence.push({
      kind: "measured",
      source: "form-error-flow-probe",
      description:
        "Runtime form validation probe measured invalid state exposure, error association, focus movement, and live error region presence.",
      confidence: 0.9,
    });
  }

  return evidence;
}

function hasSuccessfulProbe(
  target: Target,
  key:
    | "_probe"
    | "_menuProbe"
    | "_modalProbe"
    | "_modalTriggerProbe"
    | "_tabProbe"
    | "_disclosureProbe"
    | "_comboboxProbe"
    | "_listboxProbe"
    | "_formErrorProbe",
): boolean {
  const probe = (target as Record<string, unknown>)[key] as
    | { probeSucceeded?: boolean }
    | undefined;
  return probe?.probeSucceeded === true;
}

/**
 * Truncate a path description to a maximum number of steps.
 * Adds a "... (N more steps)" suffix if truncated.
 */
function truncatePath(path: string[], maxSteps: number): string[] {
  if (path.length <= maxSteps) return path;
  const truncated = path.slice(0, maxSteps);
  truncated.push(`... (${path.length - maxSteps} more steps)`);
  return truncated;
}
