import { describe, it, expect } from "vitest";
import {
  severityFromScore,
  computeStateSignature,
  ScoreVectorSchema,
  TargetSchema,
  PageStateSchema,
  EdgeSchema,
  FindingSchema,
} from "./types.js";

describe("severityFromScore", () => {
  it("maps scores to correct severity bands", () => {
    expect(severityFromScore(95)).toBe("strong");
    expect(severityFromScore(90)).toBe("strong");
    expect(severityFromScore(80)).toBe("acceptable");
    expect(severityFromScore(75)).toBe("acceptable");
    expect(severityFromScore(65)).toBe("moderate");
    expect(severityFromScore(60)).toBe("moderate");
    expect(severityFromScore(50)).toBe("high");
    expect(severityFromScore(40)).toBe("high");
    expect(severityFromScore(30)).toBe("severe");
    expect(severityFromScore(0)).toBe("severe");
  });
});

describe("computeStateSignature", () => {
  it("produces deterministic signatures", () => {
    const state = {
      id: "s1",
      url: "https://example.com/page",
      route: "/page",
      snapshotHash: "abc123",
      interactiveHash: "def456",
      openOverlays: ["dialog-1"],
      targets: [],
      timestamp: Date.now(),
      provenance: "scripted" as const,
    };

    const sig1 = computeStateSignature(state);
    const sig2 = computeStateSignature(state);
    expect(sig1).toBe(sig2);
  });

  it("sorts overlays for consistent signatures", () => {
    const base = {
      id: "s1",
      url: "https://example.com",
      route: "/",
      snapshotHash: "abc",
      interactiveHash: "def",
      targets: [],
      timestamp: Date.now(),
      provenance: "scripted" as const,
    };

    const sig1 = computeStateSignature({ ...base, openOverlays: ["b", "a"] });
    const sig2 = computeStateSignature({ ...base, openOverlays: ["a", "b"] });
    expect(sig1).toBe(sig2);
  });
});

describe("Zod schemas", () => {
  it("validates a score vector", () => {
    const valid = {
      discoverability: 80,
      reachability: 60,
      operability: 90,
      recovery: 70,
      interopRisk: 5,
      overall: 72,
    };
    expect(ScoreVectorSchema.parse(valid)).toEqual(valid);
  });

  it("rejects out-of-range scores", () => {
    expect(() =>
      ScoreVectorSchema.parse({ discoverability: 150, reachability: 0, operability: 0, recovery: 0, interopRisk: 0, overall: 0 }),
    ).toThrow();
  });

  it("validates a target", () => {
    const target = {
      id: "t1",
      kind: "button",
      role: "button",
      name: "Submit",
    };
    const parsed = TargetSchema.parse(target);
    expect(parsed.requiresBranchOpen).toBe(false); // default
  });

  it("validates a page state", () => {
    const state = {
      id: "s1",
      url: "https://example.com",
      route: "/",
      snapshotHash: "abc",
      interactiveHash: "def",
      targets: [],
      timestamp: Date.now(),
      provenance: "scripted",
    };
    expect(() => PageStateSchema.parse(state)).not.toThrow();
  });

  it("validates an edge", () => {
    const edge = {
      id: "e1",
      from: "s1",
      to: "t1",
      action: "nextHeading",
      cost: 1.5,
      profile: "generic-mobile-web-sr-v0",
    };
    const parsed = EdgeSchema.parse(edge);
    expect(parsed.confidence).toBe(1); // default
  });

  it("validates a finding", () => {
    const finding = {
      targetId: "checkout.primary",
      profile: "generic-mobile-web-sr-v0",
      scores: {
        discoverability: 41,
        reachability: 57,
        operability: 88,
        recovery: 74,
        interopRisk: 9,
        overall: 58,
      },
      severity: "high",
      bestPath: ["next heading: Cart", "next control", "activate"],
      alternatePaths: [],
      penalties: ["Primary action is not grouped under a heading"],
      suggestedFixes: ["Add a task heading above cart actions"],
      confidence: 0.81,
    };
    expect(() => FindingSchema.parse(finding)).not.toThrow();
  });
});
