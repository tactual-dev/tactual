#!/usr/bin/env node

/**
 * Calibration corpus utility.
 *
 * The VM batch helpers produce rich local build artifacts, but build/ is not a
 * durable release input. This script imports selected batches into a portable
 * corpus directory and audits whether that corpus is broad enough for mapper
 * confidence or score-weight tuning. The portable corpus keeps observations,
 * manifests, analysis snapshots, and sequence plans; detailed review queues,
 * speech alignment dumps, and batch reports stay in build/ unless a reviewer
 * explicitly promotes them.
 */

import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const DEFAULT_ROOT = "calibration/corpus";
const DEFAULT_FULL_GOAL = 50;
const DEFAULT_ANNOUNCEMENT_GOAL = 50;

if (isMainModule()) {
  await runCli(process.argv.slice(2)).catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}

async function runCli(args) {
  const command = args[0];
  if (!command || command === "--help" || command === "-h") {
    console.log(helpText());
    return;
  }

  if (command === "import-nvda-batch") {
    const opts = parseOptions(args.slice(1));
    await importNvdaBatch({
      batch: requiredOption(opts, "batch"),
      out: opts.out ?? join(DEFAULT_ROOT, slugFromPath(requiredOption(opts, "batch"))),
      label: opts.label,
      replace: opts.replace === true,
      deriveFullObservations: opts["derive-full-observations"] === true,
    });
    return;
  }

  if (command === "audit") {
    const opts = parseOptions(args.slice(1));
    const audit = await auditCorpus({
      root: opts.root ?? DEFAULT_ROOT,
      fullGoal: numberOption(opts, "full-goal", DEFAULT_FULL_GOAL),
      announcementGoal: numberOption(opts, "announcement-goal", DEFAULT_ANNOUNCEMENT_GOAL),
    });
    const format = String(opts.format ?? "markdown").toLowerCase();
    const output = format === "json" ? `${JSON.stringify(audit, null, 2)}\n` : formatAudit(audit);
    if (opts.output) {
      await ensureDir(dirname(resolvePath(opts.output)));
      await writeFile(resolvePath(opts.output), output, "utf-8");
      console.error(`Wrote ${opts.output}`);
    } else {
      console.log(output);
    }
    return;
  }

  throw new Error(`Unknown calibration corpus command: ${command}`);
}

