/**
 * Tactual MCP Server
 *
 * Exposes screen-reader navigation cost analysis as MCP tools
 * for consumption by AI agents and coding assistants.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { VERSION } from "../version.js";
import { registerAnalyzeUrl } from "./tools/analyze-url.js";
import { registerValidateUrl } from "./tools/validate-url.js";
import { registerListProfiles } from "./tools/list-profiles.js";
import { registerDiffResults } from "./tools/diff-results.js";
import { registerSuggestRemediations } from "./tools/suggest-remediations.js";
import { registerTracePath } from "./tools/trace-path.js";
import { registerSaveAuth } from "./tools/save-auth.js";
import { registerAnalyzePages } from "./tools/analyze-pages.js";

export { extractFindings, getOverallScore } from "./helpers.js";
export { closeSharedBrowser } from "./browser.js";

/**
 * Construct the Tactual MCP server with all tools registered.
 * Each tool lives in its own file under tools/; shared infrastructure
 * (browser pool, probe-budget helpers) lives alongside this index.
 */
export function createMcpServer(): McpServer {
  const server = new McpServer({
    name: "tactual",
    version: VERSION,
  });

  registerAnalyzeUrl(server);
  registerValidateUrl(server);
  registerListProfiles(server);
  registerDiffResults(server);
  registerSuggestRemediations(server);
  registerTracePath(server);
  registerSaveAuth(server);
  registerAnalyzePages(server);

  return server;
}

/** Start the MCP server on stdio transport */
export async function startMcpServer(): Promise<void> {
  const server = createMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
