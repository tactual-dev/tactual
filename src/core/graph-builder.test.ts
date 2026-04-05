import { describe, it, expect } from "vitest";
import { buildGraph } from "./graph-builder.js";
import { genericMobileWebSrV0 } from "../profiles/generic-mobile.js";
import type { PageState } from "./types.js";

function makeState(overrides: Partial<PageState> = {}): PageState {
  return {
    id: "s1",
    url: "https://example.com",
    route: "/",
    snapshotHash: "abc",
    interactiveHash: "def",
    openOverlays: [],
    targets: [
      { id: "t-landmark-1", kind: "landmark", role: "banner", name: "Header", requiresBranchOpen: false },
      { id: "t-heading-1", kind: "heading", role: "heading", name: "Welcome", headingLevel: 1, requiresBranchOpen: false },
      { id: "t-landmark-2", kind: "landmark", role: "navigation", name: "Main Nav", requiresBranchOpen: false },
      { id: "t-link-1", kind: "link", role: "link", name: "Home", requiresBranchOpen: false },
      { id: "t-link-2", kind: "link", role: "link", name: "About", requiresBranchOpen: false },
      { id: "t-landmark-3", kind: "landmark", role: "main", name: "", requiresBranchOpen: false },
      { id: "t-heading-2", kind: "heading", role: "heading", name: "Content", headingLevel: 2, requiresBranchOpen: false },
      { id: "t-button-1", kind: "button", role: "button", name: "Submit", requiresBranchOpen: false },
      { id: "t-formfield-1", kind: "formField", role: "textbox", name: "Email", requiresBranchOpen: false },
    ],
    timestamp: Date.now(),
    provenance: "scripted",
    ...overrides,
  };
}

describe("buildGraph", () => {
  it("creates state and target nodes", () => {
    const state = makeState();
    const graph = buildGraph([state], genericMobileWebSrV0);

    // 1 state node + 9 target nodes
    expect(graph.nodeCount).toBe(10);
    expect(graph.hasNode("s1")).toBe(true);
    expect(graph.hasNode("s1:t-heading-1")).toBe(true);
    expect(graph.hasNode("s1:t-button-1")).toBe(true);
  });

  it("generates linear navigation edges between adjacent targets", () => {
    const state = makeState();
    const graph = buildGraph([state], genericMobileWebSrV0);

    // Should have nextItem edges between consecutive targets
    const path = graph.shortestPath("s1:t-heading-1", "s1:t-landmark-2");
    expect(path).not.toBeNull();
    expect(path!.edges[0].action).toBe("nextItem");
  });

  it("generates heading skip navigation", () => {
    const state = makeState();
    const graph = buildGraph([state], genericMobileWebSrV0);

    // Should be able to jump between headings
    const h1Node = "s1:t-heading-1";
    const h2Node = "s1:t-heading-2";
    const headingEdges = graph.getOutEdges(h1Node).filter((e) => e.action === "nextHeading");
    expect(headingEdges.length).toBe(1);
    expect(headingEdges[0].to).toBe(h2Node);
  });

  it("generates link skip navigation", () => {
    const state = makeState();
    const graph = buildGraph([state], genericMobileWebSrV0);

    const linkEdges = graph
      .getOutEdges("s1:t-link-1")
      .filter((e) => e.action === "nextLink");
    expect(linkEdges.length).toBe(1);
    expect(linkEdges[0].to).toBe("s1:t-link-2");
  });

  it("generates control skip navigation", () => {
    const state = makeState();
    const graph = buildGraph([state], genericMobileWebSrV0);

    // Controls: link-1, link-2, button-1, formfield-1
    const controlEdges = graph
      .getOutEdges("s1:t-link-1")
      .filter((e) => e.action === "nextControl");
    expect(controlEdges.length).toBe(1);
    expect(controlEdges[0].to).toBe("s1:t-link-2");
  });

  it("generates heading navigation from state entry", () => {
    const state = makeState();
    const graph = buildGraph([state], genericMobileWebSrV0);

    const headingEdges = graph
      .getOutEdges("s1")
      .filter((e) => e.action === "nextHeading");
    // Should have edges to both headings
    expect(headingEdges.length).toBe(2);
  });

  it("generates landmark navigation from state entry", () => {
    const state = makeState();
    const graph = buildGraph([state], genericMobileWebSrV0);

    const landmarkEdges = graph
      .getOutEdges("s1")
      .filter((e) => e.action === "groupEntry");
    // 3 landmarks: banner, navigation, main
    expect(landmarkEdges.length).toBe(3);
  });

  it("finds shortest path using heading navigation", () => {
    const state = makeState();
    const graph = buildGraph([state], genericMobileWebSrV0);

    // From state entry to the Submit button
    const path = graph.shortestPath("s1", "s1:t-button-1");
    expect(path).not.toBeNull();
    // Should use some skip navigation, not just linear
    expect(path!.totalCost).toBeLessThan(9 * genericMobileWebSrV0.actionCosts.nextItem);
  });

  it("handles multi-state flows with cross-state edges", () => {
    const state1 = makeState({ id: "s1", snapshotHash: "aaa", interactiveHash: "a1" });
    const state2 = makeState({
      id: "s2",
      url: "https://example.com/next",
      route: "/next",
      snapshotHash: "bbb",
      interactiveHash: "b1",
    });

    const graph = buildGraph([state1, state2], genericMobileWebSrV0);

    // Should have flow transition edge
    const flowEdge = graph.getOutEdges("s1").find((e) => e.to === "s2");
    expect(flowEdge).toBeDefined();
    expect(flowEdge!.action).toBe("activate");
  });

  it("deduplicates identical states by signature", () => {
    const state1 = makeState({ id: "s1" });
    const state2 = makeState({ id: "s2" }); // Same signature

    const graph = buildGraph([state1, state2], genericMobileWebSrV0);

    // Second state should be deduped — only first state's nodes added
    expect(graph.hasNode("s1")).toBe(true);
    expect(graph.hasNode("s2")).toBe(false);
  });

  it("handles empty state", () => {
    const state: PageState = {
      id: "empty",
      url: "https://example.com",
      route: "/",
      snapshotHash: "empty",
      interactiveHash: "empty",
      openOverlays: [],
      targets: [],
      timestamp: Date.now(),
      provenance: "scripted",
    };

    const graph = buildGraph([state], genericMobileWebSrV0);
    expect(graph.nodeCount).toBe(1); // Just the state node
    expect(graph.edgeCount).toBe(0);
  });
});
