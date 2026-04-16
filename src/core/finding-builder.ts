import type { PageState, Target, Finding } from "./types.js";
import { severityFromScore, CONTROL_KINDS } from "./types.js";
import type { NavigationGraph, PathResult } from "./graph.js";
import type { ScoreInputs } from "../scoring/index.js";
import { computeScores } from "../scoring/index.js";
import { computeInteropRisk } from "../scoring/interop.js";
import { builtinRules } from "../rules/index.js";
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

/**
 * Build a scored Finding for a single target within a state.
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
  const linearSteps = bestPath
    ? bestPath.edges.filter((e) => e.action === "nextItem").length
    : 0;
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
    target, headings, landmarks, nearestHeading, nearestLandmark,
    isControl, totalTargets, usesSkipNav, shortestCost, medianCost, linearSteps, hasContextSwitch,
    targetAttrs,
  );

  // --- Interop risk (with ARIA APG conformance check) ---
  const interop = computeInteropRisk(target.role, targetAttrs);
  scoreInputs.interopRisk = interop.risk;

  const scores = computeScores(scoreInputs, profile);

  // --- Penalties and fixes ---
  const { penalties, suggestedFixes } = generatePenalties(
    target, state, graph, profile, interop,
    linearSteps, isControl, controlIndex, headingPath, landmarkPath, headings,
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
  if (!nearestHeading && !nearestLandmark) confidence -= 0.1;  // no structural context
  if (target.requiresBranchOpen) confidence -= 0.15;           // hidden branch may not be explored
  if (shortestCost === Infinity) confidence -= 0.25;           // unreachable target
  confidence = Math.max(0.1, confidence);

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
    confidence: Math.round(confidence * 100) / 100,
  };
}

// ---------------------------------------------------------------------------
// Score input assembly
// ---------------------------------------------------------------------------

function assembleScoreInputs(
  target: Target,
  headings: Target[],
  landmarks: Target[],
  nearestHeading: Target | null,
  nearestLandmark: Target | null,
  isControl: boolean,
  totalTargets: number,
  usesSkipNavigation: boolean,
  shortestCost: number,
  medianCost: number,
  linearSteps: number,
  hasContextSwitch: boolean,
  attributes?: string[],
): ScoreInputs {
  // Skip links are discoverable by definition — they're the first focusable element
  const isSkipLink = target.kind === "link" && /skip|jump to/i.test(target.name ?? "");

  return {
    discoverability: {
      // Landmarks, headings, and skip links are structural anchors.
      inHeadingStructure: target.kind === "heading" || target.kind === "landmark" || isSkipLink || nearestHeading !== null,
      headingLevel: target.kind === "heading"
        ? target.headingLevel
        : nearestHeading?.headingLevel,
      inLandmark: target.kind === "landmark" || nearestLandmark !== null,
      inControlNavigation: isControl,
      hasAccessibleName: !!target.name && target.name.trim().length > 0,
      hasRole: !!target.role,
      searchDiscoverable: !!target.name && target.name.trim().length > 2,
      hasKeyboardShortcut: (attributes ?? []).some((a) => a.includes("keyshortcuts")),
      requiresBranchOpen: target.requiresBranchOpen,
      branchTriggerQuality: (target as Record<string, unknown>)._branchTriggerQuality as "well-labeled" | "labeled" | "unlabeled" | undefined,
    },
    reachability: {
      shortestPathCost: shortestCost === Infinity ? 50 : shortestCost,
      medianPathCost: medianCost === Infinity ? 50 : medianCost,
      unrelatedItemsOnPath: linearSteps,
      involvesContextSwitch: hasContextSwitch,
      requiresBranchOpen: target.requiresBranchOpen,
      branchTriggerQuality: (target as Record<string, unknown>)._branchTriggerQuality as "well-labeled" | "labeled" | "unlabeled" | undefined,
      totalTargets,
      usesSkipNavigation,
    },
    operability: deriveOperability(target),
    recovery: deriveRecovery(target, headings, landmarks, attributes),
    interopRisk: 0,
  };
}

// ---------------------------------------------------------------------------
// Penalty generation
// ---------------------------------------------------------------------------

function generatePenalties(
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
  // Rule-based penalties
  const ruleResults = builtinRules.map((rule) =>
    rule.evaluate({ target, state, graph, profile: profile.id }),
  );
  const penalties = ruleResults.flatMap((r) => r.penalties);
  const suggestedFixes = ruleResults.flatMap((r) => r.suggestedFixes);

  // Interop risk
  if (interop.risk > 0) {
    for (const issue of interop.issues) {
      penalties.push(`Interop risk: ${issue}`);
    }
    if (interop.risk >= 8) {
      suggestedFixes.push(
        `Consider using a more widely supported pattern instead of role="${target.role}"`,
      );
    }
  }

  // Graph-derived penalties
  if (linearSteps > 8) {
    penalties.push(`${linearSteps} sequential items must be traversed on the best path`);
    suggestedFixes.push("Add skip navigation or restructure content to reduce linear traversal");
  }

  if (isControl && controlIndex > 10) {
    penalties.push(`${controlIndex} controls precede this target in control navigation`);
    suggestedFixes.push("Move this control earlier in the DOM or add a heading anchor nearby");
  }

  // Skip-link exemption: a "skip to content" link IS the skip mechanism.
  // It doesn't need heading/landmark reachability — its purpose is being first-in-tab-order.
  // Don't penalize elements that ARE the navigation structure (landmarks, headings, skip links)
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

  if (!target.name || target.name.trim() === "") {
    penalties.push("Target has no accessible name — screen-reader users cannot identify it");
    suggestedFixes.push("Add an aria-label, aria-labelledby, or visible text label");
  }

  // State-aware penalties (from captured ARIA attribute values)
  const stateResults = detectStatePenalties(target);
  penalties.push(...stateResults.penalties);
  suggestedFixes.push(...stateResults.suggestedFixes);

  // Explain low discoverability when no other penalty covers it.
  // Without this, an LLM sees D:47 + no penalties = no guidance.
  if (penalties.length === 0) {
    const hasHeadingNearby = headings.length > 0;
    const hasLandmarkNearby = !!findNearestLandmark(state, target);
    if (!hasHeadingNearby && !hasLandmarkNearby && target.kind !== "heading" && target.kind !== "landmark") {
      penalties.push("Low discoverability: not near any heading or landmark — screen-reader users navigating by structure will miss this target");
      suggestedFixes.push("Add a heading nearby, or place this target inside a labeled landmark region");
    } else if (!hasHeadingNearby) {
      penalties.push("Low discoverability: no heading structure nearby for heading-based navigation");
      suggestedFixes.push("Add a heading near this target to support heading navigation (71.6% of SR users start with headings)");
    }
  }

  // Recovery explanations — make Rec scores actionable
  const probe = (target as Record<string, unknown>)._probe as {
    escapeRestoresFocus?: boolean;
    focusNotTrapped?: boolean;
    tabbable?: boolean;
    hasPositiveTabindex?: boolean;
    nestedFocusable?: boolean;
    focusIndicatorSuppressed?: boolean;
    probeSucceeded?: boolean;
  } | undefined;

  if (probe?.probeSucceeded) {
    if (probe.escapeRestoresFocus === false) {
      penalties.push("Pressing Escape does not return focus to the trigger — focus position is lost after interaction");
      suggestedFixes.push("Ensure Escape returns focus to the element that opened the overlay/menu");
    }
    if (probe.focusNotTrapped === false) {
      penalties.push("Focus appears trapped — Tab key does not advance focus after interaction");
      suggestedFixes.push("Ensure focus can leave the interactive region via Tab");
    }
    if (probe.tabbable === false) {
      penalties.push(
        "Element is not reachable via Tab key (tabindex=\"-1\"). " +
        "Keyboard-only users (no screen reader) cannot reach it. " +
        "SR users may still navigate to it via heading or landmark shortcuts.",
      );
      suggestedFixes.push("Remove tabindex=\"-1\", use roving tabindex pattern (tabindex=\"0\" on active item), or ensure focus is managed programmatically");
    }
    if (probe.hasPositiveTabindex === true) {
      penalties.push("Element uses positive tabindex — this forces a non-standard Tab order that may confuse keyboard users");
      suggestedFixes.push("Remove the positive tabindex value and use DOM source order to control Tab sequence");
    }
    if (probe.nestedFocusable === true) {
      penalties.push("This element contains a nested focusable child, causing duplicate tab stops — keyboard users must Tab through the same control twice");
      suggestedFixes.push("Remove tabindex from the inner element, or use tabindex=\"-1\" on the outer element if only the inner one should be focusable");
    }
    if (probe.focusIndicatorSuppressed === true) {
      penalties.push("Focus indicator is not visible — sighted keyboard users cannot see which element is focused");
      suggestedFixes.push("Ensure a visible focus indicator via outline, box-shadow, or border change. Do not set outline:none without providing an alternative");
    }
  } else if (target.requiresBranchOpen) {
    penalties.push("Recovery cost: target is behind a hidden branch — dismissing may lose navigation position");
  }

  return { penalties, suggestedFixes };
}

/**
 * Classify how an LLM should act on this finding.
 *
 * - "code-fix": Add/change an attribute, fix focus management, add a label.
 *   The LLM can write a targeted code change.
 * - "pattern-review": The ARIA pattern has inherent cross-AT limitations.
 *   The LLM should suggest alternative patterns, not blindly "fix" the element.
 * - "structural": Page structure issue (missing headings, deep nesting, control order).
 *   May require component reorganization, not just an attribute change.
 */
