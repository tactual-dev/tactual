import type { Target } from "./types.js";
import { CONTROL_KINDS } from "./types.js";
import type { ScoreInputs } from "../scoring/index.js";
import { summarizeVisibility } from "./visibility-detection.js";
import { hasRequiredAccessibleName } from "./accessible-name.js";

// ---------------------------------------------------------------------------
// Score-input assembly
// ---------------------------------------------------------------------------

export function assembleScoreInputs(
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
      inHeadingStructure:
        target.kind === "heading" ||
        target.kind === "landmark" ||
        isSkipLink ||
        nearestHeading !== null,
      headingLevel: target.kind === "heading" ? target.headingLevel : nearestHeading?.headingLevel,
      inLandmark: target.kind === "landmark" || nearestLandmark !== null,
      inControlNavigation: isControl,
      hasAccessibleName: hasRequiredAccessibleName(target),
      hasRole: !!target.role,
      searchDiscoverable: !!target.name && target.name.trim().length > 2,
      hasKeyboardShortcut: (attributes ?? []).some((a) => a.includes("keyshortcuts")),
      requiresBranchOpen: target.requiresBranchOpen,
      branchTriggerQuality: (target as Record<string, unknown>)._branchTriggerQuality as
        | "well-labeled"
        | "labeled"
        | "unlabeled"
        | undefined,
    },
    reachability: {
      shortestPathCost: shortestCost === Infinity ? 50 : shortestCost,
      medianPathCost: medianCost === Infinity ? 50 : medianCost,
      unrelatedItemsOnPath: linearSteps,
      involvesContextSwitch: hasContextSwitch,
      requiresBranchOpen: target.requiresBranchOpen,
      branchTriggerQuality: (target as Record<string, unknown>)._branchTriggerQuality as
        | "well-labeled"
        | "labeled"
        | "unlabeled"
        | undefined,
      totalTargets,
      usesSkipNavigation,
    },
    operability: deriveOperability(target),
    recovery: deriveRecovery(target, headings, landmarks, attributes),
    interopRisk: 0,
  };
}

// ---------------------------------------------------------------------------
// Action-type classifier
// ---------------------------------------------------------------------------

/**
 * Classify how an LLM should act on this finding.
 *
 * - "code-fix": Add/change an attribute, fix focus management, add a label.
 *   The LLM can write a targeted code change.
 * - "pattern-review": The ARIA pattern has inherent cross-AT limitations.
 *   The LLM should suggest alternative patterns, not blindly "fix" the element.
 * - "structural": Page-level issue (missing landmarks, deep DOM). Fix is
 *   architectural, not per-target.
 * - undefined: No penalties — nothing to act on.
 */
export function classifyActionType(
  penalties: string[],
  interop: { risk: number; issues: string[] },
  target: Target,
): "code-fix" | "pattern-review" | "structural" | undefined {
  if (penalties.length === 0 && interop.risk === 0) return undefined;

  const penaltyText = penalties.join(" ").toLowerCase();

  const hasOnlyInteropPenalties = penalties.every((p) => p.toLowerCase().includes("interop risk"));
  if (interop.risk > 0 && hasOnlyInteropPenalties) {
    return "pattern-review";
  }
  if (interop.risk >= 5 && !penaltyText.includes("no accessible name")) {
    return "pattern-review";
  }

  if (
    penaltyText.includes("no heading structure") ||
    penaltyText.includes("controls precede") ||
    penaltyText.includes("not efficiently reachable via heading") ||
    penaltyText.includes("sequential items must be traversed")
  ) {
    if (penaltyText.includes("no accessible name") || penaltyText.includes("focus")) {
      return "code-fix";
    }
    return "structural";
  }

  if (target.requiresBranchOpen && interop.risk >= 3) {
    return "pattern-review";
  }

  return "code-fix";
}

export function isControlKind(kind: string): boolean {
  return CONTROL_KINDS.has(kind);
}

// ---------------------------------------------------------------------------
// Operability + Recovery derivation
// ---------------------------------------------------------------------------

/** Roles that are natively interactive and keyboard-operable */
const INTERACTIVE_ROLES = new Set([
  "button",
  "link",
  "textbox",
  "searchbox",
  "checkbox",
  "radio",
  "slider",
  "spinbutton",
  "switch",
  "combobox",
  "listbox",
  "menuitem",
  "menuitemcheckbox",
  "menuitemradio",
  "tab",
  "option",
  "treeitem",
]);

/** Roles where state changes are expected and should be announced */
const STATEFUL_ROLES = new Set([
  "checkbox",
  "radio",
  "switch",
  "combobox",
  "listbox",
  "tab",
  "menuitemcheckbox",
  "menuitemradio",
  "slider",
  "spinbutton",
  "treeitem",
  "option",
]);

