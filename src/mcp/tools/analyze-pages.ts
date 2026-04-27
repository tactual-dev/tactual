import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { listProfiles } from "../../profiles/index.js";
import {
  runAnalyzePages,
  AnalyzePagesError,
} from "../../pipeline/analyze-pages.js";

export function registerAnalyzePages(server: McpServer): void {
  server.registerTool(
    "analyze_pages",
    {
      description:
        "Analyze multiple pages and produce an aggregated site-level report. " +
        "Runs analyze_url on each URL in a single browser session and combines " +
        "results into a site score with per-page breakdown. " +
        "Read-only — navigates to each URL but does not modify pages.\n\n" +
        "Use this instead of calling analyze_url repeatedly when you need a site-level assessment. " +
        "Returns ~200 bytes per page plus a site-level summary. " +
        "If a single URL fails (timeout, bot protection), its entry shows the error and " +
        "remaining URLs still complete.",
      inputSchema: {
        urls: z.array(z.string()).describe("URLs to analyze (1-20 pages)"),
        profile: z
          .string()
          .default("generic-mobile-web-sr-v0")
          .describe("AT profile ID"),
        waitForSelector: z.string().optional().describe("CSS selector to wait for on each page (for SPAs)"),
        waitTime: z.number().optional().describe("Additional wait per page in ms"),
        timeout: z.number().default(30000).describe("Page load timeout per URL"),
        storageState: z
          .string()
          .optional()
          .describe("Path to Playwright storageState JSON for authenticated pages. Use save_auth to create. Must be within cwd."),
      },
    },
    async ({ urls, profile, waitForSelector, waitTime, timeout, storageState }) => {
      try {
        const result = await runAnalyzePages({
          urls,
          profileId: profile,
          waitForSelector,
          waitTime,
          timeout,
          storageState,
          restrictStorageStateToCwd: true,
          maxUrls: 20,
          useSharedBrowserPool: true,
        });
        return {
          content: [
            { type: "text" as const, text: JSON.stringify(result, null, 2) },
          ],
        };
      } catch (err) {
        if (err instanceof AnalyzePagesError) {
          let text = err.message;
          if (err.code === "unknown-profile") {
            text += `. Available: ${listProfiles().join(", ")}`;
          }
          return { content: [{ type: "text" as const, text }], isError: true };
        }
        return {
          content: [
            {
              type: "text" as const,
              text: `Error: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
          isError: true,
        };
      }
    },
  );
}
