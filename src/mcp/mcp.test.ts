import { describe, it, expect } from "vitest";
import { createMcpServer, extractFindings, getOverallScore } from "./index.js";
import { parseMcpHttpOptions } from "./cli-args.js";

describe("MCP server", () => {
  it("creates a server instance", () => {
    const server = createMcpServer();
    expect(server).toBeDefined();
  });

  it("registers all expected tools without throwing", () => {
    // createMcpServer calls server.registerTool() for each tool.
    // If any tool definition has invalid schemas, this would throw.
    expect(() => createMcpServer()).not.toThrow();
  });

  it("registers the expected tool set", async () => {
    // Mock-based contract test: each tool-registration helper expects
    // `server.registerTool(name, schema, handler)`. Pass a stub that
    // collects registrations so we can assert the full tool inventory
    // without spinning up a real server + transport.
    type Registration = {
      name: string;
      schema: { description?: string; inputSchema?: Record<string, unknown> };
    };
    const registrations: Registration[] = [];
    const stub = {
      registerTool: (name: string, schema: Registration["schema"]) => {
        registrations.push({ name, schema });
      },
    };

    const mods = await Promise.all([
      import("./tools/analyze-url.js"),
      import("./tools/validate-url.js"),
      import("./tools/list-profiles.js"),
      import("./tools/diff-results.js"),
      import("./tools/suggest-remediations.js"),
      import("./tools/trace-path.js"),
      import("./tools/save-auth.js"),
      import("./tools/analyze-pages.js"),
    ]);
    const registers = [
      mods[0].registerAnalyzeUrl,
      mods[1].registerValidateUrl,
      mods[2].registerListProfiles,
      mods[3].registerDiffResults,
      mods[4].registerSuggestRemediations,
      mods[5].registerTracePath,
      mods[6].registerSaveAuth,
      mods[7].registerAnalyzePages,
    ];
    for (const reg of registers) {
      reg(stub as unknown as Parameters<typeof reg>[0]);
    }

    const names = registrations.map((r) => r.name).sort();
    expect(names).toEqual([
      "analyze_pages",
      "analyze_url",
      "diff_results",
      "list_profiles",
      "save_auth",
      "suggest_remediations",
      "trace_path",
      "validate_url",
    ]);
  });

  it("analyze_url input schema includes probeMode, channel, stealth, and all pre-existing params", async () => {
    const registrations: Array<{
      name: string;
      schema: { inputSchema?: Record<string, unknown> };
    }> = [];
    const stub = {
      registerTool: (name: string, schema: { inputSchema?: Record<string, unknown> }) => {
        registrations.push({ name, schema });
      },
    };
    const { registerAnalyzeUrl } = await import("./tools/analyze-url.js");
    registerAnalyzeUrl(stub as unknown as Parameters<typeof registerAnalyzeUrl>[0]);

    const analyze = registrations.find((r) => r.name === "analyze_url");
    expect(analyze).toBeDefined();
    const keys = Object.keys(analyze!.schema.inputSchema ?? {});
    // CLI, MCP, and Action expose the same high-value analysis controls.
    expect(keys).toContain("probeMode");
    expect(keys).toContain("channel");
    expect(keys).toContain("stealth");
    expect(keys).toContain("exploreDepth");
    expect(keys).toContain("exploreBudget");
    expect(keys).toContain("exploreTimeout");
    expect(keys).toContain("exploreMaxTargets");
    expect(keys).toContain("scopeSelector");
    expect(keys).toContain("probeSelector");
    expect(keys).toContain("entrySelector");
    expect(keys).toContain("goalTarget");
    expect(keys).toContain("goalPattern");
    expect(keys).toContain("probeStrategy");
    // Pre-existing params still present (regression guard)
    expect(keys).toContain("url");
    expect(keys).toContain("profile");
    expect(keys).toContain("probe");
    expect(keys).toContain("probeBudget");
    expect(keys).toContain("explore");
  });

  it("validate_url input schema has the expected shape", async () => {
    const registrations: Array<{
      name: string;
      schema: { inputSchema?: Record<string, unknown> };
    }> = [];
    const stub = {
      registerTool: (name: string, schema: { inputSchema?: Record<string, unknown> }) => {
        registrations.push({ name, schema });
      },
    };
    const { registerValidateUrl } = await import("./tools/validate-url.js");
    registerValidateUrl(stub as unknown as Parameters<typeof registerValidateUrl>[0]);

    const validate = registrations.find((r) => r.name === "validate_url");
    expect(validate).toBeDefined();
    const keys = Object.keys(validate!.schema.inputSchema ?? {});
    expect(keys).toContain("url");
    expect(keys).toContain("profile");
    expect(keys).toContain("maxTargets");
    expect(keys).toContain("strategy");
    expect(keys).toContain("channel");
    expect(keys).toContain("stealth");
  });
});

