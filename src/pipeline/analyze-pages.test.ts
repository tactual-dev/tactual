import { describe, expect, it } from "vitest";
import {
  buildRepeatedNavigationSummary,
  type RepeatedNavigationSummary,
} from "./analyze-pages.js";
import type { Finding, Target } from "../core/types.js";

function target(id: string, name: string, kind: Target["kind"] = "link"): Target {
  return {
    id,
    kind,
    role: kind === "button" ? "button" : "link",
    name,
    requiresBranchOpen: false,
  };
}

function finding(
  targetId: string,
  overall: number,
  tabSteps: number,
  penalty = "Many controls precede this target",
): Finding {
  return {
    targetId,
    profile: "generic-mobile-web-sr-v0",
    scores: {
      discoverability: overall,
      reachability: overall,
      operability: overall,
      recovery: overall,
      interopRisk: 0,
      overall,
    },
    severity: overall < 60 ? "high" : overall < 75 ? "moderate" : "acceptable",
    bestPath: Array.from({ length: tabSteps }, (_, i) => `nextItem: Step ${i + 1}`),
    alternatePaths: [],
    penalties: [penalty],
    suggestedFixes: ["Add skip navigation"],
    confidence: 0.8,
  };
}

describe("buildRepeatedNavigationSummary", () => {
  it("groups repeated targets across pages and ranks by linear step burden", () => {
    const summary: RepeatedNavigationSummary = buildRepeatedNavigationSummary([
      {
        url: "https://example.com/",
        targets: [target("home-1", "Docs"), target("cta-1", "Buy", "button")],
        findings: [finding("home-1", 60, 8), finding("cta-1", 90, 1)],
      },
      {
        url: "https://example.com/settings",
        targets: [target("home-2", "Docs"), target("cta-2", "Buy", "button")],
        findings: [finding("home-2", 50, 10), finding("cta-2", 90, 1)],
      },
    ]);

    expect(summary.repeatedTargets).toBe(2);
    expect(summary.totalOccurrences).toBe(4);
    expect(summary.totalLinearSteps).toBe(20);
    expect(summary.worstGroups[0]).toMatchObject({
      label: "Docs",
      pageCount: 2,
      totalOccurrences: 2,
      averageScore: 55,
      totalLinearSteps: 18,
    });
    expect(summary.worstGroups[0].examples).toHaveLength(2);
  });

  it("ignores repeated structural targets and single-page repeats", () => {
    const summary = buildRepeatedNavigationSummary([
      {
        url: "https://example.com/",
        targets: [
          target("heading-1", "Docs", "heading"),
          target("only-1", "Only Here"),
        ],
        findings: [finding("heading-1", 50, 1), finding("only-1", 50, 5)],
      },
    ]);

    expect(summary.repeatedTargets).toBe(0);
    expect(summary.totalOccurrences).toBe(0);
    expect(summary.worstGroups).toHaveLength(0);
  });
});
