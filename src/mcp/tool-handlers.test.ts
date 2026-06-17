import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { resolve } from "path";
import type { PageState } from "../core/types.js";
import { registerAnalyzePages } from "./tools/analyze-pages.js";
import { registerAnalyzeUrl } from "./tools/analyze-url.js";
import { registerCalibrationReport } from "./tools/calibration-report.js";
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
  const calibrationDir = resolve("__test_tactual_mcp_calibration");
  const datasetPath = resolve(calibrationDir, "dataset.json");
  const analysisPath = resolve(calibrationDir, "analysis.json");

  afterEach(() => {
    if (existsSync(calibrationDir)) rmSync(calibrationDir, { recursive: true, force: true });
  });

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

  it("executes calibration_report and returns scoring signals", async () => {
    writeCalibrationFixture();
    const { handler } = captureTool(registerCalibrationReport as ToolRegistrar);
    const response = await handler({
      datasetPath,
      analysisPaths: [analysisPath],
      format: "json",
    });

    expect(response.isError).toBeUndefined();
    const report = JSON.parse(text(response)) as {
      datasetName: string;
      scoringSignals: Array<{ id: string }>;
    };
    expect(report.datasetName).toBe("mcp-calibration");
    expect(report.scoringSignals).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "navigation.strategy-switch-pressure" }),
      ]),
    );
  });

  it("turns calibration_report missing analysis into an MCP error", async () => {
    writeCalibrationFixture({ datasetUrl: "https://example.test/missing" });
    const { handler } = captureTool(registerCalibrationReport as ToolRegistrar);
    const response = await handler({
      datasetPath,
      analysisPaths: [analysisPath],
      format: "json",
    });

    expect(response.isError).toBe(true);
    expect(text(response)).toContain("Missing analysis JSON");
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

  it("blocks local file URLs through trace_path", async () => {
    const { handler } = captureTool(registerTracePath as ToolRegistrar);
    const response = await handler({
      url: "file:///etc/passwd",
      target: "*submit*",
      profile: "generic-mobile-web-sr-v0",
      explore: false,
      timeout: 1000,
    });

    expect(response.isError).toBe(true);
    expect(text(response)).toContain("file: URLs are not allowed");
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

  it("blocks local file URLs through analyze_url", async () => {
    const { handler } = captureTool(registerAnalyzeUrl as ToolRegistrar);
    const response = await handler({
      url: "file:///etc/passwd",
      profile: "generic-mobile-web-sr-v0",
      format: "json",
      explore: false,
      probe: false,
      summaryOnly: true,
      includeStates: false,
      timeout: 1000,
    });

    expect(response.isError).toBe(true);
    expect(text(response)).toContain("file: URLs are not allowed");
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

  it("blocks local file URLs through analyze_pages", async () => {
    const { handler } = captureTool(registerAnalyzePages as ToolRegistrar);
    const response = await handler({
      urls: ["file:///etc/passwd"],
      profile: "generic-mobile-web-sr-v0",
      timeout: 1000,
    });

    expect(response.isError).toBeUndefined();
    expect(text(response)).toContain("invalid-url: file: URLs are not allowed");
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

  it("blocks local file URLs through validate_url", async () => {
    const { handler } = captureTool(registerValidateUrl as ToolRegistrar);
    const response = await handler({
      url: "file:///etc/passwd",
      maxTargets: 1,
      strategy: "semantic",
      timeout: 1000,
    });

    expect(response.isError).toBe(true);
    expect(text(response)).toContain("file: URLs are not allowed");
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

  it("blocks local file URLs through save_auth before browser launch", async () => {
    const { handler } = captureTool(registerSaveAuth as ToolRegistrar);
    const response = await handler({
      url: "file:///etc/passwd",
      steps: [],
      outputPath: "auth.json",
      timeout: 1000,
    });

    expect(response.isError).toBe(true);
    expect(text(response)).toContain("file: URLs are not allowed");
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

function writeCalibrationFixture(opts: { datasetUrl?: string } = {}): void {
  const url = opts.datasetUrl ?? "https://example.test/checkout";
  mkdirSync(resolve("__test_tactual_mcp_calibration"), { recursive: true });
  writeFileSync(
    resolve("__test_tactual_mcp_calibration", "dataset.json"),
    JSON.stringify({
      name: "mcp-calibration",
      collectedAt: "2026-06-13T00:00:00Z",
      observations: [
        {
          url,
          profileId: "nvda-desktop-v0",
          targetId: "initial:checkout",
          targetName: "Checkout",
          observedAnnouncement: "Checkout, button",
          announcementSource: "fixture",
          actualStepsToReach: 9,
          strategyUsed: "mixed",
          requiredStrategySwitch: true,
          knewTargetExisted: true,
          timeToDiscoverSeconds: 8,
          discoveryMethod: "linear-scan",
          couldOperate: true,
          couldRecover: true,
          difficultyRating: 4,
          testerId: "mcp-test",
          timestamp: "2026-06-13T00:01:00Z",
        },
      ],
    }),
  );
  writeFileSync(
    resolve("__test_tactual_mcp_calibration", "analysis.json"),
    JSON.stringify({
      flow: {
        id: "flow",
        name: "https://example.test/checkout",
        states: ["initial"],
        profile: "nvda-desktop-v0",
        timestamp: Date.now(),
      },
      states: [
        {
          id: "initial",
          url: "https://example.test/checkout",
          route: "/checkout",
          snapshotHash: "a",
          interactiveHash: "b",
          openOverlays: [],
          targets: [
            {
              id: "checkout",
              kind: "button",
              role: "button",
              name: "Checkout",
              selector: "button",
            },
          ],
          timestamp: Date.now(),
          provenance: "scripted",
        },
      ],
      findings: [
        {
          targetId: "initial:checkout",
          profile: "nvda-desktop-v0",
          scores: {
            discoverability: 96,
            reachability: 94,
            operability: 92,
            recovery: 90,
            interopRisk: 88,
            overall: 95,
          },
          severity: "strong",
          bestPath: ["initial", "initial:checkout"],
          alternatePaths: [],
          penalties: [],
          suggestedFixes: [],
          confidence: 0.9,
        },
      ],
      diagnostics: [],
      metadata: {
        version: "0.0.0-test",
        profile: "nvda-desktop-v0",
        duration: 1,
        stateCount: 1,
        targetCount: 1,
        findingCount: 1,
        edgeCount: 1,
      },
    }),
  );
}
