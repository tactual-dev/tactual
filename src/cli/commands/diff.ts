import type { Command } from "commander";
import type { ReportFormat } from "../../reporters/index.js";
import { computeDiff, formatDiff } from "../helpers/diff.js";

/**
 * CLI wraps the existing `computeDiff` helper rather than the pipeline
 * because CLI's diff format (from `helpers/diff.ts`) is richer than the
 * MCP payload shape; it includes per-section breakdowns and supports
 * SARIF/markdown/console output. The MCP tool uses src/pipeline/diff-results.ts
 * which produces a simpler JSON payload. Both are kept intentionally.
 *
 * Command name now `diff-results` for parity with MCP `diff_results`;
 * legacy `diff` alias preserves existing scripts.
 */
export function registerDiff(program: Command): void {
  program
    .command("diff-results")
    .alias("diff")
    .description("Compare two analysis results and show score changes")
    .argument("<baseline>", "Path to baseline analysis JSON")
    .argument("<candidate>", "Path to candidate analysis JSON")
    .option("-f, --format <format>", "Output format: json, markdown, console, sarif", "console")
    .action(async (baseline: string, candidate: string, opts: { format: string }) => {
      const fs = await import("fs/promises");
      const readJson = async (path: string, label: string) => {
        try {
          return JSON.parse(await fs.readFile(path, "utf-8")) as Record<string, unknown>;
        } catch (err) {
          const code = (err as NodeJS.ErrnoException).code;
          if (code === "ENOENT") {
            console.error(`Error: ${label} file not found: ${path}`);
          } else if (err instanceof SyntaxError) {
            console.error(`Error: ${label} file is not valid JSON: ${path}`);
          } else {
            const msg = err instanceof Error ? err.message : String(err);
            console.error(`Error reading ${label} (${path}): ${msg}`);
          }
          process.exit(1);
        }
      };
      const baseData = await readJson(baseline, "baseline");
      const candData = await readJson(candidate, "candidate");
      try {
        const diff = computeDiff(baseData, candData);
        console.log(formatDiff(diff, opts.format as ReportFormat));
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`Error computing diff: ${msg}`);
        process.exit(1);
      }
    });
}
