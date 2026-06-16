import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { formatCalibrationReport } from "../../calibration/index.js";
import {
  CalibrationReportError,
  runCalibrationReportFromFiles,
} from "../../pipeline/calibration-report.js";

export function registerCalibrationReport(server: McpServer): void {
  server.registerTool(
    "calibration_report",
    {
      description:
        "Run a calibration dataset against saved full Tactual analysis JSON and return " +
        "structured scoring signals. Use this after analyze_url --full-json/format=json " +
        "artifacts or VM/manual screen-reader observations have been collected. " +
        "Read-only; file inputs must be inside the current working directory. " +
        "Returns JSON by default so agents can inspect scoringSignals, announcement drift, " +
        "and per-target calibration errors.",
      inputSchema: {
        datasetPath: z
          .string()
          .describe("Path to calibration dataset JSON, within the current working directory"),
        analysisPaths: z
          .array(z.string())
          .optional()
          .describe("Full analysis JSON files produced by analyze_url/analyze-url"),
        analysisDir: z
          .string()
          .optional()
          .describe("Directory of full analysis JSON files, within the current working directory"),
        allowMissing: z
          .boolean()
          .default(false)
          .describe("Allow observations whose URLs have no matching analysis JSON"),
        format: z
          .enum(["json", "markdown"])
          .default("json")
          .describe("Output format. JSON is best for agent workflows; markdown is for human review."),
      },
    },
    async ({ datasetPath, analysisPaths, analysisDir, allowMissing, format }) => {
      try {
        const report = await runCalibrationReportFromFiles({
          datasetPath,
          analysisPaths,
          analysisDir,
          allowMissing,
          restrictInputsToCwd: true,
        });
        const text =
          format === "markdown"
            ? formatCalibrationReport(report)
            : JSON.stringify(report, null, 2);
        return {
          content: [{ type: "text" as const, text }],
        };
      } catch (err) {
        const text =
          err instanceof CalibrationReportError
            ? err.message
            : `calibration_report failed: ${err instanceof Error ? err.message : String(err)}`;
        return { content: [{ type: "text" as const, text }], isError: true };
      }
    },
  );
}
