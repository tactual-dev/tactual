#!/usr/bin/env node

/**
 * Controlled NVDA VM observation helper.
 *
 * This script deliberately does not automate or embed NVDA. It creates a
 * reproducible run folder and, when a VM speech artifact is supplied, feeds
 * explicit observed announcements into the existing observe-announcement CLI.
 */

import { spawnSync } from "node:child_process";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { dirname, extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const cli = resolve(root, "dist/cli/index.js");
const defaultProfile = "nvda-desktop-v0";
const defaultSource = "nvda-vm";

const helpText = `Usage:
  npm run -- nvda:vm:observe -- --analysis analysis.json --target "Checkout"
  npm run -- nvda:vm:observe -- --url https://app.example.test --run-analysis --target "Search"
  npm run -- nvda:vm:observe -- --analysis analysis.json --speech-log speech.jsonl --append-calibration calibration.json

Purpose:
  Create a controlled NVDA VM observation folder and optionally ingest captured
  speech into Tactual's announcement calibration dataset.

Core options:
  --url <url>                  URL to analyze or include in the VM plan
  --analysis <path>            Existing Tactual analysis JSON
  --run-analysis               Run analyze-url when --url is supplied
  --target <hint>              Target name/id/selector hint. Repeatable
  --speech-log <path>          JSONL or TSV records captured in the VM
  --append-calibration <path>  Calibration dataset to append to
  --out <dir>                  Output folder (default: build/nvda-vm-observe/<timestamp>)
  --profile <id>               Tactual profile (default: nvda-desktop-v0)
  --source <source>            Observation source (default: nvda-vm)
  --tester <id>                Tester identifier (default: nvda-vm)
  --at-version <version>       NVDA version used in the VM
  --browser <version>          Browser/version used in the VM
  --dry-run                    Write plan and parsed records without invoking Tactual

Analyze-url passthrough:
  --timeout <ms>
  --wait-for-selector <css>
  --storage-state <path>
  --detect-routes
  --descend-frames
  --auto-scroll
  --dismiss-banners

Speech log formats:
  JSONL: {"target":"Search","observedAnnouncement":"Search, edit","targetSelector":"#q"}
  TSV:   target<TAB>observedAnnouncement<TAB>observedAnnouncementTokens<TAB>targetSelector<TAB>announcementNotes
`;

const booleanOptions = new Set([
  "--auto-scroll",
  "--descend-frames",
  "--detect-routes",
  "--dismiss-banners",
  "--dry-run",
  "--help",
  "-h",
  "--run-analysis",
]);

const valueOptions = new Set([
  "--analysis",
  "--append-calibration",
  "--at-version",
  "--browser",
  "--out",
  "--profile",
  "--source",
  "--speech-log",
  "--storage-state",
  "--target",
  "--tester",
  "--timeout",
  "--url",
  "--wait-for-selector",
]);

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    console.log(helpText);
    return;
  }

  if (!opts.url && !opts.analysis) {
    throw new Error("Provide --analysis <path> or --url <url>.");
  }
  if (opts.url && opts.analysis) {
    throw new Error("Use either --analysis or --url, not both.");
  }

  const outDir = resolve(opts.out ?? defaultOutDir());
  await mkdir(outDir, { recursive: true });

  const analysisPath = opts.analysis ? resolve(opts.analysis) : resolve(outDir, "analysis.json");
  const calibrationPath = opts.appendCalibration
    ? resolve(opts.appendCalibration)
    : resolve(outDir, "calibration.json");

  const analyzeArgs = buildAnalyzeArgs(opts, analysisPath);
  const manifest = {
    schema: "tactual-nvda-vm-observe@1",
    createdAt: new Date().toISOString(),
    outDir,
    profile: opts.profile ?? defaultProfile,
    source: opts.source ?? defaultSource,
    url: opts.url,
    analysisPath,
    calibrationPath,
    speechLogPath: opts.speechLog ? resolve(opts.speechLog) : undefined,
    targetHints: opts.targets,
    dryRun: opts.dryRun === true,
    commands: {
      analyze: opts.url
        ? formatCommand([process.execPath, cli, ...analyzeArgs])
        : "analysis supplied",
      observe: [],
    },
    files: {
      manifest: resolve(outDir, "manifest.json"),
      targetsTemplate: resolve(outDir, "targets.tsv"),
      parsedSpeechRecords: undefined,
      observationPayloads: undefined,
    },
    results: {
      analysisRan: false,
      speechRecordCount: 0,
      skippedEmptySpeechRows: 0,
      ingestedObservationCount: 0,
    },
    notes: [
      "Tactual does not bundle NVDA code or automate NVDA internals.",
      "Treat observed announcements as version-, browser-, mode-, verbosity-, and state-specific evidence.",
      "Capture speech inside a disposable Windows VM snapshot, then ingest explicit JSONL/TSV records here.",
    ],
  };

  await writeTargetsTemplate(resolve(outDir, "targets.tsv"), opts.targets);

  if (opts.url && opts.runAnalysis) {
    await ensureCliBuilt();
    runCli(analyzeArgs, { label: "analyze-url" });
    manifest.results.analysisRan = true;
  }

  let records = [];
  if (opts.speechLog) {
    const speech = await readSpeechRecords(resolve(opts.speechLog));
    records = speech.records;
    manifest.results.speechRecordCount = records.length;
    manifest.results.skippedEmptySpeechRows = speech.skippedEmptyRows;
    manifest.files.parsedSpeechRecords = resolve(outDir, "speech-records.json");
    await writeJson(manifest.files.parsedSpeechRecords, records);

    if (!opts.analysis && !opts.runAnalysis) {
      throw new Error(
        "Speech ingestion requires --analysis, or --url with --run-analysis so Tactual has targets to match.",
      );
    }

    const payloads = [];
    for (const [index, record] of records.entries()) {
      const observeArgs = buildObserveArgs(record, opts, analysisPath, calibrationPath);
      manifest.commands.observe.push(formatCommand([process.execPath, cli, ...observeArgs]));
      if (opts.dryRun) continue;

      await ensureCliBuilt();
      const stdout = runCli(observeArgs, {
        label: `observe-announcement ${index + 1}/${records.length}`,
      });
      payloads.push(parseJsonOrRaw(stdout));
      manifest.results.ingestedObservationCount += 1;
    }

    if (payloads.length > 0) {
      manifest.files.observationPayloads = resolve(outDir, "observation-payloads.json");
      await writeJson(manifest.files.observationPayloads, payloads);
    }
  }

  await writeJson(resolve(outDir, "manifest.json"), manifest);

  console.log(`NVDA VM observation folder: ${outDir}`);
  console.log(`Targets template: ${resolve(outDir, "targets.tsv")}`);
  console.log(`Manifest: ${resolve(outDir, "manifest.json")}`);
  if (records.length > 0) {
    const verb = opts.dryRun ? "Parsed" : "Ingested";
    console.log(`${verb} ${records.length} speech record${records.length === 1 ? "" : "s"}.`);
    if (manifest.results.skippedEmptySpeechRows > 0) {
      console.log(
        `Skipped ${manifest.results.skippedEmptySpeechRows} unfilled TSV row${
          manifest.results.skippedEmptySpeechRows === 1 ? "" : "s"
        }.`,
      );
    }
    if (!opts.dryRun) console.log(`Calibration dataset: ${calibrationPath}`);
  }
}

