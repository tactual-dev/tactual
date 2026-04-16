import { NavigationGraph } from "./graph.js";
import type { PageState, Target, Edge } from "./types.js";
import { computeStateSignature, CONTROL_KINDS } from "./types.js";
import type { ATProfile } from "../profiles/types.js";

/**
 * Builds a NavigationGraph from captured page states and an AT profile.
 *
 * For each state, adds:
 * 1. A state node (entry point for the page)
 * 2. Target nodes for each extracted target
 * 3. Edges modeling how a screen-reader user would navigate between targets
 *    using the profile's available actions and costs
 */
export function buildGraph(states: PageState[], profile: ATProfile): NavigationGraph {
  const graph = new NavigationGraph();
  // Maps original state IDs to the graph node ID (handles dedup)
  const resolvedIds = new Map<string, string>();

  for (const state of states) {
    const resolvedId = addStateToGraph(graph, state, profile);
    resolvedIds.set(state.id, resolvedId);
  }

  // Add cross-state edges if multiple states exist (flow transitions)
  for (let i = 0; i < states.length - 1; i++) {
    const fromId = resolvedIds.get(states[i].id)!;
    const toId = resolvedIds.get(states[i + 1].id)!;
    if (fromId === toId) continue; // Same state after dedup

    graph.addEdge({
      id: `edge-flow-${fromId}-${toId}`,
      from: fromId,
      to: toId,
      action: "activate",
      cost: profile.actionCosts.activate,
      reason: "Flow transition to next page state",
      confidence: 1,
      profile: profile.id,
    });
  }

  return graph;
}

/** Returns the resolved node ID (original or deduped existing) */
function addStateToGraph(
  graph: NavigationGraph,
  state: PageState,
  profile: ATProfile,
): string {
  const signature = computeStateSignature(state);

  // Check if a state with this signature already exists
  const existing = graph.getNodeBySignature(signature);
  if (existing) return existing.id;

  // Add state node
  graph.addNode({
    id: state.id,
    kind: "state",
    signature,
    metadata: { url: state.url, route: state.route },
  });

  // Add target nodes
  for (const target of state.targets) {
    const nodeId = `${state.id}:${target.id}`;
    graph.addNode({
      id: nodeId,
      kind: "target",
      metadata: { stateId: state.id, target },
    });
  }

  // Generate navigation edges within this state
  generateIntraStateEdges(graph, state, profile);

  return state.id;
}

/**
 * Generate edges within a single state based on how a screen-reader user
 * would navigate between targets.
 */
function generateIntraStateEdges(
  graph: NavigationGraph,
  state: PageState,
  profile: ATProfile,
): void {
  const targets = state.targets;
  if (targets.length === 0) return;

  let edgeCounter = 0;
  const eid = () => `${state.id}-edge-${++edgeCounter}`;

  // Edge from state entry to first target (linear start)
  if (targets.length > 0) {
    graph.addEdge({
      id: eid(),
      from: state.id,
      to: `${state.id}:${targets[0].id}`,
      action: "nextItem",
      cost: profile.actionCosts.nextItem,
      reason: "First item in linear navigation",
      confidence: 1,
      profile: profile.id,
    });
  }

  // Linear navigation: nextItem / previousItem between adjacent targets
  for (let i = 0; i < targets.length - 1; i++) {
    const from = `${state.id}:${targets[i].id}`;
    const to = `${state.id}:${targets[i + 1].id}`;

    graph.addEdge({
      id: eid(),
      from,
      to,
      action: "nextItem",
      cost: profile.actionCosts.nextItem,
      reason: "Next item in linear navigation",
      confidence: 1,
      profile: profile.id,
    });

    graph.addEdge({
      id: eid(),
      from: to,
      to: from,
      action: "previousItem",
      cost: profile.actionCosts.previousItem,
      reason: "Previous item in linear navigation",
      confidence: 1,
      profile: profile.id,
    });
  }

  // Heading navigation: nextHeading jumps between headings
  const headings = indexByKind(targets, "heading");
  generateSkipEdges(graph, state, headings, "nextHeading", profile, eid);

  // Link navigation: nextLink jumps between links
  const links = indexByKind(targets, "link");
  generateSkipEdges(graph, state, links, "nextLink", profile, eid);

  // Control navigation: nextControl jumps between interactive elements
  const controls = targets.filter((t) => CONTROL_KINDS.has(t.kind));
  generateSkipEdges(graph, state, controls, "nextControl", profile, eid);

  // State entry to each heading (heading navigation from top)
  for (const heading of headings) {
    graph.addEdge({
      id: eid(),
      from: state.id,
      to: `${state.id}:${heading.id}`,
      action: "nextHeading",
      cost: profile.actionCosts.nextHeading,
      reason: `Jump to heading: "${heading.name}"`,
      confidence: 1,
      profile: profile.id,
    });
  }

  // State entry to each landmark via groupEntry
  const landmarks = indexByKind(targets, "landmark");
  for (const landmark of landmarks) {
    graph.addEdge({
      id: eid(),
      from: state.id,
      to: `${state.id}:${landmark.id}`,
      action: "groupEntry",
      cost: profile.actionCosts.groupEntry,
      reason: `Enter landmark: "${landmark.name || landmark.role}"`,
      confidence: 1,
      profile: profile.id,
    });
  }

  // First-letter type-ahead in menus (desktop AT only).
  // When focus is inside a menu, pressing a letter key jumps to the first
  // menuitem starting with that letter. Pressing again cycles to the next match.
  // This dramatically reduces navigation cost for deep menu items.
  if (profile.actionCosts.firstLetter < 10) {
    generateFirstLetterEdges(graph, state, targets, profile, eid);
  }
}

