#!/usr/bin/env node

/**
 * Summarize analysis drift between two Tactual JSON reports.
 *
 * This is intentionally narrower than `diff-results`: release notes need a
 * quick view of target/finding/count drift, severity mix, navigation-cost
 * movement, frame recovery/skips, and the largest score changes.
 */

import { readFile } from "node:fs/promises";

const [baselinePath, candidatePath] = process.argv.slice(2);
if (!baselinePath || !candidatePath) {
  console.error("Usage: node scripts/release-drift.mjs <baseline-analysis.json> <candidate-analysis.json>");
  process.exit(1);
}

const baseline = unwrapAnalysis(JSON.parse(await readFile(baselinePath, "utf-8")));
const candidate = unwrapAnalysis(JSON.parse(await readFile(candidatePath, "utf-8")));
const summary = {
  baseline: summarize(baseline),
  candidate: summarize(candidate),
  delta: {
    targets: summarize(candidate).targetCount - summarize(baseline).targetCount,
    findings: summarize(candidate).findingCount - summarize(baseline).findingCount,
    averageOverall: round(summarize(candidate).averageOverall - summarize(baseline).averageOverall),
    meanPathLength: round(summarize(candidate).meanPathLength - summarize(baseline).meanPathLength),
    frameTargets: summarize(candidate).frameTargets - summarize(baseline).frameTargets,
    framesSkipped: summarize(candidate).framesSkipped - summarize(baseline).framesSkipped,
  },
  changedFindings: changedFindings(baseline, candidate).slice(0, 15),
};

console.log(formatMarkdown(summary));

function unwrapAnalysis(value) {
  return value.result ?? value;
}

function summarize(result) {
  const targets = result.states?.flatMap((state) => state.targets ?? []) ?? [];
  const findings = result.findings ?? result.worstFindings ?? [];
  const severityCounts = { ...(result.severityCounts ?? {}) };
  for (const finding of findings) {
    if (result.severityCounts) break;
    severityCounts[finding.severity] = (severityCounts[finding.severity] ?? 0) + 1;
  }
  const diagnosticCounts = {};
  for (const diagnostic of result.diagnostics ?? []) {
    diagnosticCounts[diagnostic.code] = (diagnosticCounts[diagnostic.code] ?? 0) + 1;
  }
  const scores = findings.map((finding) => findingScore(finding));
  const pathLengths = findings.map((finding) => Number(finding.bestPath?.length ?? 0));
  return {
    targetCount: result.metadata?.targetCount ?? result.stats?.targetCount ?? targets.length,
    findingCount: result.metadata?.findingCount ?? result.totalFindings ?? findings.length,
    averageOverall: round(result.stats?.averageScore ?? mean(scores)),
    meanPathLength: round(mean(pathLengths)),
    severityCounts,
    diagnosticCounts,
    frameTargets: targets.filter((target) => target._frame).length,
    framesSkipped: countFramesSkipped(result),
  };
}

function countFramesSkipped(result) {
  return (result.states ?? []).reduce((sum, state) => sum + (state._framesSkipped?.length ?? 0), 0);
}

function changedFindings(baseline, candidate) {
  const before = new Map((baseline.findings ?? baseline.worstFindings ?? []).map((finding) => [finding.targetId, finding]));
  const after = new Map((candidate.findings ?? candidate.worstFindings ?? []).map((finding) => [finding.targetId, finding]));
  const ids = new Set([...before.keys(), ...after.keys()]);
  return [...ids]
    .map((id) => {
      const oldFinding = before.get(id);
      const newFinding = after.get(id);
      return {
        targetId: id,
        status: oldFinding && newFinding ? "changed" : oldFinding ? "removed" : "added",
        before: oldFinding ? findingScore(oldFinding) : undefined,
        after: newFinding ? findingScore(newFinding) : undefined,
        delta: round((newFinding ? findingScore(newFinding) : 0) - (oldFinding ? findingScore(oldFinding) : 0)),
        beforeSeverity: oldFinding?.severity,
        afterSeverity: newFinding?.severity,
      };
    })
    .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
}

function formatMarkdown(summary) {
  const lines = [];
  lines.push("# Release Drift Summary");
  lines.push("");
  lines.push("| Metric | Baseline | Candidate | Delta |");
  lines.push("|---|---:|---:|---:|");
  lines.push(row("Targets", summary.baseline.targetCount, summary.candidate.targetCount, summary.delta.targets));
  lines.push(row("Findings", summary.baseline.findingCount, summary.candidate.findingCount, summary.delta.findings));
  lines.push(row("Average overall", summary.baseline.averageOverall, summary.candidate.averageOverall, summary.delta.averageOverall));
  lines.push(row("Mean path length", summary.baseline.meanPathLength, summary.candidate.meanPathLength, summary.delta.meanPathLength));
  lines.push(row("Frame targets", summary.baseline.frameTargets, summary.candidate.frameTargets, summary.delta.frameTargets));
  lines.push(row("Frames skipped", summary.baseline.framesSkipped, summary.candidate.framesSkipped, summary.delta.framesSkipped));
  lines.push("");
  lines.push("## Severity Counts");
  lines.push(`Baseline: ${JSON.stringify(summary.baseline.severityCounts)}`);
  lines.push(`Candidate: ${JSON.stringify(summary.candidate.severityCounts)}`);
  lines.push("");
  lines.push("## Diagnostics");
  lines.push(`Baseline: ${JSON.stringify(summary.baseline.diagnosticCounts)}`);
  lines.push(`Candidate: ${JSON.stringify(summary.candidate.diagnosticCounts)}`);
  lines.push("");
  lines.push("## Largest Finding Score Changes");
  const changed = summary.changedFindings.filter(
    (finding) => finding.delta !== 0 || finding.beforeSeverity !== finding.afterSeverity,
  );
  if (changed.length === 0) {
    lines.push("No finding score or severity changes in the reported set.");
  }
  for (const finding of changed) {
    lines.push(
      `- ${finding.targetId}: ${finding.status}, ` +
        `${finding.before ?? "none"} -> ${finding.after ?? "none"} ` +
        `(${signed(finding.delta)}), ${finding.beforeSeverity ?? "none"} -> ${finding.afterSeverity ?? "none"}`,
    );
  }
  return lines.join("\n");
}

function row(name, before, after, delta) {
  return `| ${name} | ${before} | ${after} | ${signed(delta)} |`;
}

function signed(value) {
  return typeof value === "number" && value > 0 ? `+${value}` : String(value);
}

function mean(values) {
  return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function findingScore(finding) {
  return Number(finding.scores?.overall ?? finding.overall ?? 0);
}

function round(value) {
  return Math.round(value * 100) / 100;
}