describe("MCP CLI HTTP args", () => {
  it("accepts equals-style and space-separated host/port flags", () => {
    expect(parseMcpHttpOptions(["--http", "--port=8794", "--host=127.0.0.1"], {})).toEqual({
      port: 8794,
      host: "127.0.0.1",
    });
    expect(parseMcpHttpOptions(["--http", "--port", "8795", "--host", "0.0.0.0"], {})).toEqual({
      port: 8795,
      host: "0.0.0.0",
    });
  });

  it("keeps env/default fallback and rejects invalid values", () => {
    expect(parseMcpHttpOptions(["--http"], { PORT: "8888", HOST: "localhost" })).toEqual({
      port: 8888,
      host: "localhost",
    });
    expect(parseMcpHttpOptions(["--http"], {})).toEqual({
      port: 8787,
      host: "127.0.0.1",
    });
    expect(() => parseMcpHttpOptions(["--http", "--port", "0"], {})).toThrow("Invalid port");
    expect(() => parseMcpHttpOptions(["--http", "--host="], {})).toThrow("Invalid --host");
  });
});

// ---------------------------------------------------------------------------
// extractFindings / getOverallScore — the shared helpers used by diff_results
// and suggest_remediations to accept both raw and summarized shapes.
// ---------------------------------------------------------------------------

describe("extractFindings", () => {
  it("extracts from raw AnalysisResult shape (findings + scores.overall)", () => {
    const data = {
      findings: [
        {
          targetId: "t1",
          scores: { overall: 50 },
          severity: "moderate",
          penalties: ["P1"],
          suggestedFixes: ["Fix1"],
        },
        {
          targetId: "t2",
          scores: { overall: 80 },
          severity: "acceptable",
          penalties: [],
          suggestedFixes: [],
        },
      ],
    };
    const result = extractFindings(data);
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({
      targetId: "t1",
      overall: 50,
      severity: "moderate",
      penalties: ["P1"],
      suggestedFixes: ["Fix1"],
    });
    expect(result[1].overall).toBe(80);
  });

  it("extracts from SummarizedResult shape (worstFindings + top-level overall)", () => {
    const data = {
      worstFindings: [
        {
          targetId: "combobox:search",
          overall: 72,
          severity: "moderate",
          penalties: ["Interop risk"],
          suggestedFixes: ["Use simpler pattern"],
        },
        {
          targetId: "banner-7",
          overall: 74,
          severity: "moderate",
          penalties: [],
          suggestedFixes: ["Add aria-label"],
        },
      ],
    };
    const result = extractFindings(data);
    expect(result).toHaveLength(2);
    expect(result[0].targetId).toBe("combobox:search");
    expect(result[0].overall).toBe(72);
    expect(result[1].overall).toBe(74);
  });

  it("throws when neither findings nor worstFindings present", () => {
    expect(() => extractFindings({ name: "test" })).toThrow(/must contain/);
  });

  it("extracts from SARIF log shape (runs[0].results)", () => {
    const data = {
      $schema:
        "https://raw.githubusercontent.com/oasis-tcs/sarif-spec/main/sarif-2.1/schema/sarif-schema-2.1.0.json",
      version: "2.1.0",
      runs: [
        {
          tool: { driver: { name: "Tactual", version: "0.6.0" } },
          results: [
            {
              ruleId: "tactual/high",
              level: "error",
              message: {
                text: "Score: 33/100. Issues: No accessible name; Deep nesting. Fixes: Add aria-label; Simplify DOM",
              },
              locations: [
                { logicalLocations: [{ name: "menu:nav", kind: "accessibilityTarget" }] },
              ],
              properties: {
                scores: { overall: 33, discoverability: 20, reachability: 50 },
                confidence: 0.9,
              },
            },
            {
              ruleId: "tactual/moderate",
              level: "warning",
              message: { text: "Score: 68/100. Issues: Missing landmark. Fixes: Add nav landmark" },
              locations: [
                { logicalLocations: [{ name: "link:home", kind: "accessibilityTarget" }] },
              ],
              properties: {
                scores: { overall: 68, discoverability: 60, reachability: 80 },
                confidence: 0.85,
              },
            },
          ],
        },
      ],
    };
    const result = extractFindings(data);
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({
      targetId: "menu:nav",
      overall: 33,
      severity: "high",
      penalties: ["No accessible name", "Deep nesting"],
      suggestedFixes: ["Add aria-label", "Simplify DOM"],
    });
    expect(result[1].targetId).toBe("link:home");
    expect(result[1].overall).toBe(68);
    expect(result[1].severity).toBe("moderate");
  });

  it("skips SARIF truncation-notice pseudo-results", () => {
    const data = {
      runs: [
        {
          tool: { driver: { name: "Tactual" } },
          results: [
            {
              ruleId: "tactual/moderate",
              level: "note",
              message: { text: "[Truncated] Showing 25 of 40 findings" },
              locations: [],
              properties: { truncated: true, totalActionable: 40, omitted: 15 },
            },
            {
              ruleId: "tactual/high",
              level: "error",
              message: { text: "Score: 42/100." },
              locations: [{ logicalLocations: [{ name: "button:submit" }] }],
              properties: { scores: { overall: 42 } },
            },
          ],
        },
      ],
    };
    const result = extractFindings(data);
    expect(result).toHaveLength(1);
    expect(result[0].targetId).toBe("button:submit");
    expect(result[0].overall).toBe(42);
  });

  it("improved error message mentions all three accepted formats", () => {
    expect(() => extractFindings({ nothing: true })).toThrow(/SARIF/);
  });
});

