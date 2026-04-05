import type { AnalysisResult } from "../core/types.js";
import { summarize, type DetailedFinding } from "./summarize.js";

export function formatConsole(result: AnalysisResult): string {
  const s = summarize(result);
  const lines: string[] = [];

  // Header
  lines.push("");
  lines.push(`  Tactual Analysis: ${s.name}`);
  lines.push(`  Profile: ${s.profile}`);

  if (s.truncationNote) {
    lines.push("");
    lines.push(`  [truncated] ${s.truncationNote.message}`);
  }

  // Stats bar
  const targetLabel = s.stats.matchingTargets != null && s.stats.matchingTargets !== s.stats.targetCount
    ? `${s.stats.matchingTargets}/${s.stats.targetCount}`
    : `${s.stats.targetCount}`;
  lines.push("");
  lines.push(`  Targets: ${targetLabel}  |  P10: ${s.stats.p10Score}  |  Median: ${s.stats.medianScore}  |  Worst: ${s.stats.worstScore}`);

  // Severity summary as a compact bar
  const sevOrder = ["severe", "high", "moderate", "acceptable", "strong"] as const;
  const sevParts: string[] = [];
  for (const sev of sevOrder) {
    const count = s.severityCounts[sev] ?? 0;
    if (count > 0) sevParts.push(`${count} ${sev}`);
  }
  if (sevParts.length > 0) {
    lines.push(`  ${sevParts.join("  ·  ")}`);
  }

  // Diagnostics (warnings only — not duplicated from stderr)
  if (s.diagnostics.length > 0) {
    lines.push("");
    for (const d of s.diagnostics) {
      const prefix = d.level === "error" ? "  ERROR:" : "  Warning:";
      lines.push(`${prefix} ${d.message}`);
    }
  }

  if (s.totalFindings === 0) {
    lines.push("");
    lines.push("  No findings.");
    lines.push("");
    return lines.join("\n");
  }

  // Common issues (grouped)
  if (s.issueGroups.length > 0) {
    lines.push("");
    lines.push("  Issues:");
    for (const g of s.issueGroups) {
      lines.push(`    ${g.count}x  ${g.issue}`);
      if (g.fix) lines.push(`         Fix: ${g.fix}`);
    }
  }

  // Findings — only show if there are actionable ones (not strong)
  const actionable = s.worstFindings.filter((f) => f.severity !== "strong");
  if (actionable.length > 0) {
    lines.push("");
    lines.push("  Findings:");
    for (const f of actionable) {
      formatFinding(lines, f);
    }
  } else if (s.worstFindings.length > 0) {
    lines.push("");
    lines.push("  All targets score strong (90+). No action needed.");
  }

  lines.push("");
  return lines.join("\n");
}

function formatFinding(lines: string[], f: DetailedFinding): void {
  const icon = severityIcon(f.severity);
  const at = f.actionType ? ` [${f.actionType}]` : "";
  lines.push(`    ${icon} ${f.overall}/100  ${f.targetId}${at}`);
  lines.push(
    `       D:${f.scores.discoverability} R:${f.scores.reachability} O:${f.scores.operability} Rec:${f.scores.recovery} IR:${f.scores.interopRisk}`,
  );

  if (f.selector) {
    lines.push(`       ${f.selector}`);
  }

  for (const p of f.penalties) {
    lines.push(`       - ${p}`);
  }
}

function severityIcon(severity: string): string {
  const icons: Record<string, string> = {
    severe: "!!",
    high: "! ",
    moderate: "~ ",
    acceptable: "  ",
    strong: "OK",
  };
  return icons[severity] ?? "??";
}
