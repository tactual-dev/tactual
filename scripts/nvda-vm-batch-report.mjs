#!/usr/bin/env node

/**
 * Summarize an NVDA VM calibration batch.
 *
 * Batch calibration intentionally has two evidence streams:
 *   1. matched speech records, which may be ingested into calibration.json;
 *   2. missing/unmatched speech, which must stay visible because it often
 *      means the harness lost browse mode OR NVDA reached content Tactual did
 *      not model.
 *
 * This script turns the batch folder into a short markdown report and a JSON
 * review queue. It does not tune mapper assumptions by itself; it makes the
 * repeated misses obvious enough that a mapper change can be reviewed.
 */

import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const defaultMinimumMatchRatio = 0.5;

const helpText = `NVDA VM calibration batch report

Usage:
  node scripts/nvda-vm-batch-report.mjs --batch build/nvda-vm/calibration-batch/<stamp>

Options:
  --batch <dir|batch-summary.json>  Batch directory or summary JSON path
  --out-md <path>                   Markdown output path (default: <batch>/batch-report.md)
  --out-json <path>                 Review queue JSON path (default: <batch>/review-queue.json)
  --min-match-ratio <n>             Weak-case threshold (default: 0.5)
`;

if (isMainModule()) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help || !opts.batch) {
    console.log(helpText);
    return;
  }

  const report = await buildBatchReport({
    batch: opts.batch,
    minimumMatchRatio: parseNumber(opts.minMatchRatio, defaultMinimumMatchRatio),
  });
  const markdownPath = resolve(opts.outMd ?? join(report.batchDir, "batch-report.md"));
  const queuePath = resolve(opts.outJson ?? join(report.batchDir, "review-queue.json"));

  await writeJson(queuePath, report.reviewQueue);
  await writeText(markdownPath, renderMarkdown(report));

  console.log(`Batch report: ${markdownPath}`);
  console.log(`Review queue: ${queuePath}`);
}

