import type { PageState, Target } from "./types.js";
import type { NavigationGraph, PathResult } from "./graph.js";
import type { ATProfile } from "../profiles/types.js";
import { builtinRules } from "../rules/index.js";
import { findNearestLandmark } from "./path-analysis.js";
import { detectVisibilityPenalties } from "./visibility-detection.js";
import { hasUsableAccessibleName, requiresExplicitAccessibleName } from "./accessible-name.js";
import { detectStatePenalties } from "./finding-state-penalties.js";
import { detectProbePenalties } from "./finding-probe-penalties.js";

// ---------------------------------------------------------------------------
// Penalty generation
// ---------------------------------------------------------------------------

export function generatePenalties(
  target: Target,
  state: PageState,
  graph: NavigationGraph,
  profile: ATProfile,
  interop: { risk: number; issues: string[] },
  linearSteps: number,
  isControl: boolean,
  controlIndex: number,
  headingPath: PathResult | undefined,
  landmarkPath: PathResult | undefined,
  headings: Target[],
): { penalties: string[]; suggestedFixes: string[] } {
  const ruleResults = builtinRules.map((rule) =>
    rule.evaluate({ target, state, graph, profile: profile.id }),
  );
  const penalties = ruleResults.flatMap((r) => r.penalties);
  const suggestedFixes = ruleResults.flatMap((r) => r.suggestedFixes);

  addInteropPenalties(target, interop, penalties, suggestedFixes);
  addGraphPenalties(
    target,
    linearSteps,
    isControl,
    controlIndex,
    headingPath,
    landmarkPath,
    headings,
    penalties,
    suggestedFixes,
  );
  addTargetSizePenalties(target, penalties, suggestedFixes);

  const stateResults = detectStatePenalties(target);
  penalties.push(...stateResults.penalties);
  suggestedFixes.push(...stateResults.suggestedFixes);

  // Visibility-mode penalties — read passthrough `_visibility[]` populated by
  // collectVisibility when the active profile declares `visualModes`.
  const visibilityResults = detectVisibilityPenalties(target);
  penalties.push(...visibilityResults.penalties);
  suggestedFixes.push(...visibilityResults.suggestedFixes);

  addFallbackDiscoverabilityPenalty(target, state, headings, penalties, suggestedFixes);

  const probeResults = detectProbePenalties(target);
  penalties.push(...probeResults.penalties);
  suggestedFixes.push(...probeResults.suggestedFixes);

  return { penalties, suggestedFixes };
}

function addInteropPenalties(
  target: Target,
  interop: { risk: number; issues: string[] },
  penalties: string[],
  suggestedFixes: string[],
): void {
  if (interop.risk <= 0) return;

  for (const issue of interop.issues) {
    penalties.push(`Interop risk: ${issue}`);
  }
  if (interop.risk < 8) return;

  if (target.role === "combobox") {
    suggestedFixes.push(
      "Verify this combobox with the target AT/browser pairs on critical flows; prefer native <select>, <datalist>, or a simpler pattern when custom filtering is not required.",
    );
  } else {
    suggestedFixes.push(
      `Verify role="${target.role}" with target AT/browser pairs; consider a simpler or native pattern if support is inconsistent on critical flows.`,
    );
  }
}

function addGraphPenalties(
  target: Target,
  linearSteps: number,
  isControl: boolean,
  controlIndex: number,
  headingPath: PathResult | undefined,
  landmarkPath: PathResult | undefined,
  headings: Target[],
  penalties: string[],
  suggestedFixes: string[],
): void {
  if (linearSteps > 8) {
    penalties.push(`${linearSteps} sequential items must be traversed on the best path`);
    suggestedFixes.push("Add skip navigation or restructure content to reduce linear traversal");
  }

  if (isControl && controlIndex > 10) {
    penalties.push(`${controlIndex} controls precede this target in control navigation`);
    suggestedFixes.push("Move this control earlier in the DOM or add a heading anchor nearby");
  }

  const isSkipLink = target.kind === "link" && /skip|jump to/i.test(target.name ?? "");
  const isNavStructure = target.kind === "landmark" || target.kind === "heading" || isSkipLink;
  if (!headingPath && !landmarkPath && headings.length > 0 && !isNavStructure) {
    penalties.push("Target is not efficiently reachable via heading or landmark navigation");
    suggestedFixes.push("Add a heading or landmark near this target to enable skip navigation");
  }

  if (target.requiresBranchOpen) {
    penalties.push(
      `Target "${target.name || target.role}" requires opening a hidden branch before it becomes reachable`,
    );
    suggestedFixes.push(
      "Consider making this target discoverable without a branch open, " +
        "or ensure the branch trigger is clearly labeled",
    );
  }

  if (requiresExplicitAccessibleName(target) && !hasUsableAccessibleName(target)) {
    penalties.push("Target has no accessible name — screen-reader users cannot identify it");
    suggestedFixes.push("Add an aria-label, aria-labelledby, or visible text label");
  }
}

function addTargetSizePenalties(
  target: Target,
  penalties: string[],
  suggestedFixes: string[],
): void {
  // WCAG 2.5.8 target-size. The spec exempts inline text links via
  // _inlineInText, which captureState sets on links whose parent block
  // contains meaningfully more text than the link itself.
  const rect = (target as Record<string, unknown>)._rect as
    | { width: number; height: number }
    | undefined;
  const inlineInText = (target as Record<string, unknown>)._inlineInText === true;
  if (!rect || rect.width <= 0 || rect.height <= 0 || inlineInText) return;
  if (rect.width >= 24 && rect.height >= 24) return;

  penalties.push(
    `Target is ${rect.width}×${rect.height}px, below the WCAG 2.5.8 minimum (24×24 for AA). ` +
      `Users with motor impairments have a higher miss rate on small targets. ` +
      `Screen-reader users aren't affected, but touch/pointer users are.`,
  );
  suggestedFixes.push(
    "Increase min-width and min-height to 24px, or enlarge the clickable area via padding. " +
      "An invisible padded hit region can enlarge touch target without changing visual design.",
  );
}

function addFallbackDiscoverabilityPenalty(
  target: Target,
  state: PageState,
  headings: Target[],
  penalties: string[],
  suggestedFixes: string[],
): void {
  if (penalties.length > 0) return;

  const hasHeadingNearby = headings.length > 0;
  const hasLandmarkNearby = !!findNearestLandmark(state, target);
  if (
    !hasHeadingNearby &&
    !hasLandmarkNearby &&
    target.kind !== "heading" &&
    target.kind !== "landmark"
  ) {
    penalties.push(
      "Low discoverability: not near any heading or landmark — screen-reader users navigating by structure will miss this target",
    );
    suggestedFixes.push(
      "Add a heading nearby, or place this target inside a labeled landmark region",
    );
  } else if (!hasHeadingNearby) {
    penalties.push("Low discoverability: no heading structure nearby for heading-based navigation");
    suggestedFixes.push(
      "Add a heading near this target to support heading navigation (71.6% of SR users start with headings)",
    );
  }
}
