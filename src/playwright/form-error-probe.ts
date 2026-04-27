import type { Locator, Page } from "playwright";
import type { Target } from "../core/types.js";

export interface FormErrorProbeResults {
  probeSucceeded: boolean;
  invalidStateExposed: boolean;
  errorMessageAssociated: boolean;
  focusMovedToInvalidField: boolean;
  liveErrorRegionPresent: boolean;
}

export interface FormErrorProbeOptions {
  scopeSelector?: string[];
  targetIds?: Set<string>;
}

const MAX_FORM_TARGETS = 20;

export async function probeFormErrorFlows(
  page: Page,
  targets: Target[],
  maxTargetsOrOptions: number | FormErrorProbeOptions = MAX_FORM_TARGETS,
  maybeOptions: FormErrorProbeOptions = {},
): Promise<Target[]> {
  const maxTargets =
    typeof maxTargetsOrOptions === "number" ? maxTargetsOrOptions : MAX_FORM_TARGETS;
  const options = typeof maxTargetsOrOptions === "number" ? maybeOptions : maxTargetsOrOptions;
  const targetFilter = (target: Target) => !options.targetIds || options.targetIds.has(target.id);
  const candidates = targets
    .filter(
      (t) =>
        targetFilter(t) &&
        (t.kind === "formField" ||
          t.role === "combobox" ||
          t.role === "textbox" ||
          t.role === "searchbox"),
    )
    .slice(0, maxTargets);
  if (candidates.length === 0) return targets;

  const results = new Map<string, FormErrorProbeResults>();
  for (const target of candidates) {
    const result = await probeOneField(page, target);
    if (result) results.set(target.id, result);
  }

  return targets.map((t) => {
    const result = results.get(t.id);
    return result ? ({ ...t, _formErrorProbe: result } as Target) : t;
  });
}

async function probeOneField(page: Page, target: Target): Promise<FormErrorProbeResults | null> {
  const field = locateTarget(page, target);
  const visible = await field.isVisible().catch(() => false);
  if (!visible) return null;

  try {
    const result = await field.evaluate((el: Element) => {
      const control = el as HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;
      const form = control.closest("form");
      const isRequired =
        control.hasAttribute("required") ||
        control.getAttribute("aria-required") === "true";
      const alreadyInvalid = control.getAttribute("aria-invalid") === "true";
      if (!form || (!isRequired && !alreadyInvalid)) return null;

      form.reportValidity();

      const invalidByNative = "validity" in control ? !control.validity.valid : false;
      const invalidStateExposed =
        control.getAttribute("aria-invalid") === "true" ||
        invalidByNative ||
        alreadyInvalid;

      const describedBy = idsToText(control.getAttribute("aria-describedby"));
      const errorMessage = idsToText(control.getAttribute("aria-errormessage"));
      const nativeMessage = "validationMessage" in control ? control.validationMessage : "";
      const errorMessageAssociated = !!(describedBy || errorMessage || nativeMessage);
      const liveRegion = form.querySelector('[role="alert"], [aria-live]:not([aria-live="off"])');

      return {
        invalidStateExposed,
        errorMessageAssociated,
        focusMovedToInvalidField: document.activeElement === control,
        liveErrorRegionPresent: !!(liveRegion && liveRegion.textContent?.trim()),
      };

      function idsToText(value: string | null): string {
        if (!value) return "";
        return value
          .split(/\s+/)
          .map((id) => document.getElementById(id)?.textContent?.trim() ?? "")
          .filter(Boolean)
          .join(" ");
      }
    });

    if (!result) return null;
    return { probeSucceeded: true, ...result };
  } catch {
    return {
      probeSucceeded: false,
      invalidStateExposed: false,
      errorMessageAssociated: false,
      focusMovedToInvalidField: false,
      liveErrorRegionPresent: false,
    };
  }
}

function locateTarget(page: Page, target: Target): Locator {
  const role = target.role as Parameters<Page["getByRole"]>[0];
  return target.name
    ? page.getByRole(role, { name: target.name, exact: true }).first()
    : page.locator(`[role="${target.role}"]`).first();
}