export async function buildBatchReport(args) {
  const summaryPath = resolveSummaryPath(args.batch);
  const batchDir = dirname(summaryPath);
  const summary = await readJson(summaryPath);
  const minimumMatchRatio = args.minimumMatchRatio ?? defaultMinimumMatchRatio;

  const cases = [];
  const missingTargets = [];
  const unmatchedSpeech = [];
  const unmatchedTargetSpeech = [];
  const mapperComparisons = [];
  const capturedTargetNames = new Set();

  for (const result of summary.results ?? []) {
    const caseOut = result.output ? resolve(result.output) : join(batchDir, result.name ?? "unknown");
    const alignment = await readJsonIfExists(join(caseOut, "sequence-alignment.json"));
    const hostSummary = await readJsonIfExists(join(caseOut, "host-calibration-summary.json"));
    const analysis = await readJsonIfExists(join(caseOut, "analysis.full.json"));
    const analysisTargets = targetsFromAnalysis(analysis);
    for (const target of analysisTargets) capturedTargetNames.add(target.normalizedName);
    const planned = numberValue(alignment?.summary?.plannedTargets ?? result.plannedTargets);
    const matched = numberValue(alignment?.summary?.matchedTargets ?? result.matchedTargets);
    const parsedSpeechBlocks = numberValue(alignment?.summary?.parsedSpeechBlocks ?? result.parsedSpeechBlocks);
    const matchRatio = planned > 0 ? matched / planned : (hostSummary?.matchRatio ?? 0);
    const ingestionSkipped = Boolean(hostSummary?.ingestionSkipped);
    const ingestionSkipReason = hostSummary?.ingestionSkipReason;
    const status = result.status ?? "unknown";
    const harnessIssue =
      hostSummary?.harnessIssue ??
      result.harnessIssue ??
      (planned > 0 && parsedSpeechBlocks === 0 ? "no-speech-parsed" : null);
    const harnessIssueDetail =
      hostSummary?.harnessIssueDetail ??
      result.harnessIssueDetail ??
      result.error ??
      (harnessIssue === "no-speech-parsed"
        ? "No NVDA speech blocks were parsed after navigation."
        : harnessIssue);
    const harnessBlocked = status === "harness-blocked" || Boolean(harnessIssue);
    const evidenceUsable = !harnessBlocked;
    const weak = status === "passed" && evidenceUsable && planned > 0 && matchRatio < minimumMatchRatio;

    const caseRecord = {
      name: result.name ?? caseOut,
      fixture: result.fixture,
      mode: result.mode,
      status,
      output: caseOut,
      plannedTargets: planned,
      parsedSpeechBlocks,
      matchedTargets: matched,
      missingTargets: numberValue(alignment?.summary?.missingTargets ?? result.missingTargets),
      unmatchedSpeechBlocks: numberValue(alignment?.summary?.unmatchedSpeechBlocks ?? result.unmatchedSpeechBlocks),
      matchRatio,
      weak,
      harnessBlocked,
      harnessIssue,
      harnessIssueDetail,
      evidenceUsable,
      retryAttempts: numberValue(result.retryAttempts),
      ingestionSkipped,
      ingestionSkipReason,
      hostUrl: result.hostUrl,
      guestUrl: result.guestUrl ?? hostSummary?.guestUrl,
    };
    cases.push(caseRecord);

    for (const missing of evidenceUsable ? (alignment?.missingTargets ?? []) : []) {
      const target = missing.target ?? {};
      missingTargets.push({
        case: caseRecord.name,
        mode: caseRecord.mode,
        fixture: caseRecord.fixture,
        targetId: target.stateId ? `${target.stateId}:${target.id}` : target.id,
        name: target.name ?? "",
        role: target.role ?? "",
        kind: target.kind ?? "",
        selector: target.selector,
        expectedTokens: missing.expectedTokens ?? target.expectedTokens ?? [],
      });
    }

    const capturedTargets = evidenceUsable ? analysisTargets : [];
    const matchedTargetIds = new Set(
      (alignment?.matches ?? []).map((match) => targetKey(match.target)).filter(Boolean),
    );
    for (const block of evidenceUsable ? (alignment?.unmatchedBlocks ?? []) : []) {
      const category = classifySpeechBlock(block);
      unmatchedSpeech.push({
        case: caseRecord.name,
        mode: caseRecord.mode,
        fixture: caseRecord.fixture,
        category,
        line: block.line,
        timestamp: block.timestamp,
        announcement: block.announcement ?? "",
        tokens: block.tokens ?? [],
      });
      if (category !== "content") continue;
      for (const target of targetsMentionedBySpeech(capturedTargets, block, matchedTargetIds, caseRecord.mode)) {
        unmatchedTargetSpeech.push({
          case: caseRecord.name,
          mode: caseRecord.mode,
          fixture: caseRecord.fixture,
          phase: speechPhase(block, alignment?.matches ?? []),
          line: block.line,
          timestamp: block.timestamp,
          announcement: block.announcement ?? "",
          targetId: target.targetId,
          name: target.name,
          role: target.role,
          kind: target.kind,
          selector: target.selector,
        });
      }
    }

    const payloads = evidenceUsable
      ? await readJsonIfExists(join(caseOut, "observer", "observation-payloads.json"))
      : null;
    for (const payload of Array.isArray(payloads) ? payloads : []) {
      const extraObservedTokens = extraObservedAnnouncementTokens({
        modeled: payload.modeledAnnouncement,
        observed: payload.observedAnnouncement,
      });
      mapperComparisons.push({
        case: caseRecord.name,
        mode: caseRecord.mode,
        fixture: caseRecord.fixture,
        targetName: payload.target?.name ?? payload.observation?.targetName ?? "",
        targetId: payload.observation?.targetId ?? payload.target?.id,
        role: payload.target?.role,
        modeledAnnouncement: payload.modeledAnnouncement,
        observedAnnouncement: payload.observedAnnouncement,
        announcementMatch: Boolean(payload.announcementMatch),
        missingAnnouncementTokens: payload.missingAnnouncementTokens ?? [],
        unexpectedAnnouncementTokens: payload.unexpectedAnnouncementTokens ?? [],
        extraObservedTokens,
      });
    }
  }

  const groups = {
    missingByModeRole: groupMissingTargets(missingTargets),
    unmatchedContentByMode: groupUnmatchedSpeech(unmatchedSpeech, "content"),
    unmatchedNoiseByMode: groupUnmatchedSpeech(unmatchedSpeech, "noise"),
    unmatchedNegativeQuickNavByMode: groupUnmatchedSpeech(unmatchedSpeech, "negative-quick-nav"),
    unmatchedTargetSpeech: groupUnmatchedTargetSpeech(unmatchedTargetSpeech),
    missingAnnouncementTokens: groupMissingAnnouncementTokens(mapperComparisons),
    extraObservedAnnouncementTokens: groupExtraObservedTokens(mapperComparisons),
    extraObservedContextTokens: groupExtraObservedTokens(mapperComparisons, "context", capturedTargetNames),
    extraObservedTargetNameTokens: groupExtraObservedTokens(mapperComparisons, "target-name", capturedTargetNames),
    extraObservedValueTokens: groupExtraObservedTokens(mapperComparisons, "value", capturedTargetNames),
  };

  const totals = {
    cases: cases.length,
    passed: cases.filter((item) => item.status === "passed").length,
    failed: cases.filter((item) => item.status === "failed").length,
    weak: cases.filter((item) => item.weak).length,
    harnessBlocked: cases.filter((item) => item.harnessBlocked).length,
    ingestedCases: cases.filter((item) => item.status === "passed" && !item.ingestionSkipped).length,
    plannedTargets: sum(cases, "plannedTargets"),
    matchedTargets: sum(cases, "matchedTargets"),
    missingTargets: sum(cases, "missingTargets"),
    unmatchedSpeechBlocks: sum(cases, "unmatchedSpeechBlocks"),
  };

  const reviewQueue = {
    schema: "tactual-nvda-vm-batch-review@1",
    generatedAt: new Date().toISOString(),
    batchDir,
    batchSummary: summaryPath,
    minimumMatchRatio,
    totals,
    cases,
    missingTargets,
    unmatchedSpeech,
    unmatchedTargetSpeech,
    mapperComparisons,
    groups,
    scoringSignals: buildScoringSignals({ cases, groups, totals }),
  };

  return {
    summary,
    summaryPath,
    batchDir,
    minimumMatchRatio,
    reviewQueue,
  };
}

