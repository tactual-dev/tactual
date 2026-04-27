import type { ReportFormat } from "../../reporters/index.js";
import { extractFindings, type NormalizedFinding } from "../../core/result-extraction.js";

export interface DiffEntry {
  targetId: string;
  baseline: NormalizedFinding | undefined;
  candidate: NormalizedFinding | undefined;
  overallDelta: number;
}

export interface DiffResult {
  entries: DiffEntry[];
  improved: number;
  regressed: number;
  unchanged: number;
}

export function computeDiff(
  baseline: Record<string, unknown>,
  candidate: Record<string, unknown>,
): DiffResult {
  // Use the shared extractor; handles AnalysisResult,
  // SummarizedResult (JSON reporter), and SARIF shapes.
  const baseMap = new Map(extractFindings(baseline).map((f) => [f.targetId, f]));
  const candMap = new Map(extractFindings(candidate).map((f) => [f.targetId, f]));
  const allIds = new Set([...baseMap.keys(), ...candMap.keys()]);

  const entries: DiffEntry[] = [];
  let improved = 0;
  let regressed = 0;
  let unchanged = 0;

  for (const id of allIds) {
    const b = baseMap.get(id);
    const c = candMap.get(id);
    const delta = (c?.overall ?? 0) - (b?.overall ?? 0);
    entries.push({ targetId: id, baseline: b, candidate: c, overallDelta: delta });
    if (delta > 0) improved++;
    else if (delta < 0) regressed++;
    else unchanged++;
  }

  entries.sort((a, b) => a.overallDelta - b.overallDelta);
  return { entries, improved, regressed, unchanged };
}

export function formatDiff(diff: DiffResult, _format: ReportFormat): string {
  switch (_format) {
    case "json":
      return JSON.stringify(toJsonDiff(diff), null, 2);
    case "markdown":
      return formatMarkdownDiff(diff);
    case "sarif":
      return formatSarifDiff(diff);
    case "console":
      return formatConsoleDiff(diff);
    default:
      throw new Error(`Unknown diff format: ${_format as string}`);
  }
}

function toJsonDiff(diff: DiffResult) {
  return {
    summary: {
      improved: diff.improved,
      regressed: diff.regressed,
      unchanged: diff.unchanged,
      total: diff.entries.length,
    },
    changes: diff.entries.map((entry) => ({
      targetId: entry.targetId,
      baselineScore: entry.baseline?.overall ?? null,
      candidateScore: entry.candidate?.overall ?? null,
      delta: entry.overallDelta,
      baselineSeverity: entry.baseline?.severity ?? null,
      candidateSeverity: entry.candidate?.severity ?? null,
      status: getEntryStatus(entry),
      penaltiesResolved: (entry.baseline?.penalties ?? []).filter(
        (penalty) => !(entry.candidate?.penalties ?? []).includes(penalty),
      ),
      penaltiesAdded: (entry.candidate?.penalties ?? []).filter(
        (penalty) => !(entry.baseline?.penalties ?? []).includes(penalty),
      ),
    })),
  };
}

function getEntryStatus(entry: DiffEntry): "improved" | "regressed" | "new" | "removed" | "unchanged" {
  if (!entry.baseline) return "new";
  if (!entry.candidate) return "removed";
  if (entry.overallDelta > 0) return "improved";
  if (entry.overallDelta < 0) return "regressed";
  return "unchanged";
}

function formatConsoleDiff(diff: DiffResult): string {
  const lines: string[] = [];
  lines.push(
    `Diff: ${diff.improved} improved, ${diff.regressed} regressed, ${diff.unchanged} unchanged`,
  );
  lines.push("");

  for (const entry of diff.entries) {
    const sign = entry.overallDelta > 0 ? "+" : "";
    const base = entry.baseline?.overall ?? "new";
    const cand = entry.candidate?.overall ?? "removed";
    lines.push(`  ${entry.targetId}: ${base} -> ${cand} (${sign}${entry.overallDelta})`);
  }

  return lines.join("\n");
}

function formatMarkdownDiff(diff: DiffResult): string {
  const lines: string[] = [
    "# Tactual Diff",
    "",
    `**Improved:** ${diff.improved} | **Regressed:** ${diff.regressed} | **Unchanged:** ${diff.unchanged}`,
    "",
    "| Target | Baseline | Candidate | Delta | Status |",
    "|---|---:|---:|---:|---|",
  ];

  for (const entry of diff.entries) {
    const sign = entry.overallDelta > 0 ? "+" : "";
    lines.push(
      `| ${escapeMarkdown(entry.targetId)} | ${entry.baseline?.overall ?? "new"} | ` +
        `${entry.candidate?.overall ?? "removed"} | ${sign}${entry.overallDelta} | ${getEntryStatus(entry)} |`,
    );
  }

  return lines.join("\n");
}

function escapeMarkdown(value: string): string {
  return value.replace(/\|/g, "\\|");
}

function formatSarifDiff(diff: DiffResult): string {
  const results = diff.entries
    .filter((entry) => getEntryStatus(entry) !== "unchanged")
    .map((entry) => {
      const status = getEntryStatus(entry);
      const isRegression = status === "regressed" || status === "new";
      return {
        ruleId: `tactual/diff-${status}`,
        level: isRegression ? "warning" : "note",
        message: {
          text:
            `${entry.targetId}: ${entry.baseline?.overall ?? "new"} -> ` +
            `${entry.candidate?.overall ?? "removed"} (${entry.overallDelta > 0 ? "+" : ""}${entry.overallDelta})`,
        },
        locations: [
          {
            logicalLocations: [
              {
                name: entry.targetId,
                kind: "accessibilityTarget",
              },
            ],
          },
        ],
        properties: {
          baselineScore: entry.baseline?.overall ?? null,
          candidateScore: entry.candidate?.overall ?? null,
          delta: entry.overallDelta,
          status,
          baselineSeverity: entry.baseline?.severity ?? null,
          candidateSeverity: entry.candidate?.severity ?? null,
        },
      };
    });

  return JSON.stringify(
    {
      $schema: "https://raw.githubusercontent.com/oasis-tcs/sarif-spec/main/sarif-2.1/schema/sarif-schema-2.1.0.json",
      version: "2.1.0",
      runs: [
        {
          tool: {
            driver: {
              name: "Tactual",
              informationUri: "https://github.com/tactual-dev/tactual",
              rules: [
                {
                  id: "tactual/diff-regressed",
                  name: "TactualDiffRegression",
                  shortDescription: { text: "Target score regressed between Tactual runs" },
                  defaultConfiguration: { level: "warning" },
                },
                {
                  id: "tactual/diff-new",
                  name: "TactualDiffNewTarget",
                  shortDescription: { text: "Target is new in the candidate Tactual run" },
                  defaultConfiguration: { level: "warning" },
                },
                {
                  id: "tactual/diff-improved",
                  name: "TactualDiffImprovement",
                  shortDescription: { text: "Target score improved between Tactual runs" },
                  defaultConfiguration: { level: "note" },
                },
                {
                  id: "tactual/diff-removed",
                  name: "TactualDiffRemovedTarget",
                  shortDescription: { text: "Target was removed from the candidate Tactual run" },
                  defaultConfiguration: { level: "note" },
                },
              ],
            },
          },
          results,
          properties: toJsonDiff(diff).summary,
        },
      ],
    },
    null,
    2,
  );
}
