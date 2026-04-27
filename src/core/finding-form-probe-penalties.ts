import type { Target } from "./types.js";

export function addFormErrorProbePenalties(
  target: Target,
  penalties: string[],
  suggestedFixes: string[],
): void {
  const formErrorProbe = (target as Record<string, unknown>)._formErrorProbe as
    | {
        probeSucceeded?: boolean;
        invalidStateExposed?: boolean;
        errorMessageAssociated?: boolean;
        focusMovedToInvalidField?: boolean;
        liveErrorRegionPresent?: boolean;
      }
    | undefined;
  if (!formErrorProbe?.probeSucceeded) return;

  if (formErrorProbe.invalidStateExposed === false) {
    penalties.push("Form error flow: invalid field state is not exposed after validation.");
    suggestedFixes.push(
      "Set aria-invalid='true' on invalid fields when validation fails, and clear it when the field becomes valid.",
    );
  }
  if (formErrorProbe.errorMessageAssociated === false) {
    penalties.push(
      "Form error flow: validation error text is not associated with the invalid field.",
    );
    suggestedFixes.push(
      "Render an error message element and reference it with aria-describedby or aria-errormessage on the invalid field.",
    );
  }
  if (formErrorProbe.focusMovedToInvalidField === false) {
    penalties.push("Form error flow: validation does not move focus to the invalid field.");
    suggestedFixes.push(
      "On failed submit or validation, move focus to the first invalid field or to an error summary that links to it.",
    );
  }
  if (formErrorProbe.liveErrorRegionPresent === false) {
    suggestedFixes.push(
      "Consider an aria-live='polite' or role='alert' error summary for form-level validation changes.",
    );
  }
}
