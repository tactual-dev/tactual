/**
 * Compatibility re-export for trace_path helper tests and public MCP exports.
 * The implementation lives in core so shared pipeline code does not depend on
 * MCP internals.
 */

export {
  findMatchingTargets,
  globToRegex,
  modelAnnouncement,
  SR_ROLE_MAP,
  type TargetMatch,
} from "../core/trace-helpers.js";
