import type { AnalysisResult } from "../core/types.js";
import { summarize, type DetailedFinding } from "./summarize.js";

export function formatConsole(result: AnalysisResult): string {
  const s = summarize(result);
  const lines: string[] = [];

  lines.push(`Tactual Analysis: ${s.name}`);

  if (s.truncationNote) {
    lines.push(`[truncated] ${s.truncationNote.message}`);
    lines.push(`            ${s.truncationNote.howToSeeMore}`);
  }

  const targetLabel = s.stats.matchingTargets != null && s.stats.matchingTargets !== s.stats.targetCount
    ? `${s.stats.matchingTargets} shown / ${s.stats.targetCount} total`
    : `${s.stats.targetCount}`;
  lines.push(`Profile: ${s.profile} | Targets: ${targetLabel} | States: ${s.stats.stateCount}`);
  lines.push(`P10: ${s.stats.p10Score} | Median: ${s.stats.medianScore} | Avg: ${s.stats.averageScore} | Worst: ${s.stats.worstScore}`);
  lines.push("");

  // Diagnostics
  if (s.diagnostics.length > 0) {
    for (const d of s.diagnostics) {
      const prefix = d.level === "error" ? "!!!" : " ! ";
      lines.push(`${prefix} ${d.message}`);
    }
    lines.push("");
  }

  // Severity overview (one line)
  const sevParts: string[] = [];
  for (const [sev, count] of Object.entries(s.severityCounts)) {
    if (count > 0) sevParts.push(`${sev}: ${count}`);
  }
  lines.push(sevParts.join(" | "));
  lines.push("");

  if (s.totalFindings === 0) {
    lines.push("No findings.");
    return lines.join("\n");
  }

  // Common issues (grouped)
  if (s.issueGroups.length > 0) {
    lines.push("Common Issues:");
    for (const g of s.issueGroups) {
      lines.push(`  [${g.count}x] ${g.issue} (worst: ${g.worstScore})`);
      if (g.fix) lines.push(`       Fix: ${g.fix}`);
    }
    lines.push("");
  }

  // Worst findings
  const actionable = s.worstFindings.filter((f) => f.severity !== "strong");
  if (actionable.length > 0) {
    lines.push("Worst Findings:");
    for (const f of actionable) {
      formatFinding(lines, f);
    }
  }

  return lines.join("\n");
}

function formatFinding(lines: string[], f: DetailedFinding): void {
  const icon = severityIcon(f.severity);
  lines.push(`${icon} ${f.targetId}  ${f.overall}/100  [${f.severity}]`);
  lines.push(
    `  D:${f.scores.discoverability} R:${f.scores.reachability} O:${f.scores.operability} Rec:${f.scores.recovery} IR:${f.scores.interopRisk}`,
  );

  if (f.bestPath.length > 0) {
    lines.push(`  Path: ${f.bestPath.join(" > ")}`);
  }

  for (const p of f.penalties) {
    lines.push(`  - ${p}`);
  }
  lines.push("");
}

function severityIcon(severity: string): string {
  const icons: Record<string, string> = {
    severe: "[!!]",
    high: "[! ]",
    moderate: "[~ ]",
    acceptable: "[ok]",
    strong: "[++]",
  };
  return icons[severity] ?? "[??]";
}
