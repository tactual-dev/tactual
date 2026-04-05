import type { AnalysisResult } from "../core/types.js";
import { formatJSON } from "./json.js";
import { formatMarkdown } from "./markdown.js";
import { formatConsole } from "./console.js";
import { formatSARIF } from "./sarif.js";

export type ReportFormat = "json" | "markdown" | "console" | "sarif";

export function formatReport(result: AnalysisResult, format: ReportFormat): string {
  switch (format) {
    case "json":
      return formatJSON(result);
    case "markdown":
      return formatMarkdown(result);
    case "console":
      return formatConsole(result);
    case "sarif":
      return formatSARIF(result);
  }
}
