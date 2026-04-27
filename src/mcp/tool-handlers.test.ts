import { describe, expect, it } from "vitest";
import type { PageState } from "../core/types.js";
import { registerAnalyzePages } from "./tools/analyze-pages.js";
import { registerAnalyzeUrl } from "./tools/analyze-url.js";
import { registerDiffResults } from "./tools/diff-results.js";
import { registerListProfiles } from "./tools/list-profiles.js";
import { registerSaveAuth } from "./tools/save-auth.js";
import { registerSuggestRemediations } from "./tools/suggest-remediations.js";
import { registerTracePath } from "./tools/trace-path.js";
import { registerValidateUrl } from "./tools/validate-url.js";

type McpResponse = {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
};

type ToolHandler = (args: Record<string, unknown>) => Promise<McpResponse>;
type ToolRegistrar = (server: unknown) => void;

function captureTool(registrar: ToolRegistrar): { name: string; handler: ToolHandler } {
  let captured: { name: string; handler: ToolHandler } | null = null;
  const server = {
    registerTool: (name: string, _schema: unknown, handler: ToolHandler) => {
      captured = { name, handler };
    },
  };

  registrar(server);
  if (!captured) throw new Error("Tool was not registered");
  return captured;
}

function text(response: McpResponse): string {
  return response.content.map((item) => item.text).join("\n");
}

function makeState(): PageState {
  return {
    id: "s1",
    url: "https://example.test",
    route: "/",
    snapshotHash: "snapshot-1",
    interactiveHash: "interactive-1",
    openOverlays: [],
    targets: [
      {
        id: "main",
        kind: "landmark",
        role: "main",
        name: "",
        requiresBranchOpen: false,
      },
      {
        id: "heading",
        kind: "heading",
        role: "heading",
        name: "Checkout",
        headingLevel: 1,
        requiresBranchOpen: false,
      },
      {
        id: "submit",
        kind: "button",
        role: "button",
        name: "Submit order",
        requiresBranchOpen: false,
        selector: "button",
      },
    ],
    timestamp: 1,
    provenance: "scripted",
  };
}

