#!/usr/bin/env node

/**
 * Calibration matrix reporter.
 *
 * The corpus audit answers whether enough evidence exists. This script turns
 * that evidence into tuning queues: per-profile/mode/role/fixture error,
 * variance, and provenance. It intentionally reads the built calibration
 * package so the matrix reflects the same public API that release users get.
 */

import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const DEFAULT_ROOT = "calibration/corpus";

if (isMainModule()) {
  await runCli(process.argv.slice(2)).catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}

async function runCli(args) {
  if (args.includes("--help") || args.includes("-h")) {
    console.log(helpText());
    return;
  }

  const opts = parseOptions(args);
  const matrix = await buildCalibrationMatrix({
    root: opts.root ?? DEFAULT_ROOT,
  });
  const format = String(opts.format ?? "markdown").toLowerCase();
  const output = format === "json" ? `${JSON.stringify(matrix, null, 2)}\n` : formatMatrix(matrix);
  if (opts.output) {
    await ensureDir(dirname(resolvePath(opts.output)));
    await writeFile(resolvePath(opts.output), output, "utf-8");
    console.error(`Wrote ${opts.output}`);
  } else {
    console.log(output);
  }
}

async function buildCalibrationMatrix(options) {
  const { runCalibration } = await loadCalibrationApi();
  const root = resolvePath(options.root);
  const corpusDirs = await listCorpusDirs(root);
  const observations = [];
  const unmatched = [];

  for (const corpusDir of corpusDirs) {
    const datasetPath = join(corpusDir, "dataset.json");
    if (!existsSync(datasetPath)) continue;

    const dataset = await readJson(datasetPath, "dataset");
    const analyses = await readCorpusAnalyses(root, corpusDir);
    const sequencePlanIndex = await readSequencePlanIndex(corpusDir);
    const corpus = basename(corpusDir);

    for (const [index, observation] of (dataset.observations ?? []).entries()) {
      const targetInfo = findObservationTarget(analyses, observation);
      const role = targetInfo?.role ?? observationRole(observation);
      const report = runCalibration(
        {
          name: `${dataset.name ?? corpus}:${index}`,
          collectedAt: dataset.collectedAt ?? dataset.corpusMetadata?.importedAt ?? new Date(0).toISOString(),
          observations: [observation],
          announcementObservations: [],
        },
        analyses,
      );
      const result = report.results[0];
      if (!result) {
        unmatched.push({
          corpus,
          target: observation.targetName,
          url: observation.url,
          mode: observationMode(observation),
          role,
        });
        continue;
      }

      const predicted = Number(result.predictedPathCost);
      const actual = Number(result.actualSteps);
      const bias = actual - predicted;
      const planMatch = findSequencePlanMatch(sequencePlanIndex, observation);
      const planDrift = isSequencePlanDrift({ observation, predicted, actual, planMatch });
      const trustedReachability = !planDrift && observation?.observationUse?.reachability !== false;
      observations.push({
        corpus,
        profile: observation.profileId ?? result.profileId ?? "unknown",
        mode: observationMode(observation),
        role,
        kind: targetInfo?.kind,
        fixture: fixtureKey(observation.url),
        source: observation.observationSource ?? observation.announcementSource ?? "manual-sr",
        scripted: isScriptedFullObservation(observation),
        target: observation.targetName,
        targetId: observation.targetId,
        predicted,
        actual,
        absoluteError: Math.abs(bias),
        bias,
        trustedReachability,
        planDrift,
        sequencePlanIndex: planMatch?.index,
        sequencePlanCase: planMatch?.caseName,
        severityMatch: result.severityMatch,
        predictedSeverity: result.predictedSeverity,
        groundTruthSeverity: result.groundTruthSeverity,
        announcementAccuracy: result.announcementAccuracy,
      });
    }
  }

  const trustedObservations = observations.filter((item) => item.trustedReachability);
  const groups = {
    profile: summarizeGroups(trustedObservations, (item) => item.profile),
    mode: summarizeGroups(trustedObservations, (item) => item.mode),
    role: summarizeGroups(trustedObservations, (item) => item.role),
    fixture: summarizeGroups(trustedObservations, (item) => item.fixture),
    source: summarizeGroups(trustedObservations, (item) => item.source),
    corpus: summarizeGroups(trustedObservations, (item) => item.corpus),
    profileMode: summarizeGroups(trustedObservations, (item) => `${item.profile} / ${item.mode}`),
    modeRole: summarizeGroups(trustedObservations, (item) => `${item.mode} / ${item.role}`),
    fixtureMode: summarizeGroups(trustedObservations, (item) => `${item.fixture} / ${item.mode}`),
  };
  const planDriftObservations = observations.filter((item) => item.planDrift);

  return {
    schema: "tactual-calibration-matrix@1",
    generatedAt: new Date().toISOString(),
    root: relativePath(root),
    totals: {
      observations: observations.length,
      unmatched: unmatched.length,
      reachabilityTrusted: trustedObservations.length,
      sequencePlanDrift: planDriftObservations.length,
      scripted: observations.filter((item) => item.scripted).length,
      manual: observations.filter((item) => !item.scripted).length,
      profiles: new Set(observations.map((item) => item.profile)).size,
      modes: new Set(observations.map((item) => item.mode)).size,
      roles: new Set(observations.map((item) => item.role)).size,
      fixtures: new Set(observations.map((item) => item.fixture)).size,
    },
    overall: summarizeGroup("trusted reachability", trustedObservations),
    allOverall: summarizeGroup("all matched observations", observations),
    groups,
    tuningQueue: buildTuningQueue(groups),
    sequencePlanDrift: planDriftObservations
      .sort((a, b) => b.absoluteError - a.absoluteError || a.target.localeCompare(b.target))
      .slice(0, 20)
      .map((item) => ({
        corpus: item.corpus,
        case: item.sequencePlanCase,
        target: item.target,
        mode: item.mode,
        role: item.role,
        planIndex: item.sequencePlanIndex,
        currentPrediction: item.predicted,
        observedSteps: item.actual,
      })),
    unmatched,
    notes: [
      "Positive bias means observed steps exceeded predicted path cost, so Tactual was optimistic.",
      "Scripted VM records should tune reachability/action-cost assumptions before subjective scoring weights.",
      "Sequence-plan drift means an older VM plan omitted targets the current model now includes; keep those records for announcement evidence, but exclude them from reachability tuning.",
      "Severity accuracy is only score-tuning evidence for manual full observations; scripted VM difficulty ratings are proxy metadata.",
      "High variance groups need repeat runs or fixture isolation before changing weights.",
    ],
  };
}

