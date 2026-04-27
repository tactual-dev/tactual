/**
 * Pipeline: extract top-priority remediation suggestions from an analysis
 * result. Tiny pipeline — mostly deduplicates fixes and ranks by score.
 *
 * Accepts any of the shapes extractFindings knows about (raw
 * AnalysisResult, SummarizedResult, SARIF log).
 */

import { extractFindings } from "../core/result-extraction.js";

export interface Suggestion {
  targetId: string;
  severity: string;
  score: number;
  fix: string;
  penalties: string[];
}

export interface SuggestRemediationsOptions {
  analysis: unknown;
  maxSuggestions?: number;
}

export class SuggestRemediationsError extends Error {
  constructor(
    public readonly code: "bad-input" | "runtime",
    message: string,
  ) {
    super(message);
    this.name = "SuggestRemediationsError";
  }
}

export function runSuggestRemediations(
  opts: SuggestRemediationsOptions,
): Suggestion[] {
  let findings;
  try {
    findings = extractFindings(opts.analysis);
  } catch (err) {
    throw new SuggestRemediationsError(
      "bad-input",
      `Error parsing analysis: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const max = opts.maxSuggestions ?? 10;
  const sorted = [...findings].sort((a, b) => a.overall - b.overall);

  const suggestions: Suggestion[] = [];
  const seenFixes = new Set<string>();

  for (const finding of sorted) {
    for (const fix of finding.suggestedFixes) {
      if (seenFixes.has(fix)) continue;
      seenFixes.add(fix);
      suggestions.push({
        targetId: finding.targetId,
        severity: finding.severity,
        score: finding.overall,
        fix,
        penalties: finding.penalties,
      });
      if (suggestions.length >= max) return suggestions;
    }
  }
  return suggestions;
}
