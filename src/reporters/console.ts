import type { AnalysisResult } from "../core/types.js";
import { summarize, type DetailedFinding, type IssueGroup, type RemediationCandidate } from "./summarize.js";

// ---------------------------------------------------------------------------
// ANSI color helpers (no external dependencies)
// ---------------------------------------------------------------------------

const isColorSupported = process.stdout.isTTY === true && !process.env.NO_COLOR;

const c = {
  reset: isColorSupported ? "\x1b[0m" : "",
  bold: isColorSupported ? "\x1b[1m" : "",
  dim: isColorSupported ? "\x1b[2m" : "",
  red: isColorSupported ? "\x1b[31m" : "",
  yellow: isColorSupported ? "\x1b[33m" : "",
  green: isColorSupported ? "\x1b[32m" : "",
  cyan: isColorSupported ? "\x1b[36m" : "",
  gray: isColorSupported ? "\x1b[90m" : "",
  white: isColorSupported ? "\x1b[37m" : "",
  bgRed: isColorSupported ? "\x1b[41m" : "",
  bgYellow: isColorSupported ? "\x1b[43m" : "",
  bgGreen: isColorSupported ? "\x1b[42m" : "",
};

function severityColor(severity: string): string {
  if (severity === "severe") return c.red;
  if (severity === "high") return c.red;
  if (severity === "moderate") return c.yellow;
  if (severity === "acceptable") return c.green;
  if (severity === "strong") return c.green;
  return c.white;
}

/** Score bar: ████████░░ 80 */
function scoreBar(score: number, width = 10): string {
  const filled = Math.round((score / 100) * width);
  const empty = width - filled;
  const color = score >= 75 ? c.green : score >= 60 ? c.yellow : c.red;
  return `${color}${"█".repeat(filled)}${c.gray}${"░".repeat(empty)}${c.reset} ${score}`;
}

// ---------------------------------------------------------------------------
// Console formatter
// ---------------------------------------------------------------------------

/** Maximum findings to show in console (only non-strong) */
const MAX_CONSOLE_FINDINGS = 8;