describe("getOverallScore", () => {
  it("reads top-level overall (DetailedFinding shape)", () => {
    expect(getOverallScore({ overall: 72 })).toBe(72);
  });

  it("reads nested scores.overall (Finding shape)", () => {
    expect(getOverallScore({ scores: { overall: 50 } })).toBe(50);
  });

  it("prefers top-level overall when both exist", () => {
    expect(getOverallScore({ overall: 72, scores: { overall: 50 } })).toBe(72);
  });

  it("returns 0 when no score is found", () => {
    expect(getOverallScore({})).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// MCP tool logic (unit-level tests for the algorithms behind the tools)
// ---------------------------------------------------------------------------

describe("MCP tool logic", () => {
  it("diff_results works with raw findings shape", () => {
    const base = extractFindings({
      findings: [
        {
          targetId: "t1",
          scores: { overall: 50 },
          severity: "moderate",
          penalties: [],
          suggestedFixes: [],
        },
        {
          targetId: "t2",
          scores: { overall: 80 },
          severity: "acceptable",
          penalties: [],
          suggestedFixes: [],
        },
      ],
    });
    const cand = extractFindings({
      findings: [
        {
          targetId: "t1",
          scores: { overall: 70 },
          severity: "moderate",
          penalties: [],
          suggestedFixes: [],
        },
        {
          targetId: "t2",
          scores: { overall: 75 },
          severity: "acceptable",
          penalties: [],
          suggestedFixes: [],
        },
      ],
    });

    const baseMap = new Map(base.map((f) => [f.targetId, f]));
    const candMap = new Map(cand.map((f) => [f.targetId, f]));
    const allIds = new Set([...baseMap.keys(), ...candMap.keys()]);

    let improved = 0,
      regressed = 0;
    for (const id of allIds) {
      const delta = (candMap.get(id)?.overall ?? 0) - (baseMap.get(id)?.overall ?? 0);
      if (delta > 0) improved++;
      if (delta < 0) regressed++;
    }

    expect(improved).toBe(1); // t1: 50 → 70
    expect(regressed).toBe(1); // t2: 80 → 75
  });

  it("diff_results accepts worstFindings-shaped analysis input", () => {
    const base = extractFindings({
      worstFindings: [
        {
          targetId: "combobox:search",
          overall: 72,
          severity: "moderate",
          penalties: [],
          suggestedFixes: [],
        },
      ],
    });
    const cand = extractFindings({
      worstFindings: [
        {
          targetId: "combobox:search",
          overall: 85,
          severity: "acceptable",
          penalties: [],
          suggestedFixes: [],
        },
      ],
    });

    const baseMap = new Map(base.map((f) => [f.targetId, f]));
    const candMap = new Map(cand.map((f) => [f.targetId, f]));
    const delta =
      (candMap.get("combobox:search")?.overall ?? 0) -
      (baseMap.get("combobox:search")?.overall ?? 0);

    expect(delta).toBe(13);
  });

  it("suggest_remediations ranks by severity with worstFindings shape", () => {
    const findings = extractFindings({
      worstFindings: [
        {
          targetId: "t1",
          overall: 90,
          severity: "strong",
          suggestedFixes: ["Fix A"],
          penalties: [],
        },
        {
          targetId: "t2",
          overall: 30,
          severity: "severe",
          suggestedFixes: ["Fix B"],
          penalties: ["Bad"],
        },
        {
          targetId: "t3",
          overall: 60,
          severity: "moderate",
          suggestedFixes: ["Fix D"],
          penalties: ["Medium"],
        },
      ],
    });

    const sorted = [...findings].sort((a, b) => a.overall - b.overall);
    expect(sorted[0].targetId).toBe("t2"); // Worst first
    expect(sorted[0].suggestedFixes[0]).toBe("Fix B");
  });
});
