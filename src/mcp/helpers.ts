/**
 * Shared helpers for MCP tool handlers.
 *
 * Kept as a thin compatibility re-export; the reusable extraction and
 * deduplication logic lives in core so CLI and pipeline layers do not import
 * from MCP.
 */

export {
  deduplicateFindings,
  extractFindings,
  getOverallScore,
  type NormalizedFinding,
} from "../core/result-extraction.js";