function classifyActionType(
  penalties: string[],
  interop: { risk: number; issues: string[] },
  target: Target,
): "code-fix" | "pattern-review" | "structural" | undefined {
  // No penalties = no action needed
  if (penalties.length === 0 && interop.risk === 0) return undefined;

  const penaltyText = penalties.join(" ").toLowerCase();

  // Interop risk as sole or dominant penalty → pattern choice issue.
  // Can't fix cross-AT support gaps with code changes.
  const hasOnlyInteropPenalties = penalties.every((p) => p.toLowerCase().includes("interop risk"));
  if (interop.risk > 0 && hasOnlyInteropPenalties) {
    return "pattern-review";
  }
  if (interop.risk >= 5 && !penaltyText.includes("no accessible name")) {
    return "pattern-review";
  }

  // Structural issues: missing headings, deep control order, no landmark
  if (
    penaltyText.includes("no heading structure") ||
    penaltyText.includes("controls precede") ||
    penaltyText.includes("not efficiently reachable via heading") ||
    penaltyText.includes("sequential items must be traversed")
  ) {
    // If the target also has a code-level issue (no name, focus problem), prefer code-fix
    if (penaltyText.includes("no accessible name") || penaltyText.includes("focus")) {
      return "code-fix";
    }
    return "structural";
  }

  // Hidden branch with interop risk → pattern review (menu/dialog pattern choice)
  if (target.requiresBranchOpen && interop.risk >= 3) {
    return "pattern-review";
  }

  // Default: direct code fix (missing name, focus issues, branch labeling)
  return "code-fix";
}

