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
  addTargetSizePenalties(target, state, penalties, suggestedFixes);

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

  addRedundantLinkPenalty(target, state, penalties, suggestedFixes);

  return { penalties, suggestedFixes };
}

/**
 * Per-target counterpart to the page-level `redundant-tab-stops` diagnostic.
 * For each link that shares both `_href` and accessible name with another
 * link in the same state, push a penalty surfacing the duplication on the
 * specific finding. Doesn't modify the score (consistent with other penalty
 * helpers); the diagnostic carries the page-level total.
 */
function addRedundantLinkPenalty(
  target: Target,
  state: PageState,
  penalties: string[],
  suggestedFixes: string[],
): void {
  if (target.kind !== "link" || !target.name) return;
  const href = (target as Record<string, unknown>)._href as string | undefined;
  if (!href) return;

  let duplicateCount = 0;
  for (const other of state.targets) {
    if (other.id === target.id) continue;
    if (other.kind !== "link") continue;
    if (other.name !== target.name) continue;
    if ((other as Record<string, unknown>)._href !== href) continue;
    duplicateCount++;
  }
  if (duplicateCount === 0) return;

  const total = duplicateCount + 1;
  penalties.push(
    `Redundant tab stop: this is one of ${total} links named "${target.name}" reaching ${href}. ` +
      `Screen-reader and keyboard users tab through each one to no new content.`,
  );
  suggestedFixes.push(
    `Consolidate the ${total} duplicate links into one, or mark the extras with tabindex="-1" / aria-hidden="true" so SR/keyboard users only encounter the canonical link.`,
  );
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
  state: PageState,
  penalties: string[],
  suggestedFixes: string[],
): void {
  // WCAG 2.5.8 target-size. Two exemptions honored:
  //   1. Inline text links — `_inlineInText` set by captureState when a
  //      link's parent block has meaningfully more text than the link.
  //   2. Spacing — undersized targets are exempt if no other interactive
  //      target's center sits within 24 CSS px (per spec, "if a 24 CSS
  //      pixel diameter circle is centered on the bounding box, the
  //      circles do not intersect another target"). We approximate: if
  //      the nearest neighbor's center is >= 24 px from this target's
  //      center, it's exempt.
  const rect = (target as Record<string, unknown>)._rect as
    | { x?: number; y?: number; width: number; height: number }
    | undefined;
  const inlineInText = (target as Record<string, unknown>)._inlineInText === true;
  if (!rect || rect.width <= 0 || rect.height <= 0 || inlineInText) return;
  if (rect.width >= 24 && rect.height >= 24) return;

  if (typeof rect.x === "number" && typeof rect.y === "number" && hasSpacingExemption(target, rect, state)) {
    return;
  }

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

const TARGET_SIZE_INTERACTIVE_KINDS: ReadonlySet<string> = new Set([
  "button",
  "link",
  "formField",
  "menuTrigger",
  "menuItem",
  "tab",
  "search",
]);

function hasSpacingExemption(
  target: Target,
  rect: { x?: number; y?: number; width: number; height: number },
  state: PageState,
): boolean {
  const cx = (rect.x ?? 0) + rect.width / 2;
  const cy = (rect.y ?? 0) + rect.height / 2;

  for (const other of state.targets) {
    if (other.id === target.id) continue;
    if (!TARGET_SIZE_INTERACTIVE_KINDS.has(other.kind)) continue;
    const otherRect = (other as Record<string, unknown>)._rect as
      | { x?: number; y?: number; width: number; height: number }
      | undefined;
    if (
      !otherRect ||
      typeof otherRect.x !== "number" ||
      typeof otherRect.y !== "number" ||
      otherRect.width <= 0 ||
      otherRect.height <= 0
    ) {
      continue;
    }
    const ocx = otherRect.x + otherRect.width / 2;
    const ocy = otherRect.y + otherRect.height / 2;
    const dist = Math.hypot(cx - ocx, cy - ocy);
    if (dist < 24) return false;
  }
  // No interactive neighbor within 24 px → spacing exception applies.
  return true;
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
