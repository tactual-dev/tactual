import { describe, it, expect } from "vitest";
import {
  findNearestHeading,
  findNearestLandmark,
  median,
  collectEntryPoints,
} from "./path-analysis.js";
import { NavigationGraph } from "./graph.js";
import type { PageState, Target } from "./types.js";

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

function makeState(targets: Target[]): PageState {
  return {
    id: "s1",
    url: "https://example.com",
    route: "/",
    snapshotHash: "abc",
    interactiveHash: "def",
    openOverlays: [],
    targets,
    timestamp: Date.now(),
    provenance: "scripted",
  };
}

describe("findNearestHeading", () => {
  it("finds the nearest preceding heading", () => {
    const targets = [
      makeTarget({ id: "h1", kind: "heading", role: "heading", name: "Section", headingLevel: 2 }),
      makeTarget({ id: "p1", kind: "link", role: "link", name: "Link 1" }),
      makeTarget({ id: "b1", kind: "button", role: "button", name: "Button" }),
    ];
    const state = makeState(targets);
    const result = findNearestHeading(state, targets[2]);
    expect(result?.id).toBe("h1");
  });

  it("returns null when no heading precedes the target", () => {
    const targets = [
      makeTarget({ id: "b1", kind: "button", role: "button", name: "Button" }),
      makeTarget({ id: "h1", kind: "heading", role: "heading", name: "Section" }),
    ];
    const state = makeState(targets);
    const result = findNearestHeading(state, targets[0]);
    expect(result).toBeNull();
  });

  it("returns the closest heading, not a farther one", () => {
    const targets = [
      makeTarget({ id: "h1", kind: "heading", role: "heading", name: "Far", headingLevel: 1 }),
      makeTarget({ id: "p1", kind: "link", role: "link", name: "Link" }),
      makeTarget({ id: "h2", kind: "heading", role: "heading", name: "Close", headingLevel: 2 }),
      makeTarget({ id: "b1", kind: "button", role: "button", name: "Button" }),
    ];
    const state = makeState(targets);
    const result = findNearestHeading(state, targets[3]);
    expect(result?.name).toBe("Close");
  });

  it("returns null for target not in state", () => {
    const state = makeState([]);
    const result = findNearestHeading(state, makeTarget({ id: "missing" }));
    expect(result).toBeNull();
  });
});

describe("findNearestLandmark", () => {
  it("finds the nearest preceding landmark", () => {
    const targets = [
      makeTarget({ id: "l1", kind: "landmark", role: "main", name: "Main" }),
      makeTarget({ id: "b1", kind: "button", role: "button", name: "Button" }),
    ];
    const state = makeState(targets);
    const result = findNearestLandmark(state, targets[1]);
    expect(result?.id).toBe("l1");
  });

  it("returns null when no landmark precedes", () => {
    const targets = [
      makeTarget({ id: "b1", kind: "button", role: "button", name: "Button" }),
    ];
    const state = makeState(targets);
    expect(findNearestLandmark(state, targets[0])).toBeNull();
  });
});

describe("median", () => {
  it("computes median of odd-length array", () => {
    expect(median([1, 3, 5])).toBe(3);
  });

  it("computes median of even-length array", () => {
    expect(median([1, 2, 3, 4])).toBe(2.5);
  });

  it("computes median of single element", () => {
    expect(median([42])).toBe(42);
  });

  it("handles unsorted input", () => {
    expect(median([5, 1, 3])).toBe(3);
  });
});

describe("collectEntryPoints", () => {
  it("includes state entry, headings, and landmarks", () => {
    const targets = [
      makeTarget({ id: "h1", kind: "heading", role: "heading", name: "Title" }),
      makeTarget({ id: "l1", kind: "landmark", role: "main", name: "Main" }),
      makeTarget({ id: "b1", kind: "button", role: "button", name: "Action" }),
    ];
    const state = makeState(targets);
    const graph = new NavigationGraph();
    graph.addNode({ id: "s1", kind: "state" });
    graph.addNode({ id: "s1:h1", kind: "target" });
    graph.addNode({ id: "s1:l1", kind: "target" });
    graph.addNode({ id: "s1:b1", kind: "target" });

    const entries = collectEntryPoints(state, graph);
    expect(entries).toContain("s1");
    expect(entries).toContain("s1:h1");
    expect(entries).toContain("s1:l1");
    expect(entries).not.toContain("s1:b1"); // Buttons aren't entry points
  });
});
