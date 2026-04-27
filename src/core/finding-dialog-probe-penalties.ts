import type { Target } from "./types.js";

export function addModalProbePenalties(
  target: Target,
  penalties: string[],
  suggestedFixes: string[],
): void {
  const modalProbe = (target as Record<string, unknown>)._modalProbe as
    | {
        focusTrapped?: boolean;
        shiftTabWraps?: boolean;
        escapeCloses?: boolean;
        probeSucceeded?: boolean;
        dialogHasNoFocusables?: boolean;
      }
    | undefined;
  if (!modalProbe?.probeSucceeded) return;

  if (modalProbe.dialogHasNoFocusables) {
    penalties.push(
      "APG dialog pattern: dialog has no focusable descendants. Keyboard users " +
        "can reach the dialog's presence via screen-reader navigation but cannot " +
        "interact with anything inside — the dialog is effectively inert for them.",
    );
    suggestedFixes.push(
      "Add at least one focusable control (a close button at minimum) and ensure " +
        "focus is placed on it when the dialog opens.",
    );
    return;
  }

  if (modalProbe.focusTrapped === false) {
    penalties.push(
      "APG dialog pattern: Tab from the last focusable element escapes the " +
        "dialog. Per the dialog-modal pattern, focus must be trapped within the " +
        "dialog — Tab from the last focusable should cycle back to the first.",
    );
    suggestedFixes.push(
      "In the dialog's keydown handler, on Tab when document.activeElement is " +
        "the last focusable: preventDefault and focus the first focusable.",
    );
  }
  if (modalProbe.shiftTabWraps === false) {
    penalties.push(
      "APG dialog pattern: Shift+Tab from the first focusable element escapes " +
        "the dialog. The trap must work in both directions.",
    );
    suggestedFixes.push(
      "In the dialog's keydown handler, on Shift+Tab when document.activeElement " +
        "is the first focusable: preventDefault and focus the last focusable.",
    );
  }
  if (modalProbe.escapeCloses === false) {
    penalties.push(
      "APG dialog pattern: Escape does not close the dialog. Users expect " +
        "Escape to dismiss modals.",
    );
    suggestedFixes.push(
      "Add an Escape keydown handler on the dialog that closes it (hides or " +
        "removes the dialog element). Also restore focus to the element that " +
        "opened the dialog.",
    );
  }
}

export function addModalTriggerProbePenalties(
  target: Target,
  penalties: string[],
  suggestedFixes: string[],
): void {
  const modalTriggerProbe = (target as Record<string, unknown>)._modalTriggerProbe as
    | {
        opensDialog?: boolean;
        focusMovedInside?: boolean;
        tabStaysInside?: boolean;
        escapeCloses?: boolean;
        focusReturnedToTrigger?: boolean;
        probeSucceeded?: boolean;
        dialogHasNoFocusables?: boolean;
      }
    | undefined;
  if (!modalTriggerProbe?.probeSucceeded) return;

  if (modalTriggerProbe.opensDialog === false) {
    penalties.push(
      "Dialog trigger flow: activation does not open a visible role='dialog' or role='alertdialog'.",
    );
    suggestedFixes.push(
      "Connect the trigger to a rendered dialog with aria-haspopup='dialog' and aria-controls, and open it on Enter/Space.",
    );
    return;
  }

  if (modalTriggerProbe.focusMovedInside === false) {
    penalties.push(
      "Dialog trigger flow: focus does not move into the dialog after it opens. Keyboard and screen-reader users remain on the opener without context.",
    );
    suggestedFixes.push(
      "When opening the dialog, focus the dialog container or the first meaningful focusable control inside it.",
    );
  }
  if (modalTriggerProbe.dialogHasNoFocusables) {
    penalties.push("Dialog trigger flow: the opened dialog has no focusable descendants.");
    suggestedFixes.push(
      "Add at least one focusable control inside the dialog, such as a close button, and focus it on open.",
    );
  }
  if (modalTriggerProbe.tabStaysInside === false) {
    penalties.push("Dialog trigger flow: Tab can leave the opened modal dialog.");
    suggestedFixes.push("Trap Tab and Shift+Tab within the modal dialog while it is open.");
  }
  if (modalTriggerProbe.escapeCloses === false) {
    penalties.push("Dialog trigger flow: Escape does not close the opened dialog.");
    suggestedFixes.push(
      "Handle Escape inside the dialog by closing it and restoring focus to the opener.",
    );
  }
  if (modalTriggerProbe.focusReturnedToTrigger === false) {
    penalties.push(
      "Dialog trigger flow: closing the dialog does not return focus to the trigger.",
    );
    suggestedFixes.push(
      "Store the opener before showing the dialog and call focus() on it after close.",
    );
  }
}
