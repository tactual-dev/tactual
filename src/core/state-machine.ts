/**
 * Pattern state machines for stateful interaction simulation.
 *
 * Models how a target's ARIA state changes in response to keyboard
 * input, per the ARIA Authoring Practices Guide (APG). Used by:
 *
 * 1. Calibration — predict post-action state to compare against
 *    ARIA-AT "after pressing X, state Y is conveyed" assertions.
 * 2. Probe integration (finding-builder) — compare predicted state
 *    transitions against probe-observed actual transitions to flag
 *    pattern-deviation bugs.
 *
 * SCOPE: single-target state changes only. Multi-target effects
 * (e.g., arrow keys moving selection across radios in a group) are
 * NOT modeled — they require navigation context not available here.
 *
 * Sources: https://www.w3.org/WAI/ARIA/apg/patterns/
 */

import type { Target } from "./types.js";

export type Key =
  | "Space" | "Enter"
  | "ArrowUp" | "ArrowDown" | "ArrowLeft" | "ArrowRight"
  | "Home" | "End"
  | "PageUp" | "PageDown"
  | "Escape" | "Tab";

export interface AttributeChange {
  attr: string;
  from: string | undefined;
  to: string;
}

export interface ActionResult {
  /** New target state after the action (or unchanged target if no rule matched) */
  target: Target;
  /** Whether the action caused any state change */
  changed: boolean;
  /** What changed, for debugging and probe comparison */
  changes: AttributeChange[];
}

/**
 * Apply a key press to a target and return the predicted post-state.
 *
 * If no pattern rule matches the (role, key) pair, returns the target
 * unchanged with `changed: false`. This is intentional — we only model
 * well-spec'd patterns, and absence of a behavior is honest about scope.
 */
export function simulateAction(target: Target, key: Key): ActionResult {
  const role = target.role;
  const attrs = readAttrs(target);
  const value = readValue(target);

  // Toggle handlers — checkbox, switch, button[aria-pressed], button[aria-expanded]
  if ((role === "checkbox" || role === "switch" || role === "menuitemcheckbox") &&
      (key === "Space" || key === "Enter")) {
    return toggleAttr(target, "aria-checked", attrs, role === "menuitemcheckbox");
  }

  if (role === "menuitemradio" && (key === "Space" || key === "Enter")) {
    // Selecting a radio sets it to checked (group-level deselection of others
    // is multi-target and not modeled here).
    return setAttr(target, "aria-checked", attrs, "true");
  }

  if (role === "button" && (key === "Space" || key === "Enter")) {
    if (attrs["aria-pressed"] !== undefined) {
      return toggleAttr(target, "aria-pressed", attrs);
    }
    if (attrs["aria-expanded"] !== undefined) {
      return toggleAttr(target, "aria-expanded", attrs);
    }
  }

  if (role === "combobox" && (key === "Space" || key === "Enter" || key === "ArrowDown")) {
    if (attrs["aria-expanded"] !== undefined) {
      return key === "ArrowDown"
        ? setAttr(target, "aria-expanded", attrs, "true")
        : toggleAttr(target, "aria-expanded", attrs);
    }
  }

  if (role === "slider" || role === "spinbutton") {
    const min = numAttr(attrs, "aria-valuemin", -Infinity);
    const max = numAttr(attrs, "aria-valuemax", Infinity);
    const step = numAttr(attrs, "aria-valuestep", 1);
    const current = parseFloat(value ?? "0");
    if (Number.isNaN(current)) return unchanged(target);

    let next: number | null = null;
    if (key === "ArrowUp" || key === "ArrowRight") next = current + step;
    else if (key === "ArrowDown" || key === "ArrowLeft") next = current - step;
    else if (key === "Home") next = min === -Infinity ? current : min;
    else if (key === "End") next = max === Infinity ? current : max;
    else if (key === "PageUp") next = current + step * 10;
    else if (key === "PageDown") next = current - step * 10;

    if (next === null) return unchanged(target);
    next = Math.max(min, Math.min(max, next));
    if (next === current) return unchanged(target);

    const newTarget = { ...target } as Record<string, unknown>;
    newTarget._value = String(next);
    return {
      target: newTarget as Target,
      changed: true,
      changes: [{ attr: "_value", from: value, to: String(next) }],
    };
  }

  if (role === "tab" && (key === "Space" || key === "Enter")) {
    return setAttr(target, "aria-selected", attrs, "true");
  }

  if (role === "radio" && (key === "Space" || key === "Enter")) {
    return setAttr(target, "aria-checked", attrs, "true");
  }

  return unchanged(target);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function readAttrs(target: Target): Record<string, string> {
  return ((target as Record<string, unknown>)._attributeValues as
    Record<string, string> | undefined) ?? {};
}

function readValue(target: Target): string | undefined {
  return (target as Record<string, unknown>)._value as string | undefined;
}

function numAttr(attrs: Record<string, string>, name: string, fallback: number): number {
  const v = attrs[name];
  if (v === undefined) return fallback;
  const n = parseFloat(v);
  return Number.isNaN(n) ? fallback : n;
}

function unchanged(target: Target): ActionResult {
  return { target, changed: false, changes: [] };
}

function toggleAttr(
  target: Target,
  attr: string,
  attrs: Record<string, string>,
  supportsMixed = false,
): ActionResult {
  const current = attrs[attr];
  let next: string;
  if (supportsMixed) {
    // tri-state cycle: false → true → mixed → false
    next = current === "true" ? "mixed" : current === "mixed" ? "false" : "true";
  } else {
    next = current === "true" ? "false" : "true";
  }
  return setAttr(target, attr, attrs, next);
}

function setAttr(
  target: Target,
  attr: string,
  attrs: Record<string, string>,
  value: string,
): ActionResult {
  const current = attrs[attr];
  if (current === value) return unchanged(target);

  const newAttrs = { ...attrs, [attr]: value };
  const newTarget = { ...target } as Record<string, unknown>;
  newTarget._attributeValues = newAttrs;
  return {
    target: newTarget as Target,
    changed: true,
    changes: [{ attr, from: current, to: value }],
  };
}

/**
 * Apply a sequence of keys to a target, returning the final state.
 * Useful for testing patterns that cycle (e.g., tri-state checkbox).
 */
export function simulateSequence(target: Target, keys: Key[]): ActionResult {
  let current = target;
  const allChanges: AttributeChange[] = [];
  let anyChanged = false;
  for (const key of keys) {
    const result = simulateAction(current, key);
    if (result.changed) {
      anyChanged = true;
      allChanges.push(...result.changes);
      current = result.target;
    }
  }
  return { target: current, changed: anyChanged, changes: allChanges };
}