/** Roles that manage focus after activation */
const FOCUS_MANAGING_ROLES = new Set([
  "dialog",
  "alertdialog",
  "menu",
  "listbox",
  "combobox",
  "tab",
  "tree",
  "grid",
  "treegrid",
]);

/**
 * Derive operability signals for a target.
 *
 * Uses runtime keyboard probe results when available (stored in target._probe
 * by the probes module). Falls back to role-based heuristics when no probe
 * data exists (e.g., CLI analysis without browser, or non-interactive roles).
 */
function deriveOperability(target: Target): {
  roleCorrect: boolean;
  stateChangesAnnounced: boolean;
  focusCorrectAfterActivation: boolean;
  keyboardCompatible: boolean;
  menuInvariantFailures?: number;
  widgetInvariantFailures?: number;
  targetTooSmall?: boolean;
  iconInvisibleUnderHCM?: boolean;
  iconLowContrast?: boolean;
  iconHCMSubstitutionRisk?: boolean;
} {
  const visibilityFlags = summarizeVisibility(target);
  // Count failed menu-pattern invariants (if the menu probe ran).
  const menuProbe = (target as Record<string, unknown>)._menuProbe as
    | {
        opens?: boolean;
        arrowDownAdvances?: boolean;
        escapeRestoresFocus?: boolean;
        outsideClickCloses?: boolean;
        probeSucceeded?: boolean;
      }
    | undefined;
  let menuInvariantFailures: number | undefined;
  if (menuProbe?.probeSucceeded) {
    let n = 0;
    if (menuProbe.opens === false) n++;
    if (menuProbe.arrowDownAdvances === false && menuProbe.opens !== false) n++;
    if (menuProbe.escapeRestoresFocus === false && menuProbe.opens !== false) n++;
    if (menuProbe.outsideClickCloses === false && menuProbe.opens !== false) n++;
    if (n > 0) menuInvariantFailures = n;
  }

  const widgetInvariantFailures = countWidgetInvariantFailures(target);

  // WCAG 2.5.8 target-size — flag interactive targets smaller than 24×24px.
  const rect = (target as Record<string, unknown>)._rect as
    | { width: number; height: number }
    | undefined;
  const inlineInText = (target as Record<string, unknown>)._inlineInText === true;
  let targetTooSmall: boolean | undefined;
  if (rect && rect.width > 0 && rect.height > 0 && !inlineInText) {
    if (rect.width < 24 || rect.height < 24) {
      targetTooSmall = true;
    }
  }

  const probe = (target as Record<string, unknown>)._probe as
    | {
        focusable?: boolean;
        escapeRestoresFocus?: boolean;
        focusNotTrapped?: boolean;
        stateChanged?: boolean;
        tabbable?: boolean;
        hasPositiveTabindex?: boolean;
        probeSucceeded?: boolean;
      }
    | undefined;

  if (probe?.probeSucceeded) {
    const role = target.role?.toLowerCase() ?? "";
    const nativeSelect = (target as Record<string, unknown>)._nativeHtmlControl === "select";
    const isStateful = !nativeSelect && STATEFUL_ROLES.has(role);
    const managesFocus = !nativeSelect && FOCUS_MANAGING_ROLES.has(role);

    return {
      roleCorrect: !!target.role && !(probe.hasPositiveTabindex ?? false),
      keyboardCompatible: (probe.focusable ?? false) && (probe.tabbable ?? true),
      stateChangesAnnounced: isStateful ? (probe.stateChanged ?? false) : true,
      focusCorrectAfterActivation: managesFocus ? (probe.escapeRestoresFocus ?? false) : true,
      menuInvariantFailures,
      widgetInvariantFailures,
      targetTooSmall,
      ...visibilityFlags,
    };
  }

  // Fallback: role-based inference
  const role = target.role?.toLowerCase() ?? "";
  const nativeSelect = (target as Record<string, unknown>)._nativeHtmlControl === "select";
  const isInteractive = INTERACTIVE_ROLES.has(role);
  const isStateful = !nativeSelect && STATEFUL_ROLES.has(role);
  const managesFocus = !nativeSelect && FOCUS_MANAGING_ROLES.has(role);

  return {
    roleCorrect: !!role,
    keyboardCompatible: isInteractive || !isControlKind(target.kind),
    stateChangesAnnounced: !isStateful,
    focusCorrectAfterActivation: !managesFocus,
    menuInvariantFailures,
    widgetInvariantFailures,
    targetTooSmall,
    ...visibilityFlags,
  };
}

