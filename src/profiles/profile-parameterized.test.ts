import { describe, it, expect } from "vitest";
import { getProfile, listProfiles } from "./index.js";
import { analyze } from "../core/analyzer.js";
import type { PageState, Target } from "../core/types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTarget(overrides: Partial<Target> & { id: string; kind: Target["kind"] }): Target {
  return {
    role: overrides.kind,
    name: overrides.name ?? `${overrides.kind}-${overrides.id}`,
    requiresBranchOpen: false,
    ...overrides,
  };
}

function makeState(targets: Target[]): PageState {
  const now = Date.now();
  return {
    id: "s1",
    url: "https://example.com/page",
    route: "/page",
    snapshotHash: `snap-${now}`,
    interactiveHash: `int-${now}`,
    openOverlays: [],
    targets,
    timestamp: now,
    provenance: "scripted",
  };
}

// ---------------------------------------------------------------------------
// Realistic page targets: 2 headings, 1 landmark, 3 buttons, 2 links, 1 form
// ---------------------------------------------------------------------------

const realisticTargets: Target[] = [
  makeTarget({ id: "h1", kind: "heading", role: "heading", name: "Page Title", headingLevel: 1 }),
  makeTarget({ id: "nav", kind: "landmark", role: "navigation", name: "Main Navigation" }),
  makeTarget({ id: "link1", kind: "link", role: "link", name: "Home" }),
  makeTarget({ id: "link2", kind: "link", role: "link", name: "About" }),
  makeTarget({ id: "h2", kind: "heading", role: "heading", name: "Content Section", headingLevel: 2 }),
  makeTarget({ id: "btn1", kind: "button", role: "button", name: "Submit" }),
  makeTarget({ id: "btn2", kind: "button", role: "button", name: "Cancel" }),
  makeTarget({ id: "btn3", kind: "button", role: "button", name: "Reset" }),
  makeTarget({ id: "field1", kind: "formField", role: "textbox", name: "Email Address" }),
];