/**
 * Generate skip-navigation edges (e.g., heading-to-heading, link-to-link).
 */
function generateSkipEdges(
  graph: NavigationGraph,
  state: PageState,
  subset: Target[],
  action: Edge["action"],
  profile: ATProfile,
  eid: () => string,
): void {
  for (let i = 0; i < subset.length - 1; i++) {
    const from = `${state.id}:${subset[i].id}`;
    const to = `${state.id}:${subset[i + 1].id}`;

    graph.addEdge({
      id: eid(),
      from,
      to,
      action,
      cost: profile.actionCosts[action],
      reason: `Skip to next ${action.replace("next", "").toLowerCase()}`,
      confidence: 1,
      profile: profile.id,
    });
  }
}

/**
 * Generate first-letter type-ahead edges for menuitem targets.
 *
 * In a focused menu, pressing a letter key jumps to the first menuitem
 * starting with that letter. Pressing the same key again cycles to the
 * next match. This models the real desktop AT behavior where navigating
 * to "Profile" in a 20-item menu is 4 keystrokes (P, P, P, P) not 20
 * arrow presses.
 *
 * Creates edges from:
 * - The state entry to each menuitem (direct first-letter jump)
 * - Each menuitem to the next menuitem with the same starting letter
 *
 * Cost = position within the letter group × firstLetter action cost.
 */
function generateFirstLetterEdges(
  graph: NavigationGraph,
  state: PageState,
  targets: Target[],
  profile: ATProfile,
  eid: () => string,
): void {
  const menuItems = targets.filter(
    (t) => t.kind === "menuItem" || t.role === "menuitem" ||
           t.role === "menuitemcheckbox" || t.role === "menuitemradio",
  );
  if (menuItems.length < 2) return;

  // Group by first letter of name (case-insensitive)
  const byLetter = new Map<string, Target[]>();
  for (const item of menuItems) {
    const firstChar = (item.name ?? "")[0]?.toLowerCase();
    if (!firstChar || !/\p{L}/u.test(firstChar)) continue;
    const group = byLetter.get(firstChar) ?? [];
    group.push(item);
    byLetter.set(firstChar, group);
  }

  for (const [letter, group] of byLetter) {
    // State entry → first item in each letter group (single keypress)
    graph.addEdge({
      id: eid(),
      from: state.id,
      to: `${state.id}:${group[0].id}`,
      action: "firstLetter",
      cost: profile.actionCosts.firstLetter,
      reason: `Type-ahead: press "${letter}" to jump to "${group[0].name}"`,
      confidence: 0.9,
      profile: profile.id,
    });

    // Within the letter group: each item → next item (one more keypress)
    for (let i = 0; i < group.length - 1; i++) {
      graph.addEdge({
        id: eid(),
        from: `${state.id}:${group[i].id}`,
        to: `${state.id}:${group[i + 1].id}`,
        action: "firstLetter",
        cost: profile.actionCosts.firstLetter,
        reason: `Type-ahead: press "${letter}" again to cycle to "${group[i + 1].name}"`,
        confidence: 0.9,
        profile: profile.id,
      });
    }
  }
}

function indexByKind(targets: Target[], kind: Target["kind"]): Target[] {
  return targets.filter((t) => t.kind === kind);
}
