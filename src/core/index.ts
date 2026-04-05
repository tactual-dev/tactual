export { NavigationGraph } from "./graph.js";
export type { GraphNode, PathResult } from "./graph.js";
export { buildGraph } from "./graph-builder.js";
export { analyze } from "./analyzer.js";
export type { AnalyzeOptions } from "./analyzer.js";
export { buildFinding } from "./finding-builder.js";
export { diagnoseCapture, hasBlockingDiagnostic } from "./diagnostics.js";
export {
  filterTargets,
  filterFindings,
  filterDiagnostics,
  checkThreshold,
} from "./filter.js";
export type { AnalysisFilter } from "./filter.js";
export type { CaptureDiagnostic, DiagnosticCode } from "./diagnostics.js";
export {
  collectEntryPoints,
  computePathsFromEntries,
  computeAlternatePaths,
  findNearestHeading,
  findNearestLandmark,
  formatPath,
  median,
} from "./path-analysis.js";
export {
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
} from "./types.js";
export type {
  ScoreVector,
  SeverityBand,
  Target,
  PageState,
  StateSignature,
  Edge,
  Finding,
  Flow,
  AnalysisResult,
} from "./types.js";
