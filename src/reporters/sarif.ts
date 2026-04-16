import type { AnalysisResult } from "../core/types.js";
import { severityFromScore } from "../core/types.js";

// ---------------------------------------------------------------------------
// SARIF output — compatible with GitHub Code Scanning and VS Code SARIF Viewer
// ---------------------------------------------------------------------------

interface SarifLog {
  $schema: string;
  version: string;
  runs: SarifRun[];
}

interface SarifRun {
  tool: { driver: SarifDriver };
  results: SarifResult[];
  properties?: Record<string, unknown>;
}

interface SarifDriver {
  name: string;
  version: string;
  informationUri: string;
  rules: SarifRule[];
}

interface SarifRule {
  id: string;
  name: string;
  shortDescription: { text: string };
  fullDescription: { text: string };
  defaultConfiguration: { level: string };
  helpUri: string;
}

interface SarifResult {
  ruleId: string;
  level: string;
  message: { text: string };
  locations: SarifLocation[];
  properties: Record<string, unknown>;
}

interface SarifLocation {
  physicalLocation?: {
    artifactLocation: { uri: string };
  };
  logicalLocations?: Array<{
    name: string;
    kind: string;
  }>;
}

/**
 * Maximum SARIF results to emit.
 * Keeps output under ~15KB for LLM context windows.
 * Worst findings first — the rest are summarized in a note.
 */
const MAX_SARIF_RESULTS = 25;

export function formatSARIF(result: AnalysisResult): string {
  const rules: SarifRule[] = [
    {
      id: "tactual/severe",
      name: "SevereNavigationConcern",
      shortDescription: { text: "Severe navigation concern (score 0-39)" },
      fullDescription: {
        text: "Target is near-blocking or blocking for screen-reader users under the specified AT profile.",
      },
      defaultConfiguration: { level: "error" },
      helpUri: "https://github.com/tactual-dev/tactual",
    },
    {
      id: "tactual/high",
      name: "HighNavigationConcern",
      shortDescription: { text: "High navigation concern (score 40-59)" },
      fullDescription: {
        text: "Target causes meaningful friction for screen-reader users under the specified AT profile.",
      },
      defaultConfiguration: { level: "error" },
      helpUri: "https://github.com/tactual-dev/tactual",
    },
    {
      id: "tactual/moderate",
      name: "ModerateNavigationConcern",
      shortDescription: { text: "Moderate navigation concern (score 60-74)" },
      fullDescription: {
        text: "Target should be triaged for screen-reader navigation improvements.",
      },
      defaultConfiguration: { level: "warning" },
      helpUri: "https://github.com/tactual-dev/tactual",
    },
    {
      id: "tactual/acceptable",
      name: "AcceptableNavigation",
      shortDescription: { text: "Acceptable but improvable (score 75-89)" },
      fullDescription: {
        text: "Target is navigable but could be improved for screen-reader users.",
      },
      defaultConfiguration: { level: "note" },
      helpUri: "https://github.com/tactual-dev/tactual",
    },
    {
      id: "tactual/truncation-note",
      name: "TruncationNote",
      shortDescription: { text: "Output was truncated to limit size" },
      fullDescription: {
        text: "More findings exist than shown. Fix the worst issues and re-run, or use minSeverity to filter.",
      },
      defaultConfiguration: { level: "note" },
      helpUri: "https://github.com/tactual-dev/tactual",
    },
  ];

  const results: SarifResult[] = [];

  for (const finding of result.findings) {
    const severity = severityFromScore(finding.scores.overall);
    if (severity === "strong") continue; // Don't report passing items

    const ruleId = `tactual/${severity}`;
    const level = severity === "severe" || severity === "high" ? "error" : severity === "moderate" ? "warning" : "note";

    const messageParts = [
      `Score: ${finding.scores.overall}/100 (${severity})`,
      `D:${finding.scores.discoverability} R:${finding.scores.reachability} O:${finding.scores.operability} Rec:${finding.scores.recovery} IR:${finding.scores.interopRisk}`,
    ];

    if (finding.penalties.length > 0) {
      messageParts.push(`Issues: ${finding.penalties.join("; ")}`);
    }

    if (finding.suggestedFixes.length > 0) {
      messageParts.push(`Fixes: ${finding.suggestedFixes.join("; ")}`);
    }

    const url = result.states[0]?.url ?? "";

    results.push({
      ruleId,
      level,
      message: { text: messageParts.join(". ") },
      locations: [
        {
          physicalLocation: url
            ? { artifactLocation: { uri: url } }
            : undefined,
          logicalLocations: [
            {
              name: finding.targetId,
              kind: "accessibilityTarget",
            },
          ],
        },
      ],
      properties: {
        profile: finding.profile,
        scores: finding.scores,
        selector: finding.selector,
        bestPath: finding.bestPath,
        confidence: finding.confidence,
      },
    });
  }

  // Sort worst-first and cap to keep output LLM-friendly
  results.sort((a, b) => {
    const scoreA = (a.properties as Record<string, Record<string, number>>)?.scores?.overall ?? 100;
    const scoreB = (b.properties as Record<string, Record<string, number>>)?.scores?.overall ?? 100;
    return scoreA - scoreB;
  });
  const totalActionable = results.length;
  const truncated = results.length > MAX_SARIF_RESULTS;
  const capped = truncated ? results.slice(0, MAX_SARIF_RESULTS) : results;

  if (truncated) {
    // Prepend a summary note so the consumer sees truncation first
    const omitted = totalActionable - MAX_SARIF_RESULTS;
    const sevCounts: Record<string, number> = {};
    for (const r of results.slice(MAX_SARIF_RESULTS)) {
      sevCounts[r.level] = (sevCounts[r.level] ?? 0) + 1;
    }
    const sevSummary = Object.entries(sevCounts).map(([l, c]) => `${c} ${l}`).join(", ");

    capped.unshift({
      ruleId: "tactual/truncation-note",
      level: "note",
      message: {
        text: `[Truncated] Showing ${MAX_SARIF_RESULTS} of ${totalActionable} findings (worst first). ` +
          `${omitted} omitted: ${sevSummary}. ` +
          `Fix the worst issues and re-run to surface lower-priority findings, or use minSeverity to filter.`,
      },
      locations: [],
      properties: {
        truncated: true,
        totalActionable,
        omitted,
        omittedBySeverity: sevCounts,
      },
    });
  }

  const sarif: SarifLog = {
    $schema: "https://raw.githubusercontent.com/oasis-tcs/sarif-spec/main/sarif-2.1/schema/sarif-schema-2.1.0.json",
    version: "2.1.0",
    runs: [
      {
        tool: {
          driver: {
            name: "Tactual",
            version: result.metadata.version,
            informationUri: "https://github.com/tactual-dev/tactual",
            rules,
          },
        },
        results: capped,
        properties: {
          profile: result.metadata.profile,
          targetCount: result.metadata.targetCount,
          stateCount: result.metadata.stateCount,
          averageScore: result.findings.length > 0
            ? Math.round(result.findings.reduce((s, f) => s + f.scores.overall, 0) / result.findings.length * 10) / 10
            : 0,
        },
      },
    ],
  };

  return JSON.stringify(sarif, null, 2);
}
