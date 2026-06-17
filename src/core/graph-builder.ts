import { NavigationGraph } from "./graph.js";
import type { PageState, Target, Edge } from "./types.js";
import { computeStateSignature, CONTROL_KINDS } from "./types.js";
import { formFieldQuickNavTargets } from "./at-navigation.js";
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

  // More specific AT quick-nav categories. Desktop ATs expose these as
  // single-letter quick keys or element lists; mobile ATs expose comparable
  // categories through rotor / reading-controls. Modeling them separately
  // prevents "nextControl" from hiding the real difference between jumping
  // by any control and jumping directly by form fields, buttons, or regions.
  generateSkipEdges(graph, state, formFieldQuickNavTargets(targets, profile.id), "nextFormField", profile, eid);
  generateSkipEdges(graph, state, targets.filter((t) => t.kind === "button"), "nextButton", profile, eid);
  generateSkipEdges(graph, state, targets.filter((t) => t.kind === "landmark" || t.kind === "search"), "nextLandmark", profile, eid);

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

  if (profile.actionCosts.rotor < 50) {
    generateRotorEdges(graph, state, targets, profile, eid);
  }

  if (profile.actionCosts.formsMode < 50) {
    generateFormsModeEdges(graph, state, targets, profile, eid);
  }

  if (profile.actionCosts.touchExplore < 50) {
    generateTouchExploreEdges(graph, state, targets, profile, eid);
  }

  generateRelationshipEdges(graph, state, targets, profile, eid);
  generateCompositeWidgetEdges(graph, state, targets, profile, eid);
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

function generateRotorEdges(
  graph: NavigationGraph,
  state: PageState,
  targets: Target[],
  profile: ATProfile,
  eid: () => string,
): void {
  const rotorTargets = targets.filter(
    (t) =>
      t.kind === "heading" ||
      t.kind === "landmark" ||
      t.kind === "search" ||
      t.kind === "link" ||
      t.kind === "button" ||
      t.kind === "formField",
  );
  for (let i = 0; i < rotorTargets.length; i++) {
    const target = rotorTargets[i];
    graph.addEdge({
      id: eid(),
      from: state.id,
      to: `${state.id}:${target.id}`,
      action: "rotor",
      cost: profile.actionCosts.rotor + i * 0.15,
      reason: `AT rotor / element-list jump to "${target.name || target.role}"`,
      confidence: profile.platform === "mobile" ? 0.85 : 0.75,
      profile: profile.id,
    });
  }
}

function generateFormsModeEdges(
  graph: NavigationGraph,
  state: PageState,
  targets: Target[],
  profile: ATProfile,
  eid: () => string,
): void {
  const formFields = targets.filter((t) => t.kind === "formField");
  for (let i = 0; i < formFields.length; i++) {
    const field = formFields[i];
    graph.addEdge({
      id: eid(),
      from: state.id,
      to: `${state.id}:${field.id}`,
      action: "formsMode",
      cost: profile.actionCosts.formsMode + i * profile.actionCosts.nextFormField,
      reason: `Switch to forms/focus mode and reach "${field.name || field.role}"`,
      confidence: profile.platform === "desktop" ? 0.85 : 0.65,
      profile: profile.id,
    });
  }
}

function generateTouchExploreEdges(
  graph: NavigationGraph,
  state: PageState,
  targets: Target[],
  profile: ATProfile,
  eid: () => string,
): void {
  const viewport = state.viewport;
  const spatialTargets = targets.filter((target) => {
    const rect = (target as Record<string, unknown>)._rect as
      | { x: number; y: number; width: number; height: number }
      | undefined;
    if (!rect || rect.width <= 0 || rect.height <= 0) return false;
    if (!viewport) return true;
    return (
      rect.x < viewport.width &&
      rect.x + rect.width > 0 &&
      rect.y < viewport.height &&
      rect.y + rect.height > 0
    );
  });

  for (const target of spatialTargets) {
    const rect = (target as Record<string, unknown>)._rect as
      { x: number; y: number; width: number; height: number };
    const verticalPenalty = viewport ? Math.max(0, Math.min(2, rect.y / Math.max(1, viewport.height))) : 0.5;
    graph.addEdge({
      id: eid(),
      from: state.id,
      to: `${state.id}:${target.id}`,
      action: "touchExplore",
      cost: profile.actionCosts.touchExplore + verticalPenalty,
      reason: `Spatial touch exploration to visible ${target.kind}: "${target.name || target.role}"`,
      confidence: 0.65,
      profile: profile.id,
    });
  }
}