export function formatConsole(result: AnalysisResult, options?: { maxDetailedFindings?: number }): string {
  const s = summarize(result, options);
  const lines: string[] = [];

  // ── Header ──
  lines.push("");
  lines.push(`  ${c.bold}Tactual Analysis${c.reset}  ${c.cyan}${s.name}${c.reset}`);
  lines.push(`  ${c.dim}Profile: ${s.profile}${c.reset}`);

  // ── Stats ──
  const targetLabel = s.stats.matchingTargets != null && s.stats.matchingTargets !== s.stats.targetCount
    ? `${s.stats.matchingTargets}/${s.stats.targetCount}`
    : `${s.stats.targetCount}`;

  lines.push("");
  lines.push(`  ${c.dim}Targets${c.reset} ${targetLabel}    ${c.dim}P10${c.reset} ${scoreBar(s.stats.p10Score)}    ${c.dim}Median${c.reset} ${scoreBar(s.stats.medianScore)}    ${c.dim}Worst${c.reset} ${scoreBar(s.stats.worstScore)}`);

  // ── Severity summary ──
  const sevOrder = ["severe", "high", "moderate", "acceptable", "strong"] as const;
  const sevParts: string[] = [];
  for (const sev of sevOrder) {
    const count = s.severityCounts[sev] ?? 0;
    if (count > 0) {
      sevParts.push(`${severityColor(sev)}${count} ${sev}${c.reset}`);
    }
  }
  if (sevParts.length > 0) {
    lines.push(`  ${sevParts.join(`${c.dim}  ·  ${c.reset}`)}`);
  }

  // ── Diagnostics ──
  if (s.diagnostics.length > 0) {
    lines.push("");
    for (const d of s.diagnostics) {
      if (d.level === "error") {
        lines.push(`  ${c.bgRed}${c.white}${c.bold} ERROR ${c.reset} ${d.message}`);
      } else {
        lines.push(`  ${c.yellow}Warning:${c.reset} ${d.message}`);
      }
    }
  }

  if (s.totalFindings === 0) {
    lines.push("");
    lines.push(`  ${c.green}No findings.${c.reset}`);
    lines.push("");
    return lines.join("\n");
  }

  // ── Issues (grouped) ──
  if (s.issueGroups.length > 0) {
    lines.push("");
    lines.push(`  ${c.bold}Issues${c.reset}`);
    for (const g of s.issueGroups.slice(0, 5)) {
      formatIssueGroup(lines, g);
    }
    if (s.issueGroups.length > 5) {
      lines.push(`  ${c.dim}  ... and ${s.issueGroups.length - 5} more issue groups${c.reset}`);
    }
  }

  if (s.remediationCandidates.length > 0) {
    lines.push("");
    lines.push(`  ${c.bold}Remediation Candidates${c.reset}`);
    for (const candidate of s.remediationCandidates.slice(0, 3)) {
      formatRemediationCandidate(lines, candidate);
    }
    if (s.remediationCandidates.length > 3) {
      lines.push(`  ${c.dim}  ... and ${s.remediationCandidates.length - 3} more remediation candidates in JSON output${c.reset}`);
    }
  }

  // ── Findings (only actionable: severe, high, moderate) ──
  const actionable = s.worstFindings.filter(
    (f) => f.severity === "severe" || f.severity === "high" || f.severity === "moderate",
  );

  if (actionable.length > 0) {
    const maxShown = options?.maxDetailedFindings ?? MAX_CONSOLE_FINDINGS;
    const shown = actionable.slice(0, maxShown);
    const remaining = actionable.length - shown.length;

    lines.push("");
    lines.push(`  ${c.bold}Findings${c.reset}${remaining > 0 ? `${c.dim}  (${shown.length} of ${actionable.length} shown)${c.reset}` : ""}`);
    lines.push("");

    for (const f of shown) {
      formatFinding(lines, f);
    }

    if (remaining > 0) {
      lines.push(`  ${c.dim}  ... and ${remaining} more. Use -f json or --top ${actionable.length} to see all.${c.reset}`);
    }
  } else {
    lines.push("");
    lines.push(`  ${c.green}${c.bold}All clear${c.reset}${c.green} — no severe, high, or moderate findings.${c.reset}`);
  }

  // ── Validation (when --validate was set) ──
  if (s.validation) {
    const v = s.validation;
    lines.push("");
    lines.push(`  ${c.bold}Validation${c.reset} ${c.dim}(virtual screen reader, ${v.strategy})${c.reset}`);
    const reachColor = v.reachable === v.totalValidated ? c.green : c.yellow;
    const unreachColor = v.unreachable > 0 ? c.red : c.dim;
    lines.push(
      `  ${c.dim}  Validated${c.reset} ${v.totalValidated}    ` +
      `${reachColor}${v.reachable} reachable${c.reset}    ` +
      `${unreachColor}${v.unreachable} unreachable${c.reset}`,
    );
    if (v.meanAccuracy !== null) {
      // Accuracy near 1.0 = predictions match virtual SR. Low = Tactual is
      // underestimating steps (the virtual SR needed more).
      const acc = v.meanAccuracy;
      const accColor = acc >= 0.8 ? c.green : acc >= 0.5 ? c.yellow : c.red;
      lines.push(
        `  ${c.dim}  Predicted/actual step ratio${c.reset} ` +
        `${accColor}${acc.toFixed(2)}${c.reset} ${c.dim}(1.0 = perfect)${c.reset}`,
      );
    }
  }

  // ── Truncation note ──
  if (s.truncationNote) {
    const omittedActionable = (s.truncationNote.omittedBySeverity.severe ?? 0) +
      (s.truncationNote.omittedBySeverity.high ?? 0) +
      (s.truncationNote.omittedBySeverity.moderate ?? 0);
    if (omittedActionable > 0) {
      lines.push("");
      lines.push(`  ${c.dim}${omittedActionable} more actionable findings not shown. Use -f json for full results.${c.reset}`);
    }
  }

  lines.push("");
  return lines.join("\n");
}

function formatIssueGroup(lines: string[], g: IssueGroup): void {
  const color = g.worstScore < 60 ? c.red : g.worstScore < 75 ? c.yellow : c.dim;
  // Impact note: "fixing this lifts 12 targets from avg 55" — lets users
  // prioritize by aggregate score upside, not just affected-target count.
  const impact = g.estimatedScoreUplift > 0
    ? `${c.dim} · fix adds ~${g.estimatedScoreUplift} score pts across ${g.count} targets (avg ${g.averageScore})${c.reset}`
    : "";
  lines.push(`  ${color}  ${String(g.count).padStart(3)}x${c.reset}  ${g.issue}${impact}`);
  if (g.fix) {
    lines.push(`  ${c.dim}       ↳ ${g.fix}${c.reset}`);
  }
}

function formatRemediationCandidate(lines: string[], candidate: RemediationCandidate): void {
  const uplift = candidate.estimatedScoreUplift
    ? `${c.dim} · ~${candidate.estimatedScoreUplift} score pts${c.reset}`
    : "";
  lines.push(
    `  ${c.cyan}  ${candidate.title}${c.reset} ${c.dim}[${candidate.category}, confidence ${candidate.confidence}]${c.reset}${uplift}`,
  );
  if (candidate.primaryFix) {
    lines.push(`  ${c.dim}       Fix: ${candidate.primaryFix}${c.reset}`);
  }
  if (candidate.examples.length > 0) {
    lines.push(`  ${c.dim}       Examples: ${candidate.examples.slice(0, 3).join(", ")}${c.reset}`);
  }
}