function isControlKind(kind: string): boolean {
  return CONTROL_KINDS.has(kind);
}

// ---------------------------------------------------------------------------
// Operability derivation
// ---------------------------------------------------------------------------

/** Roles that are natively interactive and keyboard-operable */
const INTERACTIVE_ROLES = new Set([
  "button", "link", "textbox", "searchbox", "checkbox", "radio",
  "slider", "spinbutton", "switch", "combobox", "listbox",
  "menuitem", "menuitemcheckbox", "menuitemradio", "tab", "option",
  "treeitem",
]);

/** Roles where state changes are expected and should be announced */
const STATEFUL_ROLES = new Set([
  "checkbox", "radio", "switch", "combobox", "listbox",
  "tab", "menuitemcheckbox", "menuitemradio", "slider", "spinbutton",
  "treeitem", "option",
]);

/** Roles that manage focus after activation */
const FOCUS_MANAGING_ROLES = new Set([
  "dialog", "alertdialog", "menu", "listbox", "combobox",
  "tab", "tree", "grid", "treegrid",
]);

/**
 * Derive operability signals for a target.
 *
 * Uses runtime keyboard probe results when available (stored in target._probe
 * by the probes module). Falls back to role-based heuristics when no probe
 * data exists (e.g., CLI analysis without browser, or non-interactive roles).
 *
 * Probe-based scoring:
 * - roleCorrect: probe succeeded and element was focusable
 * - keyboardCompatible: element received focus via click
 * - stateChangesAnnounced: activation changed aria-expanded/checked/pressed
 * - focusCorrectAfterActivation: Escape returned focus to trigger
 *
 * Role-based fallback (unchanged from before):
 * - button/link/heading: operability 100
 * - checkbox/switch: operability 75
 * - dialog/menu: operability 75
 * - combobox (stateful + focus-managing): operability 50
 */
