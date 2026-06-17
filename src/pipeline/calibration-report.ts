/**
 * Pipeline: run a calibration dataset against saved full analysis JSON.
 *
 * Shared by CLI and MCP so both surfaces use the same strict matching rules:
 * one URL-keyed analysis map, duplicate URL rejection, and missing dataset URL
 * rejection unless the caller explicitly opts into a partial report.
 */

import { join, relative, resolve as resolvePath, isAbsolute } from "node:path";
import { readdir, readFile } from "node:fs/promises";
import { AnalysisResultSchema, type AnalysisResult } from "../core/types.js";
import {
  runCalibration,
  type CalibrationDataset,
  type CalibrationReport,
} from "../calibration/index.js";

export interface CalibrationReportOptions {
  datasetPath: string;
  analysisPaths?: string[];
  analysisDir?: string;
  allowMissing?: boolean;
  /** MCP callers pass true; CLI passes false because local paths are explicit. */
  restrictInputsToCwd?: boolean;
}

export class CalibrationReportError extends Error {
  constructor(
    public readonly code:
      | "invalid-input-path"
      | "invalid-dataset"
      | "invalid-analysis"
      | "missing-analysis"
      | "duplicate-analysis-url"
      | "runtime",
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "CalibrationReportError";
  }
}

interface LoadedAnalysis {
  path: string;
  result: AnalysisResult;
  urls: string[];
}

export async function runCalibrationReportFromFiles(
  opts: CalibrationReportOptions,
): Promise<CalibrationReport> {
  const datasetPath = resolveInputPath(opts.datasetPath, opts.restrictInputsToCwd);
  const dataset = readCalibrationDataset(
    await readJsonFile(datasetPath, "calibration dataset"),
    datasetPath,
  );
  const analyses = await loadAnalyses(opts, datasetPath);
  assertDatasetCoverage(dataset, analyses, opts.allowMissing === true);
  return runCalibration(dataset, analyses);
}

async function loadAnalyses(
  opts: CalibrationReportOptions,
  datasetPath: string,
): Promise<Map<string, AnalysisResult>> {
  const paths = await collectAnalysisPaths(opts, datasetPath);
  const loaded = await Promise.all(paths.map(loadAnalysis));
  const analyses = new Map<string, AnalysisResult>();
  const sources = new Map<string, string>();

  for (const analysis of loaded) {
    for (const url of analysis.urls) {
      const existing = sources.get(url);
      if (existing && existing !== analysis.path) {
        throw new CalibrationReportError(
          "duplicate-analysis-url",
          `Duplicate analysis URL ${url} in ${existing} and ${analysis.path}. ` +
            "Provide one full analysis JSON per observed URL.",
        );
      }
      sources.set(url, analysis.path);
      analyses.set(url, analysis.result);
    }
  }

  return analyses;
}

async function collectAnalysisPaths(
  opts: CalibrationReportOptions,
  datasetPath: string,
): Promise<string[]> {
  const explicitPaths = (opts.analysisPaths ?? []).map((path) =>
    resolveInputPath(path, opts.restrictInputsToCwd),
  );
  const paths = [...explicitPaths];

  if (opts.analysisDir) {
    const analysisDir = resolveInputPath(opts.analysisDir, opts.restrictInputsToCwd);
    let entries: string[];
    try {
      entries = await readdir(analysisDir);
    } catch (err) {
      throw new CalibrationReportError(
        "invalid-input-path",
        `Could not read analysis directory ${analysisDir}: ${errorMessage(err)}`,
        { cause: err },
      );
    }
    paths.push(
      ...entries
        .filter((entry) => entry.toLowerCase().endsWith(".json"))
        .sort((a, b) => a.localeCompare(b))
        .map((entry) => join(analysisDir, entry)),
    );
  }

  const datasetAbsolutePath = resolvePath(datasetPath);
  const uniquePaths = [...new Set(paths.map((path) => resolvePath(path)))].filter(
    (path) => path !== datasetAbsolutePath,
  );

  if (uniquePaths.length === 0) {
    throw new CalibrationReportError(
      "invalid-input-path",
      "At least one analysis source is required. Use --analysis <file...> or --analysis-dir <dir>.",
    );
  }

  return uniquePaths;
}

