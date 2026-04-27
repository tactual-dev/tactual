import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { runDiffResults, DiffResultsError } from "../../pipeline/diff-results.js";

export function registerDiffResults(server: McpServer): void {
  server.registerTool(
    "diff_results",
    {
      description:
        "Compare two Tactual analysis results (before/after). Shows what improved, regressed, " +
        "which penalties were resolved or added, and severity band changes per target. " +
        "Returns a JSON array of {targetId, baselineScore, candidateScore, status, penalties}.\n\n" +
        "Read-only, no side effects. Use after fixing accessibility issues to verify improvements. " +
        "Both inputs must be JSON strings from analyze_url (format='json'). " +
        "Not useful for SARIF output — use analyze_url directly for before/after SARIF comparisons.",
      inputSchema: {
        baseline: z.string().describe("Baseline analysis result as JSON string"),
        candidate: z.string().describe("Candidate analysis result as JSON string"),
      },
    },
    async ({ baseline, candidate }) => {
      try {
        const result = runDiffResults(JSON.parse(baseline), JSON.parse(candidate));
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
        };
      } catch (err) {
        const text =
          err instanceof DiffResultsError
            ? err.message
            : `Error parsing results: ${err instanceof Error ? err.message : String(err)}`;
        return { content: [{ type: "text" as const, text }], isError: true };
      }
    },
  );
}
