import type { AnalysisResult, Finding } from "./types.js";

/**
 * Normalized finding shape for diff/suggest tools.
 *
 * Accepts both raw AnalysisResult (which has `findings: Finding[]` with
 * `scores.overall`) and summarized JSON (which has `worstFindings:
 * DetailedFinding[]` with top-level `overall`).
 */
export interface NormalizedFinding {
  targetId: string;
  overall: number;
  severity: string;
  penalties: string[];
  suggestedFixes: string[];
}

/**
 * Extract findings from either a raw AnalysisResult, SummarizedResult, or SARIF log.
 * Throws if no supported shape is found.
 */
export function extractFindings(data: unknown): NormalizedFinding[] {
  const obj = data as Record<string, unknown>;

  if (Array.isArray(obj.findings)) {
    return (obj.findings as Array<Record<string, unknown>>).map((f) => ({
      targetId: String(f.targetId ?? ""),
      overall: getOverallScore(f),
      severity: String(f.severity ?? "unknown"),
      penalties: (f.penalties as string[] | undefined) ?? [],
      suggestedFixes: (f.suggestedFixes as string[] | undefined) ?? [],
    }));
  }

  if (Array.isArray(obj.worstFindings)) {
    return (obj.worstFindings as Array<Record<string, unknown>>).map((f) => ({
      targetId: String(f.targetId ?? ""),
      overall: getOverallScore(f),
      severity: String(f.severity ?? "unknown"),
      penalties: (f.penalties as string[] | undefined) ?? [],
      suggestedFixes: (f.suggestedFixes as string[] | undefined) ?? [],
    }));
  }

  if (Array.isArray(obj.runs)) {
    const runs = obj.runs as Array<Record<string, unknown>>;
    const results = (runs[0]?.results ?? []) as Array<Record<string, unknown>>;
    return results
      .filter((r) => {
        const props = r.properties as Record<string, unknown> | undefined;
        return !props?.truncated;
      })
      .map((r) => {
        const props = (r.properties ?? {}) as Record<string, unknown>;
        const scores = (props.scores ?? {}) as Record<string, unknown>;
        const locs = (r.locations ?? []) as Array<Record<string, unknown>>;
        const logLocs = (locs[0]?.logicalLocations ?? []) as Array<Record<string, unknown>>;
        const targetId = String(logLocs[0]?.name ?? "");
        const level = String(r.level ?? "note");
        const severity =
          level === "error" ? "high" : level === "warning" ? "moderate" : "acceptable";
        const msgText = String((r.message as Record<string, unknown>)?.text ?? "");
        const penalties: string[] = [];
        const suggestedFixes: string[] = [];
        const issuesMatch = msgText.match(/Issues:\s*(.+?)(?:\.\s*Fixes:|$)/);
        if (issuesMatch) penalties.push(...issuesMatch[1].split(/;\s*/).filter(Boolean));
        const fixesMatch = msgText.match(/Fixes:\s*(.+)/);
        if (fixesMatch) suggestedFixes.push(...fixesMatch[1].split(/;\s*/).filter(Boolean));

        return {
          targetId,
          overall: Number(scores.overall ?? 0),
          severity,
          penalties,
          suggestedFixes,
        };
      });
  }

  throw new Error(
    'Input must contain "findings" (raw), "worstFindings" (summarized), or "runs" (SARIF) array. ' +
      "Pass the full analysis result object, not a sub-field.",
  );
}

/**
 * Extract the overall score from either Finding or DetailedFinding shape.
 * Finding:         { scores: { overall: N } }
 * DetailedFinding: { overall: N, scores: { discoverability, ... } }
 */
export function getOverallScore(f: Record<string, unknown>): number {
  if (typeof f.overall === "number") return f.overall;
  const scores = f.scores as Record<string, unknown> | undefined;
  if (scores && typeof scores.overall === "number") return scores.overall;
  return 0;
}

/**
 * Group findings with identical penalty signatures into a single representative
 * finding with a count annotation.
 */
export function deduplicateFindings(result: AnalysisResult): AnalysisResult {
  const findings = result.findings;
  if (findings.length <= 1) return result;

  const byTargetId = new Map<string, Finding>();
  for (const f of findings) {
    const existing = byTargetId.get(f.targetId);
    if (!existing || f.scores.overall > existing.scores.overall) {
      byTargetId.set(f.targetId, f);
    }
  }
  const uniqueFindings = [...byTargetId.values()];

  const groups = new Map<string, Finding[]>();
  for (const f of uniqueFindings) {
    const sig = [...f.penalties].sort().join("|||") + ":::" + f.severity;
    const group = groups.get(sig);
    if (group) {
      group.push(f);
    } else {
      groups.set(sig, [f]);
    }
  }

  const deduped: Finding[] = [];
  for (const [, group] of groups) {
    if (group.length <= 2) {
      deduped.push(...group);
    } else {
      const worst = group.reduce((a, b) => (a.scores.overall <= b.scores.overall ? a : b));
      const others = group.filter((f) => f !== worst);
      const names = others
        .slice(0, 3)
        .map((f) => f.targetId)
        .join(", ");
      const suffix = group.length > 4 ? ` and ${group.length - 4} more` : "";

      deduped.push({
        ...worst,
        penalties: [
          ...worst.penalties,
          `(${group.length} similar targets: ${names}${suffix})`,
        ],
      });
    }
  }

  deduped.sort((a, b) => a.scores.overall - b.scores.overall);

  return {
    ...result,
    findings: deduped,
    metadata: {
      ...result.metadata,
      matchingTargets: deduped.length,
    },
  };
}
