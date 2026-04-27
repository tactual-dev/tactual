/**
 * Classify per-icon visibility records into finding tiers and derive
 * operability-input flags. Called by finding-penalties.ts (to emit
 * penalties) and finding-scoring.ts (to cap operability scores).
 *
 * The `_visibility` passthrough field on each Target is populated by
 * `collectVisibility` in `playwright/visibility-probe.ts` when the
 * active profile declares `visualModes` and the user hasn't disabled
 * the check.
 *
 * Four tiers:
 *   - `invisible` — contrast <1.5:1 against ancestor background. Hard
 *     operability cap at 60.
 *   - `decorative` — same contrast, but the control also has a visible
 *     text label. Severity downgraded one tier; label still identifies
 *     the control.
 *   - `low` — 1.5 ≤ contrast < 3.0. Soft operability deduction, below
 *     WCAG 1.4.11 non-text 3:1 threshold.
 *   - `hcm-substitution-risk` — contrast ≥ 3.0 in forced-colors-active
 *     mode, but the fill is an author-set non-system literal. Playwright
 *     reads the author color; real Windows HCM may substitute at the
 *     OS-paint level. Small operability deduction with a "verify in
 *     real Edge" fix hint.
 *
 * Skip cases (no finding emitted):
 *   - hidden icons (display:none, visibility:hidden, ~0 opacity, 0 area)
 *   - author opt-out via `forced-color-adjust: none`
 *   - fill attribute is `currentColor` / a system color / `none`
 *   - computed `fill === color` (CSS-applied currentColor; HCM-safe)
 */

import type { Target } from "./types.js";
import type { VisibilityRecord } from "../playwright/visibility-probe.js";
import {
  parseColor,
  isSystemColor,
  isCurrentColor,
  contrastRatio,
  compositeOver,
} from "./contrast.js";

export type VisibilityTier =
  | "invisible"
  | "decorative"
  | "low"
  | "hcm-substitution-risk";

export function classifyVisibility(
  r: VisibilityRecord,
): { tier: VisibilityTier; ratio: number } | null {
  if (r.hidden) return null;
  if (r.forcedColorAdjust === "none") return null;
  if (r.fillAttr) {
    if (isCurrentColor(r.fillAttr)) return null;
    if (isSystemColor(r.fillAttr)) return null;
    if (r.fillAttr.trim().toLowerCase() === "none") return null;
  }
  if (r.fill === r.color) return null;

  const fg = parseColor(r.fill);
  const bg = parseColor(r.bgColor);
  if (!fg || !bg) return null;

  const composedFg = fg.a < 1 ? compositeOver(fg, bg) : fg;
  const ratio = contrastRatio(composedFg, bg);

  if (ratio < 1.5) {
    return { tier: r.hasTextLabel ? "decorative" : "invisible", ratio };
  }
  if (ratio < 3.0) {
    if (r.hasTextLabel) return null;
    return { tier: "low", ratio };
  }
  // ratio ≥ 3.0 — Playwright contrast looks fine, but in forced-colors-active
  // mode the fill is author-set (we passed the currentColor / system-color
  // / cascade checks above), so real Windows HCM may substitute at paint
  // time regardless of what Chromium computed. Flag as substitution risk
  // so the user verifies in real Edge rather than trusting the screenshot.
  if (r.mode.forcedColors === "active") {
    return { tier: "hcm-substitution-risk", ratio };
  }
  return null;
}

/**
 * Aggregate per-record classifications into operability-input flags.
 * Tier priority for scoring: invisible > low/decorative > hcm-substitution-risk.
 */
export function summarizeVisibility(target: Target): {
  iconInvisibleUnderHCM?: boolean;
  iconLowContrast?: boolean;
  iconHCMSubstitutionRisk?: boolean;
} {
  const records = (target as Record<string, unknown>)._visibility as
    | VisibilityRecord[]
    | undefined;
  if (!records || records.length === 0) return {};
  let invisible = false;
  let soft = false;
  let risk = false;
  for (const r of records) {
    const c = classifyVisibility(r);
    if (!c) continue;
    if (c.tier === "invisible") invisible = true;
    else if (c.tier === "decorative" || c.tier === "low") soft = true;
    else if (c.tier === "hcm-substitution-risk") risk = true;
  }
  return {
    iconInvisibleUnderHCM: invisible || undefined,
    iconLowContrast: !invisible && soft ? true : undefined,
    iconHCMSubstitutionRisk:
      !invisible && !soft && risk ? true : undefined,
  };
}

export function detectVisibilityPenalties(target: Target): {
  penalties: string[];
  suggestedFixes: string[];
} {
  const records = (target as Record<string, unknown>)._visibility as
    | VisibilityRecord[]
    | undefined;
  if (!records || records.length === 0) {
    return { penalties: [], suggestedFixes: [] };
  }

  const penalties: string[] = [];
  const seenKey = new Set<string>();
  let needsFix = false;

  for (const r of records) {
    const c = classifyVisibility(r);
    if (!c) continue;
    const modeLabel = `${r.mode.colorScheme}/${
      r.mode.forcedColors === "active" ? "forced-colors" : "no-forced-colors"
    }`;
    // Dedupe per (mode, tier) so an opblock with three identical black
    // chevrons emits one finding per affected mode, not three.
    const key = `${modeLabel}|${c.tier}`;
    if (seenKey.has(key)) continue;
    seenKey.add(key);

    if (c.tier === "invisible") {
      penalties.push(
        `Icon invisible in ${modeLabel} (contrast ${c.ratio.toFixed(2)}:1)`,
      );
    } else if (c.tier === "decorative") {
      penalties.push(
        `Decorative icon invisible in ${modeLabel} (contrast ${c.ratio.toFixed(2)}:1) — ` +
          `adjacent text label remains visible, so the control is still identifiable.`,
      );
    } else if (c.tier === "low") {
      penalties.push(
        `Low icon contrast in ${modeLabel} (ratio ${c.ratio.toFixed(2)}:1)`,
      );
    } else {
      penalties.push(
        `Author-set SVG fill in ${modeLabel} (Playwright contrast ${c.ratio.toFixed(2)}:1) — ` +
          `non-system literals may render unpredictably across user HCM themes. ` +
          `Verify in real Edge with HCM enabled.`,
      );
    }
    needsFix = true;
  }

  const suggestedFixes = needsFix
    ? [
        'Replace hardcoded SVG fill (e.g., fill="#000") with fill="currentColor" ' +
          "or a system color (ButtonText, CanvasText). Hardcoded literals survive " +
          "Chromium's `forced-color-adjust: preserve-parent-color` default for SVG, " +
          "leaving icons invisible against HCM-substituted backgrounds.",
      ]
    : [];

  return { penalties, suggestedFixes };
}