function renderMarkdown(report) {
  const queue = report.reviewQueue;
  const lines = [];
  lines.push(`# NVDA VM Calibration Batch`);
  lines.push("");
  lines.push(`Batch: \`${relativePath(queue.batchDir)}\``);
  lines.push(`Generated: ${queue.generatedAt}`);
  lines.push("");
  lines.push("## Totals");
  lines.push("");
  lines.push(
    `- Cases: ${queue.totals.cases} (${queue.totals.passed} passed, ` +
      `${queue.totals.failed} failed, ${queue.totals.weak} weak, ` +
      `${queue.totals.harnessBlocked} harness-blocked)`,
  );
  lines.push(`- Planned targets: ${queue.totals.plannedTargets}`);
  lines.push(`- Matched targets: ${queue.totals.matchedTargets}`);
  lines.push(`- Missing targets: ${queue.totals.missingTargets}`);
  lines.push(`- Unmatched speech blocks: ${queue.totals.unmatchedSpeechBlocks}`);
  lines.push(`- Ingested cases: ${queue.totals.ingestedCases}`);
  lines.push("");

  const scoringSignals = queue.scoringSignals ?? [];
  if (scoringSignals.length > 0) {
    lines.push("## Scoring Signals");
    lines.push("");
    lines.push("These are scoring-model candidates, not automatic score changes.");
    lines.push("");
    for (const signal of scoringSignals.slice(0, 12)) {
      lines.push(
        `- ${signal.id} [${signal.status} ${signal.kind}/${signal.dimension}]: ${signal.summary} ` +
          `(${Math.round(signal.confidence * 100)}% confidence)`,
      );
      lines.push(`  Implication: ${signal.scoringImplication}`);
    }
    lines.push("");
  }

  lines.push("## Case Health");
  lines.push("");
  lines.push("| Case | Mode | Status | Planned | Matched | Missing | Unmatched | Match | Ingested |");
  lines.push("|---|---:|---|---:|---:|---:|---:|---:|---|");
  for (const item of queue.cases) {
    const ingested = item.status === "passed" && !item.ingestionSkipped ? "yes" : item.ingestionSkipReason ?? "no";
    lines.push(
      `| ${escapeCell(item.name)} | ${escapeCell(item.mode ?? "")} | ${escapeCell(item.status)} | ${item.plannedTargets} | ` +
        `${item.matchedTargets} | ${item.missingTargets} | ${item.unmatchedSpeechBlocks} | ` +
        `${Math.round(item.matchRatio * 100)}% | ${escapeCell(ingested)} |`,
    );
  }
  lines.push("");

  const weakCases = queue.cases.filter((item) => item.harnessBlocked || item.weak || item.status === "failed");
  if (weakCases.length > 0) {
    lines.push("## Harness Blockers");
    lines.push("");
    for (const item of weakCases) {
      const reason = item.harnessIssue
        ? `${item.harnessIssue}: ${item.harnessIssueDetail ?? item.ingestionSkipReason ?? "harness evidence unavailable"}`
        : (item.ingestionSkipReason ?? (item.status === "failed" ? "case failed" : "low match ratio"));
      lines.push(`- ${item.name} (${item.mode}): ${Math.round(item.matchRatio * 100)}% matched; ${trimSentenceEnd(reason)}.`);
    }
    lines.push("");
  }

  lines.push("## Missing Target Groups");
  lines.push("");
  const missingGroups = queue.groups.missingByModeRole.slice(0, 12);
  if (missingGroups.length === 0) {
    lines.push("No missing target groups.");
  } else {
    for (const group of missingGroups) {
      lines.push(
        `- ${group.mode}/${group.role || "unknown-role"}/${group.kind || "unknown-kind"}: ` +
          `${group.count} target(s); examples: ${group.examples.join("; ")}`,
      );
    }
  }
  lines.push("");

  lines.push("## Unmatched Content Speech");
  lines.push("");
  const contentGroups = queue.groups.unmatchedContentByMode.slice(0, 12);
  if (contentGroups.length === 0) {
    lines.push("No unmatched content speech groups.");
  } else {
    for (const group of contentGroups) {
      lines.push(`- ${group.mode}: ${group.count} block(s); examples: ${group.examples.join("; ")}`);
    }
  }
  lines.push("");

  const targetSpeechGroups = queue.groups.unmatchedTargetSpeech.slice(0, 12);
  if (targetSpeechGroups.length > 0) {
    lines.push("## Unmatched Speech Referencing Captured Targets");
    lines.push("");
    lines.push("These blocks mention targets Tactual captured but did not match in the planned navigation sequence.");
    lines.push("");
    for (const group of targetSpeechGroups) {
      lines.push(
        `- ${group.mode}/${group.role || "unknown-role"}/${group.phase}: ` +
          `${group.count} target(s); examples: ${group.examples.join("; ")}`,
      );
    }
    lines.push("");
  }

  const missingAnnouncementGroups = queue.groups.missingAnnouncementTokens.slice(0, 12);
  if (missingAnnouncementGroups.length > 0) {
    lines.push("## Announcement Mapper Mismatches");
    lines.push("");
    for (const group of missingAnnouncementGroups) {
      lines.push(`- ${group.token}: ${group.count} target(s); examples: ${group.examples.join("; ")}`);
    }
    lines.push("");
  }

  const extraObservedContextGroups = queue.groups.extraObservedContextTokens.slice(0, 12);
  if (extraObservedContextGroups.length > 0) {
    lines.push("## Extra Observed Context Tokens");
    lines.push("");
    lines.push("These did not fail matching; repeated structural terms are mapper candidates after review.");
    lines.push("");
    for (const group of extraObservedContextGroups) {
      lines.push(`- ${group.token}: ${group.count} target(s); examples: ${group.examples.join("; ")}`);
    }
    lines.push("");
  }

  const extraObservedTargetNameGroups = queue.groups.extraObservedTargetNameTokens.slice(0, 12);
  if (extraObservedTargetNameGroups.length > 0) {
    lines.push("## Extra Observed Target-Name Tokens");
    lines.push("");
    lines.push("These are names of other captured targets that appeared in the same observed speech block.");
    lines.push("");
    for (const group of extraObservedTargetNameGroups) {
      lines.push(`- ${group.token}: ${group.count} target(s); examples: ${group.examples.join("; ")}`);
    }
    lines.push("");
  }

  const extraObservedValueGroups = queue.groups.extraObservedValueTokens.slice(0, 12);
  if (extraObservedValueGroups.length > 0) {
    lines.push("## Extra Observed Value Tokens");
    lines.push("");
    lines.push("These look like current field values or user/page data; preserve them as observations, not mapper phrasing candidates.");
    lines.push("");
    for (const group of extraObservedValueGroups) {
      lines.push(`- ${group.token}: ${group.count} target(s); examples: ${group.examples.join("; ")}`);
    }
    lines.push("");
  }

  lines.push("## Next Calibration Actions");
  lines.push("");
  for (const action of recommendedActions(queue)) {
    lines.push(`- ${action}`);
  }
  return `${lines.join("\n")}\n`;
}

