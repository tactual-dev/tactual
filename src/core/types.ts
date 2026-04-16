import { z } from "zod";

// ---------------------------------------------------------------------------
// Score vector
// ---------------------------------------------------------------------------

export const ScoreVectorSchema = z.object({
  discoverability: z.number().min(0).max(100),
  reachability: z.number().min(0).max(100),
  operability: z.number().min(0).max(100),
  recovery: z.number().min(0).max(100),
  interopRisk: z.number().min(0).max(100),
  overall: z.number().min(0).max(100),
}).passthrough();

export type ScoreVector = z.infer<typeof ScoreVectorSchema>;

export type SeverityBand = "strong" | "acceptable" | "moderate" | "high" | "severe";

export function severityFromScore(score: number): SeverityBand {
  if (score >= 90) return "strong";
  if (score >= 75) return "acceptable";
  if (score >= 60) return "moderate";
  if (score >= 40) return "high";
  return "severe";
}

// ---------------------------------------------------------------------------
// Targets — meaningful objects a user wants to discover or operate
// ---------------------------------------------------------------------------

export const TargetKind = z.enum([
  "landmark",
  "heading",
  "link",
  "button",
  "menuTrigger",
  "menuItem",
  "tab",
  "tabPanel",
  "dialog",
  "formField",
  "errorMessage",
  "statusMessage",
  "search",
  "pagination",
  "disclosure",
  "other",
]);

// eslint-disable-next-line no-redeclare
export type TargetKind = z.infer<typeof TargetKind>;

/** Kinds that participate in control/Tab navigation (shared between graph-builder and finding-builder) */
export const CONTROL_KINDS: ReadonlySet<string> = new Set(["button", "link", "formField", "menuTrigger", "tab", "search"]);

export const TargetSchema = z.object({
  id: z.string(),
  kind: TargetKind,
  role: z.string(),
  name: z.string(),
  description: z.string().optional(),
  /** DOM selector for relocating the element */
  selector: z.string().optional(),
  /** Whether the target is only reachable after opening a hidden branch */
  requiresBranchOpen: z.boolean().default(false),
  /** The heading level if kind === "heading" */
  headingLevel: z.number().min(1).max(6).optional(),
}).passthrough();

export type Target = z.infer<typeof TargetSchema>;

// ---------------------------------------------------------------------------
// Page state — a snapshot of the page at a point in time
// ---------------------------------------------------------------------------

export const PageStateSchema = z.object({
  id: z.string(),
  url: z.string(),
  /** Normalized route or path (without query/hash) */
  route: z.string(),
  /** Device descriptor used during capture */
  device: z.string().optional(),
  /** Viewport dimensions */
  viewport: z.object({ width: z.number(), height: z.number() }).optional(),
  /** Accessibility snapshot hash for dedup */
  snapshotHash: z.string(),
  /** Hash of visible interactive elements */
  interactiveHash: z.string(),
  /** List of currently open overlays (dialog IDs, menu IDs, etc.) */
  openOverlays: z.array(z.string()).default([]),
  /** Targets available in this state */
  targets: z.array(TargetSchema),
  /** Timestamp of capture */
  timestamp: z.number(),
  /** How this state was reached */
  provenance: z.enum(["scripted", "explored", "crawled"]),
}).passthrough();

export type PageState = z.infer<typeof PageStateSchema>;

// ---------------------------------------------------------------------------
// State signature — for deduplication
// ---------------------------------------------------------------------------

export interface StateSignature {
  route: string;
  snapshotHash: string;
  interactiveHash: string;
  openOverlays: string[];
}

export function computeStateSignature(state: PageState): string {
  const sig: StateSignature = {
    route: state.route,
    snapshotHash: state.snapshotHash,
    interactiveHash: state.interactiveHash,
    openOverlays: [...state.openOverlays].sort(),
  };
  return JSON.stringify(sig);
}

// ---------------------------------------------------------------------------
// Navigation actions — how a user moves between states/targets
// ---------------------------------------------------------------------------

export const NavigationAction = z.enum([
  "nextItem",
  "previousItem",
  "nextHeading",
  "nextLink",
  "nextControl",
  "activate",
  "dismiss",
  "back",
  "find",
  "groupEntry",
  "groupExit",
  /** First-letter type-ahead in focused menus (desktop AT only) */
  "firstLetter",
]);

// eslint-disable-next-line no-redeclare
export type NavigationAction = z.infer<typeof NavigationAction>;

// ---------------------------------------------------------------------------
// Edge — a weighted action connecting states or targets
// ---------------------------------------------------------------------------

export const EdgeSchema = z.object({
  id: z.string(),
  from: z.string(),
  to: z.string(),
  action: NavigationAction,
  /** Cost of this action under the active profile */
  cost: z.number().min(0),
  /** Human-readable reason for the cost */
  reason: z.string().optional(),
  /** Confidence in this edge's accuracy (0-1) */
  confidence: z.number().min(0).max(1).default(1),
  /** Profile under which this edge was computed */
  profile: z.string(),
}).passthrough();

export type Edge = z.infer<typeof EdgeSchema>;

// ---------------------------------------------------------------------------
// Finding — a scored result for a target under a profile
// ---------------------------------------------------------------------------

export const FindingSchema = z.object({
  targetId: z.string(),
  /** Playwright-style locator for the target element (e.g., getByRole('button', { name: 'Submit' })) */
  selector: z.string().optional(),
  profile: z.string(),
  scores: ScoreVectorSchema,
  severity: z.enum(["strong", "acceptable", "moderate", "high", "severe"]),
  /** How an LLM should act: "code-fix" (targeted change), "pattern-review" (consider alternatives), "structural" (reorganize) */
  actionType: z.enum(["code-fix", "pattern-review", "structural"]).optional(),
  bestPath: z.array(z.string()),
  alternatePaths: z.array(z.array(z.string())),
  penalties: z.array(z.string()),
  suggestedFixes: z.array(z.string()),
  confidence: z.number().min(0).max(1),
}).passthrough();

export type Finding = z.infer<typeof FindingSchema>;

// ---------------------------------------------------------------------------
// Flow — an ordered sequence of states from a scripted scenario
// ---------------------------------------------------------------------------

export const FlowSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().optional(),
  states: z.array(z.string()),
  profile: z.string(),
  timestamp: z.number(),
}).passthrough();

export type Flow = z.infer<typeof FlowSchema>;

// ---------------------------------------------------------------------------
// Analysis result — the full output of an analysis run
// ---------------------------------------------------------------------------

export const DiagnosticSchema = z.object({
  level: z.enum(["info", "warning", "error"]),
  code: z.string(),
  message: z.string(),
});

export const AnalysisResultSchema = z.object({
  flow: FlowSchema,
  states: z.array(PageStateSchema),
  findings: z.array(FindingSchema),
  diagnostics: z.array(DiagnosticSchema).default([]),
  metadata: z.object({
    version: z.string(),
    profile: z.string(),
    duration: z.number(),
    stateCount: z.number(),
    targetCount: z.number(),
    findingCount: z.number(),
    edgeCount: z.number(),
    matchingTargets: z.number().optional(),
  }).passthrough(),
}).passthrough();

export type AnalysisResult = z.infer<typeof AnalysisResultSchema>;
