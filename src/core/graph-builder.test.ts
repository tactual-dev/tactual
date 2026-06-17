import { describe, it, expect } from "vitest";
import { buildGraph } from "./graph-builder.js";
import { genericMobileWebSrV0 } from "../profiles/generic-mobile.js";
import { nvdaDesktopV0 } from "../profiles/nvda-desktop.js";
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

  it("generates richer AT mode edges for forms, buttons, landmarks, rotor, and touch exploration", () => {
    const baseTargets = makeState().targets;
    const state = makeState({
      viewport: { width: 800, height: 600 },
      targets: [
        ...baseTargets.map((target) =>
          target.id === "t-button-1"
            ? {
                ...target,
                _rect: { x: 20, y: 30, width: 120, height: 40 },
              } as PageState["targets"][number]
            : target,
        ),
        { id: "t-formfield-2", kind: "formField", role: "textbox", name: "Phone", requiresBranchOpen: false },
        { id: "t-button-2", kind: "button", role: "button", name: "Cancel", requiresBranchOpen: false },
      ],
    });
    const graph = buildGraph([state], genericMobileWebSrV0);

    expect(graph.edgesOfAction("nextFormField").some((edge) => edge.to === "s1:t-formfield-2")).toBe(true);
    expect(graph.edgesOfAction("nextButton").some((edge) => edge.to === "s1:t-button-2")).toBe(true);
    expect(graph.edgesOfAction("nextLandmark").length).toBeGreaterThan(0);
    expect(graph.getOutEdges("s1").some((e) => e.action === "rotor")).toBe(true);
    expect(graph.getOutEdges("s1").some((e) => e.action === "formsMode")).toBe(true);
    expect(graph.getOutEdges("s1").some((e) => e.action === "touchExplore" && e.to === "s1:t-button-1")).toBe(true);
  });

  it("models NVDA form-field quick-nav over the calibrated target subset", () => {
    const state = makeState({
      targets: [
        {
          id: "save",
          kind: "button",
          role: "button",
          name: "Save draft",
          requiresBranchOpen: false,
        } as PageState["targets"][number],
        {
          id: "native-email",
          kind: "formField",
          role: "textbox",
          name: "Email",
          requiresBranchOpen: false,
          _nativeHtmlControl: "input",
          _inputType: "email",
        } as PageState["targets"][number],
        {
          id: "aria-combo",
          kind: "formField",
          role: "combobox",
          name: "Assignee",
          requiresBranchOpen: false,
          _nativeHtmlControl: "input",
          _inputType: "text",
        } as PageState["targets"][number],
        {
          id: "range",
          kind: "formField",
          role: "slider",
          name: "Priority",
          requiresBranchOpen: false,
          _nativeHtmlControl: "input",
          _inputType: "range",
        } as PageState["targets"][number],
        {
          id: "spin",
          kind: "formField",
          role: "spinbutton",
          name: "Seats",
          requiresBranchOpen: false,
        } as PageState["targets"][number],
        {
          id: "actions",
          kind: "button",
          role: "button",
          name: "Actions",
          requiresBranchOpen: false,
        } as PageState["targets"][number],
        {
          id: "native-select",
          kind: "formField",
          role: "combobox",
          name: "Plan",
          requiresBranchOpen: false,
          _nativeHtmlControl: "select",
        } as PageState["targets"][number],
        {
          id: "frame-text",
          kind: "formField",
          role: "textbox",
          name: "Card number",
          requiresBranchOpen: false,
          _nativeHtmlControl: "input",
          _inputType: "text",
          _frame: { url: "https://example.com/frame", source: "ariaSnapshot" },
        } as PageState["targets"][number],
      ],
    });
    const graph = buildGraph([state], nvdaDesktopV0);

    const quickNavEdges = graph.edgesOfAction("nextFormField");
    expect(quickNavEdges.map((edge) => [edge.from, edge.to])).toEqual([
      ["s1:save", "s1:native-email"],
      ["s1:native-email", "s1:aria-combo"],
      ["s1:aria-combo", "s1:spin"],
      ["s1:spin", "s1:actions"],
      ["s1:actions", "s1:native-select"],
      ["s1:native-select", "s1:frame-text"],
    ]);
    expect(graph.getOutEdges("s1").some((edge) => edge.action === "formsMode" && edge.to === "s1:aria-combo")).toBe(true);
    expect(graph.getOutEdges("s1").some((edge) => edge.action === "formsMode" && edge.to === "s1:range")).toBe(true);
    expect(graph.getOutEdges("s1").some((edge) => edge.action === "formsMode" && edge.to === "s1:frame-text")).toBe(true);
  });

  it("generates relationship edges from ARIA controls metadata", () => {
    const state = makeState({
      targets: [
        {
          id: "trigger",
          kind: "button",
          role: "button",
          name: "Open settings",
          requiresBranchOpen: false,
          _ariaRelationships: {
            controls: [{ id: "settings", role: "dialog", name: "Settings" }],
          },
        } as PageState["targets"][number],
        {
          id: "dialog",
          kind: "dialog",
          role: "dialog",
          name: "Settings",
          requiresBranchOpen: false,
          _domId: "settings",
        } as PageState["targets"][number],
      ],
    });
    const graph = buildGraph([state], genericMobileWebSrV0);

    const relationship = graph
      .getOutEdges("s1:trigger")
      .find((edge) => edge.action === "relationshipJump");
    expect(relationship?.to).toBe("s1:dialog");
  });

  it("generates active-descendant edges from composite owner metadata", () => {
    const state = makeState({
      targets: [
        {
          id: "combo",
          kind: "formField",
          role: "combobox",
          name: "Assignee",
          requiresBranchOpen: false,
          _ariaRelationships: {
            activeDescendant: { id: "active-assignee", role: "button", name: "Assign to Ada" },
          },
        } as PageState["targets"][number],
        {
          id: "active",
          kind: "button",
          role: "button",
          name: "Assign to Ada",
          requiresBranchOpen: false,
          _domId: "active-assignee",
        } as PageState["targets"][number],
      ],
    });
    const graph = buildGraph([state], genericMobileWebSrV0);

    const active = graph
      .getOutEdges("s1:combo")
      .find((edge) => edge.action === "activeDescendant");
    expect(active?.to).toBe("s1:active");
  });

  it("generates composite-widget arrow navigation between adjacent tabs", () => {
    const state = makeState({
      targets: [
        { id: "tab-1", kind: "tab", role: "tab", name: "Details", requiresBranchOpen: false },
        { id: "tab-2", kind: "tab", role: "tab", name: "Activity", requiresBranchOpen: false },
      ],
    });
    const graph = buildGraph([state], genericMobileWebSrV0);

    const composite = graph
      .getOutEdges("s1:tab-1")
      .find((edge) => edge.action === "compositeNavigation");
    expect(composite?.to).toBe("s1:tab-2");
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