function recommendedActions(queue) {
  const actions = [];
  if (queue.totals.harnessBlocked > 0) {
    actions.push("Resolve harness-blocked runs before reviewing mapper evidence; the VM received input without usable NVDA speech.");
  }
  const weakModes = new Set(queue.cases.filter((item) => item.weak).map((item) => item.mode));
  if (weakModes.has("link") || weakModes.has("form-field")) {
    actions.push("Stabilize browse-mode readiness for link/form-field quick-nav before treating those misses as mapper evidence.");
  }
  if (queue.groups.unmatchedContentByMode.length > 0) {
    actions.push("Review repeated unmatched content speech; promote real page targets into capture/modeling tests when NVDA reaches them consistently.");
  }
  if (queue.groups.unmatchedTargetSpeech.length > 0) {
    actions.push("Review unmatched speech that names captured targets; phase tags separate page-load reading from navigation-order gaps.");
  }
  if (queue.groups.extraObservedContextTokens.length > 0) {
    actions.push("Review extra observed context tokens separately from required mapper tokens; repeated structural terms are candidates for the next announcement-model expansion.");
  }
  if (queue.groups.extraObservedTargetNameTokens.length > 0) {
    actions.push("Review extra observed target-name tokens as speech-block coalescing/order evidence before treating them as mapper phrasing.");
  }
  if (queue.groups.extraObservedValueTokens.length > 0) {
    actions.push("Keep observed value tokens out of generic mapper phrasing unless the target value is explicitly captured and privacy-reviewed.");
  }
  if (queue.groups.missingByModeRole.some((group) => group.role === "searchbox" || group.role === "textbox")) {
    actions.push("Compare form-field misses against focus screenshots and NVDA log offsets; many failures come from focus mode instead of role phrasing.");
  }
  if (queue.missingTargets.some((item) => /frame|iframe|embedded/i.test(`${item.name} ${item.fixture}`))) {
    actions.push("Review iframe misses against descendFrames/OOPIF recovery to separate capture gaps from VM navigation order gaps.");
  }
  if (actions.length === 0) {
    actions.push("Rerun the same batch from a clean VM snapshot and promote repeated mapper mismatches into simulator tests.");
  }
  return actions;
}