function formatFinding(lines: string[], f: DetailedFinding): void {
  const sColor = severityColor(f.severity);
  const at = f.actionType ? `${c.dim} ${f.actionType}${c.reset}` : "";

  // Score + severity + target
  lines.push(`  ${sColor}  ${scoreBar(f.overall, 8)}${c.reset}  ${c.bold}${f.targetId}${c.reset}${at}`);

  // Dimension scores (compact)
  lines.push(
    `  ${c.dim}              D:${f.scores.discoverability} R:${f.scores.reachability} O:${f.scores.operability} Rec:${f.scores.recovery}${f.scores.interopRisk > 0 ? ` IR:${f.scores.interopRisk}` : ""}${c.reset}`,
  );
  if (f.evidence.length > 0) {
    lines.push(`  ${c.dim}              Evidence: ${formatEvidenceSummary(f)}${c.reset}`);
  }

  // Selector
  if (f.selector) {
    lines.push(`  ${c.dim}              ${f.selector}${c.reset}`);
  }

  // How to reach the target — compacted SR-command-style string.
  // Collapses consecutive same-action steps ("nextItem, nextItem, nextItem" → "Tab ×3")
  // and translates action names to the shorter form AT users recognize
  // (H for heading, ; for landmark, Enter for activation). Surfaces
  // actionability: readers see exactly how many keystrokes reach this
  // finding's target from the nearest entry point.
  const pathStr = compactPathForConsole(f.bestPath);
  if (pathStr) {
    lines.push(`  ${c.dim}              ↪ ${pathStr}${c.reset}`);
  }

  // Penalties
  for (const p of f.penalties.slice(0, 2)) {
    lines.push(`  ${c.dim}              → ${c.reset}${p}`);
  }
  if (f.penalties.length > 2) {
    lines.push(`  ${c.dim}              ... and ${f.penalties.length - 2} more${c.reset}`);
  }

  lines.push("");
}

function formatEvidenceSummary(f: DetailedFinding): string {
  const parts = [
    ["measured", f.evidenceSummary.measured],
    ["validated", f.evidenceSummary.validated],
    ["modeled", f.evidenceSummary.modeled],
    ["heuristic", f.evidenceSummary.heuristic],
  ]
    .filter(([, count]) => Number(count) > 0)
    .map(([kind, count]) => `${kind} ${count}`);
  return parts.join(", ");
}

/**
 * Compact a bestPath array ("nextItem: Home", "nextItem: About", ...)
 * into a single readable SR-command line ("Tab ×2 → H \"Cart\" → Enter").
 *
 * Rules:
 *   - Consecutive same-action steps collapse: "nextItem, nextItem" → "Tab ×2"
 *   - Action names translate to the short form AT users know:
 *       nextItem     → Tab
 *       nextHeading  → H
 *       nextLandmark → ;
 *       nextLink     → K
 *       groupEntry   → enter
 *       groupExit    → exit
 *       activate     → Enter
 *   - A "... (N more steps)" marker from truncatePath renders as "+N more"
 *   - Empty path (unreachable) returns empty string → caller suppresses line
 */
function compactPathForConsole(path: string[]): string {
  if (path.length === 0) return "";
  const actionShort: Record<string, string> = {
    nextItem: "Tab",
    nextHeading: "H",
    nextLandmark: ";",
    nextLink: "K",
    nextButton: "B",
    nextControl: "Tab",
    groupEntry: "→",
    groupExit: "←",
    activate: "Enter",
  };
  // Parse "action: targetName" back into (action, name) pairs.
  const parsed = path.map((step) => {
    if (step.startsWith("... (")) return { action: "_more", name: step.replace(/^\.\.\. \(/, "+").replace(/\)$/, "") };
    const idx = step.indexOf(": ");
    return idx >= 0
      ? { action: step.slice(0, idx), name: step.slice(idx + 2) }
      : { action: step, name: "" };
  });
  // Collapse runs of same action (ignore name differences for "nextItem" etc.).
  const compacted: Array<{ action: string; name: string; count: number }> = [];
  for (const p of parsed) {
    const last = compacted[compacted.length - 1];
    // Only collapse actions where the name is incidental (Tab ×3 over different
    // items is meaningful; H "Cart" carries the target name explicitly).
    const collapsible = p.action === "nextItem" || p.action === "nextControl";
    if (last && collapsible && last.action === p.action) {
      last.count++;
      last.name = p.name; // keep the last name as the landing point
      continue;
    }
    compacted.push({ action: p.action, name: p.name, count: 1 });
  }
  // Render each step.
  return compacted
    .map(({ action, name, count }) => {
      if (action === "_more") return name;
      const short = actionShort[action] ?? action;
      const countSuffix = count > 1 ? ` ×${count}` : "";
      const quotedName = name && name !== "element" && name !== "page" ? ` "${name}"` : "";
      // For Tab runs we show the landing target; for others name is the action target.
      if (short === "Tab" || short === ";" || short === "H" || short === "K" || short === "B") {
        return `${short}${countSuffix}${quotedName}`;
      }
      return `${short}${quotedName}`;
    })
    .join(" → ");
}