function countWidgetInvariantFailures(target: Target): number | undefined {
  let failures = 0;
  const tabProbe = (target as Record<string, unknown>)._tabProbe as
    | {
        probeSucceeded?: boolean;
        singleTab?: boolean;
        arrowRightMovesFocus?: boolean;
        activationSelectsTab?: boolean;
        selectedTabHasPanel?: boolean;
      }
    | undefined;
  if (tabProbe?.probeSucceeded && !tabProbe.singleTab) {
    if (tabProbe.arrowRightMovesFocus === false) failures++;
    if (tabProbe.activationSelectsTab === false) failures++;
    if (tabProbe.selectedTabHasPanel === false) failures++;
  }

  const disclosureProbe = (target as Record<string, unknown>)._disclosureProbe as
    | {
        probeSucceeded?: boolean;
        expandedFlipped?: boolean;
        controlledRegionDisplayed?: boolean;
        focusLostToBody?: boolean;
      }
    | undefined;
  if (disclosureProbe?.probeSucceeded) {
    if (disclosureProbe.expandedFlipped === false) failures++;
    if (disclosureProbe.controlledRegionDisplayed === false) failures++;
    if (disclosureProbe.focusLostToBody === true) failures++;
  }

  const comboboxProbe = (target as Record<string, unknown>)._comboboxProbe as
    | {
        probeSucceeded?: boolean;
        opensWithArrowDown?: boolean;
        exposesActiveOption?: boolean;
        escapeCloses?: boolean;
      }
    | undefined;
  if (comboboxProbe?.probeSucceeded) {
    if (comboboxProbe.opensWithArrowDown === false) failures++;
    if (comboboxProbe.exposesActiveOption === false) failures++;
    if (comboboxProbe.escapeCloses === false) failures++;
  }

  const listboxProbe = (target as Record<string, unknown>)._listboxProbe as
    | {
        probeSucceeded?: boolean;
        arrowDownMovesOption?: boolean;
        exposesSelectedOption?: boolean;
      }
    | undefined;
  if (listboxProbe?.probeSucceeded) {
    if (listboxProbe.arrowDownMovesOption === false) failures++;
    if (listboxProbe.exposesSelectedOption === false) failures++;
  }

  const formErrorProbe = (target as Record<string, unknown>)._formErrorProbe as
    | {
        probeSucceeded?: boolean;
        invalidStateExposed?: boolean;
        errorMessageAssociated?: boolean;
        focusMovedToInvalidField?: boolean;
      }
    | undefined;
  if (formErrorProbe?.probeSucceeded) {
    if (formErrorProbe.invalidStateExposed === false) failures++;
    if (formErrorProbe.errorMessageAssociated === false) failures++;
    if (formErrorProbe.focusMovedToInvalidField === false) failures++;
  }

  const modalTriggerProbe = (target as Record<string, unknown>)._modalTriggerProbe as
    | {
        probeSucceeded?: boolean;
        opensDialog?: boolean;
        focusMovedInside?: boolean;
        tabStaysInside?: boolean;
        escapeCloses?: boolean;
        focusReturnedToTrigger?: boolean;
        dialogHasNoFocusables?: boolean;
      }
    | undefined;
  if (modalTriggerProbe?.probeSucceeded) {
    if (modalTriggerProbe.opensDialog === false) failures++;
    if (modalTriggerProbe.focusMovedInside === false) failures++;
    if (modalTriggerProbe.tabStaysInside === false) failures++;
    if (modalTriggerProbe.escapeCloses === false) failures++;
    if (modalTriggerProbe.focusReturnedToTrigger === false) failures++;
    if (modalTriggerProbe.dialogHasNoFocusables === true) failures++;
  }

  return failures > 0 ? failures : undefined;
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
  const probe = (target as Record<string, unknown>)._probe as
    | {
        escapeRestoresFocus?: boolean;
        focusNotTrapped?: boolean;
        probeSucceeded?: boolean;
      }
    | undefined;

  const hasShortcut = (attributes ?? []).some((a) => a.includes("keyshortcuts"));

  const modalTriggerProbe = (target as Record<string, unknown>)._modalTriggerProbe as
    | {
        probeSucceeded?: boolean;
        escapeCloses?: boolean;
        focusReturnedToTrigger?: boolean;
      }
    | undefined;
  if (modalTriggerProbe?.probeSucceeded) {
    return {
      canDismiss: modalTriggerProbe.escapeCloses ?? false,
      focusReturnsLogically: (modalTriggerProbe.focusReturnedToTrigger ?? false) || hasShortcut,
      canRelocateContext: headings.length > 0 || landmarks.length > 0 || hasShortcut,
      branchesPredictable:
        modalTriggerProbe.escapeCloses === true &&
        modalTriggerProbe.focusReturnedToTrigger === true,
    };
  }

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
