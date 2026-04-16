import type { AnalysisResult } from "../core/types.js";
import { summarize } from "./summarize.js";

/**
 * JSON output — compact summarized format.
 *
 * Instead of dumping the full AnalysisResult (which can be 300KB+ for
 * large pages), outputs a summarized object:
 *
 * - Stats: severity counts, average/worst/best scores
 * - Issue groups: common problems grouped with counts
 * - Detailed findings: worst 15 only
 * - Diagnostics: errors and warnings only
 *
 * This keeps JSON output under ~20KB for most pages, making it
 * usable in LLM context windows.
 */
export function formatJSON(result: AnalysisResult, options?: { maxDetailedFindings?: number }): string {
  const summary = summarize(result, options);
  return JSON.stringify(summary, null, 2);
}
