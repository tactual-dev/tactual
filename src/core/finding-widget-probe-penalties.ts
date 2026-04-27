import type { Target } from "./types.js";

export function addCompositeWidgetProbePenalties(
  target: Target,
  penalties: string[],
  suggestedFixes: string[],
): void {
  addTabProbePenalties(target, penalties, suggestedFixes);
  addDisclosureProbePenalties(target, penalties, suggestedFixes);
  addComboboxProbePenalties(target, penalties, suggestedFixes);
  addListboxProbePenalties(target, penalties, suggestedFixes);
}

function addTabProbePenalties(
  target: Target,
  penalties: string[],
  suggestedFixes: string[],
): void {
  const tabProbe = (target as Record<string, unknown>)._tabProbe as
    | {
        probeSucceeded?: boolean;
        singleTab?: boolean;
        arrowRightMovesFocus?: boolean;
        activationSelectsTab?: boolean;
        selectedTabHasPanel?: boolean;
      }
    | undefined;
  if (!tabProbe?.probeSucceeded || tabProbe.singleTab) return;

  if (tabProbe.arrowRightMovesFocus === false) {
    penalties.push(
      "APG tabs pattern: ArrowRight does not move focus to another tab. " +
        "Screen-reader and keyboard users expect arrow keys to move within the tablist.",
    );
    suggestedFixes.push(
      "Add a keydown handler on the tablist for ArrowRight/ArrowLeft/Home/End " +
        "that moves focus among tabs using roving tabindex or focus().",
    );
  }
  if (tabProbe.activationSelectsTab === false) {
    penalties.push(
      "APG tabs pattern: activating the focused tab does not set aria-selected='true'. " +
        "The selected tab state is not exposed reliably to assistive technology.",
    );
    suggestedFixes.push(
      "When a tab is activated, set aria-selected='true' on the active tab, " +
        "aria-selected='false' on sibling tabs, and update tabindex values.",
    );
  }
  if (tabProbe.selectedTabHasPanel === false) {
    penalties.push(
      "APG tabs pattern: selected tab does not expose a visible controlled tabpanel. " +
        "Users can select a tab but the relationship to its content is missing or hidden.",
    );
    suggestedFixes.push(
      "Connect each tab to a role='tabpanel' with aria-controls/aria-labelledby " +
        "and ensure the active panel is visible when its tab is selected.",
    );
  }
}

function addDisclosureProbePenalties(
  target: Target,
  penalties: string[],
  suggestedFixes: string[],
): void {
  const disclosureProbe = (target as Record<string, unknown>)._disclosureProbe as
    | {
        probeSucceeded?: boolean;
        expandedFlipped?: boolean;
        controlledRegionDisplayed?: boolean;
        focusLostToBody?: boolean;
      }
    | undefined;
  if (!disclosureProbe?.probeSucceeded) return;

  if (disclosureProbe.expandedFlipped === false) {
    penalties.push(
      "Disclosure pattern: pressing Enter does not toggle aria-expanded. " +
        "Screen-reader users cannot tell whether the controlled content opened.",
    );
    suggestedFixes.push(
      "In the disclosure button activation handler, toggle aria-expanded between " +
        "'false' and 'true' in sync with the visible content.",
    );
  }
  if (disclosureProbe.controlledRegionDisplayed === false) {
    penalties.push(
      "Disclosure pattern: aria-expanded indicates open, but the controlled region is still hidden.",
    );
    suggestedFixes.push(
      "When aria-expanded becomes 'true', remove hidden/display:none/visibility:hidden " +
        "from the aria-controls target at the same time.",
    );
  }
  if (disclosureProbe.focusLostToBody === true) {
    penalties.push(
      "Disclosure pattern: activation drops focus to document.body. Users lose their place after opening the disclosure.",
    );
    suggestedFixes.push(
      "Keep focus on the disclosure button after toggling, or move focus to a deliberate target inside the opened panel.",
    );
  }
}

function addComboboxProbePenalties(
  target: Target,
  penalties: string[],
  suggestedFixes: string[],
): void {
  const comboboxProbe = (target as Record<string, unknown>)._comboboxProbe as
    | {
        probeSucceeded?: boolean;
        opensWithArrowDown?: boolean;
        exposesActiveOption?: boolean;
        escapeCloses?: boolean;
      }
    | undefined;
  if (!comboboxProbe?.probeSucceeded) return;

  if (comboboxProbe.opensWithArrowDown === false) {
    penalties.push(
      "APG combobox pattern: ArrowDown does not open the popup. Keyboard users cannot enter the option list predictably.",
    );
    suggestedFixes.push(
      "Handle ArrowDown on the combobox by opening the popup, setting aria-expanded='true', and rendering the controlled listbox.",
    );
  }
  if (comboboxProbe.exposesActiveOption === false) {
    penalties.push(
      "APG combobox pattern: opening the popup does not expose an active or selected option.",
    );
    suggestedFixes.push(
      "When the popup opens, set aria-activedescendant to an option id or move focus to an option, and keep option roles/selection state current.",
    );
  }
  if (comboboxProbe.escapeCloses === false) {
    penalties.push(
      "APG combobox pattern: Escape does not close the popup or reset aria-expanded.",
    );
    suggestedFixes.push(
      "Handle Escape on the combobox/listbox popup by closing the popup and setting aria-expanded='false'.",
    );
  }
}

function addListboxProbePenalties(
  target: Target,
  penalties: string[],
  suggestedFixes: string[],
): void {
  const listboxProbe = (target as Record<string, unknown>)._listboxProbe as
    | {
        probeSucceeded?: boolean;
        arrowDownMovesOption?: boolean;
        exposesSelectedOption?: boolean;
      }
    | undefined;
  if (!listboxProbe?.probeSucceeded) return;

  if (listboxProbe.arrowDownMovesOption === false) {
    penalties.push("APG listbox pattern: ArrowDown does not move to another option.");
    suggestedFixes.push(
      "Handle ArrowDown/ArrowUp/Home/End on the listbox with roving tabindex, aria-activedescendant, or DOM focus on options.",
    );
  }
  if (listboxProbe.exposesSelectedOption === false) {
    penalties.push(
      "APG listbox pattern: no active or selected option is exposed after keyboard navigation.",
    );
    suggestedFixes.push(
      "Expose the active option via aria-activedescendant or aria-selected='true' on the selected option.",
    );
  }
}
