import { describe, it, expect } from "vitest";
import { NavigationGraph } from "./graph.js";
import type { Edge } from "./types.js";

function edge(id: string, from: string, to: string, cost: number, action = "nextItem"): Edge {
  return {
    id,
    from,
    to,
    action: action as Edge["action"],
    cost,
    profile: "test",
    confidence: 1,
  };
}

describe("NavigationGraph", () => {
  describe("nodes", () => {
    it("adds and retrieves nodes", () => {
      const g = new NavigationGraph();
      g.addNode({ id: "s1", kind: "state" });
      g.addNode({ id: "t1", kind: "target" });

      expect(g.hasNode("s1")).toBe(true);
      expect(g.hasNode("t1")).toBe(true);
      expect(g.hasNode("nope")).toBe(false);
      expect(g.nodeCount).toBe(2);
    });

    it("rejects duplicate node IDs", () => {
      const g = new NavigationGraph();
      expect(g.addNode({ id: "s1", kind: "state" })).toBe(true);
      expect(g.addNode({ id: "s1", kind: "state" })).toBe(false);
      expect(g.nodeCount).toBe(1);
    });

    it("deduplicates by state signature", () => {
      const g = new NavigationGraph();
      g.addNode({ id: "s1", kind: "state", signature: "sig-abc" });
      const added = g.addNode({ id: "s2", kind: "state", signature: "sig-abc" });

      expect(added).toBe(false);
      expect(g.nodeCount).toBe(1);
      expect(g.getNodeBySignature("sig-abc")?.id).toBe("s1");
    });
  });

  describe("edges", () => {
    it("adds edges between existing nodes", () => {
      const g = new NavigationGraph();
      g.addNode({ id: "a", kind: "state" });
      g.addNode({ id: "b", kind: "target" });
      g.addEdge(edge("e1", "a", "b", 1.5));

      expect(g.edgeCount).toBe(1);
      expect(g.getOutEdges("a")).toHaveLength(1);
      expect(g.getInEdges("b")).toHaveLength(1);
    });

    it("throws on edge to missing node", () => {
      const g = new NavigationGraph();
      g.addNode({ id: "a", kind: "state" });

      expect(() => g.addEdge(edge("e1", "a", "missing", 1))).toThrow("missing");
    });
  });

  describe("shortestPath", () => {
    it("finds direct path", () => {
      const g = new NavigationGraph();
      g.addNode({ id: "a", kind: "state" });
      g.addNode({ id: "b", kind: "target" });
      g.addEdge(edge("e1", "a", "b", 2));

      const path = g.shortestPath("a", "b");
      expect(path).not.toBeNull();
      expect(path!.nodes).toEqual(["a", "b"]);
      expect(path!.totalCost).toBe(2);
    });

    it("finds cheapest multi-hop path", () => {
      const g = new NavigationGraph();
      g.addNode({ id: "a", kind: "state" });
      g.addNode({ id: "b", kind: "state" });
      g.addNode({ id: "c", kind: "target" });

      // Direct but expensive
      g.addEdge(edge("e1", "a", "c", 10));
      // Cheaper via b
      g.addEdge(edge("e2", "a", "b", 2));
      g.addEdge(edge("e3", "b", "c", 3));

      const path = g.shortestPath("a", "c");
      expect(path!.nodes).toEqual(["a", "b", "c"]);
      expect(path!.totalCost).toBe(5);
    });

    it("returns null for unreachable targets", () => {
      const g = new NavigationGraph();
      g.addNode({ id: "a", kind: "state" });
      g.addNode({ id: "b", kind: "target" });
      // No edges

      expect(g.shortestPath("a", "b")).toBeNull();
    });

    it("returns zero-cost path for same node", () => {
      const g = new NavigationGraph();
      g.addNode({ id: "a", kind: "state" });

      const path = g.shortestPath("a", "a");
      expect(path!.totalCost).toBe(0);
      expect(path!.nodes).toEqual(["a"]);
    });
  });

  describe("reachableWithin", () => {
    it("finds all nodes within cost budget", () => {
      const g = new NavigationGraph();
      g.addNode({ id: "a", kind: "state" });
      g.addNode({ id: "b", kind: "state" });
      g.addNode({ id: "c", kind: "target" });
      g.addNode({ id: "d", kind: "target" });

      g.addEdge(edge("e1", "a", "b", 2));
      g.addEdge(edge("e2", "b", "c", 3));
      g.addEdge(edge("e3", "b", "d", 10));

      const reachable = g.reachableWithin("a", 5);
      expect(reachable.has("a")).toBe(true);
      expect(reachable.has("b")).toBe(true);
      expect(reachable.has("c")).toBe(true);
      expect(reachable.has("d")).toBe(false);
    });
  });

  describe("serialization", () => {
    it("round-trips through JSON", () => {
      const g = new NavigationGraph();
      g.addNode({ id: "a", kind: "state" });
      g.addNode({ id: "b", kind: "target" });
      g.addEdge(edge("e1", "a", "b", 1.5));

      const json = g.toJSON();
      const restored = NavigationGraph.fromJSON(json);

      expect(restored.nodeCount).toBe(2);
      expect(restored.edgeCount).toBe(1);
      expect(restored.shortestPath("a", "b")!.totalCost).toBe(1.5);
    });
  });

  describe("targetsReachableFrom", () => {
    it("returns only target-kind nodes with costs", () => {
      const g = new NavigationGraph();
      g.addNode({ id: "s1", kind: "state" });
      g.addNode({ id: "s2", kind: "state" });
      g.addNode({ id: "t1", kind: "target" });
      g.addNode({ id: "t2", kind: "target" });

      g.addEdge(edge("e1", "s1", "s2", 1));
      g.addEdge(edge("e2", "s2", "t1", 2));
      g.addEdge(edge("e3", "s1", "t2", 5));

      const targets = g.targetsReachableFrom("s1");
      expect(targets.size).toBe(2);
      expect(targets.get("t1")).toBe(3);
      expect(targets.get("t2")).toBe(5);
    });
  });
});