interface RelatedTargetRef {
  id?: string;
  role?: string;
  name?: string;
}

interface TargetRelationshipMetadata {
  controls?: RelatedTargetRef[];
  owns?: RelatedTargetRef[];
  activeDescendant?: RelatedTargetRef;
  flowto?: RelatedTargetRef[];
  hasPopup?: string;
}

function generateRelationshipEdges(
  graph: NavigationGraph,
  state: PageState,
  targets: Target[],
  profile: ATProfile,
  eid: () => string,
): void {
  for (const source of targets) {
    const relationships = (source as Record<string, unknown>)._ariaRelationships as
      | TargetRelationshipMetadata
      | undefined;
    if (!relationships) continue;

    const sourceId = `${state.id}:${source.id}`;
    for (const ref of [
      ...(relationships.controls ?? []),
      ...(relationships.owns ?? []),
      ...(relationships.flowto ?? []),
    ]) {
      const target = findRelatedTarget(targets, ref);
      if (!target || target.id === source.id) continue;
      graph.addEdge({
        id: eid(),
        from: sourceId,
        to: `${state.id}:${target.id}`,
        action: "relationshipJump",
        cost: profile.actionCosts.relationshipJump,
        reason: `Follow ARIA relationship from "${source.name || source.role}" to "${target.name || target.role}"`,
        confidence: 0.75,
        profile: profile.id,
      });
    }

    if (relationships.activeDescendant) {
      const target = findRelatedTarget(targets, relationships.activeDescendant);
      if (target && target.id !== source.id) {
        graph.addEdge({
          id: eid(),
          from: sourceId,
          to: `${state.id}:${target.id}`,
          action: "activeDescendant",
          cost: profile.actionCosts.activeDescendant,
          reason: `Move to active descendant "${target.name || target.role}"`,
          confidence: 0.8,
          profile: profile.id,
        });
      }
    }
  }
}

function generateCompositeWidgetEdges(
  graph: NavigationGraph,
  state: PageState,
  targets: Target[],
  profile: ATProfile,
  eid: () => string,
): void {
  const compositeRoles = new Set([
    "menuitem",
    "menuitemcheckbox",
    "menuitemradio",
    "tab",
    "radio",
  ]);

  let group: Target[] = [];
  const flush = () => {
    if (group.length < 2) {
      group = [];
      return;
    }
    for (let i = 0; i < group.length - 1; i++) {
      const from = `${state.id}:${group[i].id}`;
      const to = `${state.id}:${group[i + 1].id}`;
      graph.addEdge({
        id: eid(),
        from,
        to,
        action: "compositeNavigation",
        cost: profile.actionCosts.compositeNavigation,
        reason: `Arrow-key navigation inside ${group[i].role} group`,
        confidence: 0.8,
        profile: profile.id,
      });
      graph.addEdge({
        id: eid(),
        from: to,
        to: from,
        action: "compositeNavigation",
        cost: profile.actionCosts.compositeNavigation,
        reason: `Reverse arrow-key navigation inside ${group[i].role} group`,
        confidence: 0.8,
        profile: profile.id,
      });
    }
    group = [];
  };

  for (const target of targets) {
    if (compositeRoles.has(target.role)) {
      const compatibleGroup =
        group.length === 0 ||
        group[0].role === target.role ||
        (group[0].role.startsWith("menuitem") && target.role.startsWith("menuitem"));
      if (!compatibleGroup) flush();
      group.push(target);
    } else {
      flush();
    }
  }
  flush();
}

function findRelatedTarget(
  targets: Target[],
  ref: RelatedTargetRef,
): Target | undefined {
  if (ref.id) {
    const byDomId = targets.find((t) => (t as Record<string, unknown>)._domId === ref.id);
    if (byDomId) return byDomId;
  }
  if (ref.role && ref.name !== undefined) {
    const exact = targets.find((t) => t.role === ref.role && (t.name ?? "") === ref.name);
    if (exact) return exact;
  }
  if (ref.name) {
    return targets.find((t) => (t.name ?? "") === ref.name);
  }
  return undefined;
}

function indexByKind(targets: Target[], kind: Target["kind"]): Target[] {
  return targets.filter((t) => t.kind === kind);
}
