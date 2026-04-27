import { listProfiles } from "../../profiles/index.js";
import { formatReport, type ReportFormat } from "../../reporters/index.js";
import { summarize } from "../../reporters/summarize.js";
import { runAnalyzeUrl, AnalyzeUrlError } from "../../pipeline/analyze-url.js";
import { deduplicateFindings } from "../helpers.js";

interface AnalyzeUrlToolInput {
  url: string;
  profile?: string;
  device?: string;
  explore?: boolean;
  exploreDepth?: number;
  exploreBudget?: number;
  exploreTimeout?: number;
  exploreMaxTargets?: number;
  allowAction?: string[];
  format?: ReportFormat;
  minSeverity?: "severe" | "high" | "moderate" | "acceptable" | "strong";
  waitForSelector?: string;
  waitTime?: number;
  timeout?: number;
  focus?: string[];
  excludeSelector?: string[];
  scopeSelector?: string[];
  exclude?: string[];
  maxFindings?: number;
  probe?: boolean;
  probeBudget?: number;
  probeMode?: "fast" | "standard" | "deep";
  probeSelector?: string[];
  entrySelector?: string;
  goalTarget?: string;
  goalPattern?: string;
  probeStrategy?:
    | "all"
    | "overlay"
    | "composite-widget"
    | "form"
    | "navigation"
    | "modal-return-focus"
    | "menu-pattern";
  summaryOnly?: boolean;
  includeStates?: boolean;
  storageState?: string;
  channel?: string;
  stealth?: boolean;
  checkVisibility?: boolean;
}

type McpToolResult = {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
};

export async function handleAnalyzeUrlTool(input: AnalyzeUrlToolInput): Promise<McpToolResult> {
  try {
    const pipelineResult = await runAnalyzeUrl({
      url: input.url,
      profileId: input.profile,
      device: input.device,
      filter: buildMcpFilter(input),
      excludeSelector: input.excludeSelector,
      scopeSelector: input.scopeSelector,
      explore: input.explore,
      exploreDepth: input.exploreDepth ?? 2,
      exploreBudget: input.exploreBudget ?? 30,
      exploreTimeout: input.exploreTimeout ?? 60000,
      exploreMaxTargets: input.exploreMaxTargets ?? 2000,
      allowAction: input.allowAction,
      probe: input.probe,
      probeBudget: input.probeBudget,
      probeMode: input.probeMode,
      probeSelector: input.probeSelector,
      entrySelector: input.entrySelector,
      goalTarget: input.goalTarget,
      goalPattern: input.goalPattern,
      probeStrategy: input.probeStrategy,
      timeout: input.timeout,
      waitForSelector: input.waitForSelector,
      waitTime: input.waitTime,
      storageState: input.storageState,
      restrictStorageStateToCwd: true,
      useSharedBrowserPool: true,
      channel: input.channel,
      stealth: input.stealth,
      checkVisibility: input.checkVisibility,
    });

    const { result } = pipelineResult;
    for (const warning of pipelineResult.warnings) {
      result.diagnostics.push({
        level: "warning",
        code: "timeout-during-render",
        message: warning,
      });
    }

    const deduped = deduplicateFindings(result);
    const text = input.summaryOnly
      ? formatSummary(input.url, deduped)
      : formatDetailedOutput(deduped, input.format ?? "sarif", input.includeStates ?? false);
    return { content: [{ type: "text", text }] };
  } catch (err) {
    return handleAnalyzeUrlToolError(input.url, err);
  }
}

function buildMcpFilter(input: AnalyzeUrlToolInput): Record<string, unknown> {
  const filter: Record<string, unknown> = {};
  if (input.minSeverity) filter.minSeverity = input.minSeverity;
  if (input.focus) filter.focus = input.focus;
  if (input.exclude) filter.exclude = input.exclude;
  if (input.maxFindings) filter.maxFindings = input.maxFindings;
  return filter;
}

function formatSummary(
  url: string,
  result: Parameters<typeof deduplicateFindings>[0],
): string {
  const s = summarize(result);
  return JSON.stringify(
    {
      url,
      profile: s.profile,
      stats: s.stats,
      severityCounts: s.severityCounts,
      diagnostics: s.diagnostics,
      topIssues: s.issueGroups.slice(0, 3).map((g) => ({
        issue: g.issue,
        count: g.count,
        worstScore: g.worstScore,
      })),
    },
    null,
    2,
  );
}

function formatDetailedOutput(
  result: Parameters<typeof deduplicateFindings>[0],
  format: ReportFormat,
  includeStates: boolean,
): string {
  let output = formatReport(result, format);
  if (includeStates && format === "json") {
    const parsed = JSON.parse(output);
    parsed.states = result.states.map((s) => ({
      id: s.id,
      url: s.url,
      route: s.route,
      snapshotHash: s.snapshotHash,
      interactiveHash: s.interactiveHash,
      openOverlays: s.openOverlays,
      timestamp: s.timestamp,
      provenance: s.provenance,
      targets: s.targets.map((t) => ({
        id: t.id,
        kind: t.kind,
        role: t.role,
        name: t.name,
        selector: t.selector,
        requiresBranchOpen: t.requiresBranchOpen,
        headingLevel: t.headingLevel,
      })),
    }));
    output = JSON.stringify(parsed, null, 2);
  }
  return output;
}

function handleAnalyzeUrlToolError(url: string, err: unknown): McpToolResult {
  if (err instanceof AnalyzeUrlError) {
    const text =
      err.code === "unknown-profile"
        ? `${err.message}. Available: ${listProfiles().join(", ")}`
        : err.message;
    return {
      content: [{ type: "text", text }],
      isError: true,
    };
  }

  return {
    content: [
      {
        type: "text",
        text: `Error analyzing ${url}: ${err instanceof Error ? err.message : String(err)}`,
      },
    ],
    isError: true,
  };
}