function buildScoringSignals({ cases, groups, totals }) {
  const signals = [];
  const usableCases = cases.filter((item) => item.evidenceUsable && item.plannedTargets > 0);
  const plannedTargets = sum(usableCases, "plannedTargets");
  const matchedTargets = sum(usableCases, "matchedTargets");
  const observedReachability = plannedTargets > 0 ? matchedTargets / plannedTargets : 0;

  if (totals.harnessBlocked > 0) {
    signals.push({
      id: "harness-health.blocked",
      kind: "harness-health",
      dimension: "confidence",
      status: "blocked",
      confidence: 1,
      summary: `${totals.harnessBlocked} case(s) blocked by harness health`,
      scoringImplication: "Do not tune scoring weights from blocked cases; rerun after VM/Guest Control evidence is clean.",
      evidence: {
        count: totals.harnessBlocked,
        examples: cases
          .filter((item) => item.harnessBlocked)
          .slice(0, 4)
          .map((item) => `${item.name}:${item.harnessIssue ?? "harness-blocked"}`),
      },
    });
  }

  if (plannedTargets > 0) {
    const weakCases = usableCases.filter((item) => item.weak || item.matchRatio < 0.95);
    signals.push({
      id: "reachability.quick-nav.observed-match",
      kind: "observed-reachability",
      dimension: "reachability",
      status: observedReachability >= 0.95 && weakCases.length === 0 ? "confirmed" : "review",
      confidence: round2(observedReachability),
      summary: `${matchedTargets}/${plannedTargets} planned target(s) matched observed AT navigation`,
      scoringImplication:
        observedReachability >= 0.95
          ? "The calibrated reachable-set model is supported for these fixtures/modes; promote repeated passes into profile-specific quick-nav confidence."
          : "The graph likely over-predicts quick-nav reachability for at least one fixture/mode; review missing roles before changing weights.",
      evidence: {
        count: plannedTargets,
        examples: usableCases
          .slice(0, 4)
          .map((item) => `${item.name}:${item.matchedTargets}/${item.plannedTargets}`),
      },
    });
  }

  if (groups.extraObservedContextTokens.length > 0) {
    signals.push({
      id: "speech.context-verbosity",
      kind: "context-verbosity",
      dimension: "reachability",
      status: "review",
      confidence: groupConfidence(groups.extraObservedContextTokens),
      summary: `${tokenCount(groups.extraObservedContextTokens)} structural/context token occurrence(s) observed beyond the modeled announcement`,
      scoringImplication: "Repeated frame, landmark, region, grouping, autocomplete, and boundary terms are candidates for an AT-specific context verbosity cost.",
      evidence: {
        count: tokenCount(groups.extraObservedContextTokens),
        examples: groupExamples(groups.extraObservedContextTokens),
      },
    });
  }

  if (groups.extraObservedTargetNameTokens.length > 0 || groups.unmatchedTargetSpeech.length > 0) {
    const coalescedCount =
      tokenCount(groups.extraObservedTargetNameTokens) +
      groups.unmatchedTargetSpeech.reduce((sumValue, group) => sumValue + numberValue(group.count), 0);
    signals.push({
      id: "speech.target-name-coalescing",
      kind: "target-name-coalescing",
      dimension: "discoverability",
      status: "review",
      confidence: Math.min(1, 0.45 + coalescedCount / 20),
      summary: `${coalescedCount} observed block(s)/token(s) named captured targets outside the planned match`,
      scoringImplication: "One speech block may cover multiple targets; this can lower raw step count while increasing disambiguation and target-selection load.",
      evidence: {
        count: coalescedCount,
        examples: [
          ...groupExamples(groups.extraObservedTargetNameTokens),
          ...groupExamples(groups.unmatchedTargetSpeech),
        ].slice(0, 4),
      },
    });
  }

  if (groups.missingAnnouncementTokens.length > 0) {
    signals.push({
      id: "announcement.mapper-drift",
      kind: "mapper-phrasing",
      dimension: "confidence",
      status: "review",
      confidence: groupConfidence(groups.missingAnnouncementTokens),
      summary: `${tokenCount(groups.missingAnnouncementTokens)} modeled announcement token miss(es)`,
      scoringImplication: "Treat affected findings as lower-confidence until the announcement mapper or fixture expectation is corrected.",
      evidence: {
        count: tokenCount(groups.missingAnnouncementTokens),
        examples: groupExamples(groups.missingAnnouncementTokens),
      },
    });
  }

  if (groups.extraObservedValueTokens.length > 0) {
    signals.push({
      id: "speech.observed-values",
      kind: "value-speech",
      dimension: "confidence",
      status: "observed-only",
      confidence: groupConfidence(groups.extraObservedValueTokens),
      summary: `${tokenCount(groups.extraObservedValueTokens)} likely value/data token occurrence(s) observed`,
      scoringImplication: "Preserve these as observations for target-specific evidence; do not turn page/user data into generic scoring weights.",
      evidence: {
        count: tokenCount(groups.extraObservedValueTokens),
        examples: groupExamples(groups.extraObservedValueTokens),
      },
    });
  }

  if (signals.length === 0) {
    signals.push({
      id: "calibration.no-actionable-scoring-signal",
      kind: "no-actionable-signal",
      dimension: "confidence",
      status: "confirmed",
      confidence: 1,
      summary: "No scoring-relevant drift detected in this batch",
      scoringImplication: "Use this batch as regression evidence for the current mapper and graph assumptions.",
      evidence: { count: 0, examples: [] },
    });
  }

  return signals.map((signal) => ({
    ...signal,
    confidence: round2(Math.max(0, Math.min(1, signal.confidence))),
  }));
}

