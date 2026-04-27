/**
 * Compat re-export. Probe + inline-validation helpers live under
 * src/pipeline/ so CLI and MCP share one implementation.
 */
export {
  resolveProbeBudgets,
  makeProbingExploreHook,
  type ProbeBudgets,
} from "../../pipeline/probe-helpers.js";
export { runInlineValidation } from "../../pipeline/inline-validation.js";
