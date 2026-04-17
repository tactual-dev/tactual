import { describe, it, expect } from "vitest";
import {
  filterTargets,
  filterFindings,
  filterDiagnostics,
  checkThreshold,
} from "./filter.js";
import type { Target, Finding } from "./types.js";
import type { CaptureDiagnostic } from "./diagnostics.js";

function makeTarget(overrides: Partial<Target>): Target {
  return {
    id: "t1",
    kind: "button",
    role: "button",
    name: "Test",
    requiresBranchOpen: false,
    ...overrides,
  };
}

function makeFinding(overrides: Partial<Finding>): Finding {
  return {
    targetId: "t1",
    profile: "test",
    scores: { discoverability: 80, reachability: 80, operability: 80, recovery: 80, interopRisk: 0, overall: 80 },
    severity: "acceptable",
    bestPath: [],
    alternatePaths: [],
    penalties: [],
    suggestedFixes: [],
    confidence: 0.8,
    ...overrides,
  };
}

describe("filterTargets", () => {
  it("excludes targets matching name patterns", () => {
    const targets = [
      makeTarget({ id: "t1", name: "Easter Egg Button" }),
      makeTarget({ id: "t2", name: "Submit Form" }),
      makeTarget({ id: "t3", name: "Debug Panel" }),
    ];
    const result = filterTargets(targets, { exclude: ["easter*", "debug*"] });
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("Submit Form");
  });

  it("excludes targets matching role patterns", () => {
    const targets = [
      makeTarget({ id: "t1", role: "menuitem", name: "Secret" }),
      makeTarget({ id: "t2", role: "button", name: "Visible" }),
    ];
    const result = filterTargets(targets, { exclude: ["menuitem"] });
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("Visible");
  });

  it("excludes targets matching kind patterns", () => {
    const targets = [
      makeTarget({ id: "t1", kind: "statusMessage", name: "Status" }),
      makeTarget({ id: "t2", kind: "button", name: "Action" }),
    ];
    const result = filterTargets(targets, { exclude: ["statusMessage"] });
    expect(result).toHaveLength(1);
  });

  it("is case-insensitive", () => {
    const targets = [
      makeTarget({ id: "t1", name: "EASTER EGG" }),
      makeTarget({ id: "t2", name: "Normal" }),
    ];
    const result = filterTargets(targets, { exclude: ["easter*"] });
    expect(result).toHaveLength(1);
  });

  it("focuses on targets within specified landmarks", () => {
    const targets = [
      makeTarget({ id: "l1", kind: "landmark", role: "banner", name: "Header" }),
      makeTarget({ id: "t1", kind: "link", name: "Logo" }),
      makeTarget({ id: "l2", kind: "landmark", role: "main", name: "Content" }),
      makeTarget({ id: "t2", kind: "button", name: "Submit" }),
      makeTarget({ id: "t3", kind: "link", name: "More" }),
      makeTarget({ id: "l3", kind: "landmark", role: "contentinfo", name: "Footer" }),
      makeTarget({ id: "t4", kind: "link", name: "Privacy" }),
    ];
    const result = filterTargets(targets, { focus: ["main"] });
    expect(result.map((t) => t.name)).toEqual(["Content", "Submit", "More"]);
  });

  it("returns all targets when no filter is specified", () => {
    const targets = [makeTarget({}), makeTarget({ id: "t2", name: "Other" })];
    expect(filterTargets(targets, {})).toHaveLength(2);
  });

  it("supports wildcard patterns", () => {
    const targets = [
      makeTarget({ name: "admin-panel-button" }),
      makeTarget({ id: "t2", name: "user-profile-button" }),
    ];
    const result = filterTargets(targets, { exclude: ["admin*"] });
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("user-profile-button");
  });
});

describe("filterFindings", () => {
  it("filters by minimum severity", () => {
    const findings = [
      makeFinding({ targetId: "t1", severity: "severe", scores: { discoverability: 0, reachability: 0, operability: 0, recovery: 0, interopRisk: 0, overall: 20 } }),
      makeFinding({ targetId: "t2", severity: "moderate", scores: { discoverability: 0, reachability: 0, operability: 0, recovery: 0, interopRisk: 0, overall: 65 } }),
      makeFinding({ targetId: "t3", severity: "strong", scores: { discoverability: 0, reachability: 0, operability: 0, recovery: 0, interopRisk: 0, overall: 95 } }),
    ];
    const result = filterFindings(findings, { minSeverity: "moderate" });
    expect(result).toHaveLength(2);
    expect(result.map((f) => f.targetId)).toEqual(["t1", "t2"]);
  });

  it("limits findings count", () => {
    const findings = Array.from({ length: 10 }, (_, i) =>
      makeFinding({ targetId: `t${i}` }),
    );
    const result = filterFindings(findings, { maxFindings: 3 });
    expect(result).toHaveLength(3);
  });

  it("removes ignore-priority findings", () => {
    const findings = [
      makeFinding({ targetId: "easter-egg-1" }),
      makeFinding({ targetId: "checkout-btn" }),
    ];
    const result = filterFindings(findings, {
      priority: { "easter*": "ignore" },
    });
    expect(result).toHaveLength(1);
    expect(result[0].targetId).toBe("checkout-btn");
  });
});

describe("filterDiagnostics", () => {
  it("suppresses specific diagnostic codes", () => {
    const diagnostics: CaptureDiagnostic[] = [
      { level: "warning", code: "no-headings", message: "No headings" },
      { level: "warning", code: "no-landmarks", message: "No landmarks" },
      { level: "info", code: "possible-cookie-wall", message: "Cookies" },
    ];
    const result = filterDiagnostics(diagnostics, {
      suppress: ["no-headings", "possible-cookie-wall"],
    });
    expect(result).toHaveLength(1);
    expect(result[0].code).toBe("no-landmarks");
  });

  it("returns all diagnostics when no suppressions", () => {
    const diagnostics: CaptureDiagnostic[] = [
      { level: "warning", code: "no-headings", message: "test" },
    ];
    expect(filterDiagnostics(diagnostics, {})).toHaveLength(1);
  });
});

describe("checkThreshold", () => {
  it("passes when average meets threshold", () => {
    const findings = [
      makeFinding({ scores: { discoverability: 0, reachability: 0, operability: 0, recovery: 0, interopRisk: 0, overall: 80 } }),
      makeFinding({ scores: { discoverability: 0, reachability: 0, operability: 0, recovery: 0, interopRisk: 0, overall: 90 } }),
    ];
    const result = checkThreshold(findings, 70);
    expect(result.passed).toBe(true);
    expect(result.average).toBe(85);
  });

  it("fails when average is below threshold", () => {
    const findings = [
      makeFinding({ scores: { discoverability: 0, reachability: 0, operability: 0, recovery: 0, interopRisk: 0, overall: 40 } }),
      makeFinding({ scores: { discoverability: 0, reachability: 0, operability: 0, recovery: 0, interopRisk: 0, overall: 50 } }),
    ];
    const result = checkThreshold(findings, 70);
    expect(result.passed).toBe(false);
    expect(result.average).toBe(45);
  });

  it("fails with empty findings (page may be blocked)", () => {
    expect(checkThreshold([], 70).passed).toBe(false);
  });
});
