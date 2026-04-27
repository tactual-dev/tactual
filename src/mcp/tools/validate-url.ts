import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { runValidateUrl, ValidateUrlError } from "../../pipeline/validate-url.js";

export function registerValidateUrl(server: McpServer): void {
  server.registerTool(
    "validate_url",
    {
      description:
        "Validate Tactual's predicted navigation paths against a virtual screen reader. " +
        "Runs analyze_url internally, then for each worst finding drives " +
        "@guidepup/virtual-screen-reader over the captured DOM (via jsdom) to check: " +
        "(a) is the target reachable at all, and (b) how many virtual SR announcements " +
        "does it take to reach it? Compares to Tactual's predicted step count. " +
        "Returns an accuracy ratio per target and a mean across all validated targets — " +
        "closer to 1.0 means Tactual's predictions match this virtual-screen-reader run, " +
        "not a guarantee of full real-AT fidelity.\n\n" +
        "**Requires** (optional deps): jsdom + @guidepup/virtual-screen-reader. " +
        "Installed with tactual if optionalDependencies were honored; otherwise run " +
        "`npm install jsdom @guidepup/virtual-screen-reader` in your project.\n\n" +
        "**When to use**: closing the predicted-vs-actual loop. If Tactual's predictions " +
        "diverge a lot from the virtual SR, either the profile weights need calibration " +
        "or the page has structural patterns the analyzer doesn't model. Use sparingly — " +
        "this adds the analyze_url cost plus jsdom parsing + virtual SR navigation time.",
      inputSchema: {
        url: z.string().describe("URL to analyze and validate"),
        profile: z
          .string()
          .optional()
          .describe("AT profile ID (default: nvda-desktop-v0). Use list_profiles to see options."),
        maxTargets: z
          .number()
          .int()
          .min(1)
          .max(50)
          .default(10)
          .describe("Maximum findings to validate (worst-first). Higher = slower but more signal."),
        strategy: z
          .enum(["linear", "semantic"])
          .default("semantic")
          .describe(
            "Navigation strategy for the virtual SR. 'linear' uses Tab/Shift-Tab (keyboard flow); " +
            "'semantic' uses heading/landmark skip commands (screen-reader flow). Semantic is more " +
            "representative for NVDA/JAWS/VoiceOver users.",
          ),
        timeout: z.number().default(30000).describe("Page load timeout in ms"),
        waitTime: z.number().optional().describe("Additional wait after load (ms)"),
        channel: z.string().optional().describe("Browser channel: chrome, chrome-beta, msedge"),
        stealth: z.boolean().optional().describe("Apply anti-bot-detection defaults"),
        storageState: z
          .string()
          .optional()
          .describe(
            "Path to a Playwright storageState JSON (for authenticated pages). " +
            "Must be within the current working directory.",
          ),
      },
    },
    async ({ url, profile, maxTargets, strategy, timeout, waitTime, channel, stealth, storageState }) => {
      try {
        const result = await runValidateUrl({
          url,
          profileId: profile,
          maxTargets,
          strategy,
          timeout,
          waitTime,
          channel,
          stealth,
          storageState,
          restrictStorageStateToCwd: true,
          useSharedBrowserPool: true,
        });
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
        };
      } catch (err) {
        const text =
          err instanceof ValidateUrlError
            ? err.message
            : `validate_url failed: ${err instanceof Error ? err.message : String(err)}`;
        return {
          content: [{ type: "text" as const, text }],
          isError: true,
        };
      }
    },
  );
}