async function importNvdaBatch(options) {
  const batchDir = resolvePath(options.batch);
  const outDir = resolvePath(options.out);
  const reviewQueuePath = join(batchDir, "review-queue.json");
  const calibrationPath = join(batchDir, "calibration.json");

  const reviewQueue = await readJson(reviewQueuePath, "review queue");
  const dataset = await readJson(calibrationPath, "calibration dataset");

  if (options.replace) {
    await rm(outDir, { recursive: true, force: true });
  } else if (existsSync(outDir)) {
    throw new Error(`Output directory already exists: ${outDir}. Pass --replace to overwrite.`);
  }

  await ensureDir(join(outDir, "analyses"));
  await ensureDir(join(outDir, "evidence"));

  const cases = Array.isArray(reviewQueue.cases) ? reviewQueue.cases : [];
  const canonicalByObservedUrl = buildCanonicalUrlMap(cases);
  const importedAnalyses = [];
  const importedEvidence = [];
  const seenFixtureUrls = new Set();

  for (const item of cases) {
    if (!item || typeof item !== "object") continue;
    const output = typeof item.output === "string" ? item.output : undefined;
    const fixture = typeof item.fixture === "string" ? item.fixture : undefined;
    if (!output || !fixture) continue;
    const canonicalUrl = canonicalFixtureUrl(fixture);
    if (seenFixtureUrls.has(canonicalUrl)) continue;
    seenFixtureUrls.add(canonicalUrl);

    const analysisPath = join(output, "analysis.full.json");
    if (!existsSync(analysisPath)) continue;
    const analysis = await readJson(analysisPath, "analysis");
    rewriteAnalysisUrls(analysis, canonicalUrl);
    const analysisFile = `${safeFileStem(fixture)}.analysis.full.json`;
    await writeJson(join(outDir, "analyses", analysisFile), analysis);
    importedAnalyses.push({
      fixture,
      canonicalUrl,
      analysis: `analyses/${analysisFile}`,
    });
  }

  rewriteDatasetUrls(dataset, canonicalByObservedUrl);
  if (options.deriveFullObservations) {
    const derived = await deriveFullObservationsFromCases(cases, importedEvidence, outDir);
    dataset.observations = [...(dataset.observations ?? []), ...derived];
    rewriteDatasetUrls(dataset, canonicalByObservedUrl);
  }
  dataset.name = options.label ?? dataset.name ?? slugFromPath(batchDir);
  dataset.corpusMetadata = {
    schema: "tactual-calibration-corpus-dataset@1",
    importedAt: new Date().toISOString(),
    transientUrlsRewritten: true,
  };

  const manifest = {
    schema: "tactual-calibration-corpus-manifest@1",
    label: dataset.name,
    importedAt: dataset.corpusMetadata.importedAt,
    dataset: "dataset.json",
    analysesDir: "analyses",
    cases: cases.map((item) => ({
      name: item.name,
      fixture: item.fixture,
      mode: item.mode,
      status: item.status,
      plannedTargets: item.plannedTargets,
      matchedTargets: item.matchedTargets,
      missingTargets: item.missingTargets,
      unmatchedSpeechBlocks: item.unmatchedSpeechBlocks,
      evidenceUsable: item.evidenceUsable,
      canonicalUrl: item.fixture ? canonicalFixtureUrl(item.fixture) : undefined,
    })),
    importedAnalyses,
    importedEvidence,
    totals: reviewQueue.totals ?? {},
    scoringSignals: reviewQueue.scoringSignals ?? [],
  };

  await writeJson(join(outDir, "dataset.json"), dataset);
  await writeJson(join(outDir, "manifest.json"), manifest);

  console.log(`Imported ${relativePath(batchDir)} -> ${relativePath(outDir)}`);
  console.log(`  Announcement observations: ${(dataset.announcementObservations ?? []).length}`);
  console.log(`  Full observations: ${(dataset.observations ?? []).length}`);
  console.log(`  Analyses: ${importedAnalyses.length}`);
}

