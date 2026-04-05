// Tactual — Screen-reader navigation cost analyzer
// Main library entry point

export {
  NavigationGraph,
  buildGraph,
  analyze,
  ScoreVectorSchema,
  TargetKind,
  TargetSchema,
  PageStateSchema,
  NavigationAction,
  EdgeSchema,
  FindingSchema,
  FlowSchema,
  AnalysisResultSchema,
  severityFromScore,
  computeStateSignature,
} from "./core/index.js";

export type {
  AnalyzeOptions,
  GraphNode,
  PathResult,
  ScoreVector,
  SeverityBand,
  Target,
  PageState,
  Edge,
  Finding,
  Flow,
  AnalysisResult,
} from "./core/index.js";

export {
  registerProfile,
  getProfile,
  listProfiles,
  genericMobileWebSrV0,
  voiceoverIosV0,
  talkbackAndroidV0,
  nvdaDesktopV0,
  jawsDesktopV0,
} from "./profiles/index.js";

export type { ATProfile, CostModifier, CostCondition } from "./profiles/index.js";

export { computeScores, scoreSeverity } from "./scoring/index.js";
export { computeInteropRisk, roleInteropRisk, attributeInteropRisk } from "./scoring/interop.js";

export { formatReport } from "./reporters/index.js";
export type { ReportFormat } from "./reporters/index.js";

export { builtinRules } from "./rules/index.js";
export type { Rule, RuleContext, RuleResult } from "./rules/index.js";
