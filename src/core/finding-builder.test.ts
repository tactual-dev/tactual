import { describe, it, expect } from "vitest";
import { buildFinding } from "./finding-builder.js";
import { buildGraph } from "./graph-builder.js";
import { getProfile } from "../profiles/index.js";
import { FindingSchema } from "./types.js";
import type { PageState, Target } from "./types.js";
import type { ATProfile } from "../profiles/types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTarget(overrides: Partial<Target> = {}): Target {
  return {
    id: overrides.id ?? `target-${Math.random().toString(36).slice(2, 8)}`,
    kind: overrides.kind ?? "button",
    role: overrides.role ?? "button",
    name: overrides.name ?? "Test Button",
    requiresBranchOpen: false,
    ...overrides,
  };
}

function makeState(targets: Target[], overrides: Partial<PageState> = {}): PageState {
  return {
    id: overrides.id ?? `state-${Math.random().toString(36).slice(2, 8)}`,
    url: "https://example.com",
    route: "/",
    snapshotHash: `hash-${Math.random().toString(36).slice(2, 8)}`,
    interactiveHash: `ihash-${Math.random().toString(36).slice(2, 8)}`,
    openOverlays: [],
    targets,
    timestamp: Date.now(),
    provenance: "scripted" as const,
    ...overrides,
  };
}

function loadProfile(): ATProfile {
  const p = getProfile("generic-mobile-web-sr-v0");
  if (!p) throw new Error("Profile generic-mobile-web-sr-v0 not registered");
  return p;
}