async function deriveFullObservationsFromCases(cases, importedEvidence, outDir) {
  const observations = [];

  for (const item of cases) {
    if (!item || typeof item !== "object") continue;
    if (item.evidenceUsable === false || item.ingestionSkipped === true) continue;

    const output = typeof item.output === "string" ? item.output : undefined;
    const fixture = typeof item.fixture === "string" ? item.fixture : undefined;
    if (!output || !fixture) continue;

    const alignmentPath = join(output, "sequence-alignment.json");
    const planPath = join(output, "sequence-plan.json");
    if (!existsSync(alignmentPath)) continue;

    const alignment = await readJson(alignmentPath, "sequence alignment");
    const plan = existsSync(planPath) ? await readJson(planPath, "sequence plan") : null;
    const canonicalUrl = canonicalFixtureUrl(fixture);
    const evidenceDir = join("evidence", safeFileStem(item.name ?? fixture));

    await copySequencePlanFile(planPath, evidenceDir, importedEvidence, outDir, canonicalUrl);

    for (const match of alignment.matches ?? []) {
      const target = match?.target;
      const block = match?.block;
      if (!target || !block) continue;
      if (Array.isArray(match.missingTokens) && match.missingTokens.length > 0) continue;

      const actualSteps = Number(target.index);
      if (!Number.isFinite(actualSteps) || actualSteps < 1) continue;

      const mode = target.mode ?? item.mode ?? alignment.plan?.mode ?? plan?.mode ?? "unknown";
      const targetName = String(target.name ?? "").trim() || String(target.id ?? "target");
      const targetId = `${target.stateId}:${target.id}`;
      const observedAnnouncement = String(block.announcement ?? "").trim();
      const tokens = Array.isArray(block.tokens) ? block.tokens.map(String).filter(Boolean) : [];

      observations.push({
        url: canonicalUrl,
        profileId: plan?.profile ?? "nvda-desktop-v0",
        targetName,
        targetId,
        targetSelector: target.selector,
        observedAnnouncement,
        observedAnnouncementTokens: tokens,
        announcementSource: "nvda-vm",
        atVersion: "NVDA 2026.1.1",
        browser: "Microsoft Edge (guest)",
        testerId: "vm-nvda-scripted",
        timestamp: alignment.generatedAt ?? plan?.createdAt ?? new Date().toISOString(),
        announcementNotes:
          `nvda-vm full ${actualSteps} ${target.id}; mode=${mode}; speechLine=${block.line ?? "unknown"}; ` +
          `matched=${(match.matchedTokens ?? []).join("|")}; source=scripted-sequence`,

        actualStepsToReach: actualSteps,
        strategyUsed: mode,
        requiredStrategySwitch: false,
        knewTargetExisted: true,
        timeToDiscoverSeconds: actualSteps,
        discoveryMethod: `scripted-${mode}-sequence`,
        couldOperate: true,
        operabilityNotes:
          "Scripted VM sequence confirmed reachability and announcement; activation was not exercised.",
        couldRecover: true,
        recoverySteps: 0,
        difficultyRating: difficultyFromSteps(actualSteps),
        observationSource: "nvda-vm-scripted",
        observationUse: {
          reachability: true,
          announcement: true,
          discoverability: "proxy",
          severity: "proxy",
          operability: false,
          recovery: false,
          notes:
            "Derived from deterministic NVDA quick-navigation sequence. Use for reachability/action-cost calibration before subjective score-weight tuning.",
        },
      });
    }
  }

  return observations;
}

async function copySequencePlanFile(sourcePath, evidenceDir, importedEvidence, outDir, canonicalUrl) {
  if (!existsSync(sourcePath)) return;
  const relativeTarget = join(evidenceDir, basename(sourcePath)).replace(/\\/g, "/");
  const plan = await readJson(sourcePath, "sequence plan");
  delete plan.analysisPath;
  plan.url = canonicalUrl;
  await ensureDir(join(outDir, evidenceDir));
  await writeJson(join(outDir, relativeTarget), plan);
  importedEvidence.push({
    evidence: relativeTarget,
  });
}

function difficultyFromSteps(steps) {
  if (steps <= 3) return 1;
  if (steps <= 8) return 2;
  if (steps <= 15) return 3;
  if (steps <= 25) return 4;
  return 5;
}