function deriveOperability(target: Target): {
  roleCorrect: boolean;
  stateChangesAnnounced: boolean;
  focusCorrectAfterActivation: boolean;
  keyboardCompatible: boolean;
} {
  // Check for runtime probe results (passthrough field from probes.ts)
  const probe = (target as Record<string, unknown>)._probe as {
    focusable?: boolean;
    activatable?: boolean;
    escapeRestoresFocus?: boolean;
    focusNotTrapped?: boolean;
    stateChanged?: boolean;
    tabbable?: boolean;
    hasPositiveTabindex?: boolean;
    probeSucceeded?: boolean;
  } | undefined;

  if (probe?.probeSucceeded) {
    const role = target.role?.toLowerCase() ?? "";
    const isStateful = STATEFUL_ROLES.has(role);
    const managesFocus = FOCUS_MANAGING_ROLES.has(role);

    return {
      roleCorrect: !!target.role && !(probe.hasPositiveTabindex ?? false),
      keyboardCompatible: (probe.focusable ?? false) && (probe.tabbable ?? true),
      // Only penalize missing state changes on roles that SHOULD change state.
      // A plain button not toggling aria-expanded is correct behavior, not a bug.
      stateChangesAnnounced: isStateful ? (probe.stateChanged ?? false) : true,
      // Only penalize focus management on roles that SHOULD manage focus.
      // A search button doesn't need Escape-to-return behavior.
      focusCorrectAfterActivation: managesFocus ? (probe.escapeRestoresFocus ?? false) : true,
    };
  }

  // Fallback: role-based inference
  const role = target.role?.toLowerCase() ?? "";
  const isInteractive = INTERACTIVE_ROLES.has(role);
  const isStateful = STATEFUL_ROLES.has(role);
  const managesFocus = FOCUS_MANAGING_ROLES.has(role);

  // Without probe data, assume the worst for complex roles:
  // - Stateful roles (combobox, checkbox) are assumed NOT to announce state changes
  // - Focus-managing roles (dialog, menu) are assumed NOT to handle focus correctly
  // The probe path provides ground truth; this is the conservative fallback.
  return {
    roleCorrect: !!role,
    keyboardCompatible: isInteractive || !isControlKind(target.kind),
    stateChangesAnnounced: !isStateful,
    focusCorrectAfterActivation: !managesFocus,
  };
}

/**
 * Derive recovery signals for a target.
 *
 * Uses probe data when available: escapeRestoresFocus and focusNotTrapped
 * are direct runtime observations. Falls back to structural heuristics.
 */
