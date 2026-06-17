import type { Target } from "./types.js";

const nvdaObservedFormFieldQuickNavRoles = new Set([
  "checkbox",
  "combobox",
  "listbox",
  "radio",
  "spinbutton",
]);

const nvdaObservedNativeTextRoles = new Set(["searchbox", "textbox"]);
const nvdaObservedControlQuickNavKinds = new Set(["button", "disclosure", "menuTrigger"]);

/**
 * Evidence-backed approximation of NVDA/Edge browse-mode `F` quick navigation.
 *
 * VM calibration on 2026-06-12 showed this is neither "all form fields" nor a
 * native-only subset. NVDA 2026.1.1 + Edge reached buttons, native text/search
 * fields, comboboxes, checkboxes, radios, spinbuttons, and ARIA
 * combobox/listbox widgets with browse-mode `F`. The same runs skipped a
 * generic custom `div role=textbox` and a native range slider, even though
 * browse traversal announced both. Keep this list conservative until VM
 * evidence contradicts it.
 */
export function isLikelyNvdaFormFieldQuickNavTarget(target: Target): boolean {
  if (nvdaObservedControlQuickNavKinds.has(target.kind) || target.role === "button") return true;
  if (target.kind !== "formField") return false;

  const role = target.role.toLowerCase();
  if (nvdaObservedFormFieldQuickNavRoles.has(role)) return true;

  if (!nvdaObservedNativeTextRoles.has(role)) return false;
  return target._nativeHtmlControl === "input" || target._nativeHtmlControl === "textarea";
}

export function formFieldQuickNavTargets(targets: Target[], profileId: string): Target[] {
  if (!profileId.includes("nvda")) return targets.filter((target) => target.kind === "formField");
  return targets.filter(isLikelyNvdaFormFieldQuickNavTarget);
}