async function auditCorpus(options) {
  const root = resolvePath(options.root);
  const entries = existsSync(root) ? await readdir(root, { withFileTypes: true }) : [];
  const corpusDirs = entries.filter((entry) => entry.isDirectory()).map((entry) => join(root, entry.name));
  const datasets = [];
  const manifests = [];

  for (const corpusDir of corpusDirs) {
    const datasetPath = join(corpusDir, "dataset.json");
    const manifestPath = join(corpusDir, "manifest.json");
    if (!existsSync(datasetPath)) continue;
    const dataset = await readJson(datasetPath, "dataset");
    const manifest = existsSync(manifestPath) ? await readJson(manifestPath, "manifest") : null;
    const analyses = await readCorpusAnalyses(root, corpusDir);
    datasets.push({ dir: corpusDir, dataset, analyses });
    if (manifest) manifests.push({ dir: corpusDir, manifest });
  }

  const profileStats = new Map();
  const sourceStats = new Map();
  const modeStats = new Map();
  const targetStats = new Map();
  const roleStats = new Map();
  const fixtureStats = new Map();
  const atVersions = new Map();
  const browsers = new Map();
  const scoringSignals = [];
  let fullObservations = 0;
  let scriptedFullObservations = 0;
  let manualFullObservations = 0;
  let announcementObservations = 0;

  for (const { dir, dataset, analyses } of datasets) {
    for (const observation of dataset.observations ?? []) {
      fullObservations += 1;
      const scripted = isScriptedFullObservation(observation);
      if (scripted) {
        scriptedFullObservations += 1;
      } else {
        manualFullObservations += 1;
      }
      countObservation({
        observation,
        dir,
        analyses,
        profileStats,
        sourceStats,
        modeStats,
        targetStats,
        roleStats,
        fixtureStats,
        atVersions,
        browsers,
        kind: "full",
        scripted,
      });
    }
    for (const observation of dataset.announcementObservations ?? []) {
      announcementObservations += 1;
      countObservation({
        observation,
        dir,
        analyses,
        profileStats,
        sourceStats,
        modeStats,
        targetStats,
        roleStats,
        fixtureStats,
        atVersions,
        browsers,
        kind: "announcement",
      });
    }
  }

  for (const { dir, manifest } of manifests) {
    for (const signal of manifest.scoringSignals ?? []) {
      scoringSignals.push({
        corpus: basename(dir),
        id: signal.id,
        status: signal.status,
        kind: signal.kind,
        dimension: signal.dimension,
        summary: signal.summary,
      });
    }
  }

  const profiles = [...profileStats.values()].sort((a, b) => a.profile.localeCompare(b.profile));
  const mapperGaps = [];
  const reachabilityGaps = [];
  const subjectiveGaps = [];
  const recommendations = [];

  for (const item of profiles) {
    if (item.full < options.fullGoal) {
      reachabilityGaps.push(
        `${item.profile}: ${item.full}/${options.fullGoal} full navigation observations for score tuning`,
      );
    }
    if ((item.manualFull ?? 0) < options.fullGoal) {
      subjectiveGaps.push(
        `${item.profile}: ${item.manualFull ?? 0}/${options.fullGoal} manual full observations for subjective score tuning`,
      );
    }
    if (item.announcement < options.announcementGoal) {
      mapperGaps.push(
        `${item.profile}: ${item.announcement}/${options.announcementGoal} announcement observations for mapper confidence`,
      );
    }
  }

  if (profiles.length === 0) {
    mapperGaps.push("No calibration observations found.");
    reachabilityGaps.push("No calibration observations found.");
    subjectiveGaps.push("No calibration observations found.");
  }
  if (fullObservations === 0) {
    recommendations.push(
      "Collect full GroundTruthObservation records before tuning score weights; current VM batches are announcement/reachability evidence only.",
    );
  } else if (scriptedFullObservations === fullObservations) {
    recommendations.push(
      "All full observations are scripted VM-derived records; use them for reachability/action-cost tuning, and collect manual SR full observations before tuning subjective severity, operability, or recovery weights.",
    );
  } else if (scriptedFullObservations > 0) {
    recommendations.push(
      `${scriptedFullObservations}/${fullObservations} full observations are scripted VM-derived; keep manual and scripted evidence separated when tuning subjective score dimensions.`,
    );
  }
  if (modeStats.size < 4) {
    recommendations.push(
      "Add repeated mode coverage for tab, heading, landmark, button/link, and form-field navigation.",
    );
  }
  if (fixtureStats.size < 5) {
    recommendations.push(
      "Add more fixtures and real-page captures; current corpus is too fixture-concentrated for broad claims.",
    );
  }

  return {
    schema: "tactual-calibration-corpus-audit@1",
    generatedAt: new Date().toISOString(),
    root: relativePath(root),
    goals: {
      fullObservationsPerProfile: options.fullGoal,
      announcementObservationsPerProfile: options.announcementGoal,
    },
    totals: {
      corpora: datasets.length,
      fullObservations,
      scriptedFullObservations,
      manualFullObservations,
      announcementObservations,
      profiles: profiles.length,
      modes: modeStats.size,
      fixtures: fixtureStats.size,
      targetInstances: targetStats.size,
      roles: roleStats.size,
      scoringSignals: scoringSignals.length,
    },
    profiles,
    modes: sortedCounts(modeStats),
    roles: sortedCounts(roleStats),
    sources: sortedCounts(sourceStats),
    fixtures: sortedCounts(fixtureStats),
    atVersions: sortedCounts(atVersions),
    browsers: sortedCounts(browsers),
    repeatedTargets: [...targetStats.values()]
      .filter((item) => item.count > 1)
      .sort((a, b) => b.count - a.count || a.target.localeCompare(b.target))
      .slice(0, 25),
    scoringSignals,
    blockers: [...mapperGaps, ...reachabilityGaps, ...subjectiveGaps],
    coverageGaps: {
      mapperConfidence: mapperGaps,
      reachabilityTuning: reachabilityGaps,
      subjectiveScoreTuning: subjectiveGaps,
    },
    recommendations,
    readiness: buildReadiness({ mapperGaps, reachabilityGaps, subjectiveGaps }),
  };
}

