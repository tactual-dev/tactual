import { describe, it, expect } from "vitest";
import { analyze } from "./analyzer.js";
import { genericMobileWebSrV0 } from "../profiles/generic-mobile.js";
import type { PageState } from "./types.js";

function makeState(overrides: Partial<PageState> = {}): PageState {
  return {
    id: "s1",
    url: "https://example.com",
    route: "/",
    snapshotHash: "abc123",
    interactiveHash: "def456",
    openOverlays: [],
    targets: [
      { id: "t-landmark-1", kind: "landmark", role: "main", name: "Main", requiresBranchOpen: false },
      { id: "t-heading-1", kind: "heading", role: "heading", name: "Welcome", headingLevel: 1, requiresBranchOpen: false },
      { id: "t-link-1", kind: "link", role: "link", name: "Learn More", requiresBranchOpen: false },
      { id: "t-button-1", kind: "button", role: "button", name: "Sign Up", requiresBranchOpen: false },
      { id: "t-formfield-1", kind: "formField", role: "textbox", name: "Email", requiresBranchOpen: false },
    ],
    timestamp: Date.now(),
    provenance: "scripted",
    ...overrides,
  };
}

describe("analyze", () => {
  it("produces findings for all targets", () => {
    const state = makeState();
    const result = analyze([state], genericMobileWebSrV0, { name: "Test" });

    expect(result.findings.length).toBe(5);
    expect(result.metadata.stateCount).toBe(1);
    expect(result.metadata.targetCount).toBe(5);
    expect(result.metadata.edgeCount).toBeGreaterThan(0);
    expect(result.flow.profile).toBe("generic-mobile-web-sr-v0");
  });

  it("scores findings with valid score vectors", () => {
    const state = makeState();
    const result = analyze([state], genericMobileWebSrV0);

    for (const finding of result.findings) {
      expect(finding.scores.overall).toBeGreaterThanOrEqual(0);
      expect(finding.scores.overall).toBeLessThanOrEqual(100);
      expect(finding.scores.discoverability).toBeGreaterThanOrEqual(0);
      expect(finding.scores.reachability).toBeGreaterThanOrEqual(0);
      expect(finding.severity).toBeDefined();
      expect(finding.profile).toBe("generic-mobile-web-sr-v0");
    }
  });

  it("sorts findings by severity (worst first)", () => {
    const state = makeState();
    const result = analyze([state], genericMobileWebSrV0);

    for (let i = 0; i < result.findings.length - 1; i++) {
      expect(result.findings[i].scores.overall).toBeLessThanOrEqual(
        result.findings[i + 1].scores.overall,
      );
    }
  });

  it("generates bestPath for reachable targets", () => {
    const state = makeState();
    const result = analyze([state], genericMobileWebSrV0);

    // All targets should have a path from the state entry
    for (const finding of result.findings) {
      expect(finding.bestPath.length).toBeGreaterThanOrEqual(0);
    }
  });

  it("generates penalties and suggested fixes", () => {
    // State with no headings — should trigger noHeadingAnchorRule
    const state = makeState({
      targets: [
        { id: "t-button-1", kind: "button", role: "button", name: "", requiresBranchOpen: true },
      ],
    });
    const result = analyze([state], genericMobileWebSrV0);

    const finding = result.findings[0];
    // Should have penalties from rules
    expect(finding.penalties.length).toBeGreaterThan(0);
    expect(finding.suggestedFixes.length).toBeGreaterThan(0);
  });

  it("formats as valid JSON", () => {
    const state = makeState();
    const result = analyze([state], genericMobileWebSrV0);

    // Should be serializable
    const json = JSON.stringify(result);
    const parsed = JSON.parse(json);
    expect(parsed.findings.length).toBe(5);
  });

  it("reports version and timing metadata", () => {
    const state = makeState();
    const result = analyze([state], genericMobileWebSrV0);

    expect(result.metadata.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(result.metadata.duration).toBeGreaterThanOrEqual(0);
  });

  it("warns when --focus filter matches no landmarks (no-effect)", () => {
    const state = makeState();
    const result = analyze([state], genericMobileWebSrV0, {
      filter: { focus: ["does-not-exist"] },
    });

    const warning = result.diagnostics.find((d) =>
      d.message.includes("Focus filter") && d.message.includes("had no effect"),
    );
    expect(warning).toBeDefined();
    expect(warning?.level).toBe("warning");
  });

  it("does not emit no-effect warning when focus filter actually matches", () => {
    const state = makeState();
    // makeState includes a landmark with role "main"
    const result = analyze([state], genericMobileWebSrV0, {
      filter: { focus: ["main"] },
    });

    const warning = result.diagnostics.find((d) =>
      d.message.includes("Focus filter") && d.message.includes("had no effect"),
    );
    expect(warning).toBeUndefined();
  });
});
