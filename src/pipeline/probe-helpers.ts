/**
 * Probe-budget resolver + explore-reveal hook.
 *
 * Shared by the analyze-url pipeline across CLI and MCP so probe budgets
 * behave consistently on the initial page and revealed exploration states.
 */

import type { Page } from "playwright";
import type { PageState } from "../core/types.js";
import { globToRegex } from "../core/glob.js";

/**
 * Per-layer probe budgets shared between the initial probe call and the
 * onStateRevealed hook. Mutated in place as probes consume budget — callers
 * pass the SAME object to both sites so total probe work across initial
 * and revealed states respects the user-specified cap.
 */
export interface ProbeBudgets {
  generic: number;
  menu: number;
  modal: number;
  widget: number;
}

export type ProbeStrategy =
  | "all"
  | "overlay"
  | "composite-widget"
  | "form"
  | "navigation"
  | "modal-return-focus"
  | "menu-pattern";

export interface ProbeRunOptions {
  /** Target IDs to probe, typically the delta revealed by exploration or entry activation. */
  targetIds?: Set<string>;
  /** CSS selectors that bound DOM-first probes. */
  scopeSelector?: string[];
  /** CSS selectors that narrow probing without changing the scored capture. */
  probeSelector?: string[];
  /** Exact-ish target/selector/name hint. */
  goalTarget?: string;
  /** Glob pattern matched against target id/name/role/kind/selector. */
  goalPattern?: string;
  /** Which invariant family to spend budget on. */
  strategy?: ProbeStrategy;
  /** Optional time/budget guard used by exploration hooks. */
  shouldContinue?: () => boolean;
}

export interface ProbingExploreHookOptions {
  /** Minimum remaining exploration budget before starting another probe family. */
  minRemainingMs?: number;
  /** Probe filters/strategy shared with the initial probe pass. */
  runOptions?: ProbeRunOptions;
}

const PRESETS: Record<"fast" | "standard" | "deep", ProbeBudgets> = {
  fast: { generic: 5, menu: 5, modal: 3, widget: 5 },
  standard: { generic: 20, menu: 20, modal: 10, widget: 20 },
  deep: { generic: 50, menu: 40, modal: 20, widget: 40 },
};

/**
 * Resolve per-layer probe budgets from probeMode + optional generic
 * override. Layered because probeTargets, probeMenuPatterns, and
 * probeModalDialogs each consume very different amounts of time per
 * target; a single "budget" knob forced all three to share or run
 * unbounded. Explicit override applies only to the generic layer.
 */
export function resolveProbeBudgets(
  mode: "fast" | "standard" | "deep" | string | undefined,
  genericOverride: number | undefined,
): ProbeBudgets {
  const key = (mode ?? "standard").toLowerCase() as keyof typeof PRESETS;
  const preset = PRESETS[key] ?? PRESETS.standard;
  return {
    generic: genericOverride ?? preset.generic,
    menu: preset.menu,
    modal: preset.modal,
    widget: preset.widget,
  };
}

export function countWidgetProbeResults(targets: PageState["targets"]): number {
  const keys = [
    "_tabProbe",
    "_disclosureProbe",
    "_comboboxProbe",
    "_listboxProbe",
    "_formErrorProbe",
  ];
  return targets.reduce((sum, target) => {
    const record = target as Record<string, unknown>;
    return sum + keys.filter((key) => record[key]).length;
  }, 0);
}