function buildReadiness({ mapperGaps, reachabilityGaps, subjectiveGaps }) {
  const mapperConfidence = mapperGaps.length === 0;
  const reachabilityTuning = reachabilityGaps.length === 0;
  const subjectiveScoreTuning = subjectiveGaps.length === 0;
  return {
    mapperConfidence,
    reachabilityTuning,
    subjectiveScoreTuning,
    // Backward-compatible aliases for pre-split consumers. `scoreTuning`
    // now means subjective score tuning, not scripted reachability tuning.
    mapper: mapperConfidence,
    scoreTuning: subjectiveScoreTuning,
  };
}

function isScriptedFullObservation(observation) {
  return (
    observation?.observationSource === "nvda-vm-scripted" ||
    observation?.observationUse?.operability === false ||
    observation?.observationUse?.recovery === false
  );
}

function countObservation(args) {
  const { observation, dir, kind } = args;
  const role = observationRoleFromAnalyses(args.analyses, observation) ?? observationRole(observation);
  const profile = observation.profileId ?? "unknown";
  const profileItem = args.profileStats.get(profile) ?? {
    profile,
    full: 0,
    scriptedFull: 0,
    manualFull: 0,
    announcement: 0,
    sources: {},
    modes: {},
  };
  profileItem[kind] += 1;
  if (kind === "full") {
    if (args.scripted) {
      profileItem.scriptedFull += 1;
    } else {
      profileItem.manualFull += 1;
    }
  }
  incrementObject(profileItem.sources, observation.announcementSource ?? "manual-sr");
  incrementObject(profileItem.modes, observationMode(observation));
  args.profileStats.set(profile, profileItem);

  increment(args.sourceStats, observation.announcementSource ?? "manual-sr");
  increment(args.modeStats, observationMode(observation));
  increment(args.roleStats, role);
  increment(args.fixtureStats, fixtureKey(observation.url));
  if (observation.atVersion) increment(args.atVersions, observation.atVersion);
  if (observation.browser) increment(args.browsers, observation.browser);

  const target = `${profile}|${fixtureKey(observation.url)}|${observationMode(observation)}|${observation.targetName}`;
  const targetItem = args.targetStats.get(target) ?? {
    target: observation.targetName,
    profile,
    fixture: fixtureKey(observation.url),
    mode: observationMode(observation),
    role,
    count: 0,
    corpora: {},
  };
  targetItem.count += 1;
  incrementObject(targetItem.corpora, basename(dir));
  args.targetStats.set(target, targetItem);
}