function summarizeGroups(items, keyFn) {
  const grouped = new Map();
  for (const item of items) {
    const key = keyFn(item) || "unknown";
    const group = grouped.get(key) ?? [];
    group.push(item);
    grouped.set(key, group);
  }
  return [...grouped.entries()]
    .map(([name, groupItems]) => summarizeGroup(name, groupItems))
    .sort((a, b) => b.count - a.count || b.mae - a.mae || a.name.localeCompare(b.name));
}

function summarizeGroup(name, items) {
  const count = items.length;
  const predicted = items.map((item) => item.predicted);
  const actual = items.map((item) => item.actual);
  const errors = items.map((item) => item.bias);
  const absoluteErrors = items.map((item) => item.absoluteError);
  const announcementAccuracies = items
    .map((item) => item.announcementAccuracy)
    .filter((value) => Number.isFinite(value));
  return {
    name,
    count,
    scripted: items.filter((item) => item.scripted).length,
    manual: items.filter((item) => !item.scripted).length,
    predictedAvg: round(mean(predicted)),
    actualAvg: round(mean(actual)),
    mae: round(mean(absoluteErrors)),
    bias: round(mean(errors)),
    errorVariance: round(variance(errors)),
    actualStepVariance: round(variance(actual)),
    severityAccuracy: round(count > 0 ? items.filter((item) => item.severityMatch).length / count : 0),
    announcementAccuracy: round(announcementAccuracies.length > 0 ? mean(announcementAccuracies) : 0),
    examples: [...items]
      .sort((a, b) => b.absoluteError - a.absoluteError || a.target.localeCompare(b.target))
      .slice(0, 4)
      .map((item) => ({
        target: item.target,
        corpus: item.corpus,
        mode: item.mode,
        role: item.role,
        predicted: item.predicted,
        actual: item.actual,
        bias: round(item.bias),
      })),
  };
}

