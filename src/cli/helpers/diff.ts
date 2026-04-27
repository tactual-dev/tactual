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
