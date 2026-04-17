import { describe, it, expect } from "vitest";
import { formatSARIF } from "./sarif.js";
import type { AnalysisResult, Finding, PageState } from "../core/types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeFinding(overrides: Partial<Finding> = {}): Finding {
  return {
    targetId: "t1",
    profile: "test-profile",
    scores: {
      discoverability: 70,
      reachability: 70,
      operability: 70,
      recovery: 70,
      interopRisk: 0,
      overall: 70,
    },
    severity: "moderate",
    bestPath: ["nextItem: t1"],
    alternatePaths: [],
    penalties: ["No heading anchor"],
    suggestedFixes: ["Add a heading"],
    confidence: 0.8,
    ...overrides,
  };
}

function makeResult(findings: Finding[], stateOverrides: Partial<PageState> = {}): AnalysisResult {
  return {
    flow: { id: "f1", name: "test", states: ["s1"], profile: "test-profile", timestamp: Date.now() },
    states: [{
      id: "s1",
      url: "https://example.com",
      route: "/",
      snapshotHash: "h1",
      interactiveHash: "ih1",
      openOverlays: [],
      targets: [],
      timestamp: Date.now(),
      provenance: "scripted" as const,
      ...stateOverrides,
    }],
    findings,
    diagnostics: [],
    metadata: { version: "0.1.0", profile: "test-profile", duration: 100, stateCount: 1, targetCount: findings.length, findingCount: findings.length, edgeCount: 0 },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("SARIF validation", () => {
  it("valid SARIF envelope", () => {
    const result = makeResult([makeFinding()]);
    const sarif = JSON.parse(formatSARIF(result));

    expect(sarif.$schema).toBe(
      "https://raw.githubusercontent.com/oasis-tcs/sarif-spec/main/sarif-2.1/schema/sarif-schema-2.1.0.json",
    );
    expect(sarif.version).toBe("2.1.0");
    expect(Array.isArray(sarif.runs)).toBe(true);
    expect(sarif.runs).toHaveLength(1);
    expect(sarif.runs[0].tool.driver.name).toBe("Tactual");
    expect(Array.isArray(sarif.runs[0].tool.driver.rules)).toBe(true);
    expect(sarif.runs[0].tool.driver.rules).toHaveLength(5);
  });

  it("rule IDs match severity levels", () => {
    const result = makeResult([makeFinding()]);
    const sarif = JSON.parse(formatSARIF(result));
    const ruleIds = sarif.runs[0].tool.driver.rules.map((r: { id: string }) => r.id);

    expect(ruleIds).toContain("tactual/severe");
    expect(ruleIds).toContain("tactual/high");
    expect(ruleIds).toContain("tactual/moderate");
    expect(ruleIds).toContain("tactual/acceptable");
  });

  it("severe finding produces error-level result", () => {
    const finding = makeFinding({
      scores: { discoverability: 30, reachability: 30, operability: 30, recovery: 30, interopRisk: 0, overall: 30 },
      severity: "severe",
    });
    const sarif = JSON.parse(formatSARIF(makeResult([finding])));
    const res = sarif.runs[0].results[0];

    expect(res.level).toBe("error");
    expect(res.ruleId).toBe("tactual/severe");
  });

  it("moderate finding produces warning-level result", () => {
    const finding = makeFinding({
      scores: { discoverability: 65, reachability: 65, operability: 65, recovery: 65, interopRisk: 0, overall: 65 },
      severity: "moderate",
    });
    const sarif = JSON.parse(formatSARIF(makeResult([finding])));
    const res = sarif.runs[0].results[0];

    expect(res.level).toBe("warning");
    expect(res.ruleId).toBe("tactual/moderate");
  });

  it("acceptable finding produces note-level result", () => {
    const finding = makeFinding({
      scores: { discoverability: 80, reachability: 80, operability: 80, recovery: 80, interopRisk: 0, overall: 80 },
      severity: "acceptable",
    });
    const sarif = JSON.parse(formatSARIF(makeResult([finding])));
    const res = sarif.runs[0].results[0];

    expect(res.level).toBe("note");
    expect(res.ruleId).toBe("tactual/acceptable");
  });

  it("strong findings are excluded", () => {
    const finding = makeFinding({
      scores: { discoverability: 95, reachability: 95, operability: 95, recovery: 95, interopRisk: 0, overall: 95 },
      severity: "strong",
    });
    const sarif = JSON.parse(formatSARIF(makeResult([finding])));

    expect(sarif.runs[0].results).toHaveLength(0);
  });

  it("empty findings", () => {
    const sarif = JSON.parse(formatSARIF(makeResult([])));

    expect(sarif.version).toBe("2.1.0");
    expect(sarif.runs[0].results).toHaveLength(0);
    expect(sarif.runs[0].tool.driver.rules).toHaveLength(5);
  });

  it("empty states — no crash, valid JSON", () => {
    const result: AnalysisResult = {
      flow: { id: "f1", name: "test", states: [], profile: "test-profile", timestamp: Date.now() },
      states: [],
      findings: [makeFinding()],
      diagnostics: [],
      metadata: { version: "0.1.0", profile: "test-profile", duration: 100, stateCount: 0, targetCount: 1, findingCount: 1, edgeCount: 0 },
    };

    const raw = formatSARIF(result);
    expect(() => JSON.parse(raw)).not.toThrow();

    const sarif = JSON.parse(raw);
    // Physical location URI should be empty string since there are no states
    const loc = sarif.runs[0].results[0]?.locations?.[0];
    // With no states, states[0]?.url is undefined, so physicalLocation may be absent
    expect(loc).toBeDefined();
  });

  it("result message contains score and penalties", () => {
    const finding = makeFinding({
      scores: { discoverability: 50, reachability: 50, operability: 50, recovery: 50, interopRisk: 0, overall: 50 },
      severity: "high",
      penalties: ["Missing landmark", "No heading structure"],
    });
    const sarif = JSON.parse(formatSARIF(makeResult([finding])));
    const message = sarif.runs[0].results[0].message.text;

    expect(message).toContain("50/100");
    expect(message).toContain("Missing landmark");
    expect(message).toContain("No heading structure");
  });

  it("result properties contain scores object with all 6 dimensions", () => {
    const finding = makeFinding();
    const sarif = JSON.parse(formatSARIF(makeResult([finding])));
    const props = sarif.runs[0].results[0].properties;

    expect(props.scores).toBeDefined();
    expect(typeof props.scores.discoverability).toBe("number");
    expect(typeof props.scores.reachability).toBe("number");
    expect(typeof props.scores.operability).toBe("number");
    expect(typeof props.scores.recovery).toBe("number");
    expect(typeof props.scores.interopRisk).toBe("number");
    expect(typeof props.scores.overall).toBe("number");
  });

  it("multiple findings produce correctly mapped results", () => {
    const findings: Finding[] = [
      makeFinding({ targetId: "t1", scores: { discoverability: 20, reachability: 20, operability: 20, recovery: 20, interopRisk: 0, overall: 20 }, severity: "severe" }),
      makeFinding({ targetId: "t2", scores: { discoverability: 50, reachability: 50, operability: 50, recovery: 50, interopRisk: 0, overall: 50 }, severity: "high" }),
      makeFinding({ targetId: "t3", scores: { discoverability: 65, reachability: 65, operability: 65, recovery: 65, interopRisk: 0, overall: 65 }, severity: "moderate" }),
      makeFinding({ targetId: "t4", scores: { discoverability: 80, reachability: 80, operability: 80, recovery: 80, interopRisk: 0, overall: 80 }, severity: "acceptable" }),
      makeFinding({ targetId: "t5", scores: { discoverability: 95, reachability: 95, operability: 95, recovery: 95, interopRisk: 0, overall: 95 }, severity: "strong" }),
    ];

    const sarif = JSON.parse(formatSARIF(makeResult(findings)));
    const results = sarif.runs[0].results;

    // Strong finding (t5) is excluded
    expect(results).toHaveLength(4);

    expect(results[0].ruleId).toBe("tactual/severe");
    expect(results[1].ruleId).toBe("tactual/high");
    expect(results[2].ruleId).toBe("tactual/moderate");
    expect(results[3].ruleId).toBe("tactual/acceptable");
  });

  it("location logicalLocations have accessibilityTarget kind", () => {
    const finding = makeFinding({ targetId: "nav-button" });
    const sarif = JSON.parse(formatSARIF(makeResult([finding])));
    const locations = sarif.runs[0].results[0].locations;

    expect(locations).toHaveLength(1);
    expect(locations[0].logicalLocations).toBeDefined();
    expect(locations[0].logicalLocations).toHaveLength(1);
    expect(locations[0].logicalLocations[0].kind).toBe("accessibilityTarget");
    expect(locations[0].logicalLocations[0].name).toBe("nav-button");
  });

  it("SARIF output is valid JSON for every severity", () => {
    const severityCases = [
      { overall: 20, severity: "severe" as const },
      { overall: 50, severity: "high" as const },
      { overall: 65, severity: "moderate" as const },
      { overall: 80, severity: "acceptable" as const },
      { overall: 95, severity: "strong" as const },
    ];

    for (const { overall, severity } of severityCases) {
      const finding = makeFinding({
        scores: { discoverability: overall, reachability: overall, operability: overall, recovery: overall, interopRisk: 0, overall },
        severity,
      });
      const raw = formatSARIF(makeResult([finding]));
      expect(() => JSON.parse(raw)).not.toThrow();
    }
  });

  it("no unescaped special chars in message text", () => {
    const finding = makeFinding({
      penalties: ['Button labeled "Click here" is ambiguous', "Missing <main> landmark"],
      suggestedFixes: ['Add aria-label="Submit form"', "Wrap content in <main>"],
    });

    const raw = formatSARIF(makeResult([finding]));
    // If JSON.parse succeeds, all special characters are properly escaped
    expect(() => JSON.parse(raw)).not.toThrow();

    const sarif = JSON.parse(raw);
    const message = sarif.runs[0].results[0].message.text;
    expect(message).toContain('"Click here"');
    expect(message).toContain("<main>");
  });
});
