/**
 * Compat re-export. Probe-budget helpers live in src/pipeline/probe-helpers.ts
 * so CLI and MCP share one implementation. Existing imports keep resolving;
 * the legacy `resolveMcpProbeBudgets` / `makeMcpProbingExploreHook` names
 * alias the unified ones.
 */
export {
  resolveProbeBudgets as resolveMcpProbeBudgets,
  makeProbingExploreHook as makeMcpProbingExploreHook,
  type ProbeBudgets,
} from "../pipeline/probe-helpers.js";
