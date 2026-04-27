import { simulateAction } from "./state-machine.js";
import type { Target } from "./types.js";

export function addGenericProbePenalties(
  target: Target,
  penalties: string[],
  suggestedFixes: string[],
): void {
  const probe = (target as Record<string, unknown>)._probe as
    | {
        escapeRestoresFocus?: boolean;
        focusNotTrapped?: boolean;
        tabbable?: boolean;
        hasPositiveTabindex?: boolean;
        nestedFocusable?: boolean;
        focusIndicatorSuppressed?: boolean;
        probeSucceeded?: boolean;
        ariaStateBeforeEnter?: Record<string, string>;
        ariaStateAfterEnter?: Record<string, string>;
        focusAfterActivation?: "stayed" | "moved-inside" | "moved-away" | "moved-to-body";
        elementStillConnected?: boolean;
      }
    | undefined;

  // Pattern-deviation: APG state-machine prediction vs probe observation.
  // Suppress when re-rendered (post-state from detached node) or when a tab
  // was already selected pre-probe (APG permits implicit activation-on-focus).
  if (probe?.probeSucceeded && probe.ariaStateBeforeEnter && probe.ariaStateAfterEnter) {
    const elementSurvived = probe.elementStillConnected !== false;
    const tabAlreadySelected =
      target.role === "tab" && probe.ariaStateBeforeEnter["aria-selected"] === "true";
    if (elementSurvived && !tabAlreadySelected) {
      const deviations = detectPatternDeviation(
        target,
        probe.ariaStateBeforeEnter,
        probe.ariaStateAfterEnter,
      );
      for (const d of deviations) {
        penalties.push(d.message);
        suggestedFixes.push(d.fix);
      }
    }
  }

  if (probe?.probeSucceeded) {
    if (probe.focusAfterActivation === "moved-to-body") {
      penalties.push(
        "Focus was lost after activation — pressing Enter sent focus to document.body " +
          "(the user is now at the start of the page). Screen-reader users lose their place; " +
          "keyboard-only users must Tab through everything to recover position.",
      );
      suggestedFixes.push(
        "In the activation handler, ensure focus moves to a sensible target: for panels/modals, " +
          "to the first interactive control inside the new content; for toggles, leave focus on " +
          "the trigger (don't blur or re-render it out of the DOM).",
      );
    }

    const menuHasFailure = hasMenuPatternFailure(target);
    if (probe.escapeRestoresFocus === false && !menuHasFailure) {
      penalties.push(
        "Pressing Escape does not return focus to the trigger — focus position is lost after interaction",
      );
      suggestedFixes.push(
        "Ensure Escape returns focus to the element that opened the overlay/menu",
      );
    }
    if (probe.focusNotTrapped === false && !menuHasFailure) {
      penalties.push("Focus appears trapped — Tab key does not advance focus after interaction");
      suggestedFixes.push("Ensure focus can leave the interactive region via Tab");
    }
    if (probe.tabbable === false) {
      penalties.push(
        'Element is not reachable via Tab key (tabindex="-1"). ' +
          "Keyboard-only users (no screen reader) cannot reach it. " +
          "SR users may still navigate to it via heading or landmark shortcuts.",
      );
      suggestedFixes.push(
        'Remove tabindex="-1", use roving tabindex pattern (tabindex="0" on active item), or ensure focus is managed programmatically',
      );
    }
    if (probe.hasPositiveTabindex === true) {
      penalties.push(
        "Element uses positive tabindex — this forces a non-standard Tab order that may confuse keyboard users",
      );
      suggestedFixes.push(
        "Remove the positive tabindex value and use DOM source order to control Tab sequence",
      );
    }
    if (probe.nestedFocusable === true) {
      penalties.push(
        "This element contains a nested focusable child, causing duplicate tab stops — keyboard users must Tab through the same control twice",
      );
      suggestedFixes.push(
        'Remove tabindex from the inner element, or use tabindex="-1" on the outer element if only the inner one should be focusable',
      );
    }
    if (probe.focusIndicatorSuppressed === true) {
      penalties.push(
        "Focus indicator is not visible — sighted keyboard users cannot see which element is focused",
      );
      suggestedFixes.push(
        "Ensure a visible focus indicator via outline, box-shadow, or border change. Do not set outline:none without providing an alternative",
      );
    }
  } else if (target.requiresBranchOpen) {
    penalties.push(
      "Recovery cost: target is behind a hidden branch — dismissing may lose navigation position",
    );
  }
}

function hasMenuPatternFailure(target: Target): boolean {
  const menuProbe = (target as Record<string, unknown>)._menuProbe as
    | {
        probeSucceeded?: boolean;
        expandedFlipped?: boolean;
        menuDisplayed?: boolean;
        focusMovedIntoMenu?: boolean;
        escapeRestoresFocus?: boolean;
      }
    | undefined;

  return (
    menuProbe?.probeSucceeded === true &&
    (menuProbe.expandedFlipped === false ||
      menuProbe.menuDisplayed === false ||
      menuProbe.focusMovedIntoMenu === false ||
      menuProbe.escapeRestoresFocus === false)
  );
}

function detectPatternDeviation(
  target: Target,
  before: Record<string, string>,
  after: Record<string, string>,
): Array<{ message: string; fix: string }> {
  const beforeTarget = {
    ...target,
    _attributeValues: { ...before },
  } as Target;
  const predicted = simulateAction(beforeTarget, "Enter");
  if (!predicted.changed) return [];

  const out: Array<{ message: string; fix: string }> = [];
  for (const change of predicted.changes) {
    if (!change.attr.startsWith("aria-")) continue;
    const expected = change.to;
    const actual = after[change.attr];
    if (actual === expected) continue;

    const role = target.role;
    const patternName =
      role === "button" ? (change.attr === "aria-pressed" ? "toggle-button" : "disclosure") : role;
    const fixHint =
      change.attr === "aria-pressed"
        ? "Ensure the button's onClick handler toggles aria-pressed. Screen-reader users rely on this state to know whether the toggle is active."
        : change.attr === "aria-expanded"
          ? "Ensure the button's click handler toggles aria-expanded AND shows/hides the disclosed content."
          : `Ensure the ${role}'s keyboard handler toggles ${change.attr}. Screen-reader users rely on this state.`;

    out.push({
      message:
        `Pattern deviation: pressing Enter on a ${patternName} should toggle ${change.attr} ` +
        `from "${change.from ?? "(unset)"}" to "${expected}" per the ARIA APG ${patternName} ` +
        `pattern, but probe observed ${change.attr}="${actual ?? "(unset)"}".`,
      fix: fixHint,
    });
  }
  return out;
}
