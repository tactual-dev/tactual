/**
 * Inline virtual-screen-reader validation used by the analyze-url pipeline
 * when opts.validate is set. Kept separate from the standalone validate-url
 * pipeline because this variant:
 *
 * - reuses the already-open Playwright Page (no re-navigation)
 * - must not abort the analyze run on missing optional deps — it logs a
 *   warning and returns null instead so users without jsdom / guidepup
 *   still get their normal analysis output
 * - is inlined into the AnalysisResult via a `validation` passthrough
 *
 * The standalone validate-url pipeline (src/pipeline/validate-url.ts)
 * owns the full lifecycle and treats missing deps as a hard error.
 */

import type { Page } from "playwright";
import type { AnalysisResult, PageState } from "../core/types.js";
import { summarizeEvidence } from "../core/evidence.js";
import type { ATProfile } from "../profiles/types.js";

export interface InlineValidationResult {
  strategy: string;
  totalValidated: number;
  reachable: number;
  unreachable: number;
  meanAccuracy: number | null;
  results: unknown[];
}

export async function runInlineValidation(
  page: Page,
  result: AnalysisResult,
  state: PageState,
  profile: ATProfile,
  options: { maxTargets: number; strategy: "linear" | "semantic" },
): Promise<InlineValidationResult | null> {
  let JSDOM: typeof import("jsdom").JSDOM;
  try {
    ({ JSDOM } = await import("jsdom"));
    await import("@guidepup/virtual-screen-reader");
  } catch {
    process.stderr.write(
      "  --validate requested but deps missing. Install: npm install jsdom @guidepup/virtual-screen-reader\n",
    );
    return null;
  }

  const { validateFindingsInJsdom } = await import("../validation/index.js");
  const html = await page.content();
  const dom = new JSDOM(html, { url: state.url || undefined });

  const results = await validateFindingsInJsdom(
    dom,
    state,
    result.findings,
    options,
  );
  for (const validation of results) {
    const finding = result.findings.find((f) => f.targetId === validation.targetId);
    if (!finding) continue;
    const evidence = [
      ...(finding.evidence ?? []),
      {
        kind: "validated" as const,
        source: "guidepup-virtual-screen-reader",
        description: validation.reachable
          ? `Virtual screen-reader validation reached this target in ${validation.actualSteps} steps (${validation.strategy}; predicted ${validation.predictedCost}).`
          : `Virtual screen-reader validation could not reach this target within the ${validation.strategy} strategy.`,
        confidence: validation.reachable ? validation.accuracy : 0,
      },
    ];
    finding.evidence = evidence;
    finding.evidenceSummary = summarizeEvidence(evidence);
  }
  void profile;

  const reachable = results.filter((r) => r.reachable).length;
  const accuracies = results
    .filter((r) => r.reachable && r.actualSteps > 0)
    .map((r) => r.accuracy);
  const meanAccuracy =
    accuracies.length > 0
      ? accuracies.reduce((a, b) => a + b, 0) / accuracies.length
      : null;

  return {
    strategy: options.strategy,
    totalValidated: results.length,
    reachable,
    unreachable: results.length - reachable,
    meanAccuracy,
    results,
  };
}
