import type { AnalysisResult } from "../core/types.js";

/**
 * A benchmark case defines an expected outcome for analysis.
 */
export interface BenchmarkCase {
  /** Unique case identifier */
  id: string;
  /** Human-readable name */
  name: string;
  /** Description of what this case validates */
  description: string;
  /** Source to analyze */
  source: BenchmarkSource;
  /** AT profile to use */
  profile: string;
  /** Whether to run exploration */
  explore?: boolean;
  /** Assertions to validate against the result */
  assertions: BenchmarkAssertion[];
}

export type BenchmarkSource =
  | { type: "file"; path: string }
  | { type: "url"; url: string };

export type BenchmarkAssertion =
  /** Average overall score must be in range */
  | { type: "averageScoreInRange"; min: number; max: number }
  /** Total target count must be in range */
  | { type: "targetCountInRange"; min: number; max: number }
  /** No findings should have severity worse than this */
  | { type: "noSeverityWorseThan"; severity: "strong" | "acceptable" | "moderate" | "high" | "severe" }
  /** At least N findings must have this severity or better */
  | { type: "minFindingsAtSeverity"; severity: "strong" | "acceptable" | "moderate" | "high" | "severe"; count: number }
  /** Must find targets of specific kinds */
  | { type: "hasTargetKinds"; kinds: string[] }
  /** Edge count must be positive (graph was built) */
  | { type: "hasEdges" }
  /** Specific targets with names matching pattern must exist */
  | { type: "hasTargetWithName"; pattern: string };

/**
 * A comparison benchmark verifies relative ordering between two cases.
 */
export interface BenchmarkComparison {
  id: string;
  name: string;
  description: string;
  /** The case expected to score higher (or have more targets) */
  better: string;
  /** The case expected to score lower (or have fewer targets) */
  worse: string;
  /** Minimum score gap expected */
  minGap?: number;
  /** Compare target counts instead of average scores */
  compareBy?: "score" | "targetCount";
}

export interface BenchmarkSuite {
  name: string;
  description: string;
  cases: BenchmarkCase[];
  comparisons: BenchmarkComparison[];
}

export interface BenchmarkCaseResult {
  caseId: string;
  caseName: string;
  passed: boolean;
  analysis: AnalysisResult | null;
  assertionResults: AssertionResult[];
  error?: string;
  durationMs: number;
}

export interface AssertionResult {
  assertion: BenchmarkAssertion;
  passed: boolean;
  message: string;
}

export interface BenchmarkComparisonResult {
  comparisonId: string;
  comparisonName: string;
  passed: boolean;
  betterScore: number;
  worseScore: number;
  gap: number;
  message: string;
}

export interface BenchmarkSuiteResult {
  suiteName: string;
  cases: BenchmarkCaseResult[];
  comparisons: BenchmarkComparisonResult[];
  totalPassed: number;
  totalFailed: number;
  durationMs: number;
}
