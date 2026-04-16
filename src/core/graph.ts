import type { Edge, NavigationAction } from "./types.js";

// ---------------------------------------------------------------------------
// Node types in the navigation graph
// ---------------------------------------------------------------------------

export interface GraphNode {
  id: string;
  kind: "state" | "target";
  /** State signature for dedup (state nodes only) */
  signature?: string;
  metadata?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Path result from shortest-path queries
// ---------------------------------------------------------------------------

export interface PathResult {
  nodes: string[];
  edges: Edge[];
  totalCost: number;
  actions: string[];
}

// ---------------------------------------------------------------------------
// NavigationGraph — directed weighted graph for SR navigation modeling
// ---------------------------------------------------------------------------

export class NavigationGraph {
  private nodes = new Map<string, GraphNode>();
  private outEdges = new Map<string, Edge[]>();
  private inEdges = new Map<string, Edge[]>();
  private signatureIndex = new Map<string, string>();

  // ---- Nodes ----

  addNode(node: GraphNode): boolean {
    if (this.nodes.has(node.id)) return false;

    if (node.signature) {
      const existing = this.signatureIndex.get(node.signature);
      if (existing) return false;
      this.signatureIndex.set(node.signature, node.id);
    }

    this.nodes.set(node.id, node);
    this.outEdges.set(node.id, []);
    this.inEdges.set(node.id, []);
    return true;
  }

  getNode(id: string): GraphNode | undefined {
    return this.nodes.get(id);
  }

  hasNode(id: string): boolean {
    return this.nodes.has(id);
  }

  /** Look up a node by its state signature (returns undefined if not found) */
  getNodeBySignature(signature: string): GraphNode | undefined {
    const id = this.signatureIndex.get(signature);
    return id ? this.nodes.get(id) : undefined;
  }

  get nodeCount(): number {
    return this.nodes.size;
  }

  // ---- Edges ----

  addEdge(edge: Edge): void {
    if (!this.nodes.has(edge.from)) {
      throw new Error(`Source node "${edge.from}" not in graph`);
    }
    if (!this.nodes.has(edge.to)) {
      throw new Error(`Target node "${edge.to}" not in graph`);
    }
    this.outEdges.get(edge.from)!.push(edge);
    this.inEdges.get(edge.to)!.push(edge);
  }

  getOutEdges(nodeId: string): readonly Edge[] {
    return this.outEdges.get(nodeId) ?? [];
  }

  getInEdges(nodeId: string): readonly Edge[] {
    return this.inEdges.get(nodeId) ?? [];
  }

  get edgeCount(): number {
    let count = 0;
    for (const edges of this.outEdges.values()) count += edges.length;
    return count;
  }

  // ---- Queries ----

  /** All node IDs */
  nodeIds(): IterableIterator<string> {
    return this.nodes.keys();
  }

  /** All nodes */
  allNodes(): IterableIterator<GraphNode> {
    return this.nodes.values();
  }

  /** All edges in the graph */
  allEdges(): Edge[] {
    const result: Edge[] = [];
    for (const edges of this.outEdges.values()) result.push(...edges);
    return result;
  }

  /** Nodes reachable from `startId` within `maxCost` total edge cost */
  reachableWithin(startId: string, maxCost: number): Map<string, number> {
    const costs = new Map<string, number>();
    costs.set(startId, 0);

    // Min-heap priority queue (same pattern as shortestPath)
    const heap: [string, number][] = [[startId, 0]];
    const push = (item: [string, number]) => {
      heap.push(item);
      let i = heap.length - 1;
      while (i > 0) {
        const p = (i - 1) >> 1;
        if (heap[p][1] <= heap[i][1]) break;
        [heap[p], heap[i]] = [heap[i], heap[p]];
        i = p;
      }
    };
    const pop = (): [string, number] => {
      const top = heap[0];
      const last = heap.pop()!;
      if (heap.length > 0) {
        heap[0] = last;
        let i = 0;
        while (true) {
          let s = i;
          const l = 2 * i + 1, r = 2 * i + 2;
          if (l < heap.length && heap[l][1] < heap[s][1]) s = l;
          if (r < heap.length && heap[r][1] < heap[s][1]) s = r;
          if (s === i) break;
          [heap[s], heap[i]] = [heap[i], heap[s]];
          i = s;
        }
      }
      return top;
    };

    while (heap.length > 0) {
      const [current, currentCost] = pop();
      if (currentCost > (costs.get(current) ?? Infinity)) continue;
      for (const edge of this.getOutEdges(current)) {
        const newCost = currentCost + edge.cost;
        if (newCost > maxCost) continue;
        const existing = costs.get(edge.to);
        if (existing === undefined || newCost < existing) {
          costs.set(edge.to, newCost);
          push([edge.to, newCost]);
        }
      }
    }

    return costs;
  }

