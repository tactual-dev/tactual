import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { runSaveAuth, SaveAuthError } from "../../pipeline/save-auth.js";

const AuthStepInputSchema = z.union([
  z.object({ click: z.string().min(1) }).strict(),
  z.object({ fill: z.tuple([z.string().min(1), z.string()]) }).strict(),
  z.object({ wait: z.number().nonnegative() }).strict(),
  z.object({ waitForUrl: z.string().min(1) }).strict(),
]);

export function registerSaveAuth(server: McpServer): void {
  server.registerTool(
    "save_auth",
    {
      description:
        "Authenticate with a web application and save the session for subsequent analysis. " +
        "Navigates to the URL, executes login steps (click a button, fill a form, etc.), " +
        "waits for the authenticated page to load, then saves cookies and localStorage " +
        "to a JSON file. Overwrites the output file if it already exists.\n\n" +
        "**Side effects**: Writes a storageState JSON file to disk at `outputPath`. " +
        "Launches a headed browser that interacts with the page (clicks, fills inputs). " +
        "Not needed for public pages — only use when content is behind authentication.\n\n" +
        "Pass the output file path as `storageState` to analyze_url, trace_path, " +
        "or analyze_pages to analyze authenticated content.\n\n" +
        "**Steps format**: Array of actions to perform in order. Each step is an object:\n" +
        "- `{ click: 'button text or selector' }` — click a button/link\n" +
        "- `{ fill: ['input selector', 'value'] }` — fill an input field\n" +
        "- `{ wait: 2000 }` — wait N milliseconds\n" +
        "- `{ waitForUrl: '/dashboard' }` — wait until URL contains this string\n\n" +
        "Example for a dev login: `steps: [{ click: 'Dev Login' }, { waitForUrl: '/workspace' }]`\n" +
        "Example for form login: `steps: [{ fill: ['#email', 'user@test.com'] }, { fill: ['#password', 'pass'] }, { click: 'Sign In' }, { waitForUrl: '/dashboard' }]`",
      inputSchema: {
        url: z.string().describe("Login page URL"),
        steps: z
          .array(AuthStepInputSchema)
          .describe("Login steps to execute (see description for format)"),
        outputPath: z
          .string()
          .default("tactual-auth.json")
          .describe("File path to save the storageState JSON (must be within cwd)"),
        timeout: z.number().default(30000).describe("Timeout per step in ms"),
      },
    },
    async ({ url, steps, outputPath, timeout }) => {
      try {
        const result = await runSaveAuth({
          url,
          steps: steps as Record<string, unknown>[],
          outputPath,
          timeout,
          restrictOutputToCwd: true,
          useSharedBrowserPool: true,
        });
        return {
          content: [
            { type: "text" as const, text: JSON.stringify(result, null, 2) },
          ],
        };
      } catch (err) {
        const text =
          err instanceof SaveAuthError
            ? err.message
            : `Auth failed: ${err instanceof Error ? err.message : String(err)}`;
        return { content: [{ type: "text" as const, text }], isError: true };
      }
    },
  );
}
