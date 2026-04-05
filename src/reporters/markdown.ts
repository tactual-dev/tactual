import type { AnalysisResult } from "../core/types.js";
import { summarize, type IssueGroup, type DetailedFinding } from "./summarize.js";

export function formatMarkdown(result: AnalysisResult): string {
  const s = summarize(result);
  const lines: string[] = [];

  lines.push(`# Tactual Analysis: ${s.name}`);
  lines.push("");

  if (s.truncationNote) {
    lines.push(`> **Note:** ${s.truncationNote.message}`);
    lines.push(`> ${s.truncationNote.howToSeeMore}`);
    lines.push("");
  }

  const targetLabel = s.stats.matchingTargets != null && s.stats.matchingTargets !== s.stats.targetCount
    ? `${s.stats.matchingTargets} shown / ${s.stats.targetCount} total`
    : `${s.stats.targetCount}`;
  lines.push(`**Profile:** ${s.profile} | **Targets:** ${targetLabel} | **States:** ${s.stats.stateCount}`);
  lines.push(`**P10:** ${s.stats.p10Score} | **Median:** ${s.stats.medianScore} | **Average:** ${s.stats.averageScore} | **Worst:** ${s.stats.worstScore}`);
  lines.push("");

  // Diagnostics
  if (s.diagnostics.length > 0) {
    lines.push("## Diagnostics");
    lines.push("");
    for (const d of s.diagnostics) {
      const icon = d.level === "error" ? "**ERROR**" : "**WARNING**";
      lines.push(`- ${icon}: ${d.message}`);
    }
    lines.push("");
  }

  // Severity summary
  lines.push("## Summary");
  lines.push("");
  lines.push("| Severity | Count |");
  lines.push("|---|--:|");
  for (const [sev, count] of Object.entries(s.severityCounts)) {
    if (count > 0) lines.push(`| ${severityLabel(sev)} | ${count} |`);
  }
  lines.push("");

  if (s.totalFindings === 0) {
    lines.push("No findings.");
    return lines.join("\n");
  }

  // Common issues (grouped)
  if (s.issueGroups.length > 0) {
    lines.push("## Common Issues");
    lines.push("");
    for (const g of s.issueGroups) {
      formatIssueGroup(lines, g);
    }
    lines.push("");
  }

  // Worst findings (detailed)
  const actionable = s.worstFindings.filter((f) => f.severity !== "strong");
  if (actionable.length > 0) {
    lines.push("## Worst Findings");
    lines.push("");
    for (const f of actionable) {
      formatDetailedFinding(lines, f);
    }
  }

  return lines.join("\n");
}

function formatIssueGroup(lines: string[], g: IssueGroup): void {
  lines.push(`**${g.issue}** — ${g.count} targets (worst score: ${g.worstScore})`);
  if (g.fix) lines.push(`  Fix: ${g.fix}`);
  lines.push(`  Examples: ${g.examples.join(", ")}`);
  lines.push("");
}

function formatDetailedFinding(lines: string[], f: DetailedFinding): void {
  lines.push(`### ${f.targetId} — ${f.overall}/100 [${f.severity}]`);
  lines.push("");
  lines.push(`D:${f.scores.discoverability} R:${f.scores.reachability} O:${f.scores.operability} Rec:${f.scores.recovery} IR:${f.scores.interopRisk}`);
  lines.push("");

  if (f.bestPath.length > 0) {
    lines.push(`**Path:** ${f.bestPath.join(" → ")}`);
    lines.push("");
  }

  if (f.penalties.length > 0) {
    for (const p of f.penalties) lines.push(`- ${p}`);
    lines.push("");
  }

  if (f.suggestedFixes.length > 0) {
    lines.push("**Fixes:**");
    for (const fix of f.suggestedFixes) lines.push(`- ${fix}`);
    lines.push("");
  }
}

function severityLabel(severity: string): string {
  const labels: Record<string, string> = {
    severe: "Severe (0-39)",
    high: "High Concern (40-59)",
    moderate: "Moderate (60-74)",
    acceptable: "Acceptable (75-89)",
    strong: "Strong (90-100)",
  };
  return labels[severity] ?? severity;
}