function groupConfidence(groups) {
  return Math.min(1, 0.5 + tokenCount(groups) / 20);
}

function tokenCount(groups) {
  return groups.reduce((sumValue, group) => sumValue + numberValue(group.count), 0);
}

function groupExamples(groups) {
  return groups.flatMap((group) => group.examples ?? []).slice(0, 4);
}

function classifySpeechBlock(block) {
  const text = String(block.announcement ?? "").toLowerCase();
  if (/^no (next|previous) /.test(text)) return "negative-quick-nav";
  if (
    text === "unknown" ||
    /chrome legacy window|microsoft edge|good accessibility example window|window$|document$/.test(text)
  ) {
    return "noise";
  }
  return "content";
}

function groupMissingTargets(items) {
  const groups = new Map();
  for (const item of items) {
    const key = `${item.mode}|${item.role}|${item.kind}`;
    const existing = groups.get(key);
    const example = `${item.case}:${item.name || item.targetId || "(unnamed)"}`;
    if (existing) {
      existing.count += 1;
      if (existing.examples.length < 4) existing.examples.push(example);
    } else {
      groups.set(key, {
        mode: item.mode,
        role: item.role,
        kind: item.kind,
        count: 1,
        examples: [example],
      });
    }
  }
  return [...groups.values()].sort((a, b) => b.count - a.count || `${a.mode}`.localeCompare(`${b.mode}`));
}