function parseArgs(argv) {
  const opts = {
    targets: [],
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (booleanOptions.has(arg)) {
      if (arg === "--help" || arg === "-h") opts.help = true;
      else opts[toCamel(arg)] = true;
      continue;
    }
    if (!valueOptions.has(arg)) {
      throw new Error(`Unknown option: ${arg}. Use --help for usage.`);
    }
    const value = argv[i + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`Missing value for ${arg}.`);
    }
    i += 1;
    if (arg === "--target") opts.targets.push(value);
    else opts[toCamel(arg)] = value;
  }
  return opts;
}

function toCamel(flag) {
  return flag.replace(/^--/, "").replace(/-([a-z])/g, (_, char) => char.toUpperCase());
}

function defaultOutDir() {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return resolve(root, "build", "nvda-vm-observe", stamp);
}

function buildAnalyzeArgs(opts, analysisPath) {
  if (!opts.url) return [];
  return [
    "analyze-url",
    opts.url,
    "--profile",
    opts.profile ?? defaultProfile,
    "--format",
    "json",
    "--full-json",
    "--output",
    analysisPath,
    "--no-check-visibility",
    "--timeout",
    opts.timeout ?? "30000",
    ...valueArg("--wait-for-selector", opts.waitForSelector),
    ...valueArg("--storage-state", opts.storageState),
    ...flagArg("--detect-routes", opts.detectRoutes),
    ...flagArg("--descend-frames", opts.descendFrames),
    ...flagArg("--auto-scroll", opts.autoScroll),
    ...flagArg("--dismiss-banners", opts.dismissBanners),
  ];
}

function buildObserveArgs(record, opts, analysisPath, calibrationPath) {
  return [
    "observe-announcement",
    record.target,
    "--analysis",
    analysisPath,
    "--source",
    record.announcementSource ?? opts.source ?? defaultSource,
    "--tester",
    record.testerId ?? opts.tester ?? "nvda-vm",
    "--format",
    "json",
    "--output",
    calibrationPath,
    "--append",
    ...valueArg("--target-selector", record.targetSelector),
    ...valueArg("--observed", record.observedAnnouncement),
    ...tokensArg(record.observedAnnouncementTokens),
    ...valueArg("--at-version", record.atVersion ?? opts.atVersion),
    ...valueArg("--browser", record.browser ?? opts.browser),
    ...valueArg("--notes", record.announcementNotes),
  ];
}

function valueArg(flag, value) {
  return value ? [flag, String(value)] : [];
}

function flagArg(flag, enabled) {
  return enabled ? [flag] : [];
}

function tokensArg(tokens) {
  return tokens?.length ? ["--observed-token", ...tokens] : [];
}