describe("MCP tool handlers", () => {
  it("executes list_profiles and returns profile details", async () => {
    const { name, handler } = captureTool(registerListProfiles as ToolRegistrar);
    const response = await handler({});

    expect(name).toBe("list_profiles");
    expect(response.isError).toBeUndefined();
    const profiles = JSON.parse(text(response)) as Array<{ id: string; platform: string }>;
    expect(profiles.some((profile) => profile.id === "generic-mobile-web-sr-v0")).toBe(true);
    expect(profiles.some((profile) => profile.platform === "desktop")).toBe(true);
  });

  it("executes suggest_remediations against summarized JSON", async () => {
    const { handler } = captureTool(registerSuggestRemediations as ToolRegistrar);
    const response = await handler({
      analysis: JSON.stringify({
        worstFindings: [
          {
            targetId: "button:save",
            overall: 42,
            severity: "high",
            penalties: ["No accessible name"],
            suggestedFixes: ["Add visible text or aria-label"],
          },
        ],
      }),
      maxSuggestions: 1,
    });

    expect(response.isError).toBeUndefined();
    const suggestions = JSON.parse(text(response)) as Array<{ targetId: string; fix: string }>;
    expect(suggestions).toEqual([
      {
        targetId: "button:save",
        severity: "high",
        score: 42,
        fix: "Add visible text or aria-label",
        penalties: ["No accessible name"],
      },
    ]);
  });

  it("executes diff_results and reports score movement", async () => {
    const { handler } = captureTool(registerDiffResults as ToolRegistrar);
    const response = await handler({
      baseline: JSON.stringify({
        worstFindings: [
          { targetId: "button:save", overall: 40, severity: "high", penalties: ["Bad"], suggestedFixes: ["Fix"] },
        ],
      }),
      candidate: JSON.stringify({
        worstFindings: [
          { targetId: "button:save", overall: 80, severity: "acceptable", penalties: [], suggestedFixes: [] },
        ],
      }),
    });

    expect(response.isError).toBeUndefined();
    const diff = JSON.parse(text(response)) as {
      summary: { improved: number };
      changes: Array<{ targetId: string; delta: number; penaltiesResolved: string[] }>;
    };
    expect(diff.summary.improved).toBe(1);
    expect(diff.changes[0]).toMatchObject({
      targetId: "button:save",
      delta: 40,
      penaltiesResolved: ["Bad"],
    });
  });

  it("executes trace_path against pre-captured states without launching a browser", async () => {
    const { handler } = captureTool(registerTracePath as ToolRegistrar);
    const response = await handler({
      url: "https://example.test",
      target: "*submit*",
      profile: "generic-mobile-web-sr-v0",
      explore: false,
      timeout: 1000,
      statesJson: JSON.stringify([makeState()]),
    });

    expect(response.isError).toBeUndefined();
    const trace = JSON.parse(text(response)) as {
      matchCount: number;
      traces: Array<{ targetId: string; reachable: boolean; steps: unknown[] }>;
    };
    expect(trace.matchCount).toBe(1);
    expect(trace.traces[0].targetId).toBe("submit");
    expect(trace.traces[0].reachable).toBe(true);
    expect(trace.traces[0].steps.length).toBeGreaterThan(0);
  });

  it("turns malformed trace_path statesJson into an MCP error", async () => {
    const { handler } = captureTool(registerTracePath as ToolRegistrar);
    const response = await handler({
      url: "https://example.test",
      target: "*submit*",
      profile: "generic-mobile-web-sr-v0",
      explore: false,
      timeout: 1000,
      statesJson: "{not-json",
    });

    expect(response.isError).toBe(true);
    expect(text(response)).toContain("Error tracing path on https://example.test");
  });

  it("turns analyze_url validation failures into MCP errors", async () => {
    const { handler } = captureTool(registerAnalyzeUrl as ToolRegistrar);
    const response = await handler({
      url: "javascript:alert(1)",
      profile: "generic-mobile-web-sr-v0",
      format: "json",
      explore: false,
      probe: false,
      summaryOnly: true,
      includeStates: false,
      timeout: 1000,
    });

    expect(response.isError).toBe(true);
    expect(text(response)).toContain("Blocked protocol");
  });

  it("turns analyze_pages max-url failures into MCP errors", async () => {
    const { handler } = captureTool(registerAnalyzePages as ToolRegistrar);
    const response = await handler({
      urls: Array.from({ length: 21 }, (_, i) => `https://example.test/${i}`),
      profile: "generic-mobile-web-sr-v0",
      timeout: 1000,
    });

    expect(response.isError).toBe(true);
    expect(text(response)).toContain("Maximum 20 URLs per call");
  });

  it("turns validate_url URL failures into MCP errors", async () => {
    const { handler } = captureTool(registerValidateUrl as ToolRegistrar);
    const response = await handler({
      url: "data:text/html,<button>Bad</button>",
      maxTargets: 1,
      strategy: "semantic",
      timeout: 1000,
    });

    expect(response.isError).toBe(true);
    expect(text(response)).toContain("Blocked protocol");
  });

  it("turns save_auth URL failures into MCP errors before browser launch", async () => {
    const { handler } = captureTool(registerSaveAuth as ToolRegistrar);
    const response = await handler({
      url: "vbscript:msgbox(1)",
      steps: [],
      outputPath: "auth.json",
      timeout: 1000,
    });

    expect(response.isError).toBe(true);
    expect(text(response)).toContain("Blocked protocol");
  });

  it("turns malformed save_auth steps into MCP errors before browser launch", async () => {
    const { handler } = captureTool(registerSaveAuth as ToolRegistrar);
    const response = await handler({
      url: "https://example.test/login",
      steps: [{ fill: ["#email"] }],
      outputPath: "auth.json",
      timeout: 1000,
    });

    expect(response.isError).toBe(true);
    expect(text(response)).toContain("Valid step types: click, fill, wait, waitForUrl");
  });
});