  // ---- Shortest path (Dijkstra) ----

  shortestPath(fromId: string, toId: string): PathResult | null {
    if (!this.nodes.has(fromId) || !this.nodes.has(toId)) return null;
    if (fromId === toId) return { nodes: [fromId], edges: [], totalCost: 0, actions: [] };

    const dist = new Map<string, number>();
    const prev = new Map<string, { nodeId: string; edge: Edge }>();
    const visited = new Set<string>();

    // Binary min-heap priority queue for O((V + E) log V) Dijkstra
    const heap: Array<{ id: string; cost: number }> = [];

    function heapPush(item: { id: string; cost: number }) {
      heap.push(item);
      let i = heap.length - 1;
      while (i > 0) {
        const parent = (i - 1) >> 1;
        if (heap[parent].cost <= heap[i].cost) break;
        [heap[parent], heap[i]] = [heap[i], heap[parent]];
        i = parent;
      }
    }

    function heapPop(): { id: string; cost: number } {
      const top = heap[0];
      const last = heap.pop()!;
      if (heap.length > 0) {
        heap[0] = last;
        let i = 0;
        while (true) {
          let smallest = i;
          const left = 2 * i + 1;
          const right = 2 * i + 2;
          if (left < heap.length && heap[left].cost < heap[smallest].cost) smallest = left;
          if (right < heap.length && heap[right].cost < heap[smallest].cost) smallest = right;
          if (smallest === i) break;
          [heap[smallest], heap[i]] = [heap[i], heap[smallest]];
          i = smallest;
        }
      }
      return top;
    }

    dist.set(fromId, 0);
    heapPush({ id: fromId, cost: 0 });

    while (heap.length > 0) {
      const { id: current, cost: currentCost } = heapPop();

      if (visited.has(current)) continue;
      visited.add(current);

      if (current === toId) break;

      for (const edge of this.getOutEdges(current)) {
        if (visited.has(edge.to)) continue;
        const newCost = currentCost + edge.cost;
        const existingCost = dist.get(edge.to);
        if (existingCost === undefined || newCost < existingCost) {
          dist.set(edge.to, newCost);
          prev.set(edge.to, { nodeId: current, edge });
          heapPush({ id: edge.to, cost: newCost });
        }
      }
    }

    if (!prev.has(toId)) return null;

    // Reconstruct path
    const pathNodes: string[] = [];
    const pathEdges: Edge[] = [];
    let cursor = toId;

    while (cursor !== fromId) {
      pathNodes.unshift(cursor);
      const step = prev.get(cursor)!;
      pathEdges.unshift(step.edge);
      cursor = step.nodeId;
    }
    pathNodes.unshift(fromId);

    return {
      nodes: pathNodes,
      edges: pathEdges,
      totalCost: dist.get(toId)!,
      actions: pathEdges.map((e) => `${e.action}: ${e.to}`),
    };
  }

  /** Find all shortest paths from a source to every reachable node */
  shortestPathsFrom(fromId: string): Map<string, PathResult> {
    const results = new Map<string, PathResult>();
    for (const nodeId of this.nodes.keys()) {
      if (nodeId === fromId) continue;
      const path = this.shortestPath(fromId, nodeId);
      if (path) results.set(nodeId, path);
    }
    return results;
  }

  // ---- Filtering ----

  /** Get edges matching a specific action type */
  edgesOfAction(action: NavigationAction): Edge[] {
    const result: Edge[] = [];
    for (const edges of this.outEdges.values()) {
      for (const edge of edges) {
        if (edge.action === action) result.push(edge);
      }
    }
    return result;
  }

  /** Get all target-kind nodes reachable from a state node */
  targetsReachableFrom(stateId: string): Map<string, number> {
    const all = this.reachableWithin(stateId, Infinity);
    const targets = new Map<string, number>();
    for (const [id, cost] of all) {
      const node = this.nodes.get(id);
      if (node?.kind === "target") targets.set(id, cost);
    }
    return targets;
  }

  // ---- Serialization ----

  toJSON(): { nodes: GraphNode[]; edges: Edge[] } {
    return {
      nodes: [...this.nodes.values()],
      edges: this.allEdges(),
    };
  }

  static fromJSON(data: { nodes: GraphNode[]; edges: Edge[] }): NavigationGraph {
    const graph = new NavigationGraph();
    for (const node of data.nodes) graph.addNode(node);
    for (const edge of data.edges) graph.addEdge(edge);
    return graph;
  }
}
