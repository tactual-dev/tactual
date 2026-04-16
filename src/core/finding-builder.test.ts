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

    // Combobox risk is 8, which triggers the "consider a more widely supported pattern" fix
    const patternFix = finding.suggestedFixes.find((f) => /more widely supported pattern/i.test(f));
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
});