async function writeTargetsTemplate(path, targets) {
  const lines = [
    "target\tobservedAnnouncement\tobservedAnnouncementTokens\ttargetSelector\tannouncementNotes",
    ...targets.map((target) => `${target}\t\t\t\t`),
  ];
  await writeFile(path, `${lines.join("\n")}\n`, "utf-8");
}

async function readSpeechRecords(path) {
  const text = await readFile(path, "utf-8");
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length === 0) return { records: [], skippedEmptyRows: 0 };

  const ext = extname(path).toLowerCase();
  if (ext === ".jsonl" || lines[0].startsWith("{")) {
    return {
      records: lines.map((line, index) => normalizeRecord(JSON.parse(line), index + 1)),
      skippedEmptyRows: 0,
    };
  }

  const records = [];
  let skippedEmptyRows = 0;
  for (const [index, record] of parseTsv(lines).entries()) {
    const normalized = normalizeRecord(record, index + 1, { skipEmptyObservation: true });
    if (normalized) records.push(normalized);
    else skippedEmptyRows += 1;
  }
  return { records, skippedEmptyRows };
}

function parseTsv(lines) {
  const first = splitTsvLine(lines[0]);
  const knownHeaders = new Set([
    "announcement",
    "announcementNotes",
    "browser",
    "observedAnnouncement",
    "observedAnnouncementTokens",
    "target",
    "targetName",
    "targetSelector",
    "text",
    "tokens",
  ]);
  const hasHeader = first.some((cell) => knownHeaders.has(cell));
  const headers = hasHeader
    ? first
    : [
        "target",
        "observedAnnouncement",
        "observedAnnouncementTokens",
        "targetSelector",
        "announcementNotes",
      ];
  const rows = hasHeader ? lines.slice(1) : lines;
  return rows.map((line) => {
    const cells = splitTsvLine(line);
    const row = {};
    headers.forEach((header, index) => {
      row[header] = cells[index] ?? "";
    });
    return row;
  });
}

function splitTsvLine(line) {
  return line.split("\t").map((cell) => cell.trim());
}

function normalizeRecord(raw, lineNumber, opts = {}) {
  const target = stringValue(raw.target ?? raw.targetName ?? raw.name);
  const observedAnnouncement = stringValue(
    raw.observedAnnouncement ?? raw.announcement ?? raw.text ?? raw.speech,
  );
  const observedAnnouncementTokens = parseTokens(
    raw.observedAnnouncementTokens ?? raw.observedTokens ?? raw.tokens,
  );
  if (!target) {
    throw new Error(`Speech record ${lineNumber} is missing target or targetName.`);
  }
  if (!observedAnnouncement && observedAnnouncementTokens.length === 0) {
    if (opts.skipEmptyObservation) return null;
    throw new Error(
      `Speech record ${lineNumber} is missing observedAnnouncement or observedAnnouncementTokens.`,
    );
  }
  return {
    target,
    ...(observedAnnouncement ? { observedAnnouncement } : {}),
    ...(observedAnnouncementTokens.length ? { observedAnnouncementTokens } : {}),
    ...optionalRecordField("targetSelector", raw.targetSelector ?? raw.selector),
    ...optionalRecordField("announcementSource", raw.announcementSource ?? raw.source),
    ...optionalRecordField("testerId", raw.testerId ?? raw.tester),
    ...optionalRecordField("atVersion", raw.atVersion),
    ...optionalRecordField("browser", raw.browser),
    ...optionalRecordField("announcementNotes", raw.announcementNotes ?? raw.notes),
  };
}

function stringValue(value) {
  return typeof value === "string" ? value.trim() : "";
}

function optionalRecordField(name, value) {
  const text = stringValue(value);
  return text ? { [name]: text } : {};
}

function parseTokens(value) {
  if (Array.isArray(value)) return value.map((token) => String(token).trim()).filter(Boolean);
  if (typeof value !== "string") return [];
  return value
    .split(/[|,]/)
    .map((token) => token.trim())
    .filter(Boolean);
}

async function ensureCliBuilt() {
  try {
    await access(cli, fsConstants.R_OK);
  } catch {
    throw new Error(`Missing compiled CLI at ${cli}. Run npm run build before ingestion.`);
  }
}

function runCli(args, { label }) {
  const result = spawnSync(process.execPath, [cli, ...args], {
    cwd: root,
    encoding: "utf-8",
    env: { ...process.env, NODE_NO_WARNINGS: "1" },
    timeout: 120_000,
  });
  if (result.error) {
    throw new Error(`Could not run ${label}: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(`${label} failed.\n${result.stderr || result.stdout || "(no output)"}`);
  }
  return result.stdout.trim();
}

function parseJsonOrRaw(text) {
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

async function writeJson(path, value) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf-8");
}

function formatCommand(argv) {
  return argv.map(quoteArg).join(" ");
}

function quoteArg(value) {
  const text = String(value);
  if (/^[A-Za-z0-9_./:=+-]+$/.test(text)) return text;
  return `"${text.replace(/"/g, '\\"')}"`;
}
