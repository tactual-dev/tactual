import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  runSuggestRemediations,
  SuggestRemediationsError,
} from "../../pipeline/suggest-remediations.js";

export function registerSuggestRemediations(server: McpServer): void {
  server.registerTool(
    "suggest_remediations",
    {
      description:
        "Extract the top unique remediation suggestions from a Tactual analysis result, " +
        "ranked by severity. Returns a JSON array of {targetId, severity, score, fix, penalties}.\n\n" +
        "Read-only, no side effects. Most useful with large JSON results where you want a prioritized " +
        "shortlist of what to fix first. For SARIF results, the findings already contain fix " +
        "suggestions inline — this tool is redundant in that case. " +
        "Input must be a JSON string from analyze_url (format='json').",
      inputSchema: {
        analysis: z.string().describe("Analysis result as JSON string"),
        maxSuggestions: z.number().default(10).describe("Maximum number of suggestions to return"),
      },
    },
    async ({ analysis, maxSuggestions }) => {
      try {
        const suggestions = runSuggestRemediations({
          analysis: JSON.parse(analysis),
          maxSuggestions,
        });
        return {
          content: [
            { type: "text" as const, text: JSON.stringify(suggestions, null, 2) },
          ],
        };
      } catch (err) {
        const text =
          err instanceof SuggestRemediationsError
            ? err.message
            : `Error: ${err instanceof Error ? err.message : String(err)}`;
        return { content: [{ type: "text" as const, text }], isError: true };
      }
    },
  );
}
