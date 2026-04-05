import { describe, it, expect } from "vitest";
import { NavigationGraph } from "./graph.js";
import { buildGraph } from "./graph-builder.js";
import { getProfile } from "../profiles/index.js";
import type { Target, PageState, Edge } from "./types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TARGET_KINDS = ["heading", "landmark", "button", "link", "formField", "menuTrigger", "tab", "search"] as const;
const ROLES = ["heading", "navigation", "button", "link", "textbox", "menuitem", "tab", "search"];

function generateTargets(count: number): Target[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `t${i}`,
    kind: TARGET_KINDS[i % TARGET_KINDS.length],
    role: ROLES[i % ROLES.length],
    name: `Target ${i}`,
    requiresBranchOpen: false,
    ...(TARGET_KINDS[i % TARGET_KINDS.length] === "heading" ? { headingLevel: (i % 3) + 1 } : {}),
  }));
}

function makeEdge(id: string, from: string, to: string, cost: number): Edge {
  return {
    id,
    from,
    to,
    action: "nextItem",
    cost,
    profile: "test",
    confidence: 1,
  };
}

function makeLargeState(targetCount: number, id = "s1"): PageState {
  return {
    id,
    url: "https://example.com",
    route: "/",
    snapshotHash: `hash-${id}`,
    interactiveHash: `ihash-${id}`,
    openOverlays: [],
    targets: generateTargets(targetCount),
    timestamp: Date.now(),
    provenance: "scripted",
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("NavigationGraph at scale", () => {
  it("1000 nodes, 5000 edges — Dijkstra completes under 1000ms", () => {
    const graph = new NavigationGraph();

    // Add 1000 nodes
    for (let i = 0; i < 1000; i++) {
      graph.addNode({ id: `n${i}`, kind: "target" });
    }

    // Add 5000 directed edges between random pairs with random costs
    const seededRandom = (seed: number) => {
      let s = seed;
      return () => {
        s = (s * 16807 + 0) % 2147483647;
        return s / 2147483647;
      };
    };
    const rng = seededRandom(42);

    for (let i = 0; i < 5000; i++) {
      const from = Math.floor(rng() * 1000);
      const to = Math.floor(rng() * 1000);
      if (from === to) continue;
      const cost = Math.floor(rng() * 10) + 1;
      graph.addEdge(makeEdge(`e${i}`, `n${from}`, `n${to}`, cost));
    }

    const start = performance.now();
    const path = graph.shortestPath("n0", "n999");
    const elapsed = performance.now() - start;

    // Should complete — result is either a valid path or null (unreachable)
    expect(path === null || path.nodes.length > 0).toBe(true);
    expect(elapsed).toBeLessThan(1000);
  });

  it("large realistic page — 200 targets", () => {
    const profile = getProfile("generic-mobile-web-sr-v0");
    expect(profile).toBeDefined();

    const state = makeLargeState(200);
    const graph = buildGraph([state], profile!);

    // 1 state node + 200 target nodes = 201 nodes
    expect(graph.nodeCount).toBe(201);
    // Must have more than 200 edges (linear + skip navigation)
    expect(graph.edgeCount).toBeGreaterThan(200);

    // First and last target
    const firstTarget = `s1:t0`;
    const lastTarget = `s1:t199`;

    const path = graph.shortestPath(firstTarget, lastTarget);
    // Should find a path (all targets are connected via linear navigation)
    expect(path).not.toBeNull();
    expect(path!.nodes.length).toBeGreaterThan(1);
  });

  it("graph serialization roundtrip at scale", () => {
    const profile = getProfile("generic-mobile-web-sr-v0")!;
    const state = makeLargeState(200);
    const graph = buildGraph([state], profile);

    const json = graph.toJSON();
    const restored = NavigationGraph.fromJSON(json);

    expect(restored.nodeCount).toBe(graph.nodeCount);
    expect(restored.edgeCount).toBe(graph.edgeCount);
  });

  it("reachability at scale — completes under 500ms", () => {
    const profile = getProfile("generic-mobile-web-sr-v0")!;
    const state = makeLargeState(200);
    const graph = buildGraph([state], profile);

    const entryNode = "s1";

    const start = performance.now();
    const reachable = graph.reachableWithin(entryNode, 50);
    const elapsed = performance.now() - start;

    expect(reachable).toBeInstanceOf(Map);
    expect(reachable.size).toBeGreaterThan(0);
    expect(elapsed).toBeLessThan(500);
  });

  it("deduplication at scale — 500 nodes with 100 duplicate signatures", () => {
    const graph = new NavigationGraph();

    // Add 500 nodes: 100 unique signatures, 5 attempts per signature
    let addedCount = 0;
    for (let sig = 0; sig < 100; sig++) {
      for (let dup = 0; dup < 5; dup++) {
        const nodeId = `n${sig}-${dup}`;
        const signature = `sig-${sig}`;
        const wasAdded = graph.addNode({ id: nodeId, kind: "state", signature });
        if (wasAdded) addedCount++;
      }
    }

    // Only the first of each signature group should be added
    expect(addedCount).toBe(100);
    expect(graph.nodeCount).toBe(100);

    // Verify signature lookup returns the correct (first) node
    for (let sig = 0; sig < 100; sig++) {
      const node = graph.getNodeBySignature(`sig-${sig}`);
      expect(node).toBeDefined();
      expect(node!.id).toBe(`n${sig}-0`);
    }
  });

  it("empty graph operations — no crash", () => {
    const graph = new NavigationGraph();

    expect(graph.nodeCount).toBe(0);
    expect(graph.edgeCount).toBe(0);

    // shortestPath on missing nodes returns null
    const path = graph.shortestPath("nonexistent-a", "nonexistent-b");
    expect(path).toBeNull();

    // reachableWithin on missing node returns map with no entries
    // (or just the start if it exists — here it doesn't exist so empty)
    const reachable = graph.reachableWithin("nonexistent", 100);
    expect(reachable).toBeInstanceOf(Map);
    // No crash is the key assertion
  });

  it("single-node graph — trivial self-path", () => {
    const graph = new NavigationGraph();
    graph.addNode({ id: "only", kind: "state" });

    const path = graph.shortestPath("only", "only");
    expect(path).not.toBeNull();
    expect(path!.nodes).toEqual(["only"]);
    expect(path!.totalCost).toBe(0);
    expect(path!.edges).toHaveLength(0);
  });
});
