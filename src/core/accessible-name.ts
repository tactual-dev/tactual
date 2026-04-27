import type { Target } from "./types.js";

const STRUCTURAL_LANDMARK_ROLES = new Set([
  "banner",
  "complementary",
  "contentinfo",
  "main",
  "navigation",
  "region",
  "search",
]);

const NAME_REQUIRED_ROLES = new Set([
  "alertdialog",
  "button",
  "checkbox",
  "combobox",
  "dialog",
  "link",
  "listbox",
  "menuitem",
  "menuitemcheckbox",
  "menuitemradio",
  "option",
  "radio",
  "searchbox",
  "slider",
  "spinbutton",
  "switch",
  "tab",
  "textbox",
  "treeitem",
]);

export function hasUsableAccessibleName(target: Target): boolean {
  if ((target.name ?? "").trim().length > 0) return true;
  return target.kind === "landmark" && STRUCTURAL_LANDMARK_ROLES.has(normalizeRole(target.role));
}

export function requiresExplicitAccessibleName(target: Target): boolean {
  if (target.kind === "landmark") return false;
  if (target.kind === "heading") return true;
  if (target.kind === "button" || target.kind === "link" || target.kind === "formField") {
    return true;
  }
  if (target.kind === "menuTrigger" || target.kind === "menuItem" || target.kind === "tab") {
    return true;
  }
  if (target.kind === "dialog") return true;
  return NAME_REQUIRED_ROLES.has(normalizeRole(target.role));
}

export function hasRequiredAccessibleName(target: Target): boolean {
  return hasUsableAccessibleName(target) || !requiresExplicitAccessibleName(target);
}

function normalizeRole(role: string | undefined): string {
  return (role ?? "").toLowerCase();
}
