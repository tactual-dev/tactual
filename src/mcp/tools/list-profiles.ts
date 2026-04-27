import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getProfile, listProfiles } from "../../profiles/index.js";

export function registerListProfiles(server: McpServer): void {
  server.registerTool(
    "list_profiles",
    {
      description:
        "List the assistive-technology (AT) profiles available for scoring. " +
        "Each profile models a specific screen reader and platform — e.g., NVDA on Windows, " +
        "VoiceOver on iOS — with its own navigation cost weights and action vocabulary. " +
        "Returns an array of {id, name, platform, description} for each profile.\n\n" +
        "Read-only, no parameters, static data. Call once to discover valid profile IDs, " +
        "then pass a profile ID to analyze_url, trace_path, or analyze_pages. " +
        "Default profile for all analysis tools is 'generic-mobile-web-sr-v0' if none is specified.",
      inputSchema: {},
    },
    async () => {
      const profiles = listProfiles();
      const details = profiles.map((id) => {
        const p = getProfile(id);
        return {
          id,
          name: p?.name ?? id,
          platform: p?.platform ?? "unknown",
          description: p?.description ?? "",
        };
      });

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(details, null, 2),
          },
        ],
      };
    },
  );
}
