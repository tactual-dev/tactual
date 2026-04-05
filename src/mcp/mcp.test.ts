import { describe, it, expect } from "vitest";
import { createMcpServer, extractFindings, getOverallScore } from "./index.js";

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
});

// ---------------------------------------------------------------------------
// extractFindings / getOverallScore — the shared helpers used by diff_results
// and suggest_remediations to accept both raw and summarized shapes.
// ---------------------------------------------------------------------------

describe("extractFindings", () => {
  it("extracts from raw AnalysisResult shape (findings + scores.overall)", () => {
    const data = {
      findings: [
        { targetId: "t1", scores: { overall: 50 }, severity: "moderate", penalties: ["P1"], suggestedFixes: ["Fix1"] },
        { targetId: "t2", scores: { overall: 80 }, severity: "acceptable", penalties: [], suggestedFixes: [] },
      ],
    };
    const result = extractFindings(data);
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({
      targetId: "t1", overall: 50, severity: "moderate", penalties: ["P1"], suggestedFixes: ["Fix1"],
    });
    expect(result[1].overall).toBe(80);
  });

  it("extracts from SummarizedResult shape (worstFindings + top-level overall)", () => {
    const data = {
      worstFindings: [
        { targetId: "combobox:search", overall: 72, severity: "moderate", penalties: ["Interop risk"], suggestedFixes: ["Use simpler pattern"] },
        { targetId: "banner-7", overall: 74, severity: "moderate", penalties: [], suggestedFixes: ["Add aria-label"] },
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
      $schema: "https://raw.githubusercontent.com/oasis-tcs/sarif-spec/main/sarif-2.1/schema/sarif-schema-2.1.0.json",
      version: "2.1.0",
      runs: [{
        tool: { driver: { name: "Tactual", version: "0.6.0" } },
        results: [
          {
            ruleId: "tactual/high",
            level: "error",
            message: { text: "Score: 33/100. Issues: No accessible name; Deep nesting. Fixes: Add aria-label; Simplify DOM" },
            locations: [{ logicalLocations: [{ name: "menu:nav", kind: "accessibilityTarget" }] }],
            properties: { scores: { overall: 33, discoverability: 20, reachability: 50 }, confidence: 0.9 },
          },
          {
            ruleId: "tactual/moderate",
            level: "warning",
            message: { text: "Score: 68/100. Issues: Missing landmark. Fixes: Add nav landmark" },
            locations: [{ logicalLocations: [{ name: "link:home", kind: "accessibilityTarget" }] }],
            properties: { scores: { overall: 68, discoverability: 60, reachability: 80 }, confidence: 0.85 },
          },
        ],
      }],
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
      runs: [{
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
      }],
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
        { targetId: "t1", scores: { overall: 50 }, severity: "moderate", penalties: [], suggestedFixes: [] },
        { targetId: "t2", scores: { overall: 80 }, severity: "acceptable", penalties: [], suggestedFixes: [] },
      ],
    });
    const cand = extractFindings({
      findings: [
        { targetId: "t1", scores: { overall: 70 }, severity: "moderate", penalties: [], suggestedFixes: [] },
        { targetId: "t2", scores: { overall: 75 }, severity: "acceptable", penalties: [], suggestedFixes: [] },
      ],
    });

    const baseMap = new Map(base.map((f) => [f.targetId, f]));
    const candMap = new Map(cand.map((f) => [f.targetId, f]));
    const allIds = new Set([...baseMap.keys(), ...candMap.keys()]);

    let improved = 0, regressed = 0;
    for (const id of allIds) {
      const delta = (candMap.get(id)?.overall ?? 0) - (baseMap.get(id)?.overall ?? 0);
      if (delta > 0) improved++;
      if (delta < 0) regressed++;
    }

    expect(improved).toBe(1);  // t1: 50 → 70
    expect(regressed).toBe(1); // t2: 80 → 75
  });

  it("diff_results works with worstFindings shape (previously caused crash)", () => {
    const base = extractFindings({
      worstFindings: [
        { targetId: "combobox:search", overall: 72, severity: "moderate", penalties: [], suggestedFixes: [] },
      ],
    });
    const cand = extractFindings({
      worstFindings: [
        { targetId: "combobox:search", overall: 85, severity: "acceptable", penalties: [], suggestedFixes: [] },
      ],
    });

    const baseMap = new Map(base.map((f) => [f.targetId, f]));
    const candMap = new Map(cand.map((f) => [f.targetId, f]));
    const delta = (candMap.get("combobox:search")?.overall ?? 0) - (baseMap.get("combobox:search")?.overall ?? 0);

    expect(delta).toBe(13);
  });

  it("suggest_remediations ranks by severity with worstFindings shape", () => {
    const findings = extractFindings({
      worstFindings: [
        { targetId: "t1", overall: 90, severity: "strong", suggestedFixes: ["Fix A"], penalties: [] },
        { targetId: "t2", overall: 30, severity: "severe", suggestedFixes: ["Fix B"], penalties: ["Bad"] },
        { targetId: "t3", overall: 60, severity: "moderate", suggestedFixes: ["Fix D"], penalties: ["Medium"] },
      ],
    });

    const sorted = [...findings].sort((a, b) => a.overall - b.overall);
    expect(sorted[0].targetId).toBe("t2"); // Worst first
    expect(sorted[0].suggestedFixes[0]).toBe("Fix B");
  });
});
