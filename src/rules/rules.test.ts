import { describe, it, expect } from "vitest";
import {
  noHeadingAnchorRule,
  hiddenBranchRule,
  missingAccessibleNameRule,
  excessiveControlSequenceRule,
  builtinRules,
} from "./index.js";
import type { Target, PageState } from "../core/types.js";
import { NavigationGraph } from "../core/graph.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTarget(overrides: Partial<Target> & { id: string; kind: Target["kind"] }): Target {
  return {
    role: overrides.role ?? overrides.kind,
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

// Minimal mock graph — rules don't use graph edges, only context
const graph = new NavigationGraph();

function ctx(target: Target, state: PageState) {
  return { target, state, graph, profile: "test-profile" };
}

// ---------------------------------------------------------------------------
// noHeadingAnchorRule
// ---------------------------------------------------------------------------

describe("noHeadingAnchorRule", () => {
  it("no penalty when page has headings", () => {
    const heading = makeTarget({ id: "h1", kind: "heading", name: "Title", headingLevel: 1 });
    const button = makeTarget({ id: "btn1", kind: "button", name: "Submit" });
    const state = makeState([heading, button]);

    const result = noHeadingAnchorRule.evaluate(ctx(button, state));
    expect(result.penalties).toHaveLength(0);
  });

  it("penalty when page has zero headings", () => {
    const button = makeTarget({ id: "btn1", kind: "button", name: "Submit" });
    const link = makeTarget({ id: "link1", kind: "link", name: "Home" });
    const state = makeState([button, link]);

    const result = noHeadingAnchorRule.evaluate(ctx(button, state));
    expect(result.penalties.length).toBeGreaterThan(0);
    expect(result.penalties[0]).toMatch(/no heading/i);
  });

  it("no penalty when target itself is a heading", () => {
    const heading = makeTarget({ id: "h1", kind: "heading", name: "Section", headingLevel: 2 });
    const state = makeState([heading]);

    const result = noHeadingAnchorRule.evaluate(ctx(heading, state));
    // The heading itself counts as heading structure existing
    expect(result.penalties).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// hiddenBranchRule
// ---------------------------------------------------------------------------

describe("hiddenBranchRule", () => {
  it("no penalty when requiresBranchOpen is false", () => {
    const button = makeTarget({ id: "btn1", kind: "button", name: "Save" });
    const state = makeState([button]);

    const result = hiddenBranchRule.evaluate(ctx(button, state));
    expect(result.penalties).toHaveLength(0);
    expect(result.suggestedFixes).toHaveLength(0);
  });

  it("penalty when requiresBranchOpen is true", () => {
    const menuItem = makeTarget({
      id: "mi1",
      kind: "menuItem",
      name: "Settings",
      requiresBranchOpen: true,
    });
    const state = makeState([menuItem]);

    const result = hiddenBranchRule.evaluate(ctx(menuItem, state));
    expect(result.penalties.length).toBeGreaterThan(0);
    expect(result.penalties[0]).toMatch(/hidden branch/i);
    expect(result.suggestedFixes.length).toBeGreaterThan(0);
    expect(result.suggestedFixes[0]).toMatch(/branch trigger/i);
  });
});

// ---------------------------------------------------------------------------
// missingAccessibleNameRule
// ---------------------------------------------------------------------------

describe("missingAccessibleNameRule", () => {
  it("no penalty when target has a name", () => {
    const button = makeTarget({ id: "btn1", kind: "button", name: "Submit" });
    const state = makeState([button]);

    const result = missingAccessibleNameRule.evaluate(ctx(button, state));
    expect(result.penalties).toHaveLength(0);
  });

  it("penalty when name is empty string", () => {
    const button = makeTarget({ id: "btn1", kind: "button", name: "" });
    const state = makeState([button]);

    const result = missingAccessibleNameRule.evaluate(ctx(button, state));
    expect(result.penalties.length).toBeGreaterThan(0);
    expect(result.penalties[0]).toMatch(/no accessible name/i);
    expect(result.suggestedFixes.length).toBeGreaterThan(0);
    expect(result.suggestedFixes[0]).toMatch(/aria-label/i);
  });

  it("penalty when name is whitespace only", () => {
    const button = makeTarget({ id: "btn1", kind: "button", name: "   " });
    const state = makeState([button]);

    const result = missingAccessibleNameRule.evaluate(ctx(button, state));
    expect(result.penalties.length).toBeGreaterThan(0);
    expect(result.penalties[0]).toMatch(/no accessible name/i);
  });
});

// ---------------------------------------------------------------------------
// excessiveControlSequenceRule
// ---------------------------------------------------------------------------

describe("excessiveControlSequenceRule", () => {
  it("no penalty when target is 3rd control (under threshold of 8)", () => {
    const controls = Array.from({ length: 5 }, (_, i) =>
      makeTarget({ id: `btn${i}`, kind: "button", name: `Button ${i}` }),
    );
    const state = makeState(controls);

    // Test the 3rd control (index 2, which is <= 8)
    const result = excessiveControlSequenceRule.evaluate(ctx(controls[2], state));
    expect(result.penalties).toHaveLength(0);
  });

  it("penalty when target is 12th control in sequence", () => {
    // Create 15 button targets
    const controls = Array.from({ length: 15 }, (_, i) =>
      makeTarget({ id: `btn${i}`, kind: "button", name: `Button ${i}` }),
    );
    const state = makeState(controls);

    // Test the 12th control (index 11, which is > 8)
    const result = excessiveControlSequenceRule.evaluate(ctx(controls[11], state));
    expect(result.penalties.length).toBeGreaterThan(0);
    expect(result.penalties[0]).toMatch(/controls precede/i);
  });

  it("no penalty for non-control kind regardless of position", () => {
    // Create 15 buttons then add a heading at the end
    const controls = Array.from({ length: 15 }, (_, i) =>
      makeTarget({ id: `btn${i}`, kind: "button", name: `Button ${i}` }),
    );
    const heading = makeTarget({ id: "h1", kind: "heading", name: "Section", headingLevel: 1 });
    const state = makeState([...controls, heading]);

    // Heading is not a control kind, so excessiveControlSequenceRule should not penalize
    const result = excessiveControlSequenceRule.evaluate(ctx(heading, state));
    expect(result.penalties).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// builtinRules
// ---------------------------------------------------------------------------

describe("builtinRules", () => {
  it("contains only noHeadingAnchorRule (others excluded per code comment)", () => {
    expect(builtinRules).toHaveLength(1);
    expect(builtinRules[0]).toBe(noHeadingAnchorRule);
  });
});