function groupUnmatchedSpeech(items, category) {
  const groups = new Map();
  for (const item of items) {
    if (item.category !== category) continue;
    const key = `${item.mode}|${normalizeAnnouncement(item.announcement)}`;
    const existing = groups.get(key);
    const example = `${item.case}:${shorten(item.announcement, 90)}`;
    if (existing) {
      existing.count += 1;
      if (existing.examples.length < 4) existing.examples.push(example);
    } else {
      groups.set(key, {
        mode: item.mode,
        announcement: item.announcement,
        count: 1,
        examples: [example],
      });
    }
  }
  return [...groups.values()].sort((a, b) => b.count - a.count || `${a.mode}`.localeCompare(`${b.mode}`));
}

function groupUnmatchedTargetSpeech(items) {
  const groups = new Map();
  for (const item of items) {
    const key = `${item.mode}|${item.role}|${item.kind}|${item.phase}`;
    const existing = groups.get(key);
    const example = `${item.case}:${item.name || item.targetId || "(unnamed)"} -> ${shorten(item.announcement, 70)}`;
    if (existing) {
      existing.count += 1;
      if (existing.examples.length < 4) existing.examples.push(example);
    } else {
      groups.set(key, {
        mode: item.mode,
        role: item.role,
        kind: item.kind,
        phase: item.phase,
        count: 1,
        examples: [example],
      });
    }
  }
  return [...groups.values()].sort((a, b) => b.count - a.count || `${a.mode}`.localeCompare(`${b.mode}`));
}

function groupMissingAnnouncementTokens(items) {
  const groups = new Map();
  for (const item of items) {
    for (const token of item.missingAnnouncementTokens ?? []) {
      const key = normalizeAnnouncement(token);
      if (!key) continue;
      pushTokenGroup(groups, key, `${item.case}:${item.targetName || item.targetId || "(unnamed)"}`);
    }
  }
  return sortedTokenGroups(groups);
}

function groupExtraObservedTokens(items, category, capturedTargetNames = new Set()) {
  const groups = new Map();
  for (const item of items) {
    for (const token of item.extraObservedTokens ?? []) {
      const key = normalizeAnnouncement(token);
      if (!key) continue;
      if (category && classifyExtraObservedToken(item, key, capturedTargetNames) !== category) continue;
      pushTokenGroup(groups, key, `${item.case}:${item.targetName || item.targetId || "(unnamed)"}`);
    }
  }
  return sortedTokenGroups(groups);
}

function classifyExtraObservedToken(item, token, capturedTargetNames = new Set()) {
  const currentTargetName = normalizeAnnouncement(item.targetName ?? "");
  if (capturedTargetNames.has(token) && token !== currentTargetName) return "target-name";
  if (isStructuralContextToken(token)) return "context";
  if (isValueBearingRole(item.role) && token !== "editable") return "value";
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(token)) return "value";
  return "context";
}

function isStructuralContextToken(token) {
  return (
    token === "•" ||
    token === "same page" ||
    token === "grouping" ||
    token === "editable" ||
    token === "form" ||
    token === "frame" ||
    token === "region" ||
    token === "list" ||
    token === "out of list" ||
    token === "has auto complete" ||
    token === "opens list" ||
    token.endsWith(" frame") ||
    token.endsWith(" landmark") ||
    /^with \d+ items?$/.test(token)
  );
}

function isValueBearingRole(role) {
  return new Set(["textbox", "searchbox", "combobox", "spinbutton", "slider", "progressbar"]).has(String(role ?? ""));
}

function targetsFromAnalysis(analysis) {
  const states = Array.isArray(analysis?.states) ? analysis.states : [];
  const targets = [];
  const seen = new Set();
  for (const state of states) {
    for (const target of Array.isArray(state?.targets) ? state.targets : []) {
      const name = normalizeAnnouncement(target?.name);
      if (!isReviewableTargetName(name)) continue;
      const targetId = targetKey({ ...target, stateId: state.id });
      if (!targetId || seen.has(targetId)) continue;
      seen.add(targetId);
      targets.push({
        targetId,
        name: target.name ?? "",
        normalizedName: name,
        role: target.role ?? "",
        kind: target.kind ?? "",
        selector: target.selector,
      });
    }
  }
  return targets;
}

function targetsMentionedBySpeech(targets, block, matchedTargetIds, mode) {
  const text = normalizeAnnouncement(block?.announcement);
  if (!text) return [];
  return targets.filter((target) => {
    if (matchedTargetIds.has(target.targetId)) return false;
    if (!targetRelevantForMode(target, mode)) return false;
    return text.includes(target.normalizedName);
  });
}