async function loadAnalysis(path: string): Promise<LoadedAnalysis> {
  const raw = await readJsonFile(path, "analysis");
  const candidate = unwrapAnalysis(raw);
  const parsed = AnalysisResultSchema.safeParse(candidate);
  if (!parsed.success) {
    const details = parsed.error.issues
      .slice(0, 3)
      .map((issue) => {
        const field = issue.path.length > 0 ? issue.path.join(".") : "(root)";
        return `${field}: ${issue.message}`;
      })
      .join("; ");
    throw new CalibrationReportError(
      "invalid-analysis",
      `Analysis file is not a full Tactual analysis JSON: ${path}. ${details}`,
    );
  }

  const urls = extractAnalysisUrls(raw, parsed.data);
  if (urls.length === 0) {
    throw new CalibrationReportError(
      "invalid-analysis",
      `Analysis file has no URL to match observations: ${path}`,
    );
  }

  return { path, result: parsed.data, urls };
}

async function readJsonFile(path: string, label: string): Promise<unknown> {
  let text: string;
  try {
    text = await readFile(path, "utf-8");
  } catch (err) {
    throw new CalibrationReportError(
      "invalid-input-path",
      `Could not read ${label} ${path}: ${errorMessage(err)}`,
      { cause: err },
    );
  }

  try {
    return JSON.parse(text) as unknown;
  } catch (err) {
    throw new CalibrationReportError(
      label === "calibration dataset" ? "invalid-dataset" : "invalid-analysis",
      `Could not parse ${label} ${path}: ${errorMessage(err)}`,
      { cause: err },
    );
  }
}

function readCalibrationDataset(
  raw: unknown,
  path: string,
): CalibrationDataset {
  const object = asRecord(raw);
  if (!object) {
    throw new CalibrationReportError(
      "invalid-dataset",
      `Calibration dataset must be a JSON object: ${path}`,
    );
  }
  if (typeof object.name !== "string" || object.name.trim() === "") {
    throw new CalibrationReportError(
      "invalid-dataset",
      `Calibration dataset is missing string field "name": ${path}`,
    );
  }
  if (typeof object.collectedAt !== "string" || object.collectedAt.trim() === "") {
    throw new CalibrationReportError(
      "invalid-dataset",
      `Calibration dataset is missing string field "collectedAt": ${path}`,
    );
  }
  if (!Array.isArray(object.observations)) {
    throw new CalibrationReportError(
      "invalid-dataset",
      `Calibration dataset is missing array field "observations": ${path}`,
    );
  }
  if (
    object.announcementObservations !== undefined &&
    !Array.isArray(object.announcementObservations)
  ) {
    throw new CalibrationReportError(
      "invalid-dataset",
      `Calibration dataset field "announcementObservations" must be an array: ${path}`,
    );
  }
  return raw as CalibrationDataset;
}

function assertDatasetCoverage(
  dataset: CalibrationDataset,
  analyses: Map<string, AnalysisResult>,
  allowMissing: boolean,
): void {
  if (allowMissing) return;

  const requiredUrls = new Set<string>();
  for (const observation of dataset.observations) {
    requiredUrls.add(observation.url);
  }
  for (const observation of dataset.announcementObservations ?? []) {
    requiredUrls.add(observation.url);
  }

  const missing = [...requiredUrls].filter((url) => !analyses.has(url));
  if (missing.length > 0) {
    throw new CalibrationReportError(
      "missing-analysis",
      "Missing analysis JSON for calibration URL(s): " +
        `${missing.join(", ")}. ` +
        "Run analyze-url --full-json for each URL, or pass --allow-missing for a partial report.",
    );
  }
}

function resolveInputPath(path: string, restrictToCwd: boolean | undefined): string {
  const resolved = resolvePath(path);
  if (restrictToCwd) {
    const rel = relative(process.cwd(), resolved);
    if (rel.startsWith("..") || isAbsolute(rel)) {
      throw new CalibrationReportError(
        "invalid-input-path",
        `Invalid calibration input path: must be within the current working directory (${process.cwd()}). Resolved: ${resolved}`,
      );
    }
  }
  return resolved;
}

function unwrapAnalysis(raw: unknown): unknown {
  const object = asRecord(raw);
  const wrapped = asRecord(object?.result);
  return wrapped ? wrapped : raw;
}

function extractAnalysisUrls(raw: unknown, result: AnalysisResult): string[] {
  const urls = new Set<string>();
  const wrapperUrl = asString(asRecord(raw)?.url);
  if (wrapperUrl) urls.add(wrapperUrl);

  for (const state of result.states) {
    if (state.url) urls.add(state.url);
  }

  if (urls.size === 0 || looksLikeUrl(result.flow.name)) {
    urls.add(result.flow.name);
  }

  return [...urls].filter((url) => url.trim() !== "");
}

function looksLikeUrl(value: string): boolean {
  return /^[a-z][a-z0-9+.-]*:/i.test(value);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
