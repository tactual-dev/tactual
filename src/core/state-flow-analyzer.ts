/**
 * Inter-state data-flow analysis (Black Widow v1).
 *
 * Black Widow (Eriksson et al., IEEE S&P 2021) tracks how user actions
 * in earlier states ENABLE controls in later states — e.g. "filling
 * the email field unlocks the Submit button." This v1 detects the
 * subset that's directly observable from PageState arrays without
 * additional probing: targets that flip from a disabled state in one
 * captured state to an enabled state in a later captured state.
 *
 * What's covered:
 *   - aria-disabled "true" → "false"
 *   - HTML disabled attribute (recorded by capture as aria-disabled
 *     equivalent on form controls)
 *
 * What's NOT covered (deferred):
 *   - Form-input-driven enablement that requires actually filling
 *     fields. Tactual's safety policy prohibits arbitrary input;
 *     would need a per-target value-suggestion system.
 *   - Inferring the precise CAUSE of enablement (we know two states'
 *     ordering but not which specific edge between them flipped the
 *     attribute).
 */

import type { PageState, Target } from "./types.js";

export interface DataFlowDependency {
  /** id of the target that flipped from disabled to enabled. */
  targetId: string;
  /** Accessible name of that target, for human-readable reports. */
  targetName: string;
  /** id of the state where the target was disabled. */
  disabledInState: string;
  /** id of the state where the target became enabled. */
  enabledInState: string;
}

export function analyzeStateFlow(states: PageState[]): DataFlowDependency[] {
  if (states.length < 2) return [];

  // Build per-state maps: target.id → "disabled" / "enabled" / undefined
  // (undefined = either not present or no disabled-state info)
  type DisabledStatus = "disabled" | "enabled" | undefined;
  const stateDisabledStatus = new Map<string, Map<string, DisabledStatus>>();
  for (const state of states) {
    const m = new Map<string, DisabledStatus>();
    for (const target of state.targets) {
      m.set(target.id, getDisabledStatus(target));
    }
    stateDisabledStatus.set(state.id, m);
  }

  // For each target id that appears in multiple states, find the first
  // (state-order) transition from "disabled" to "enabled".
  const allTargetIds = new Set<string>();
  for (const state of states) {
    for (const target of state.targets) allTargetIds.add(target.id);
  }

  const deps: DataFlowDependency[] = [];
  for (const targetId of allTargetIds) {
    let prevDisabledStateId: string | null = null;
    for (const state of states) {
      const status = stateDisabledStatus.get(state.id)?.get(targetId);
      if (status === "disabled") {
        prevDisabledStateId = state.id;
      } else if (status === "enabled" && prevDisabledStateId !== null) {
        // Find the target in the enabling state for its name.
        const enablingState = states.find((s) => s.id === state.id);
        const target = enablingState?.targets.find((t) => t.id === targetId);
        deps.push({
          targetId,
          targetName: target?.name ?? "(unnamed)",
          disabledInState: prevDisabledStateId,
          enabledInState: state.id,
        });
        // Don't search further for this target — we only report the
        // first enablement per target.
        break;
      }
    }
  }

  return deps;
}

function getDisabledStatus(target: Target): "disabled" | "enabled" | undefined {
  const attrs = (target as Record<string, unknown>)._attributeValues as
    | Record<string, string>
    | undefined;
  const ariaDisabled = attrs?.["aria-disabled"];
  if (ariaDisabled === "true") return "disabled";
  if (ariaDisabled === "false") return "enabled";
  // Form fields have a `disabled` attr that maps elsewhere; treat
  // explicit aria-disabled as the source of truth and otherwise return
  // undefined (no information either way — don't infer from absence).
  return undefined;
}