const VALID_SEVERITIES = ["strong", "acceptable", "moderate", "high", "severe"];

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("buildFinding", () => {
  const profile = loadProfile();

  // 1. single target, well-structured
  it("produces a valid finding for a well-structured page with heading, landmark, and button", () => {
    const heading = makeTarget({ id: "h1", kind: "heading", role: "heading", name: "Page Title", headingLevel: 1 });
    const landmark = makeTarget({ id: "lm1", kind: "landmark", role: "main", name: "Main Content" });
    const button = makeTarget({ id: "btn1", kind: "button", role: "button", name: "Submit" });

    const state = makeState([heading, landmark, button], { id: "ws" });
    const graph = buildGraph([state], profile);
    const nodeId = `${state.id}:${button.id}`;

    const finding = buildFinding(graph, state, nodeId, button, profile);

    // Validates against the Zod schema
    const parsed = FindingSchema.safeParse(finding);
    expect(parsed.success).toBe(true);

    // Severity is one of the valid bands
    expect(VALID_SEVERITIES).toContain(finding.severity);

    // All score dimensions are 0-100
    for (const key of ["discoverability", "reachability", "operability", "recovery", "interopRisk", "overall"] as const) {
      expect(finding.scores[key]).toBeGreaterThanOrEqual(0);
      expect(finding.scores[key]).toBeLessThanOrEqual(100);
    }

    // Penalties and fixes are arrays of strings
    expect(Array.isArray(finding.penalties)).toBe(true);
    expect(Array.isArray(finding.suggestedFixes)).toBe(true);
    for (const p of finding.penalties) expect(typeof p).toBe("string");
    for (const f of finding.suggestedFixes) expect(typeof f).toBe("string");

    expect(finding.evidence?.map((e) => e.kind)).toEqual(
      expect.arrayContaining(["measured", "modeled", "heuristic"]),
    );
    expect(finding.evidenceSummary?.measured).toBeGreaterThanOrEqual(1);
    expect(finding.evidenceSummary?.modeled).toBe(1);
    expect(finding.evidenceSummary?.heuristic).toBe(1);
  });

  // 2. empty name target
  it("penalizes a target with an empty accessible name", () => {
    const heading = makeTarget({ id: "h1", kind: "heading", role: "heading", name: "Page", headingLevel: 1 });
    const noName = makeTarget({ id: "noname1", kind: "button", role: "button", name: "" });

    const state = makeState([heading, noName], { id: "en" });
    const graph = buildGraph([state], profile);
    const nodeId = `${state.id}:${noName.id}`;

    const finding = buildFinding(graph, state, nodeId, noName, profile);

    const namePenalty = finding.penalties.find((p) => /accessible name/i.test(p));
    expect(namePenalty).toBeDefined();

    const ariaFix = finding.suggestedFixes.find((f) => /aria-label/i.test(f));
    expect(ariaFix).toBeDefined();
  });

  it("does not require explicit names for structural landmarks", () => {
    const heading = makeTarget({ id: "h1", kind: "heading", role: "heading", name: "Page", headingLevel: 1 });
    const main = makeTarget({ id: "main1", kind: "landmark", role: "main", name: "" });

    const state = makeState([heading, main], { id: "landmark-name" });
    const graph = buildGraph([state], profile);
    const nodeId = `${state.id}:${main.id}`;

    const finding = buildFinding(graph, state, nodeId, main, profile);

    expect(finding.penalties.some((p) => /accessible name/i.test(p))).toBe(false);
    expect(finding.suggestedFixes.some((f) => /aria-label/i.test(f))).toBe(false);
  });

  // 3. target requiring branch open
  it("penalizes a target that requires opening a hidden branch", () => {
    const heading = makeTarget({ id: "h1", kind: "heading", role: "heading", name: "Page", headingLevel: 1 });
    const hidden = makeTarget({ id: "hid1", kind: "button", role: "button", name: "Hidden Action", requiresBranchOpen: true });

    const state = makeState([heading, hidden], { id: "bo" });
    const graph = buildGraph([state], profile);
    const nodeId = `${state.id}:${hidden.id}`;

    const finding = buildFinding(graph, state, nodeId, hidden, profile);

    const branchPenalty = finding.penalties.find((p) => /hidden branch|branch/i.test(p));
    expect(branchPenalty).toBeDefined();
  });

  // 4. page with only headings
  it("handles a page with only heading targets without crashing", () => {
    const headings: Target[] = [];
    for (let i = 0; i < 10; i++) {
      headings.push(
        makeTarget({
          id: `heading-${i}`,
          kind: "heading",
          role: "heading",
          name: `Heading ${i}`,
          headingLevel: (i % 3) + 1,
        }),
      );
    }

    const state = makeState(headings, { id: "ho" });
    const graph = buildGraph([state], profile);
    const target = headings[5];
    const nodeId = `${state.id}:${target.id}`;

    const finding = buildFinding(graph, state, nodeId, target, profile);

    const parsed = FindingSchema.safeParse(finding);
    expect(parsed.success).toBe(true);
    expect(finding.targetId).toBe(target.id);
  });

  // 5. page with no headings and no landmarks
  it("reduces confidence and flags missing headings when page has no headings or landmarks", () => {
    const buttons: Target[] = [];
    for (let i = 0; i < 5; i++) {
      buttons.push(makeTarget({ id: `btn-${i}`, kind: "button", role: "button", name: `Button ${i}` }));
    }

    const state = makeState(buttons, { id: "nh" });
    const graph = buildGraph([state], profile);
    const target = buttons[2];
    const nodeId = `${state.id}:${target.id}`;

    const finding = buildFinding(graph, state, nodeId, target, profile);

    // Confidence should be reduced when there are no headings and no landmarks
    expect(finding.confidence).toBeLessThan(0.8);

    // Should mention heading structure in penalties
    const headingPenalty = finding.penalties.find((p) => /heading/i.test(p));
    expect(headingPenalty).toBeDefined();
  });

  // 6. large page (100 targets)
  it("completes without hanging for a page with 100 targets", () => {
    const targets: Target[] = [];
    for (let i = 0; i < 100; i++) {
      targets.push(
        makeTarget({ id: `t100-${i}`, kind: "button", role: "button", name: `Button ${i}` }),
      );
    }

    const state = makeState(targets, { id: "lg" });
    const graph = buildGraph([state], profile);
    const target = targets[50];
    const nodeId = `${state.id}:${target.id}`;

    const finding = buildFinding(graph, state, nodeId, target, profile);

    const parsed = FindingSchema.safeParse(finding);
    expect(parsed.success).toBe(true);
    expect(finding.targetId).toBe(target.id);
  });

  // 7. very large page (500 targets)
  it("completes in reasonable time for a page with 500 mixed targets", () => {
    const kinds: Array<Target["kind"]> = ["heading", "landmark", "button", "link", "formField"];
    const roles: Record<string, string> = {
      heading: "heading",
      landmark: "main",
      button: "button",
      link: "link",
      formField: "textbox",
    };

    const targets: Target[] = [];
    for (let i = 0; i < 500; i++) {
      const kind = kinds[i % kinds.length];
      targets.push(
        makeTarget({
          id: `t500-${i}`,
          kind,
          role: roles[kind],
          name: `${kind} ${i}`,
          headingLevel: kind === "heading" ? (i % 3) + 1 : undefined,
        }),
      );
    }

    const state = makeState(targets, { id: "vl" });
    const graph = buildGraph([state], profile);
    const target = targets[250];
    const nodeId = `${state.id}:${target.id}`;

    const start = performance.now();
    const finding = buildFinding(graph, state, nodeId, target, profile);
    const elapsed = performance.now() - start;

    const parsed = FindingSchema.safeParse(finding);
    expect(parsed.success).toBe(true);
    // Should complete in a reasonable time (under 5 seconds even on slow CI)
    expect(elapsed).toBeLessThan(5000);
  });

  // 8. target with complex role (combobox)
  it("flags interop risk for combobox (risk 8)", () => {
    const heading = makeTarget({ id: "h1", kind: "heading", role: "heading", name: "Form", headingLevel: 1 });
    const combo = makeTarget({ id: "cb1", kind: "formField", role: "combobox", name: "Country Picker" });

    const state = makeState([heading, combo], { id: "ir" });
    const graph = buildGraph([state], profile);
    const nodeId = `${state.id}:${combo.id}`;

    const finding = buildFinding(graph, state, nodeId, combo, profile);

    const interopPenalty = finding.penalties.find((p) => /interop risk/i.test(p));
    expect(interopPenalty).toBeDefined();

    // Combobox risk is 8, which triggers a critical-flow verification recommendation.
    const patternFix = finding.suggestedFixes.find((f) => /verify this combobox/i.test(f));
    expect(patternFix).toBeDefined();
  });

  // 9. target with simple role (button)
  it("has zero or very low interop risk for a button", () => {
    const heading = makeTarget({ id: "h1", kind: "heading", role: "heading", name: "Page", headingLevel: 1 });
    const button = makeTarget({ id: "btn-simple", kind: "button", role: "button", name: "Click Me" });

    const state = makeState([heading, button], { id: "sr" });
    const graph = buildGraph([state], profile);
    const nodeId = `${state.id}:${button.id}`;

    const finding = buildFinding(graph, state, nodeId, button, profile);

    // Button has risk 0, so no interop penalty should be present
    const interopPenalty = finding.penalties.find((p) => /interop risk/i.test(p));
    expect(interopPenalty).toBeUndefined();

    // interopRisk score dimension should be 0 (zero risk penalty)
    expect(finding.scores.interopRisk).toBe(0);
  });

  // 10. all penalty strings are non-empty
  it("produces only non-empty penalty and fix strings across edge cases", () => {
    const edgeCases: Array<{ targets: Target[]; targetIdx: number; stateId: string }> = [
      // No name
      {
        targets: [
          makeTarget({ id: "en-h", kind: "heading", role: "heading", name: "H", headingLevel: 1 }),
          makeTarget({ id: "en-b", kind: "button", role: "button", name: "" }),
        ],
        targetIdx: 1,
        stateId: "ne-1",
      },
      // Branch open
      {
        targets: [
          makeTarget({ id: "bo-h", kind: "heading", role: "heading", name: "H", headingLevel: 1 }),
          makeTarget({ id: "bo-b", kind: "button", role: "button", name: "Hidden", requiresBranchOpen: true }),
        ],
        targetIdx: 1,
        stateId: "ne-2",
      },
      // Combobox
      {
        targets: [
          makeTarget({ id: "cb-h", kind: "heading", role: "heading", name: "H", headingLevel: 1 }),
          makeTarget({ id: "cb-f", kind: "formField", role: "combobox", name: "Combo" }),
        ],
        targetIdx: 1,
        stateId: "ne-3",
      },
      // No headings
      {
        targets: [
          makeTarget({ id: "nh-b1", kind: "button", role: "button", name: "B1" }),
          makeTarget({ id: "nh-b2", kind: "button", role: "button", name: "B2" }),
        ],
        targetIdx: 0,
        stateId: "ne-4",
      },
    ];

    for (const { targets, targetIdx, stateId } of edgeCases) {
      const state = makeState(targets, { id: stateId });
      const graph = buildGraph([state], profile);
      const target = targets[targetIdx];
      const nodeId = `${state.id}:${target.id}`;

      const finding = buildFinding(graph, state, nodeId, target, profile);

      for (const p of finding.penalties) {
        expect(p.length).toBeGreaterThan(0);
      }
      for (const f of finding.suggestedFixes) {
        expect(f.length).toBeGreaterThan(0);
      }
    }
  });

  // 11. confidence never goes below 0.1
  it("clamps confidence to at least 0.1 under worst-case conditions", () => {
    // Worst case: requiresBranchOpen, no heading, no landmark, button only
    const button = makeTarget({
      id: "worst",
      kind: "button",
      role: "button",
      name: "Worst Case",
      requiresBranchOpen: true,
    });

    const state = makeState([button], { id: "wc" });
    const graph = buildGraph([state], profile);
    const nodeId = `${state.id}:${button.id}`;

    const finding = buildFinding(graph, state, nodeId, button, profile);

    expect(finding.confidence).toBeGreaterThanOrEqual(0.1);
  });

  // 12. duplicate penalties are deduplicated
  it("deduplicates penalties so no string appears more than once", () => {
    // Construct a target that would trigger multiple rules that produce the same penalty
    const heading = makeTarget({ id: "dd-h", kind: "heading", role: "heading", name: "Page", headingLevel: 1 });
    const target = makeTarget({
      id: "dd-t",
      kind: "button",
      role: "button",
      name: "",
      requiresBranchOpen: true,
    });

    const state = makeState([heading, target], { id: "dd" });
    const graph = buildGraph([state], profile);
    const nodeId = `${state.id}:${target.id}`;

    const finding = buildFinding(graph, state, nodeId, target, profile);

    const uniquePenalties = new Set(finding.penalties);
    expect(finding.penalties.length).toBe(uniquePenalties.size);

    const uniqueFixes = new Set(finding.suggestedFixes);
    expect(finding.suggestedFixes.length).toBe(uniqueFixes.size);
  });

  describe("state-aware penalties (from _attributeValues)", () => {
    function makeStatefulTarget(id: string, role: string, name: string, attrs: Record<string, string>): Target {
      return makeTarget({ id, kind: role === "tab" ? "tab" : role === "combobox" ? "formField" : "button", role, name, _attributeValues: attrs } as Partial<Target>);
    }

    function getFindingFor(target: Target): { penalties: string[]; suggestedFixes: string[] } {
      const heading = makeTarget({ id: "h1", kind: "heading", role: "heading", name: "Title", headingLevel: 1 });
      const landmark = makeTarget({ id: "lm1", kind: "landmark", role: "main", name: "Main" });
      const state = makeState([heading, landmark, target], { id: "s1" });
      const graph = buildGraph([state], profile);
      const nodeId = `${state.id}:${target.id}`;
      const finding = buildFinding(graph, state, nodeId, target, profile);
      return { penalties: finding.penalties, suggestedFixes: finding.suggestedFixes };
    }

    it("flags label-state mismatch on 'Collapse, expanded' button", () => {
      const t = makeStatefulTarget("b1", "button", "Collapse operation", { "aria-expanded": "true" });
      const { penalties, suggestedFixes } = getFindingFor(t);
      expect(penalties.some((p) => p.includes("Label-state mismatch"))).toBe(true);
      expect(suggestedFixes.some((f) => f.includes("state-neutral label"))).toBe(true);
    });

    it("flags label-state mismatch on 'Expand, collapsed' button", () => {
      const t = makeStatefulTarget("b2", "button", "Expand details", { "aria-expanded": "false" });
      const { penalties } = getFindingFor(t);
      expect(penalties.some((p) => p.includes("Label-state mismatch"))).toBe(true);
    });

    it("does NOT flag label-state mismatch on a state-neutral label", () => {
      const t = makeStatefulTarget("b3", "button", "Toggle details", { "aria-expanded": "true" });
      const { penalties } = getFindingFor(t);
      expect(penalties.some((p) => p.includes("Label-state mismatch"))).toBe(false);
    });

    it("flags disabled-but-discoverable form field", () => {
      const t = makeStatefulTarget("f1", "textbox", "petId", { "aria-disabled": "true" });
      const { penalties, suggestedFixes } = getFindingFor(t);
      expect(penalties.some((p) => p.includes("disabled") && p.includes("unavailable"))).toBe(true);
      expect(suggestedFixes.some((f) => f.includes("aria-hidden"))).toBe(true);
    });

    it("flags tab missing aria-selected", () => {
      const t = makeStatefulTarget("t1", "tab", "Settings", { "aria-controls": "panel-1" });
      const { penalties, suggestedFixes } = getFindingFor(t);
      expect(penalties.some((p) => p.includes("aria-selected"))).toBe(true);
      expect(suggestedFixes.some((f) => f.includes("aria-selected='true'"))).toBe(true);
    });

    it("does NOT flag tab when aria-selected IS present", () => {
      const t = makeStatefulTarget("t2", "tab", "Settings", { "aria-selected": "true" });
      const { penalties } = getFindingFor(t);
      expect(penalties.some((p) => p.includes("aria-selected"))).toBe(false);
    });

    it("flags combobox missing aria-expanded", () => {
      const t = makeStatefulTarget("c1", "combobox", "Country", { "aria-controls": "list-1" });
      const { penalties, suggestedFixes } = getFindingFor(t);
      expect(penalties.some((p) => p.includes("combobox") && p.includes("aria-expanded"))).toBe(true);
      expect(suggestedFixes.some((f) => f.includes("aria-expanded"))).toBe(true);
    });

    it("does NOT apply custom combobox ARIA requirements to native selects", () => {
      const t = makeTarget({
        id: "native-select",
        kind: "formField",
        role: "combobox",
        name: "Country",
        _nativeHtmlControl: "select",
      } as Partial<Target>);
      const { penalties, suggestedFixes } = getFindingFor(t);
      expect(penalties.some((p) => /combobox.*aria-expanded/i.test(p))).toBe(false);
      expect(penalties.some((p) => /Interop risk: combobox/i.test(p))).toBe(false);
      expect(suggestedFixes.some((f) => /role="combobox"/i.test(f))).toBe(false);
    });

    it("does NOT flag combobox when aria-expanded IS present", () => {
      const t = makeStatefulTarget("c2", "combobox", "Country", { "aria-expanded": "false" });
      const { penalties } = getFindingFor(t);
      expect(penalties.some((p) => p.includes("aria-expanded"))).toBe(false);
    });

    it("does nothing for targets without _attributeValues", () => {
      // Target with no captured ARIA state (e.g., a plain button)
      const t = makeTarget({ id: "b4", kind: "button", role: "button", name: "Submit" });
      const { penalties } = getFindingFor(t);
      // No state-aware penalties should fire
      expect(penalties.some((p) => p.includes("Label-state mismatch"))).toBe(false);
      expect(penalties.some((p) => p.includes("aria-disabled"))).toBe(false);
    });
  });

  describe("pattern-deviation detection (probe vs APG spec)", () => {
    function makeProbedTarget(
      role: string, kind: Target["kind"], name: string,
      before: Record<string, string>, after: Record<string, string>,
      succeeded = true,
    ): Target {
      return makeTarget({
        id: "probed-1", kind, role, name,
        _attributeValues: before,
        _probe: {
          probeSucceeded: succeeded,
          ariaStateBeforeEnter: before,
          ariaStateAfterEnter: after,
        },
      } as Partial<Target>);
    }

    function findingFor(target: Target) {
      const heading = makeTarget({ id: "h1", kind: "heading", role: "heading", name: "T", headingLevel: 1 });
      const landmark = makeTarget({ id: "lm", kind: "landmark", role: "main", name: "M" });
      const state = makeState([heading, landmark, target], { id: "s1" });
      const graph = buildGraph([state], profile);
      const finding = buildFinding(graph, state, `${state.id}:${target.id}`, target, profile);
      return finding;
    }

    it("flags toggle button that doesn't toggle aria-pressed", () => {
      const t = makeProbedTarget(
        "button", "button", "Mute",
        { "aria-pressed": "false" },
        { "aria-pressed": "false" }, // bug: state didn't change
      );
      const finding = findingFor(t);
      expect(finding.penalties.some((p) => p.includes("aria-pressed"))).toBe(true);
      expect(finding.penalties.some((p) => p.includes("Pattern deviation"))).toBe(true);
    });

    it("does NOT flag toggle button that correctly toggles", () => {
      const t = makeProbedTarget(
        "button", "button", "Mute",
        { "aria-pressed": "false" },
        { "aria-pressed": "true" }, // correct
      );
      const finding = findingFor(t);
      expect(finding.penalties.some((p) => p.includes("Pattern deviation"))).toBe(false);
    });

    it("flags disclosure button that doesn't toggle aria-expanded", () => {
      const t = makeProbedTarget(
        "button", "button", "Details",
        { "aria-expanded": "false" },
        { "aria-expanded": "false" },
      );
      const finding = findingFor(t);
      expect(finding.penalties.some((p) => p.includes("aria-expanded"))).toBe(true);
    });

    it("flags checkbox that doesn't toggle aria-checked", () => {
      const t = makeProbedTarget(
        "checkbox", "formField", "Subscribe",
        { "aria-checked": "false" },
        { "aria-checked": "false" },
      );
      const finding = findingFor(t);
      expect(finding.penalties.some((p) => p.includes("Pattern deviation"))).toBe(true);
      expect(finding.penalties.some((p) => p.includes("aria-checked"))).toBe(true);
    });

    it("suppresses pattern-deviation when the element was re-rendered", () => {
      // Stripe-style: React portal replaces the trigger on click. Post-state
      // reads from a detached node — every attribute reads as empty,
      // producing a spurious "didn't flip" deviation. Gate on
      // elementStillConnected.
      const t = makeTarget({
        id: "probed-1", kind: "button", role: "button", name: "Accept",
        _attributeValues: { "aria-expanded": "false" },
        _probe: {
          probeSucceeded: true,
          ariaStateBeforeEnter: { "aria-expanded": "false" },
          ariaStateAfterEnter: {}, // attrs disappeared (detached node)
          elementStillConnected: false,
        },
      } as Partial<Target>);
      const finding = findingFor(t);
      expect(finding.penalties.some((p) => p.includes("Pattern deviation"))).toBe(false);
    });

    it("suppresses tab deviation when tab was already selected pre-probe", () => {
      // github tabs use implicit activation-on-focus. Pressing Enter on an
      // already-selected tab is a valid no-op, not a deviation.
      const t = makeTarget({
        id: "probed-1", kind: "tab", role: "tab", name: "Plan",
        _attributeValues: { "aria-selected": "true" },
        _probe: {
          probeSucceeded: true,
          ariaStateBeforeEnter: { "aria-selected": "true" },
          ariaStateAfterEnter: { "aria-selected": "true" },
          elementStillConnected: true,
        },
      } as Partial<Target>);
      const finding = findingFor(t);
      expect(finding.penalties.some((p) => p.includes("Pattern deviation"))).toBe(false);
    });

    it("does NOT flag a checkbox that correctly toggles", () => {
      const t = makeProbedTarget(
        "checkbox", "formField", "Subscribe",
        { "aria-checked": "false" },
        { "aria-checked": "true" },
      );
      const finding = findingFor(t);
      expect(finding.penalties.some((p) => p.includes("Pattern deviation"))).toBe(false);
    });

    it("does NOT flag plain button (no aria-pressed/expanded)", () => {
      const t = makeProbedTarget("button", "button", "Submit", {}, {});
      const finding = findingFor(t);
      expect(finding.penalties.some((p) => p.includes("Pattern deviation"))).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // Menu-pattern probe penalties + operability
  // ---------------------------------------------------------------------------

  describe("menu-pattern probe", () => {
    function makeMenuTarget(probe: Record<string, boolean>): Target {
      return makeTarget({
        id: "menu-trig",
        kind: "menuTrigger",
        role: "button",
        name: "Actions",
        _attributeValues: { "aria-haspopup": "menu" },
        _menuProbe: { probeSucceeded: true, ...probe },
      } as Partial<Target>);
    }
    function findingFor(target: Target) {
      const h = makeTarget({ id: "h", kind: "heading", role: "heading", name: "T", headingLevel: 1 });
      const lm = makeTarget({ id: "lm", kind: "landmark", role: "main", name: "M" });
      const state = makeState([h, lm, target]);
      const graph = buildGraph([state], profile);
      return buildFinding(graph, state, `${state.id}:${target.id}`, target, profile);
    }

    it("flags the specific open-step failure when expandedFlipped is false", () => {
      const t = makeMenuTarget({
        opens: false, expandedFlipped: false, menuDisplayed: false, focusMovedIntoMenu: false,
        arrowDownAdvances: false, escapeRestoresFocus: false, outsideClickCloses: false,
      });
      const f = findingFor(t);
      expect(f.penalties.some((p) => /aria-expanded to 'true'/i.test(p))).toBe(true);
      // When menu doesn't open at all, we don't cascade the other 3 penalties
      // — they're N/A when the open step failed.
      expect(f.penalties.some((p) => /ArrowDown does not navigate/i.test(p))).toBe(false);
    });

    it("flags focus-into-menu specifically when expanded+visible but focus stays on trigger", () => {
      // vuejs.org top-nav pattern: menu opens correctly but focus doesn't
      // move to the first menuitem, breaking arrow-key navigation.
      const t = makeMenuTarget({
        opens: false, expandedFlipped: true, menuDisplayed: true, focusMovedIntoMenu: false,
        arrowDownAdvances: true, escapeRestoresFocus: true, outsideClickCloses: true,
      });
      const f = findingFor(t);
      expect(f.penalties.some((p) => /focus does not move to the first menuitem/i.test(p))).toBe(true);
      // The more generic "does not open" penalty should NOT fire here —
      // aria-expanded did flip, the menu is visible.
      expect(f.penalties.some((p) => /does not flip aria-expanded/i.test(p))).toBe(false);
    });

    it("flags 'ArrowDown does not navigate' when arrowDownAdvances is false", () => {
      const t = makeMenuTarget({
        opens: true, arrowDownAdvances: false, escapeRestoresFocus: true, outsideClickCloses: true,
      });
      const f = findingFor(t);
      expect(f.penalties.some((p) => /ArrowDown does not navigate within the menu/i.test(p))).toBe(true);
    });

    it("flags 'Escape does not restore focus' with APG-menu wording", () => {
      const t = makeMenuTarget({
        opens: true, arrowDownAdvances: true, escapeRestoresFocus: false, outsideClickCloses: true,
      });
      const f = findingFor(t);
      expect(f.penalties.some((p) => /APG menu pattern: Escape while menu is open/i.test(p))).toBe(true);
    });

    it("flags 'outside-click does not close' when outsideClickCloses is false", () => {
      const t = makeMenuTarget({
        opens: true, arrowDownAdvances: true, escapeRestoresFocus: true, outsideClickCloses: false,
      });
      const f = findingFor(t);
      expect(f.penalties.some((p) => /Clicking outside the menu does not close it/i.test(p))).toBe(true);
    });

    it("suppresses generic escape-restore + focus-trap penalties when menu probe identified a menu-pattern failure", () => {
      // vuejs.org / substack pattern: menu opens but APG invariants fail.
      // The generic _probe also detects escape-doesn't-restore and
      // apparent-focus-trap as symptoms of the same root cause. Reporting
      // all 3 penalties on one button triples the noise for one bug.
      // Assert the menu-specific penalty fires and the generic ones do not.
      const t = makeTarget({
        id: "m1", kind: "menuTrigger", role: "button", name: "Docs",
        _attributeValues: { "aria-haspopup": "menu" },
        _menuProbe: {
          probeSucceeded: true,
          opens: false,
          expandedFlipped: true,
          menuDisplayed: true,
          focusMovedIntoMenu: false,
          arrowDownAdvances: true,
          escapeRestoresFocus: false,
          outsideClickCloses: true,
        },
        _probe: {
          probeSucceeded: true,
          focusable: true,
          escapeRestoresFocus: false,
          focusNotTrapped: false,
          stateChanged: true,
          ariaStateBeforeEnter: { "aria-expanded": "false" },
          ariaStateAfterEnter: { "aria-expanded": "true" },
          elementStillConnected: true,
        },
      } as Partial<Target>);
      const f = findingFor(t);
      expect(f.penalties.some((p) => /focus does not move to the first menuitem/i.test(p))).toBe(true);
      expect(f.penalties.some((p) => /Pressing Escape does not return focus to the trigger/.test(p))).toBe(false);
      expect(f.penalties.some((p) => /Focus appears trapped/.test(p))).toBe(false);
    });

    it("deducts operability score for each menu invariant failure", () => {
      const working = makeMenuTarget({
        opens: true, arrowDownAdvances: true, escapeRestoresFocus: true, outsideClickCloses: true,
      });
      const broken = makeMenuTarget({
        opens: true, arrowDownAdvances: false, escapeRestoresFocus: false, outsideClickCloses: false,
      });
      const good = findingFor(working);
      const bad = findingFor(broken);
      // Broken menu has 3 failed invariants × 8 = 24 point deduction, capped at 0/100
      expect(bad.scores.operability).toBeLessThan(good.scores.operability);
      expect(good.scores.operability - bad.scores.operability).toBeGreaterThanOrEqual(16);
    });

    it("emits nothing when the menu probe didn't run (no _menuProbe field)", () => {
      const t = makeTarget({
        id: "plain-menu",
        kind: "menuTrigger",
        role: "button",
        name: "Actions",
        _attributeValues: { "aria-haspopup": "menu" },
      } as Partial<Target>);
      const f = findingFor(t);
      expect(f.penalties.some((p) => /APG menu pattern/i.test(p))).toBe(false);
      expect(f.penalties.some((p) => /Enter on the menu trigger does not open/i.test(p))).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // Modal dialog probe penalties
  // ---------------------------------------------------------------------------

  describe("modal dialog probe", () => {
    function makeModalTarget(probe: Record<string, boolean | undefined>): Target {
      return makeTarget({
        id: "dlg",
        kind: "dialog",
        role: "dialog",
        name: "Confirm",
        _modalProbe: { probeSucceeded: true, ...probe },
      } as Partial<Target>);
    }
    function findingFor(target: Target) {
      const h = makeTarget({ id: "h", kind: "heading", role: "heading", name: "T", headingLevel: 1 });
      const state = makeState([h, target]);
      const graph = buildGraph([state], profile);
      return buildFinding(graph, state, `${state.id}:${target.id}`, target, profile);
    }

    it("flags the 'Tab escapes dialog' anti-pattern", () => {
      const t = makeModalTarget({
        focusTrapped: false,
        shiftTabWraps: true,
        escapeCloses: true,
      });
      const f = findingFor(t);
      expect(f.penalties.some((p) => /Tab from the last focusable element escapes the dialog/i.test(p))).toBe(true);
    });

    it("flags the 'Shift+Tab escapes dialog' anti-pattern", () => {
      const t = makeModalTarget({
        focusTrapped: true,
        shiftTabWraps: false,
        escapeCloses: true,
      });
      const f = findingFor(t);
      expect(f.penalties.some((p) => /Shift\+Tab from the first focusable element escapes/i.test(p))).toBe(true);
    });

    it("flags the 'Escape does not close' anti-pattern", () => {
      const t = makeModalTarget({
        focusTrapped: true,
        shiftTabWraps: true,
        escapeCloses: false,
      });
      const f = findingFor(t);
      expect(f.penalties.some((p) => /Escape does not close the dialog/i.test(p))).toBe(true);
    });

    it("flags the 'dialog has no focusable descendants' case with a specific message", () => {
      const t = makeModalTarget({ dialogHasNoFocusables: true });
      const f = findingFor(t);
      expect(f.penalties.some((p) => /dialog has no focusable descendants/i.test(p))).toBe(true);
    });

    it("emits nothing for a well-formed dialog", () => {
      const t = makeModalTarget({
        focusTrapped: true,
        shiftTabWraps: true,
        escapeCloses: true,
      });
      const f = findingFor(t);
      expect(f.penalties.some((p) => /APG dialog pattern/i.test(p))).toBe(false);
    });

    it("emits nothing when modal probe didn't run (no _modalProbe field)", () => {
      const t = makeTarget({
        id: "plain-dlg",
        kind: "dialog",
        role: "dialog",
        name: "Confirm",
      });
      const f = findingFor(t);
      expect(f.penalties.some((p) => /APG dialog pattern/i.test(p))).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // Tab/disclosure widget probe penalties
  // ---------------------------------------------------------------------------

  describe("tab and disclosure widget probes", () => {
    function findingFor(target: Target) {
      const h = makeTarget({ id: "h", kind: "heading", role: "heading", name: "T", headingLevel: 1 });
      const lm = makeTarget({ id: "lm", kind: "landmark", role: "main", name: "M" });
      const state = makeState([h, lm, target]);
      const graph = buildGraph([state], profile);
      return buildFinding(graph, state, `${state.id}:${target.id}`, target, profile);
    }

    it("flags broken tab keyboard and panel invariants", () => {
      const t = makeTarget({
        id: "tab-bad",
        kind: "tab",
        role: "tab",
        name: "Settings",
        _tabProbe: {
          probeSucceeded: true,
          arrowRightMovesFocus: false,
          activationSelectsTab: false,
          selectedTabHasPanel: false,
        },
      } as Partial<Target>);
      const f = findingFor(t);
      expect(f.penalties.some((p) => /ArrowRight does not move focus/i.test(p))).toBe(true);
      expect(f.penalties.some((p) => /aria-selected='true'/i.test(p))).toBe(true);
      expect(f.penalties.some((p) => /visible controlled tabpanel/i.test(p))).toBe(true);
      expect(f.evidence?.some((e) => e.source === "tab-pattern-probe")).toBe(true);
    });

    it("flags disclosure controlled-region and focus failures", () => {
      const t = makeTarget({
        id: "disc-bad",
        kind: "button",
        role: "button",
        name: "Details",
        _disclosureProbe: {
          probeSucceeded: true,
          expandedFlipped: false,
          controlledRegionDisplayed: false,
          focusLostToBody: true,
        },
      } as Partial<Target>);
      const f = findingFor(t);
      expect(f.penalties.some((p) => /does not toggle aria-expanded/i.test(p))).toBe(true);
      expect(f.penalties.some((p) => /controlled region is still hidden/i.test(p))).toBe(true);
      expect(f.penalties.some((p) => /drops focus to document\.body/i.test(p))).toBe(true);
      expect(f.evidence?.some((e) => e.source === "disclosure-pattern-probe")).toBe(true);
    });

    it("flags combobox/listbox contract failures", () => {
      const combo = makeTarget({
        id: "combo-bad",
        kind: "formField",
        role: "combobox",
        name: "City",
        _comboboxProbe: {
          probeSucceeded: true,
          opensWithArrowDown: false,
          exposesActiveOption: false,
          escapeCloses: false,
        },
      } as Partial<Target>);
      const listbox = makeTarget({
        id: "listbox-bad",
        kind: "formField",
        role: "listbox",
        name: "Plan",
        _listboxProbe: {
          probeSucceeded: true,
          arrowDownMovesOption: false,
          exposesSelectedOption: false,
        },
      } as Partial<Target>);

      const comboFinding = findingFor(combo);
      const listboxFinding = findingFor(listbox);
      expect(comboFinding.penalties.some((p) => /ArrowDown does not open the popup/i.test(p))).toBe(true);
      expect(comboFinding.penalties.some((p) => /active or selected option/i.test(p))).toBe(true);
      expect(comboFinding.evidence?.some((e) => e.source === "combobox-contract-probe")).toBe(true);
      expect(listboxFinding.penalties.some((p) => /ArrowDown does not move to another option/i.test(p))).toBe(true);
      expect(listboxFinding.evidence?.some((e) => e.source === "listbox-contract-probe")).toBe(true);
    });

    it("flags form error flow failures", () => {
      const t = makeTarget({
        id: "email",
        kind: "formField",
        role: "textbox",
        name: "Email",
        _formErrorProbe: {
          probeSucceeded: true,
          invalidStateExposed: false,
          errorMessageAssociated: false,
          focusMovedToInvalidField: false,
          liveErrorRegionPresent: false,
        },
      } as Partial<Target>);

      const f = findingFor(t);
      expect(f.penalties.some((p) => /invalid field state is not exposed/i.test(p))).toBe(true);
      expect(f.penalties.some((p) => /error text is not associated/i.test(p))).toBe(true);
      expect(f.penalties.some((p) => /does not move focus/i.test(p))).toBe(true);
      expect(f.evidence?.some((e) => e.source === "form-error-flow-probe")).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // Focus-transition after activation (focusAfterActivation)
  // ---------------------------------------------------------------------------

  describe("focus-transition penalties", () => {
    function makeProbedTarget(focusAfter: string | undefined): Target {
      return makeTarget({
        id: "btn-focus",
        kind: "button",
        role: "button",
        name: "Submit",
        _probe: {
          probeSucceeded: true,
          focusable: true,
          tabbable: true,
          focusAfterActivation: focusAfter,
        },
      } as Partial<Target>);
    }
    function findingFor(target: Target) {
      const h = makeTarget({ id: "h", kind: "heading", role: "heading", name: "T", headingLevel: 1 });
      const lm = makeTarget({ id: "lm", kind: "landmark", role: "main", name: "M" });
      const state = makeState([h, lm, target]);
      const graph = buildGraph([state], profile);
      return buildFinding(graph, state, `${state.id}:${target.id}`, target, profile);
    }

    it("flags 'focus was lost' penalty when focusAfterActivation=moved-to-body", () => {
      const t = makeProbedTarget("moved-to-body");
      const f = findingFor(t);
      expect(f.penalties.some((p) => /Focus was lost after activation/i.test(p))).toBe(true);
      expect(f.penalties.some((p) => /document\.body/.test(p))).toBe(true);
    });

    it("emits nothing for focusAfterActivation=stayed", () => {
      const t = makeProbedTarget("stayed");
      const f = findingFor(t);
      expect(f.penalties.some((p) => /Focus was lost after activation/i.test(p))).toBe(false);
    });

    it("emits nothing for focusAfterActivation=moved-away (ambiguous, could be correct)", () => {
      const t = makeProbedTarget("moved-away");
      const f = findingFor(t);
      // moved-away could be correct (focus moved into new modal) or incorrect.
      // Without more context, don't penalize automatically.
      expect(f.penalties.some((p) => /Focus was lost after activation/i.test(p))).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // Target size (WCAG 2.5.8)
  // ---------------------------------------------------------------------------

  describe("target-size penalties", () => {
    function makeSizedTarget(width: number, height: number): Target {
      return makeTarget({
        id: "sized-btn",
        kind: "button",
        role: "button",
        name: "Tap me",
        _rect: { width, height },
      } as Partial<Target>);
    }
    function findingFor(target: Target) {
      const h = makeTarget({ id: "h", kind: "heading", role: "heading", name: "T", headingLevel: 1 });
      const lm = makeTarget({ id: "lm", kind: "landmark", role: "main", name: "M" });
      const state = makeState([h, lm, target]);
      const graph = buildGraph([state], profile);
      return buildFinding(graph, state, `${state.id}:${target.id}`, target, profile);
    }

    it("flags a 16×16 target as below WCAG 2.5.8", () => {
      const t = makeSizedTarget(16, 16);
      const f = findingFor(t);
      expect(f.penalties.some((p) => /16×16px, below the WCAG 2\.5\.8 minimum/.test(p))).toBe(true);
    });

    it("flags a 30×20 target (height below threshold)", () => {
      const t = makeSizedTarget(30, 20);
      const f = findingFor(t);
      expect(f.penalties.some((p) => /30×20px, below the WCAG/.test(p))).toBe(true);
    });

    it("does NOT flag a 24×24 target (exactly at threshold)", () => {
      const t = makeSizedTarget(24, 24);
      const f = findingFor(t);
      expect(f.penalties.some((p) => /WCAG 2\.5\.8/.test(p))).toBe(false);
    });

    it("does NOT flag a 48×48 target (comfortably above)", () => {
      const t = makeSizedTarget(48, 48);
      const f = findingFor(t);
      expect(f.penalties.some((p) => /WCAG 2\.5\.8/.test(p))).toBe(false);
    });

    it("ignores zero-size rects (hidden elements, different bug class)", () => {
      const t = makeSizedTarget(0, 0);
      const f = findingFor(t);
      expect(f.penalties.some((p) => /WCAG 2\.5\.8/.test(p))).toBe(false);
    });

    it("emits nothing when _rect is absent (offline analysis, no capture data)", () => {
      const t = makeTarget({
        id: "no-rect",
        kind: "button",
        role: "button",
        name: "Button",
      });
      const f = findingFor(t);
      expect(f.penalties.some((p) => /WCAG 2\.5\.8/.test(p))).toBe(false);
    });

    it("deducts operability for small targets", () => {
      const tiny = makeSizedTarget(12, 12);
      const big = makeSizedTarget(48, 48);
      const tinyF = findingFor(tiny);
      const bigF = findingFor(big);
      expect(tinyF.scores.operability).toBeLessThan(bigF.scores.operability);
    });
  });
});
