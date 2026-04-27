/**
 * ARIA-AT calibration utilities.
 *
 * Compares Tactual's simulator output against ground-truth recordings
 * from the W3C ARIA-AT project (https://aria-at.w3.org). ARIA-AT publishes
 * systematic test results showing what each AT actually announced under
 * each test condition.
 *
 * STATUS: active release check. Tactual ships a curated assertion fixture
 * for `npm run calibrate`; it does not bundle the full upstream ARIA-AT
 * dataset because the source data is large, attribution-sensitive
 * (CC-BY 4.0), and updated independently of Tactual releases.
 *
 * To use:
 *   1. Download ARIA-AT test reports from
 *      https://aria-at.w3.org/test-plans (export each plan's report
 *      as JSON via their API), OR clone the aria-at repo and pull
 *      results from /tests/[pattern]/.
 *   2. Convert to the AriaAtCase[] shape below (one entry per
 *      tested AT command).
 *   3. Call compareSimulatorToAriaAt() to run the comparison.
 *
 * The comparison is heuristic — ARIA-AT records the full output an AT
 * produced for a navigation command (which may include surrounding
 * content). Tactual's simulator produces a single target announcement.
 * We compare by substring containment, not exact match. False positives
 * (Tactual's output contains the expected, but the AT actually said
 * more) are common and fine. False negatives (AT said something Tactual
 * didn't predict) indicate real calibration drift.
 */

import type { Target } from "../core/types.js";
import { buildAnnouncement, type ATKind } from "../playwright/sr-simulator.js";

/**
 * One ARIA-AT test case — what an AT actually said when commanded to
 * read or navigate a specific element.
 */
export interface AriaAtCase {
  /** ARIA pattern under test (e.g., "button", "checkbox", "combobox") */
  pattern: string;
  /** Which AT (NVDA, JAWS, VoiceOver) and version */
  at: ATKind;
  atVersion: string;
  /** Browser and version (e.g., "Firefox 122", "Safari 17") */
  browser: string;
  /** The test command (e.g., "Read element", "Move forward by item") */
  command: string;
  /** What the AT actually said (verbatim, may include surrounding context) */
  actualOutput: string;
  /** A Tactual Target representing the same element under test */
  target: Target;
}

export interface CalibrationMismatch {
  case: AriaAtCase;
  /** What the simulator predicted */
  predicted: string;
  /** Why the comparison failed: 'missing-substring' | 'role-mismatch' | 'state-mismatch' */
  reason: "missing-substring" | "role-mismatch" | "state-mismatch";
  /** Confidence in this being a real mismatch (vs a known limitation) */
  confidence: "high" | "low";
}

export interface CalibrationSummary {
  totalCases: number;
  matched: number;
  mismatched: number;
  byAT: Record<ATKind, { matched: number; mismatched: number }>;
  mismatches: CalibrationMismatch[];
  /** Fraction of cases where the simulator's prediction was found in the actual output */
  coverage: number;
}

/**
 * Compare the simulator's predictions to ARIA-AT recorded output.
 *
 * Returns a summary of where the simulator agrees vs diverges, suitable
 * for surfacing calibration drift before a release.
 */
export function compareSimulatorToAriaAt(cases: AriaAtCase[]): CalibrationSummary {
  const byAT: Record<ATKind, { matched: number; mismatched: number }> = {
    nvda: { matched: 0, mismatched: 0 },
    jaws: { matched: 0, mismatched: 0 },
    voiceover: { matched: 0, mismatched: 0 },
  };
  const mismatches: CalibrationMismatch[] = [];
  let matched = 0;

  for (const c of cases) {
    const predicted = buildAnnouncement(c.target, c.at);
    // Loose comparison: every comma-separated part of predicted output
    // should appear (case-insensitively) somewhere in actual.
    const actualLower = c.actualOutput.toLowerCase();
    const parts = predicted.toLowerCase().split(",").map((p) => p.trim()).filter(Boolean);
    const allFound = parts.every((p) => actualLower.includes(p));

    if (allFound) {
      matched++;
      byAT[c.at].matched++;
    } else {
      const missing = parts.find((p) => !actualLower.includes(p)) ?? "";
      mismatches.push({
        case: c,
        predicted,
        reason: missing.length < 10 ? "state-mismatch" : "role-mismatch",
        confidence: "high",
      });
      byAT[c.at].mismatched++;
    }
  }

  return {
    totalCases: cases.length,
    matched,
    mismatched: cases.length - matched,
    byAT,
    mismatches,
    coverage: cases.length > 0 ? matched / cases.length : 0,
  };
}

/**
 * Format a calibration summary as a human-readable report.
 */
export function formatCalibrationReport(summary: CalibrationSummary): string {
  const lines: string[] = [];
  lines.push("=== ARIA-AT Calibration Report ===");
  lines.push("");
  lines.push(`Total cases: ${summary.totalCases}`);
  lines.push(`Matched: ${summary.matched} (${(summary.coverage * 100).toFixed(1)}%)`);
  lines.push(`Mismatched: ${summary.mismatched}`);
  lines.push("");
  lines.push("By AT:");
  for (const [at, stats] of Object.entries(summary.byAT)) {
    const total = stats.matched + stats.mismatched;
    if (total === 0) continue;
    const pct = total > 0 ? ((stats.matched / total) * 100).toFixed(1) : "n/a";
    lines.push(`  ${at}: ${stats.matched}/${total} (${pct}%)`);
  }
  lines.push("");

  if (summary.mismatches.length > 0) {
    lines.push("Top mismatches (calibration drift):");
    for (const m of summary.mismatches.slice(0, 10)) {
      lines.push("");
      lines.push(`  Pattern: ${m.case.pattern} (${m.case.at} ${m.case.atVersion}, ${m.case.browser})`);
      lines.push(`  Command: ${m.case.command}`);
      lines.push(`  Predicted: ${m.predicted}`);
      lines.push(`  Actual:    ${m.case.actualOutput}`);
      lines.push(`  Reason: ${m.reason}`);
    }
  }

  return lines.join("\n");
}
