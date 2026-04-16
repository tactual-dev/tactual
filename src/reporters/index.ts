import type { AnalysisResult } from "../core/types.js";
import { formatJSON } from "./json.js";
import { formatMarkdown } from "./markdown.js";
import { formatConsole } from "./console.js";
import { formatSARIF } from "./sarif.js";

export type ReportFormat = "json" | "markdown" | "console" | "sarif";

export interface ReportOptions {
  maxDetailedFindings?: number;
}

export function formatReport(result: AnalysisResult, format: ReportFormat, options?: ReportOptions): string {
  switch (format) {
    case "json":
      return formatJSON(result, options);
    case "markdown":
      return formatMarkdown(result, options);
    case "console":
      return formatConsole(result, options);
    case "sarif":
      return formatSARIF(result);
    default:
      throw new Error(`Unknown report format: ${format as string}`);
  }
}
