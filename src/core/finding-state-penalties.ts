import type { Target } from "./types.js";

interface PenaltyResult {
  penalties: string[];
  suggestedFixes: string[];
}

/**
 * State-aware penalties from captured ARIA attribute values.
 *
 * These checks complement rule-based penalties by reading the
 * Target._attributeValues map populated during snapshot parsing.
 * Each penalty represents something a screen-reader user would
 * notice when navigating: confusing announcements, missing state
 * info, disabled-but-discoverable controls, etc.
 */
export function detectStatePenalties(target: Target): PenaltyResult {
  const penalties: string[] = [];
  const suggestedFixes: string[] = [];

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

  if ((target as Record<string, unknown>)._descriptionMissing) {
    penalties.push(
      "aria-describedby references an element ID that doesn't exist — " +
        "the description the developer attached is silently dropped.",
    );
    suggestedFixes.push("Verify the IDs in aria-describedby match real elements on the page.");
  }

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
  const nativeSelect = (target as Record<string, unknown>)._nativeHtmlControl === "select";

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

  const isDisabled = attrs["aria-disabled"] === "true";
  const isFormControl =
    role === "textbox" ||
    role === "searchbox" ||
    role === "combobox" ||
    role === "listbox" ||
    role === "spinbutton" ||
    role === "slider" ||
    role === "checkbox" ||
    role === "radio" ||
    role === "switch";
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

  if (role === "tab" && attrs["aria-selected"] === undefined) {
    penalties.push(
      "Tab missing aria-selected — screen-reader users cannot tell which tab is currently active.",
    );
    suggestedFixes.push(
      "Add aria-selected='true' to the active tab and aria-selected='false' to the others.",
    );
  }

  if (
    (role === "combobox" || role === "listbox" || role === "menu") &&
    !nativeSelect &&
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

  // Cross-AT divergence — flags when AT announcements likely diverge in
  // a way that affects the user. Confidence labels are honest about
  // what's verified vs heuristic.
  if (role === "combobox" && attrs["aria-expanded"] !== undefined) {
    penalties.push(
      "Cross-AT divergence (HIGH confidence for native <select>, MEDIUM for " +
        "ARIA combobox): VoiceOver announces this combobox as 'popup button' " +
        "with state implicit in the role text, while NVDA/JAWS announce " +
        "'combo box, expanded/collapsed' explicitly. Verify with real testing " +
        "if this control is on a critical path.",
    );
  }

  return { penalties, suggestedFixes };
}
