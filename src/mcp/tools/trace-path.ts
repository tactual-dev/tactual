import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { listProfiles } from "../../profiles/index.js";
import { runTracePath, TracePathError } from "../../pipeline/trace-path.js";

export function registerTracePath(server: McpServer): void {
  server.registerTool(
    "trace_path",
    {
      description:
        "Trace the exact screen-reader navigation path to a specific interactive target. " +
        "Returns step-by-step actions a screen-reader user would perform, with modeled " +
        "announcements, cumulative cost, and the target's role/name at each hop. " +
        "Read-only — navigates to the URL but does not modify the page.\n\n" +
        "Use this after analyze_url to understand *why* a target scored poorly.\n\n" +
        "**For auth-gated or explored targets**: Pass statesJson from a prior analyze_url " +
        "(use includeStates=true). This skips browser launch entirely and traces against " +
        "the captured state, including any explored states discovered behind auth boundaries.",
      inputSchema: {
        url: z.string().describe("URL of the page to trace"),
        target: z
          .string()
          .describe(
            "Target to trace to. Exact target ID or glob pattern (e.g., '*search*', 'Submit*'). Case-insensitive.",
          ),
        profile: z.string().default("generic-mobile-web-sr-v0").describe("AT profile ID"),
        device: z.string().optional().describe("Playwright device name for emulation (e.g., 'iPhone 14')"),
        waitForSelector: z.string().optional().describe("CSS selector to wait for before capturing (essential for SPAs)"),
        explore: z.boolean().default(false).describe("Explore hidden branches (menus, tabs, dialogs) before tracing"),
        timeout: z.number().default(30000).describe("Page load timeout in milliseconds"),
        statesJson: z
          .string()
          .optional()
          .describe(
            "Pre-captured states from a prior analyze_url (use includeStates=true). " +
            "When provided, trace_path skips browser launch.",
          ),
        storageState: z
          .string()
          .optional()
          .describe("Path to Playwright storageState JSON for authenticated pages. Must be within cwd."),
      },
    },
    async ({ url, target, profile, device, waitForSelector, explore, timeout, statesJson, storageState }) => {
      try {
        let states: import("../../core/types.js").PageState[] | undefined;
        if (statesJson) {
          const { PageStateSchema } = await import("../../core/types.js");
          const parsed = JSON.parse(statesJson);
          states = Array.isArray(parsed)
            ? parsed.map((s: unknown) => PageStateSchema.parse(s))
            : [PageStateSchema.parse(parsed)];
        }

        const result = await runTracePath({
          url,
          targetPattern: target,
          profileId: profile,
          device,
          explore,
          waitForSelector,
          timeout,
          storageState,
          restrictStorageStateToCwd: true,
          useSharedBrowserPool: true,
          states,
        });

        return {
          content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
        };
      } catch (err) {
        if (err instanceof TracePathError) {
          let text = err.message;
          if (err.code === "unknown-profile") {
            text += `. Available: ${listProfiles().join(", ")}`;
          } else if (err.code === "no-matches" && err.availableTargets) {
            text += `\n\nAvailable interactive targets (first 20):\n${err.availableTargets.map((t) => `  ${t}`).join("\n")}`;
          }
          return { content: [{ type: "text" as const, text }], isError: true };
        }
        return {
          content: [
            {
              type: "text" as const,
              text: `Error tracing path on ${url}: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
          isError: true,
        };
      }
    },
  );
}
