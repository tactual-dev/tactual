import type { PageState, Target } from "./types.js";
import { NavigationGraph, type PathResult } from "./graph.js";

/**
 * Collect plausible navigation entry points for a state.
 * Headings are weighted most heavily (WebAIM 2024: 71.6% start with headings).
 */
export function collectEntryPoints(state: PageState, graph: NavigationGraph): string[] {
  const entries: string[] = [state.id];

  for (const t of state.targets) {
    if (t.kind === "heading" || t.kind === "landmark") {
      const nodeId = `${state.id}:${t.id}`;
      if (graph.hasNode(nodeId)) entries.push(nodeId);
    }
  }

  return entries;
}

/**
 * Compute shortest paths from multiple entry points to a target.
 * Returns paths sorted by cost (cheapest first).
 */
export function computePathsFromEntries(
  graph: NavigationGraph,
  entryPoints: string[],
  targetNodeId: string,
): PathResult[] {
  const paths: PathResult[] = [];
  for (const entry of entryPoints) {
    const path = graph.shortestPath(entry, targetNodeId);
    if (path && path.totalCost >= 0) paths.push(path);
  }
  paths.sort((a, b) => a.totalCost - b.totalCost);
  return paths;
}

/**
 * Compute alternate paths using different navigation strategies
 * (heading-first, landmark-first) that differ from the best path.
 */
export function computeAlternatePaths(
  graph: NavigationGraph,
  state: PageState,
  targetNodeId: string,
  bestPath: PathResult | null,
): PathResult[] {
  const alternates: PathResult[] = [];
  const bestActions = bestPath
    ? new Set(bestPath.edges.map((e) => e.action))
    : new Set<string>();

  // Heading-first strategy
  const headings = state.targets.filter((t) => t.kind === "heading");
  for (const h of headings.slice(0, 3)) {
    const combined = combinedPath(graph, state.id, `${state.id}:${h.id}`, targetNodeId);
    if (combined && !sameActionSet(new Set(combined.edges.map((e) => e.action)), bestActions)) {
      alternates.push(combined);
    }
  }

  // Landmark-first strategy
  const landmarks = state.targets.filter((t) => t.kind === "landmark");
  for (const l of landmarks.slice(0, 2)) {
    const combined = combinedPath(graph, state.id, `${state.id}:${l.id}`, targetNodeId);
    if (combined && !sameActionSet(new Set(combined.edges.map((e) => e.action)), bestActions)) {
      alternates.push(combined);
    }
  }

  alternates.sort((a, b) => a.totalCost - b.totalCost);
  return alternates.slice(0, 3);
}

/** Find the nearest preceding heading before a target in DOM order. */
export function findNearestHeading(state: PageState, target: Target): Target | null {
  const idx = state.targets.findIndex((t) => t.id === target.id);
  if (idx < 0) return null;
  for (let i = idx - 1; i >= 0; i--) {
    if (state.targets[i].kind === "heading") return state.targets[i];
  }
  return null;
}

/** Find the nearest preceding landmark before a target in DOM order. */
export function findNearestLandmark(state: PageState, target: Target): Target | null {
  const idx = state.targets.findIndex((t) => t.id === target.id);
  if (idx < 0) return null;
  for (let i = idx - 1; i >= 0; i--) {
    if (state.targets[i].kind === "landmark") return state.targets[i];
  }
  return null;
}

/** Format a path into human-readable action descriptions. */
export function formatPath(graph: NavigationGraph, path: PathResult | null): string[] {
  if (!path) return [];
  return path.edges.map((e) => {
    const targetNode = graph.getNode(e.to);
    const meta = targetNode?.metadata as
      | { target?: { name?: string; role?: string; kind?: string } }
      | undefined;
    const target = meta?.target;
    // Use accessible name if available, otherwise fall back to role or kind
    const name = (target?.name && target.name.trim())
      || target?.role
      || target?.kind
      || (targetNode?.kind === "state" ? "page" : "element");
    return `${e.action}: ${name}`;
  });
}

export function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function combinedPath(
  graph: NavigationGraph,
  startId: string,
  viaId: string,
  endId: string,
): PathResult | null {
  const toVia = graph.shortestPath(startId, viaId);
  const fromVia = graph.shortestPath(viaId, endId);
  if (!toVia || !fromVia) return null;
  return {
    nodes: [...toVia.nodes, ...fromVia.nodes.slice(1)],
    edges: [...toVia.edges, ...fromVia.edges],
    totalCost: toVia.totalCost + fromVia.totalCost,
    actions: [...toVia.actions, ...fromVia.actions],
  };
}

function sameActionSet(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return false;
  for (const item of a) if (!b.has(item)) return false;
  return true;
}