export async function runProbeFamilies(
  page: Page,
  targets: PageState["targets"],
  remaining: ProbeBudgets,
  options: ProbeRunOptions = {},
): Promise<PageState["targets"]> {
  const canRun = () => options.shouldContinue?.() ?? true;
  const selectedTargets = await selectTargets(page, targets, options);
  if (selectedTargets.length === 0 || !canRun()) return targets;

  const selectedIds = new Set(selectedTargets.map((t) => t.id));
  const targeted =
    Boolean(options.targetIds?.size) ||
    Boolean(options.probeSelector?.length) ||
    Boolean(options.goalTarget) ||
    Boolean(options.goalPattern);

  let result = mergeSelectedTargets(targets, selectedTargets);
  const beforeGeneric = remaining.generic;

  if (remaining.generic > 0 && shouldRunStrategy(options.strategy, "generic") && canRun()) {
    const { probeTargets } = await import("../playwright/probes.js");
    const probed = await probeTargets(page, selectedTargets, remaining.generic);
    const genericProbed = probed.filter((t) => (t as Record<string, unknown>)._probe).length;
    remaining.generic = Math.max(0, beforeGeneric - genericProbed);
    result = mergeSelectedTargets(result, probed);
  }

  if (remaining.menu > 0 && shouldRunStrategy(options.strategy, "menu") && canRun()) {
    const { probeMenuPatterns } = await import("../playwright/menu-probe.js");
    const before = result.filter((t) => (t as Record<string, unknown>)._menuProbe).length;
    result = await probeMenuPatterns(page, result, remaining.menu, {
      scopeSelector: mergedScopeSelectors(options),
      targetIds: selectedIds,
    });
    const after = result.filter((t) => (t as Record<string, unknown>)._menuProbe).length;
    remaining.menu = Math.max(0, remaining.menu - Math.max(0, after - before));
  }

  if (remaining.modal > 0 && shouldRunStrategy(options.strategy, "modal-trigger") && canRun()) {
    const { probeModalTriggers } = await import("../playwright/modal-trigger-probe.js");
    const before = result.filter((t) => (t as Record<string, unknown>)._modalTriggerProbe).length;
    result = await probeModalTriggers(page, result, remaining.modal, {
      scopeSelector: mergedScopeSelectors(options),
      targetIds: selectedIds,
    });
    const after = result.filter((t) => (t as Record<string, unknown>)._modalTriggerProbe).length;
    remaining.modal = Math.max(0, remaining.modal - Math.max(0, after - before));
  }

  if (
    remaining.modal > 0 &&
    shouldRunStrategy(options.strategy, "modal-dialog") &&
    canRun() &&
    (!targeted || selectedTargets.some((t) => isDialogRole(t.role)))
  ) {
    const { probeModalDialogs } = await import("../playwright/modal-probe.js");
    const before = result.filter((t) => (t as Record<string, unknown>)._modalProbe).length;
    result = await probeModalDialogs(page, result, remaining.modal, {
      scopeSelector: mergedScopeSelectors(options),
      targetIds: selectedIds,
      allowSynthetic: !targeted,
    });
    const after = result.filter((t) => (t as Record<string, unknown>)._modalProbe).length;
    remaining.modal = Math.max(0, remaining.modal - Math.max(0, after - before));
  }

  let widgetProbeCount = countWidgetProbeResults(result);
  if (remaining.widget > 0 && shouldRunStrategy(options.strategy, "tab-disclosure") && canRun()) {
    const { probeTabAndDisclosurePatterns } = await import("../playwright/widget-probe.js");
    result = await probeTabAndDisclosurePatterns(page, result, remaining.widget, {
      scopeSelector: mergedScopeSelectors(options),
      targetIds: selectedIds,
    });
    const n = countWidgetProbeResults(result) - widgetProbeCount;
    remaining.widget = Math.max(0, remaining.widget - n);
    widgetProbeCount += n;
  }
  if (remaining.widget > 0 && shouldRunStrategy(options.strategy, "combo-listbox") && canRun()) {
    const { probeComboListboxContracts } = await import("../playwright/composite-widget-probe.js");
    const probed = await probeComboListboxContracts(page, result, remaining.widget, {
      scopeSelector: mergedScopeSelectors(options),
      targetIds: selectedIds,
    });
    result = mergeSelectedTargets(result, probed);
    const n = countWidgetProbeResults(result) - widgetProbeCount;
    remaining.widget = Math.max(0, remaining.widget - n);
    widgetProbeCount += n;
  }
  if (remaining.widget > 0 && shouldRunStrategy(options.strategy, "form-error") && canRun()) {
    const { probeFormErrorFlows } = await import("../playwright/form-error-probe.js");
    const probed = await probeFormErrorFlows(page, result, remaining.widget, {
      scopeSelector: mergedScopeSelectors(options),
      targetIds: selectedIds,
    });
    result = mergeSelectedTargets(result, probed);
    const n = countWidgetProbeResults(result) - widgetProbeCount;
    remaining.widget = Math.max(0, remaining.widget - n);
  }

  return result;
}

/**
 * Build an onStateRevealed hook for the explorer that probes newly-
 * revealed targets against the live page. `remaining` is shared with the
 * initial probe call so total probe work across initial + all revealed
 * states stays under the user-specified caps.
 *
 * Probes ONLY the new-delta targets (those that first appeared in this
 * state). Initial-state targets are probed before explore starts, so
 * re-probing them in each revealed state would waste budget.
 */
