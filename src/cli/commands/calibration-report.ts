import { writeFile } from "node:fs/promises";
import type { Command } from "commander";
import { formatCalibrationReport } from "../../calibration/index.js";
import { runCalibrationReportFromFiles } from "../../pipeline/calibration-report.js";

interface CalibrationReportOptions {
  analysis?: unknown;
  analysisDir?: string;
  format?: string;
  output?: string;
  allowMissing?: boolean;
}

/**
 * Registers the `calibration-report` command.
 *
 * The heavy lifting lives in the shared pipeline helper so CLI and MCP use the
 * same duplicate-URL and missing-analysis rules. This wrapper is intentionally
 * limited to Commander argument normalization and output formatting.
 */
export function registerCalibrationReport(program: Command): void {
  program
    .command("calibration-report")
    .alias("calibrate-dataset")
    .description(
      "Run a calibration dataset against saved full analysis JSON and emit scoring signals.",
    )
    .argument("<dataset>", "Path to calibration dataset JSON")
    .option(
      "--analysis <paths...>",
      "One or more full analysis JSON files produced by analyze-url --full-json",
    )
    .option(
      "--analysis-dir <dir>",
      "Directory containing full analysis JSON files",
    )
    .option(
      "-f, --format <format>",
      "Output format: markdown | json (text and console are aliases for markdown)",
      "markdown",
    )
    .option("-o, --output <path>", "Write output to file instead of stdout")
    .option(
      "--allow-missing",
      "Do not fail when dataset URLs have no matching analysis JSON",
    )
    .action(async (datasetPath: string, opts: CalibrationReportOptions) => {
      try {
        const report = await runCalibrationReportFromFiles({
          datasetPath,
          analysisPaths: normalizePathList(opts.analysis),
          analysisDir: opts.analysisDir,
          allowMissing: opts.allowMissing === true,
        });
        const format = normalizeReportFormat(opts.format);
        const output =
          format === "json"
            ? JSON.stringify(report, null, 2)
            : formatCalibrationReport(report);

        if (opts.output) {
          await writeFile(opts.output, output, "utf-8");
          console.error(`Wrote ${opts.output}`);
        } else {
          console.log(output);
        }
      } catch (err) {
        console.error(err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    });
}

function normalizePathList(value: unknown): string[] {
  if (!value) return [];
  if (Array.isArray(value)) return value.flatMap((item) => normalizePathList(item));
  if (typeof value === "string" && value.trim() !== "") return [value];
  return [];
}

function normalizeReportFormat(format: string | undefined): "json" | "markdown" {
  const normalized = (format ?? "markdown").toLowerCase();
  if (normalized === "json") return "json";
  if (
    normalized === "markdown" ||
    normalized === "md" ||
    normalized === "text" ||
    normalized === "console"
  ) {
    return "markdown";
  }
  throw new Error(`Unsupported calibration report format: ${format}`);
}