const realisticState = makeState(realisticTargets);

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("profile-parameterized: all 5 profiles", () => {
  it("all 5 profiles produce valid results", () => {
    const profileIds = listProfiles();
    expect(profileIds.length).toBeGreaterThanOrEqual(5);

    for (const id of profileIds) {
      const profile = getProfile(id)!;
      expect(profile).toBeDefined();

      const result = analyze([realisticState], profile, { name: `test-${id}` });

      // No exceptions thrown (implicit); findings exist
      expect(result.findings.length).toBeGreaterThan(0);

      // All findings have valid severity bands
      const validBands = new Set(["strong", "acceptable", "moderate", "high", "severe"]);
      for (const finding of result.findings) {
        expect(validBands.has(finding.severity)).toBe(true);
        // All scores 0-100
        expect(finding.scores.overall).toBeGreaterThanOrEqual(0);
        expect(finding.scores.overall).toBeLessThanOrEqual(100);
        expect(finding.scores.discoverability).toBeGreaterThanOrEqual(0);
        expect(finding.scores.discoverability).toBeLessThanOrEqual(100);
        expect(finding.scores.reachability).toBeGreaterThanOrEqual(0);
        expect(finding.scores.reachability).toBeLessThanOrEqual(100);
        expect(finding.scores.operability).toBeGreaterThanOrEqual(0);
        expect(finding.scores.operability).toBeLessThanOrEqual(100);
        expect(finding.scores.recovery).toBeGreaterThanOrEqual(0);
        expect(finding.scores.recovery).toBeLessThanOrEqual(100);
      }
    }
  });

  it("desktop profiles differ from mobile", () => {
    const mobile = getProfile("generic-mobile-web-sr-v0")!;
    const desktop = getProfile("nvda-desktop-v0")!;
    expect(mobile).toBeDefined();
    expect(desktop).toBeDefined();

    const mobileResult = analyze([realisticState], mobile, { name: "mobile-test" });
    const desktopResult = analyze([realisticState], desktop, { name: "desktop-test" });

    // Both should produce findings
    expect(mobileResult.findings.length).toBeGreaterThan(0);
    expect(desktopResult.findings.length).toBeGreaterThan(0);

    // Compare overall scores — different action costs should yield different reachability scores
    const mobileScores = mobileResult.findings.map((f) => f.scores.overall);
    const desktopScores = desktopResult.findings.map((f) => f.scores.overall);

    // Not all scores should be identical across profiles
    const allIdentical =
      mobileScores.length === desktopScores.length &&
      mobileScores.every((s, i) => s === desktopScores[i]);
    expect(allIdentical).toBe(false);
  });

  it("all profiles agree on severity for a well-structured page", () => {
    const profileIds = listProfiles();

    for (const id of profileIds) {
      const profile = getProfile(id)!;
      const result = analyze([realisticState], profile, { name: `well-structured-${id}` });

      // A page with good headings + landmarks should score acceptable or better
      // for all profiles — no "severe" or "high" findings
      for (const finding of result.findings) {
        expect(
          finding.severity === "strong" ||
            finding.severity === "acceptable" ||
            finding.severity === "moderate",
        ).toBe(true);
      }
    }
  });

  it("all profiles agree on severity for a bad page", () => {
    // State with only buttons — no headings, no landmarks
    const badTargets: Target[] = [
      makeTarget({ id: "btn1", kind: "button", role: "button", name: "Click" }),
      makeTarget({ id: "btn2", kind: "button", role: "button", name: "Tap" }),
      makeTarget({ id: "btn3", kind: "button", role: "button", name: "Press" }),
      makeTarget({ id: "btn4", kind: "button", role: "button", name: "Go" }),
    ];
    const badState = makeState(badTargets);

    const profileIds = listProfiles();

    for (const id of profileIds) {
      const profile = getProfile(id)!;
      const result = analyze([badState], profile, { name: `bad-page-${id}` });

      // At least some findings should be "moderate" or worse
      const hasModerateOrWorse = result.findings.some(
        (f) => f.severity === "moderate" || f.severity === "high" || f.severity === "severe",
      );
      expect(hasModerateOrWorse).toBe(true);
    }
  });

  it("profile action cost relationships", () => {
    const profileIds = listProfiles();

    for (const id of profileIds) {
      const profile = getProfile(id)!;
      const costs = profile.actionCosts;

      // nextItem is the base action — should be the lowest or tied for lowest
      expect(costs.nextItem).toBeLessThanOrEqual(costs.find);

      // find is the most expensive real action (firstLetter uses 100 as
      // sentinel for "not available" on mobile — exclude from comparison)
      for (const action of Object.keys(costs) as Array<keyof typeof costs>) {
        if (action === "firstLetter") continue;
        expect(costs.find).toBeGreaterThanOrEqual(costs[action]);
      }

      // activate cost <= dismiss cost for most profiles
      // Exception: JAWS has dismiss=0.8 (Escape is very reliable in JAWS)
      if (profile.platform === "mobile") {
        expect(costs.activate).toBeLessThanOrEqual(costs.dismiss);
      }
    }
  });

  it("profile weights sum correctly", () => {
    const profileIds = listProfiles();

    for (const id of profileIds) {
      const profile = getProfile(id)!;
      const w = profile.weights;
      const sum = w.discoverability + w.reachability + w.operability + w.recovery;
      expect(sum).toBeCloseTo(1.0, 5);
    }
  });

  it("score stability across profiles — deterministic results", () => {
    const profileIds = listProfiles();

    for (const id of profileIds) {
      const profile = getProfile(id)!;

      const result1 = analyze([realisticState], profile, { name: `stable-1-${id}` });
      const result2 = analyze([realisticState], profile, { name: `stable-2-${id}` });

      // Same number of findings
      expect(result1.findings.length).toBe(result2.findings.length);

      // Each finding should have identical scores (deterministic)
      for (let i = 0; i < result1.findings.length; i++) {
        expect(result1.findings[i].targetId).toBe(result2.findings[i].targetId);
        expect(result1.findings[i].scores.overall).toBe(result2.findings[i].scores.overall);
        expect(result1.findings[i].scores.discoverability).toBe(result2.findings[i].scores.discoverability);
        expect(result1.findings[i].scores.reachability).toBe(result2.findings[i].scores.reachability);
        expect(result1.findings[i].scores.operability).toBe(result2.findings[i].scores.operability);
        expect(result1.findings[i].scores.recovery).toBe(result2.findings[i].scores.recovery);
        expect(result1.findings[i].severity).toBe(result2.findings[i].severity);
      }
    }
  });
});
