import type { Target } from "./types.js";

export function addMenuProbePenalties(
  target: Target,
  penalties: string[],
  suggestedFixes: string[],
): void {
  const menuProbe = (target as Record<string, unknown>)._menuProbe as
    | {
        opens?: boolean;
        expandedFlipped?: boolean;
        menuDisplayed?: boolean;
        focusMovedIntoMenu?: boolean;
        arrowDownAdvances?: boolean;
        escapeRestoresFocus?: boolean;
        outsideClickCloses?: boolean;
        probeSucceeded?: boolean;
      }
    | undefined;
  if (!menuProbe?.probeSucceeded) return;

  // Decompose "opens" into three sub-invariants so the penalty correctly
  // identifies which part failed.
  if (menuProbe.expandedFlipped === false) {
    penalties.push(
      "APG menu pattern: pressing Enter on the menu trigger does not flip " +
        "aria-expanded to 'true'. Keyboard users can't open the menu.",
    );
    suggestedFixes.push(
      "Wire the trigger's keydown handler to open the menu on Enter/Space/ArrowDown. " +
        "On open: set aria-expanded='true' and unhide the menu.",
    );
  } else if (menuProbe.menuDisplayed === false) {
    penalties.push(
      "APG menu pattern: aria-expanded flipped to 'true' but the referenced " +
        "menu element is not visible (display: none). The state attribute " +
        "and the rendered DOM are out of sync.",
    );
    suggestedFixes.push(
      "Ensure the open handler unhides the menu (remove display:none, hidden, " +
        "or aria-hidden) at the same time aria-expanded becomes 'true'.",
    );
  } else if (menuProbe.focusMovedIntoMenu === false) {
    penalties.push(
      "APG menu pattern: the menu opens (aria-expanded='true', menu visible) " +
        "but keyboard focus does not move to the first menuitem. Arrow-key " +
        "navigation within the menu won't work until the user Tabs into it.",
    );
    suggestedFixes.push(
      "In the open handler, after unhiding the menu, call firstMenuitem.focus() " +
        "(or set the first item's tabindex=0 in a roving-tabindex implementation).",
    );
  }
  if (menuProbe.arrowDownAdvances === false && menuProbe.opens === true) {
    penalties.push(
      "APG menu pattern: ArrowDown does not navigate within the menu. " +
        "Per the APG menu pattern, arrow keys move focus between menuitems; " +
        "Tab exits the menu instead.",
    );
    suggestedFixes.push(
      "In the menu's keydown handler, handle ArrowDown/ArrowUp/Home/End to move " +
        "focus between menuitems (roving-tabindex or programmatic focus()). " +
        "Don't preventDefault on Tab — let it close the menu and advance focus.",
    );
  }
  if (menuProbe.escapeRestoresFocus === false && menuProbe.opens === true) {
    penalties.push(
      "APG menu pattern: Escape while menu is open does not return focus to the " +
        "menu trigger. Per the APG menu pattern, Escape closes the menu AND " +
        "restores focus to the button that opened it.",
    );
    suggestedFixes.push(
      "Capture the trigger element on open (or document.activeElement), and in " +
        "the Escape handler, call trigger.focus() after closing the menu.",
    );
  }
  if (menuProbe.outsideClickCloses === false && menuProbe.opens === true) {
    penalties.push(
      "Clicking outside the menu does not close it. Users expect outside-click " +
        "dismissal on menu popovers.",
    );
    suggestedFixes.push(
      "Add a document-level click listener that closes the menu when the click " +
        "target is neither the menu nor the trigger. Remove the listener when the " +
        "menu closes.",
    );
  }
}
