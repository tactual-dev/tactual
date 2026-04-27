import type { NavigationAction } from "../core/types.js";

/**
 * An assistive-technology profile defines:
 * - Which navigation actions are available
 * - The base cost of each action
 * - Modifiers that adjust costs in context
 */
export interface ATProfile {
  /** Unique profile identifier */
  id: string;
  /** Human-readable name */
  name: string;
  /** Profile description */
  description: string;
  /** Platform this profile targets */
  platform: "mobile" | "desktop" | "generic";

  /** Base cost for each navigation action (1 = one atomic action) */
  actionCosts: Record<NavigationAction, number>;

  /** Score weights for composite calculation */
  weights: {
    discoverability: number;
    reachability: number;
    operability: number;
    recovery: number;
  };

  /**
   * Reachability cost sensitivity (default: 1.0).
   *
   * Scales the decay coefficient in the reachability formula.
   * Higher values make the score drop faster as path cost increases.
   * Mobile SRs should use values > 1.0 (swiping is tedious),
   * desktop SRs with quick keys should use values < 1.0.
   */
  costSensitivity?: number;

  /** Cost modifiers applied in specific contexts */
  modifiers: CostModifier[];

  /**
   * Visual modes the profile wants captured per page (light/dark × forced-colors).
   *
   * When set and the user hasn't disabled visibility checks, the analyzer
   * re-emulates each mode after capture and samples per-icon contrast against
   * ancestor backgrounds. Findings flag icons that render invisible (contrast
   * <1.5:1) or low-contrast (<3.0:1) under any declared mode.
   *
   * Desktop AT profiles typically declare the full 4-cell matrix because
   * Windows users frequently run High Contrast Mode in dark scheme — the
   * combination where author `fill="#000"` SVGs become invisible. Mobile
   * profiles leave this off.
   */
  visualModes?: VisualMode[];
}

/** A single (color-scheme, forced-colors) combination to capture. */
export interface VisualMode {
  colorScheme: "light" | "dark";
  forcedColors: "active" | "none";
}

export interface CostModifier {
  /** What this modifier applies to */
  condition: CostCondition;
  /** Multiplier applied to the base action cost */
  multiplier: number;
  /** Human-readable explanation */
  reason: string;
}

export type CostCondition =
  /** Target is hidden behind a menu/dialog/disclosure */
  | { type: "hiddenBranch" }
  /** User must pass through N unrelated items */
  | { type: "unrelatedContentTax"; minItems: number }
  /** A context switch occurs (e.g., dialog opens, tab changes) */
  | { type: "contextSwitch" }
  /** User must switch navigation mode */
  | { type: "modeSwitch" }
  /** Target lacks a heading or landmark anchor */
  | { type: "noStructuralAnchor" }
  /** Focus is trapped or lost */
  | { type: "focusTrap" };