function formatAudit(audit) {
  const lines = [];
  lines.push("# Calibration Corpus Audit");
  lines.push(`Generated: ${audit.generatedAt}`);
  lines.push(`Root: ${audit.root}`);
  lines.push("");
  lines.push("## Totals");
  lines.push(`- Corpora: ${audit.totals.corpora}`);
  lines.push(`- Full navigation observations: ${audit.totals.fullObservations}`);
  if (audit.totals.scriptedFullObservations !== undefined) {
    lines.push(`- Scripted VM full observations: ${audit.totals.scriptedFullObservations}`);
  }
  if (audit.totals.manualFullObservations !== undefined) {
    lines.push(`- Manual full observations: ${audit.totals.manualFullObservations}`);
  }
  lines.push(`- Announcement observations: ${audit.totals.announcementObservations}`);
  lines.push(`- Profiles: ${audit.totals.profiles}`);
  lines.push(`- Modes: ${audit.totals.modes}`);
  lines.push(`- Fixtures/pages: ${audit.totals.fixtures}`);
  lines.push(`- Roles: ${audit.totals.roles}`);
  lines.push(`- Scoring signals: ${audit.totals.scoringSignals}`);
  lines.push("");
  lines.push("## Readiness");
  lines.push(`- Mapper confidence goal: ${audit.readiness.mapperConfidence ? "met" : "not met"}`);
  lines.push(`- Scripted reachability tuning goal: ${audit.readiness.reachabilityTuning ? "met" : "not met"}`);
  lines.push(`- Subjective score tuning goal: ${audit.readiness.subjectiveScoreTuning ? "met" : "not met"}`);
  lines.push("");
  lines.push("## Profiles");
  lines.push("| Profile | Full | Scripted Full | Manual Full | Announcement | Sources | Modes |");
  lines.push("|---|---:|---:|---:|---:|---|---|");
  for (const profile of audit.profiles) {
    lines.push(
      `| ${profile.profile} | ${profile.full} | ${profile.scriptedFull ?? 0} | ${profile.manualFull ?? 0} | ${profile.announcement} | ${formatObjectCounts(profile.sources)} | ${formatObjectCounts(profile.modes)} |`,
    );
  }
  lines.push("");
  lines.push("## Modes");
  for (const item of audit.modes) lines.push(`- ${item.name}: ${item.count}`);
  lines.push("");
  lines.push("## Roles");
  for (const item of audit.roles.slice(0, 20)) lines.push(`- ${item.name}: ${item.count}`);
  lines.push("");
  if (audit.repeatedTargets.length > 0) {
    lines.push("## Repeated Targets");
    for (const item of audit.repeatedTargets.slice(0, 10)) {
      lines.push(
        `- ${item.target} (${item.role}, ${item.mode}, ${item.fixture}): ${item.count} observation(s) across ${formatObjectCounts(item.corpora)}`,
      );
    }
    lines.push("");
  }
  if (audit.scoringSignals.length > 0) {
    lines.push("## Imported Scoring Signals");
    for (const signal of audit.scoringSignals.slice(0, 20)) {
      lines.push(`- ${signal.corpus}: ${signal.id} [${signal.status} ${signal.kind}/${signal.dimension}] ${signal.summary}`);
    }
    lines.push("");
  }
  if (audit.blockers.length > 0) {
    lines.push("## Coverage Gaps");
    if (audit.coverageGaps) {
      for (const [gate, blockers] of Object.entries(audit.coverageGaps)) {
        for (const blocker of blockers) lines.push(`- ${gate}: ${blocker}`);
      }
    } else {
      for (const blocker of audit.blockers) lines.push(`- ${blocker}`);
    }
    lines.push("");
  }
  if (audit.recommendations.length > 0) {
    lines.push("## Next Actions");
    for (const item of audit.recommendations) lines.push(`- ${item}`);
    lines.push("");
  }
  return `${lines.join("\n")}\n`;
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

function analysisUrls(analysis) {
  const urls = new Set();
  if (typeof analysis?.flow?.name === "string") urls.add(analysis.flow.name);
  for (const state of analysis?.states ?? []) {
    if (typeof state?.url === "string") urls.add(state.url);
  }
  return urls;
}

function observationRoleFromAnalyses(analyses, observation) {
  const target = findObservationTarget(analyses, observation);
  return target?.role ?? null;
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

  const observationName = normalizeAuditText(observation?.targetName);
  const targetName = normalizeAuditText(target?.name);
  if (observationName && targetName && observationName === targetName) {
    const observedRole = observationRole(observation);
    return observedRole === "unknown" || observedRole === target.role || observedRole === target.kind;
  }
  return false;
}

function normalizeAuditText(value) {
  return String(value ?? "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function buildCanonicalUrlMap(cases) {
  const map = new Map();
  for (const item of cases) {
    if (!item || typeof item !== "object" || typeof item.fixture !== "string") continue;
    const canonical = canonicalFixtureUrl(item.fixture);
    if (typeof item.hostUrl === "string") map.set(item.hostUrl, canonical);
    if (typeof item.guestUrl === "string") map.set(item.guestUrl, canonical);
  }
  return map;
}

function rewriteDatasetUrls(dataset, canonicalByObservedUrl) {
  for (const collection of [dataset.observations ?? [], dataset.announcementObservations ?? []]) {
    for (const observation of collection) {
      if (typeof observation.url === "string" && canonicalByObservedUrl.has(observation.url)) {
        observation.url = canonicalByObservedUrl.get(observation.url);
      }
    }
  }
}

function rewriteAnalysisUrls(analysis, canonicalUrl) {
  if (analysis?.flow && typeof analysis.flow === "object") {
    analysis.flow.name = canonicalUrl;
  }
  if (Array.isArray(analysis?.states)) {
    for (const state of analysis.states) {
      if (state && typeof state === "object") state.url = canonicalUrl;
    }
  }
}

function canonicalFixtureUrl(fixture) {
  return `tactual-fixture://${fixture.replace(/\\/g, "/")}`;
}

function fixtureKey(url) {
  if (typeof url !== "string") return "unknown";
  return url.startsWith("tactual-fixture://") ? url.slice("tactual-fixture://".length) : url;
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

function sortedCounts(map) {
  return [...map.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

function formatObjectCounts(value) {
  return Object.entries(value)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([name, count]) => `${name}=${count}`)
    .join(", ");
}

function increment(map, key) {
  map.set(key, (map.get(key) ?? 0) + 1);
}

function incrementObject(object, key) {
  object[key] = (object[key] ?? 0) + 1;
}

function safeFileStem(value) {
  return value
    .replace(/\\/g, "/")
    .replace(/\.[^.]+$/, "")
    .replace(/[^a-z0-9]+/gi, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();
}

function slugFromPath(path) {
  return safeFileStem(basename(resolvePath(path)));
}

function parseOptions(args) {
  const opts = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg.startsWith("--")) {
      throw new Error(`Unexpected positional argument: ${arg}`);
    }
    const [rawKey, inlineValue] = arg.slice(2).split("=", 2);
    if (rawKey === "replace" || rawKey === "derive-full-observations") {
      opts[rawKey] = true;
      continue;
    }
    const value = inlineValue ?? args[++i];
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`Missing value for --${rawKey}`);
    }
    opts[rawKey] = value;
  }
  return opts;
}

function requiredOption(opts, key) {
  const value = opts[key];
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`Missing required option --${key}`);
  }
  return value;
}

function numberOption(opts, key, fallback) {
  if (opts[key] === undefined) return fallback;
  const value = Number(opts[key]);
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`Invalid --${key}: ${opts[key]}`);
  }
  return value;
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

async function writeJson(path, data) {
  await ensureDir(dirname(path));
  await writeFile(path, `${JSON.stringify(data, jsonReplacer, 2)}\n`, "utf-8");
}

function jsonReplacer(_key, value) {
  if (value instanceof Set) return [...value].sort();
  return value;
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
  return `Calibration corpus utility

Usage:
  node scripts/calibration-corpus.mjs import-nvda-batch --batch <dir> --out <dir> [--label <name>] [--replace] [--derive-full-observations]
  node scripts/calibration-corpus.mjs audit [--root calibration/corpus] [--format markdown|json] [--output <file>]

Commands:
  import-nvda-batch  Import a selected NVDA VM batch into portable corpus form.
                     Detailed review/debug artifacts remain in build/.
  audit              Summarize coverage and readiness against calibration goals.
`;
}