export function makeProbingExploreHook(
  remaining: ProbeBudgets,
  options: ProbingExploreHookOptions = {},
): (
  state: PageState,
  newIds: Set<string>,
  page: Page,
  budget?: { remainingMs: () => number },
) => Promise<PageState> {
  const minRemainingMs = options.minRemainingMs ?? 5000;

  return async (state, newIds, page, budget?: { remainingMs: () => number }) => {
    const hasTime = () => budget === undefined || budget.remainingMs() > minRemainingMs;
    if (
      remaining.generic <= 0 &&
      remaining.menu <= 0 &&
      remaining.modal <= 0 &&
      remaining.widget <= 0
    ) {
      return state;
    }
    if (!hasTime()) return state;

    const revealBudget: ProbeBudgets = {
      generic: Math.min(remaining.generic, 3),
      menu: Math.min(remaining.menu, 2),
      modal: Math.min(remaining.modal, 1),
      widget: Math.min(remaining.widget, 3),
    };
    const beforeReveal = { ...revealBudget };
    const probed = hasTime()
      ? await runProbeFamilies(page, state.targets, revealBudget, {
          ...options.runOptions,
          targetIds: newIds,
          shouldContinue: hasTime,
        })
      : state.targets;
    remaining.generic = Math.max(
      0,
      remaining.generic - (beforeReveal.generic - revealBudget.generic),
    );
    remaining.menu = Math.max(0, remaining.menu - (beforeReveal.menu - revealBudget.menu));
    remaining.modal = Math.max(0, remaining.modal - (beforeReveal.modal - revealBudget.modal));
    remaining.widget = Math.max(0, remaining.widget - (beforeReveal.widget - revealBudget.widget));
    const probedById = new Map(probed.map((t) => [t.id, t]));
    const syntheticFromProbe = probed.filter(
      (t) => !state.targets.some((base) => base.id === t.id),
    );
    const mergedTargets = state.targets.map((t) => probedById.get(t.id) ?? t);
    return { ...state, targets: [...mergedTargets, ...syntheticFromProbe] };
  };
}

async function selectTargets(
  page: Page,
  targets: PageState["targets"],
  options: ProbeRunOptions,
): Promise<PageState["targets"]> {
  let selected = targets;
  if (options.targetIds) selected = selected.filter((t) => options.targetIds!.has(t.id));
  if (options.goalTarget) {
    const needle = options.goalTarget.trim().toLowerCase();
    selected = selected.filter((t) => exactishMatch(t, needle));
  }
  if (options.goalPattern) {
    const re = globToRegex(options.goalPattern);
    selected = selected.filter((t) => targetSearchFields(t).some((field) => re.test(field)));
  }
  if (options.probeSelector && options.probeSelector.length > 0) {
    const scoped: PageState["targets"] = [];
    for (const target of selected) {
      if (await targetMatchesCssScope(page, target, options.probeSelector)) scoped.push(target);
    }
    selected = scoped;
  }

  const { prioritizeTargetsForProbing } = await import("../playwright/probes.js");
  return prioritizeTargetsForProbing(selected);
}

function shouldRunStrategy(
  strategy: ProbeStrategy | undefined,
  family:
    | "generic"
    | "menu"
    | "modal-trigger"
    | "modal-dialog"
    | "tab-disclosure"
    | "combo-listbox"
    | "form-error",
): boolean {
  const s = strategy ?? "all";
  if (s === "all") return true;
  if (s === "overlay") {
    return (
      family === "generic" ||
      family === "menu" ||
      family === "modal-trigger" ||
      family === "modal-dialog" ||
      family === "tab-disclosure"
    );
  }
  if (s === "navigation") {
    return family === "generic" || family === "menu" || family === "tab-disclosure";
  }
  if (s === "composite-widget") {
    return family === "tab-disclosure" || family === "combo-listbox";
  }
  if (s === "form") return family === "form-error";
  if (s === "modal-return-focus") return family === "modal-trigger" || family === "modal-dialog";
  if (s === "menu-pattern") return family === "menu";
  return true;
}

function mergeSelectedTargets(
  allTargets: PageState["targets"],
  selectedTargets: PageState["targets"],
): PageState["targets"] {
  const byId = new Map(selectedTargets.map((target) => [target.id, target]));
  const synthetic = selectedTargets.filter(
    (target) => !allTargets.some((base) => base.id === target.id),
  );
  return [...allTargets.map((target) => byId.get(target.id) ?? target), ...synthetic];
}

function mergedScopeSelectors(options: ProbeRunOptions): string[] | undefined {
  const selectors = [...(options.scopeSelector ?? []), ...(options.probeSelector ?? [])];
  return selectors.length > 0 ? selectors : undefined;
}

function exactishMatch(target: PageState["targets"][number], needle: string): boolean {
  return targetSearchFields(target).some(
    (field) => field.toLowerCase() === needle || field.toLowerCase().includes(needle),
  );
}

function targetSearchFields(target: PageState["targets"][number]): string[] {
  return [target.id, target.name ?? "", target.role ?? "", target.kind, target.selector ?? ""];
}

async function targetMatchesCssScope(
  page: Page,
  target: PageState["targets"][number],
  selectors: string[],
): Promise<boolean> {
  const locator = target.name
    ? page.getByRole(target.role as Parameters<Page["getByRole"]>[0], {
        name: target.name,
      })
    : page.locator(`[role="${target.role}"]`).first();

  return await locator
    .first()
    .evaluate((el: Element, scopeSelectors: string[]) => {
      const scopes = scopeSelectors.flatMap((selector) =>
        Array.from(document.querySelectorAll(selector)),
      );
      if (scopes.length === 0) return false;
      return scopes.some((scope) => scope === el || scope.contains(el) || el.contains(scope));
    }, selectors)
    .catch(() => false);
}

function isDialogRole(role: string | undefined): boolean {
  const r = role?.toLowerCase();
  return r === "dialog" || r === "alertdialog";
}