function buildTuningQueue(groups) {
  const candidates = [
    ...groups.mode.map((item) => ({ dimension: "mode", ...item })),
    ...groups.modeRole.map((item) => ({ dimension: "modeRole", ...item })),
    ...groups.fixtureMode.map((item) => ({ dimension: "fixtureMode", ...item })),
  ];
  return candidates
    .filter((item) => item.count >= 2 && (item.mae > 0 || Math.abs(item.bias) > 0))
    .sort((a, b) => b.mae - a.mae || Math.abs(b.bias) - Math.abs(a.bias) || b.count - a.count)
    .slice(0, 20);
}

function formatMatrix(matrix) {
  const lines = [];
  lines.push("# Calibration Matrix");
  lines.push(`Generated: ${matrix.generatedAt}`);
  lines.push(`Root: ${matrix.root}`);
  lines.push("");
  lines.push("## Totals");
  lines.push(`- Full observations matched: ${matrix.totals.observations}`);
  lines.push(`- Unmatched full observations: ${matrix.totals.unmatched}`);
  lines.push(`- Trusted reachability observations: ${matrix.totals.reachabilityTrusted}`);
  lines.push(`- Sequence-plan drift observations excluded from tuning: ${matrix.totals.sequencePlanDrift}`);
  lines.push(`- Scripted full observations: ${matrix.totals.scripted}`);
  lines.push(`- Manual full observations: ${matrix.totals.manual}`);
  lines.push(`- Profiles: ${matrix.totals.profiles}`);
  lines.push(`- Modes: ${matrix.totals.modes}`);
  lines.push(`- Roles: ${matrix.totals.roles}`);
  lines.push(`- Fixtures: ${matrix.totals.fixtures}`);
  lines.push("");
  lines.push("## Trusted Reachability Fit");
  lines.push(`- MAE: ${matrix.overall.mae} step(s)`);
  lines.push(`- Bias: ${formatSigned(matrix.overall.bias)} step(s)`);
  lines.push(`- Error variance: ${matrix.overall.errorVariance}`);
  lines.push(`- Severity accuracy: ${Math.round(matrix.overall.severityAccuracy * 100)}%`);
  if (matrix.totals.sequencePlanDrift > 0) {
    lines.push("");
    lines.push("## All Matched Observations Before Drift Exclusion");
    lines.push(`- MAE: ${matrix.allOverall.mae} step(s)`);
    lines.push(`- Bias: ${formatSigned(matrix.allOverall.bias)} step(s)`);
    lines.push(`- Error variance: ${matrix.allOverall.errorVariance}`);
  }
  lines.push("");
  lines.push("## Tuning Queue");
  if (matrix.tuningQueue.length === 0) {
    lines.push("- No non-zero trusted reachability drift groups found.");
  } else {
    for (const item of matrix.tuningQueue.slice(0, 12)) {
      lines.push(
        `- ${item.dimension} ${item.name}: count=${item.count}, MAE=${item.mae}, bias=${formatSigned(item.bias)}, variance=${item.errorVariance}`,
      );
      for (const example of item.examples.slice(0, 2)) {
        lines.push(
          `  - ${example.target}: predicted=${example.predicted}, observed=${example.actual}, bias=${formatSigned(example.bias)} (${example.corpus})`,
        );
      }
    }
  }
  if (matrix.sequencePlanDrift.length > 0) {
    lines.push("");
    lines.push("## Sequence Plan Drift");
    for (const item of matrix.sequencePlanDrift.slice(0, 10)) {
      lines.push(
        `- ${item.corpus}/${item.case}: ${item.target} (${item.mode}/${item.role}) plan=${item.planIndex}, current=${item.currentPrediction}, observed=${item.observedSteps}`,
      );
    }
  }
  lines.push("");
  lines.push("## By Mode");
  lines.push(formatTable(matrix.groups.mode));
  lines.push("");
  lines.push("## By Role");
  lines.push(formatTable(matrix.groups.role));
  lines.push("");
  lines.push("## Notes");
  for (const note of matrix.notes) lines.push(`- ${note}`);
  if (matrix.unmatched.length > 0) {
    lines.push("");
    lines.push("## Unmatched");
    for (const item of matrix.unmatched.slice(0, 10)) {
      lines.push(`- ${item.corpus}: ${item.target} (${item.mode}/${item.role}) ${item.url}`);
    }
  }
  return `${lines.join("\n")}\n`;
}