function targetRelevantForMode(target, mode) {
  const kind = String(target.kind ?? "");
  const role = String(target.role ?? "");
  switch (mode) {
    case "form-field":
      return (
        kind === "formField" ||
        kind === "button" ||
        kind === "menuTrigger" ||
        kind === "disclosure" ||
        role === "button" ||
        role === "menu button"
      );
    case "button":
      return kind === "button" || kind === "menuTrigger" || kind === "disclosure" || role === "button";
    case "heading":
      return kind === "heading" || role === "heading";
    case "link":
      return kind === "link" || role === "link";
    case "landmark":
      return kind === "landmark" || role.endsWith("landmark");
    case "tab":
      return kind === "tab" || role === "tab";
    default:
      return !new Set(["heading", "landmark"]).has(kind);
  }
}

function isReviewableTargetName(name) {
  if (!name || name.length < 4) return false;
  if (new Set(["main", "home", "form", "menu", "search"]).has(name)) return false;
  return true;
}

function speechPhase(block, matches) {
  const matchIndexes = matches
    .map((match) => numberValue(match.block?.index))
    .filter((index) => Number.isFinite(index));
  if (matchIndexes.length === 0) return "no-matches";
  const blockIndex = numberValue(block?.index);
  const first = Math.min(...matchIndexes);
  const last = Math.max(...matchIndexes);
  if (blockIndex < first) return "before-first-match";
  if (blockIndex > last) return "after-last-match";
  return "between-matches";
}

function targetKey(target) {
  if (!target?.id) return "";
  return target.stateId ? `${target.stateId}:${target.id}` : target.id;
}

function pushTokenGroup(groups, token, example) {
  const existing = groups.get(token);
  if (existing) {
    existing.count += 1;
    if (existing.examples.length < 4) existing.examples.push(example);
  } else {
    groups.set(token, { token, count: 1, examples: [example] });
  }
}

function sortedTokenGroups(groups) {
  return [...groups.values()].sort((a, b) => b.count - a.count || a.token.localeCompare(b.token));
}

function extraObservedAnnouncementTokens(args) {
  const modeled = announcementTokens(args.modeled);
  const observed = announcementTokens(args.observed);
  return observed.filter((token) => !modeled.some((expected) => tokenCovers(expected, token)));
}

function announcementTokens(value) {
  return String(value ?? "")
    .split(",")
    .map(normalizeAnnouncement)
    .filter(Boolean);
}

function tokenCovers(expected, observed) {
  return expected.includes(observed) || observed.includes(expected);
}

function parseArgs(argv) {
  const opts = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      opts.help = true;
      continue;
    }
    if (!arg.startsWith("--")) throw new Error(`Unexpected positional argument: ${arg}`);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`Missing value for ${arg}`);
    index += 1;
    opts[toCamel(arg)] = value;
  }
  return opts;
}

function toCamel(flag) {
  return flag.replace(/^--/, "").replace(/-([a-z])/g, (_, char) => char.toUpperCase());
}

function resolveSummaryPath(batch) {
  const absolute = resolve(batch);
  if (absolute.endsWith(".json")) return absolute;
  return join(absolute, "batch-summary.json");
}

async function readJson(path) {
  const text = await readFile(path, "utf-8");
  return JSON.parse(stripBom(text));
}

async function readJsonIfExists(path) {
  if (!existsSync(path)) return null;
  return readJson(path);
}

async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf-8");
}

async function writeText(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, value, "utf-8");
}

function parseNumber(value, fallback) {
  if (value === undefined || value === null || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`Expected a number, got ${value}`);
  return parsed;
}

function numberValue(value) {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function round2(value) {
  return Math.round(value * 100) / 100;
}

function sum(items, key) {
  return items.reduce((total, item) => total + numberValue(item[key]), 0);
}

function normalizeAnnouncement(value) {
  return String(value ?? "").toLowerCase().replace(/\s+/g, " ").trim();
}

function stripBom(value) {
  return value.charCodeAt(0) === 0xfeff ? value.slice(1) : value;
}

function shorten(value, max) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  return text.length <= max ? text : `${text.slice(0, max - 1)}...`;
}

function trimSentenceEnd(value) {
  return String(value ?? "").replace(/\.+$/g, "");
}

function escapeCell(value) {
  return String(value ?? "").replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

function relativePath(path) {
  const rel = path.startsWith(root) ? path.slice(root.length).replace(/^[/\\]/, "") : path;
  return rel.replace(/\\/g, "/");
}

function isMainModule() {
  if (!process.argv[1]) return false;
  return import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
}