function deriveRecovery(
  target: Target,
  headings: Target[],
  landmarks: Target[],
  attributes?: string[],
): {
  canDismiss: boolean;
  focusReturnsLogically: boolean;
  canRelocateContext: boolean;
  branchesPredictable: boolean;
} {
  const probe = (target as Record<string, unknown>)._probe as {
    escapeRestoresFocus?: boolean;
    focusNotTrapped?: boolean;
    probeSucceeded?: boolean;
  } | undefined;

  // Keyboard shortcut boosts recovery: user can always return via the shortcut
  const hasShortcut = (attributes ?? []).some((a) => a.includes("keyshortcuts"));

  if (probe?.probeSucceeded) {
    return {
      canDismiss: probe.escapeRestoresFocus ?? !target.requiresBranchOpen,
      focusReturnsLogically: (probe.escapeRestoresFocus ?? false) || hasShortcut,
      canRelocateContext: headings.length > 0 || landmarks.length > 0 || hasShortcut,
      branchesPredictable: (probe.focusNotTrapped ?? true) && !target.requiresBranchOpen,
    };
  }

  return {
    canDismiss: !target.requiresBranchOpen || hasShortcut,
    focusReturnsLogically: true,
    canRelocateContext: headings.length > 0 || landmarks.length > 0 || hasShortcut,
    branchesPredictable: !target.requiresBranchOpen,
  };
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

/**
 * State-aware penalties from captured ARIA attribute values.
 *
 * These checks complement rule-based penalties by reading the
 * Target._attributeValues map populated during snapshot parsing.
 * Each penalty represents something a screen-reader user would
 * notice when navigating — confusing announcements, missing state
 * info, disabled-but-discoverable controls, etc.
 */
function detectStatePenalties(target: Target): { penalties: string[]; suggestedFixes: string[] } {
  const penalties: string[] = [];
  const suggestedFixes: string[] = [];

  // Orphaned aria-labelledby: references at least one ID that doesn't exist.
  // The element appears unlabeled to AT despite developer intent.
  if ((target as Record<string, unknown>)._labelledByMissing) {
    penalties.push(
      "aria-labelledby references an element ID that doesn't exist — " +
      "the element has no accessible name despite the developer's intent.",
    );
    suggestedFixes.push(
      "Verify the IDs in aria-labelledby match real elements on the page. " +
      "Missing IDs silently produce unlabeled controls.",
    );
  }

  // Orphaned aria-describedby: similar — description silently missing.
  if ((target as Record<string, unknown>)._descriptionMissing) {
    penalties.push(
      "aria-describedby references an element ID that doesn't exist — " +
      "the description the developer attached is silently dropped.",
    );
    suggestedFixes.push(
      "Verify the IDs in aria-describedby match real elements on the page.",
    );
  }

  // Assertive live region: interrupts whatever the user is doing.
  // Use sparingly — for status messages, errors that need immediate attention.
  const liveRegion = (target as Record<string, unknown>)._liveRegion as string | undefined;
  if (liveRegion === "assertive" && target.kind !== "statusMessage") {
    penalties.push(
      "aria-live='assertive' interrupts the user mid-action. Use only for errors " +
      "or critical alerts; routine updates should use 'polite'.",
    );
    suggestedFixes.push(
      "Change aria-live='assertive' to 'polite' unless this is an error or critical alert " +
      "that must be heard immediately.",
    );
  }

  const attrs = (target as Record<string, unknown>)._attributeValues as
    | Record<string, string>
    | undefined;
  if (!attrs) return { penalties, suggestedFixes };

  const role = target.role;
  const name = (target.name ?? "").toLowerCase();

  // Label-state mismatch: button labeled "expand"/"collapse"/etc. while
  // aria-expanded is set. NVDA reads both, producing confusing announcements
  // like "Collapse, expanded" — technically correct but reads as a contradiction.
  const expanded = attrs["aria-expanded"];
  if (
    expanded !== undefined &&
    (role === "button" || role === "link") &&
    /\b(expand|collapse|show|hide|open|close)\b/.test(name)
  ) {
    penalties.push(
      `Label-state mismatch: button labeled "${target.name}" with aria-expanded=${expanded} ` +
      `produces a confusing announcement (e.g., "Collapse, expanded"). The label describes ` +
      `the action; the state describes the current condition.`,
    );
    suggestedFixes.push(
      "Use a state-neutral label (e.g., 'Toggle operation details') and let aria-expanded " +
      "convey state, or swap the label dynamically: 'Show details' when collapsed, 'Hide details' when expanded.",
    );
  }

  // Disabled-but-discoverable: form fields and controls that are in the AT
  // tree but disabled. NVDA announces them, users tab to them, can't interact.
  const isDisabled = attrs["aria-disabled"] === "true";
  const isFormControl =
    role === "textbox" || role === "searchbox" || role === "combobox" ||
    role === "listbox" || role === "spinbutton" || role === "slider" ||
    role === "checkbox" || role === "radio" || role === "switch";
  if (isDisabled && (isFormControl || role === "button" || role === "link")) {
    penalties.push(
      `Control is in the accessibility tree but disabled (aria-disabled=true). ` +
      `Screen-reader users will navigate to it and hear "unavailable" but cannot interact.`,
    );
    suggestedFixes.push(
      "If the control should be hidden until enabled, add aria-hidden='true' and remove " +
      "from tab order. If it must be visible, ensure surrounding context explains why " +
      "it is disabled (e.g., 'Click \"Try it out\" to enable these fields').",
    );
  }

  // Tab missing aria-selected: required for tab pattern, NVDA can't announce
  // which tab is current without it.
  if (role === "tab" && attrs["aria-selected"] === undefined) {
    penalties.push(
      "Tab missing aria-selected — screen-reader users cannot tell which tab is currently active.",
    );
    suggestedFixes.push(
      "Add aria-selected='true' to the active tab and aria-selected='false' to the others.",
    );
  }

  // Combobox/listbox/menu missing aria-expanded: NVDA can't announce whether
  // the popup is open or closed.
  if (
    (role === "combobox" || role === "listbox" || role === "menu") &&
    attrs["aria-expanded"] === undefined
  ) {
    penalties.push(
      `${role} missing aria-expanded — screen-reader users cannot tell if the popup is open or closed.`,
    );
    suggestedFixes.push(
      `Add aria-expanded='true' when the ${role} is open and 'false' when closed. ` +
      "Update on toggle.",
    );
  }

  // Cross-AT announcement divergence — flags when NVDA/JAWS/VoiceOver
  // produce materially different announcements for the same target.
  // (Inlined here to avoid core → playwright import dependency.)
  if (role === "combobox" && attrs["aria-expanded"] !== undefined) {
    penalties.push(
      "Cross-AT divergence: VoiceOver announces this combobox as 'popup button' " +
      "without an explicit expanded/collapsed state, while NVDA/JAWS announce " +
      "'combo box, collapsed/expanded'. Users on different platforms get " +
      "materially different cues about whether the popup is open.",
    );
  }

  return { penalties, suggestedFixes };
}