function formatTable(rows) {
  const lines = [
    "| Group | Count | Scripted | Manual | MAE | Bias | Error Var | Step Var | Severity |",
    "|---|---:|---:|---:|---:|---:|---:|---:|---:|",
  ];
  for (const row of rows.slice(0, 20)) {
    lines.push(
      `| ${row.name} | ${row.count} | ${row.scripted} | ${row.manual} | ${row.mae} | ${formatSigned(row.bias)} | ${row.errorVariance} | ${row.actualStepVariance} | ${Math.round(row.severityAccuracy * 100)}% |`,
    );
  }
  return lines.join("\n");
}

async function readAnalyses(analysesDir) {
  const analyses = new Map();
  if (!existsSync(analysesDir)) return analyses;
  for (const entry of await readdir(analysesDir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const analysis = await readJson(join(analysesDir, entry.name), "analysis");
    for (const url of analysisUrls(analysis)) analyses.set(url, analysis);
  }
  return analyses;
}

async function readCorpusAnalyses(root, corpusDir) {
  const shared = await readAnalyses(join(root, "analyses"));
  const local = await readAnalyses(join(corpusDir, "analyses"));
  return new Map([...shared, ...local]);
}

async function readSequencePlanIndex(corpusDir) {
  const index = new Map();
  const evidenceDir = join(corpusDir, "evidence");
  if (!existsSync(evidenceDir)) return index;

  for (const planPath of await findFilesNamed(evidenceDir, "sequence-plan.json")) {
    const plan = await readJson(planPath, "sequence plan");
    const mode = typeof plan?.mode === "string" ? plan.mode : "unknown";
    const caseName = basename(dirname(planPath));
    for (const target of plan?.targets ?? []) {
      if (!target || typeof target !== "object") continue;
      const id = typeof target.id === "string" ? target.id : "";
      const stateId = typeof target.stateId === "string" ? target.stateId : "";
      const fullId = stateId && id ? `${stateId}:${id}` : id;
      const targetIndex = Number(target.index);
      if (!fullId || !Number.isFinite(targetIndex)) continue;
      const entry = {
        caseName,
        mode,
        index: targetIndex,
        targetCount: Number(plan.targetCount ?? plan.targets?.length ?? 0),
        planPath: relativePath(planPath),
      };
      index.set(sequencePlanKey(mode, fullId), entry);
      index.set(sequencePlanKey(mode, id), entry);
    }
  }
  return index;
}

async function findFilesNamed(dir, fileName) {
  const matches = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      matches.push(...await findFilesNamed(fullPath, fileName));
    } else if (entry.isFile() && entry.name === fileName) {
      matches.push(fullPath);
    }
  }
  return matches;
}

function findSequencePlanMatch(sequencePlanIndex, observation) {
  const mode = observationMode(observation);
  const targetId = typeof observation.targetId === "string" ? observation.targetId : "";
  if (!targetId) return null;
  return (
    sequencePlanIndex.get(sequencePlanKey(mode, targetId)) ??
    sequencePlanIndex.get(sequencePlanKey(mode, targetId.split(":").slice(1).join(":"))) ??
    null
  );
}

function isSequencePlanDrift({ observation, predicted, actual, planMatch }) {
  if (!isScriptedFullObservation(observation) || !planMatch) return false;
  const followsPlanIndex = Math.abs(actual - planMatch.index) < 0.01;
  const disagreesWithCurrentModel = Math.abs(predicted - actual) > 0.01;
  return followsPlanIndex && disagreesWithCurrentModel;
}

function sequencePlanKey(mode, targetId) {
  return `${mode}::${targetId}`;
}

function analysisUrls(analysis) {
  const urls = new Set();
  if (typeof analysis?.flow?.name === "string") urls.add(analysis.flow.name);
  for (const state of analysis?.states ?? []) {
    if (typeof state?.url === "string") urls.add(state.url);
  }
  return urls;
}

function findObservationTarget(analyses, observation) {
  const direct = typeof observation?.url === "string" ? analyses.get(observation.url) : undefined;
  const ordered = [];
  if (direct) ordered.push(direct);
  for (const analysis of new Set(analyses.values())) {
    if (analysis !== direct) ordered.push(analysis);
  }

  for (const analysis of ordered) {
    for (const state of analysis?.states ?? []) {
      for (const target of state?.targets ?? []) {
        if (targetMatchesObservation(state, target, observation)) return target;
      }
    }
  }
  return null;
}

