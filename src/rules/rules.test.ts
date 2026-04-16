import { describe, it, expect } from "vitest";
import {
  noHeadingAnchorRule,
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
// builtinRules
// ---------------------------------------------------------------------------

describe("builtinRules", () => {
  it("contains only noHeadingAnchorRule (others excluded per code comment)", () => {
    expect(builtinRules).toHaveLength(1);
    expect(builtinRules[0]).toBe(noHeadingAnchorRule);
  });
});