function targetMatchesObservation(state, target, observation) {
  const observationTargetId = typeof observation?.targetId === "string" ? observation.targetId : "";
  const targetId = typeof target?.id === "string" ? target.id : "";
  const stateId = typeof state?.id === "string" ? state.id : "";
  const fullTargetId = stateId && targetId ? `${stateId}:${targetId}` : targetId;
  if (observationTargetId && targetId) {
    if (observationTargetId === targetId || observationTargetId === fullTargetId) return true;
    if (observationTargetId.endsWith(`:${targetId}`)) return true;
  }

  const observationSelector = typeof observation?.targetSelector === "string" ? observation.targetSelector : "";
  if (observationSelector && typeof target?.selector === "string" && observationSelector === target.selector) {
    return true;
  }

  const observationName = normalizeMatrixText(observation?.targetName);
  const targetName = normalizeMatrixText(target?.name);
  if (observationName && targetName && observationName === targetName) {
    const observedRole = observationRole(observation);
    return observedRole === "unknown" || observedRole === target.role || observedRole === target.kind;
  }
  return false;
}

async function listCorpusDirs(root) {
  if (!existsSync(root)) return [];
  const entries = await readdir(root, { withFileTypes: true });
  return entries.filter((entry) => entry.isDirectory()).map((entry) => join(root, entry.name));
}

async function loadCalibrationApi() {
  const distPath = join(repoRoot, "dist", "calibration", "index.js");
  if (!existsSync(distPath)) {
    throw new Error("Built calibration API not found. Run `npm run build` before `npm run calibration:matrix`.");
  }
  return import(pathToFileURL(distPath).href);
}

function normalizeMatrixText(value) {
  return String(value ?? "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function observationMode(observation) {
  const notes = typeof observation.announcementNotes === "string" ? observation.announcementNotes : "";
  const match = notes.match(/\bmode=([^;\s]+)/);
  return match?.[1] ?? observation.strategyUsed ?? "unknown";
}

function observationRole(observation) {
  const id = typeof observation.targetId === "string" ? observation.targetId : "";
  const parts = id.split(":");
  if (parts.length >= 2) return parts[parts.length - 2].replace(/^f\d+\./, "");
  const selector = typeof observation.targetSelector === "string" ? observation.targetSelector : "";
  const roleMatch = selector.match(/getByRole\('([^']+)'/);
  return roleMatch?.[1] ?? "unknown";
}

function fixtureKey(url) {
  if (typeof url !== "string") return "unknown";
  return url.startsWith("tactual-fixture://") ? url.slice("tactual-fixture://".length) : url;
}

function isScriptedFullObservation(observation) {
  return (
    observation?.observationSource === "nvda-vm-scripted" ||
    observation?.observationUse?.operability === false ||
    observation?.observationUse?.recovery === false
  );
}

function mean(values) {
  return values.length > 0 ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function variance(values) {
  if (values.length < 2) return 0;
  const avg = mean(values);
  return mean(values.map((value) => (value - avg) ** 2));
}

function round(value) {
  return Math.round((Number.isFinite(value) ? value : 0) * 100) / 100;
}

function formatSigned(value) {
  return `${value > 0 ? "+" : ""}${round(value)}`;
}

function parseOptions(args) {
  const opts = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg.startsWith("--")) throw new Error(`Unexpected positional argument: ${arg}`);
    const [rawKey, inlineValue] = arg.slice(2).split("=", 2);
    const value = inlineValue ?? args[++i];
    if (value === undefined || value.startsWith("--")) throw new Error(`Missing value for --${rawKey}`);
    opts[rawKey] = value;
  }
  return opts;
}

async function readJson(path, label) {
  try {
    return JSON.parse(await readFile(path, "utf-8"));
  } catch (err) {
    throw new Error(`Could not read ${label} ${path}: ${err instanceof Error ? err.message : String(err)}`, {
      cause: err,
    });
  }
}

async function ensureDir(path) {
  await mkdir(path, { recursive: true });
}

function resolvePath(path) {
  return resolve(repoRoot, path);
}

function relativePath(path) {
  return relative(repoRoot, resolvePath(path)).replace(/\\/g, "/");
}

function isMainModule() {
  return process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1];
}

function helpText() {
  return `Calibration matrix reporter

Usage:
  node scripts/calibration-matrix.mjs [--root calibration/corpus] [--format markdown|json] [--output <file>]

Requires:
  npm run build

Outputs per-mode, per-role, per-fixture, and tuning-queue reachability error
from versioned full calibration observations. Scripted records whose imported
sequence plans drifted from the current mapper are reported separately and
excluded from the reachability tuning queue.
`;
}
