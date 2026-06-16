import { describe, it, expect } from "vitest";
import { analyze } from "./analyzer.js";
import { genericMobileWebSrV0 } from "../profiles/generic-mobile.js";
import type { PageState } from "./types.js";

function makeState(overrides: Partial<PageState> = {}): PageState {
  return {
    id: "s1",
    url: "https://example.com",
    route: "/",
    snapshotHash: "abc123",
    interactiveHash: "def456",
    openOverlays: [],
    targets: [
      { id: "t-landmark-1", kind: "landmark", role: "main", name: "Main", requiresBranchOpen: false },
      { id: "t-heading-1", kind: "heading", role: "heading", name: "Welcome", headingLevel: 1, requiresBranchOpen: false },
      { id: "t-link-1", kind: "link", role: "link", name: "Learn More", requiresBranchOpen: false },
      { id: "t-button-1", kind: "button", role: "button", name: "Sign Up", requiresBranchOpen: false },
      { id: "t-formfield-1", kind: "formField", role: "textbox", name: "Email", requiresBranchOpen: false },
    ],
    timestamp: Date.now(),
    provenance: "scripted",
    ...overrides,
  };
}

describe("analyze", () => {
  it("produces findings for all targets", () => {
    const state = makeState();
    const result = analyze([state], genericMobileWebSrV0, { name: "Test" });

    expect(result.findings.length).toBe(5);
    expect(result.metadata.stateCount).toBe(1);
    expect(result.metadata.targetCount).toBe(5);
    expect(result.metadata.edgeCount).toBeGreaterThan(0);
    expect(result.flow.profile).toBe("generic-mobile-web-sr-v0");
  });

  it("scores findings with valid score vectors", () => {
    const state = makeState();
    const result = analyze([state], genericMobileWebSrV0);

    for (const finding of result.findings) {
      expect(finding.scores.overall).toBeGreaterThanOrEqual(0);
      expect(finding.scores.overall).toBeLessThanOrEqual(100);
      expect(finding.scores.discoverability).toBeGreaterThanOrEqual(0);
      expect(finding.scores.reachability).toBeGreaterThanOrEqual(0);
      expect(finding.severity).toBeDefined();
      expect(finding.profile).toBe("generic-mobile-web-sr-v0");
    }
  });

  it("sorts findings by severity (worst first)", () => {
    const state = makeState();
    const result = analyze([state], genericMobileWebSrV0);

    for (let i = 0; i < result.findings.length - 1; i++) {
      expect(result.findings[i].scores.overall).toBeLessThanOrEqual(
        result.findings[i + 1].scores.overall,
      );
    }
  });

  it("generates bestPath for reachable targets", () => {
    const state = makeState();
    const result = analyze([state], genericMobileWebSrV0);

    // All targets should have a path from the state entry
    for (const finding of result.findings) {
      expect(finding.bestPath.length).toBeGreaterThanOrEqual(0);
    }
  });

  it("generates penalties and suggested fixes", () => {
    // State with no headings — should trigger noHeadingAnchorRule
    const state = makeState({
      targets: [
        { id: "t-button-1", kind: "button", role: "button", name: "", requiresBranchOpen: true },
      ],
    });
    const result = analyze([state], genericMobileWebSrV0);

    const finding = result.findings[0];
    // Should have penalties from rules
    expect(finding.penalties.length).toBeGreaterThan(0);
    expect(finding.suggestedFixes.length).toBeGreaterThan(0);
  });

  it("formats as valid JSON", () => {
    const state = makeState();
    const result = analyze([state], genericMobileWebSrV0);

    // Should be serializable
    const json = JSON.stringify(result);
    const parsed = JSON.parse(json);
    expect(parsed.findings.length).toBe(5);
  });

  it("reports version and timing metadata", () => {
    const state = makeState();
    const result = analyze([state], genericMobileWebSrV0);

    expect(result.metadata.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(result.metadata.duration).toBeGreaterThanOrEqual(0);
  });

  it("warns when --focus filter matches no landmarks (no-effect)", () => {
    const state = makeState();
    const result = analyze([state], genericMobileWebSrV0, {
      filter: { focus: ["does-not-exist"] },
    });

    const warning = result.diagnostics.find((d) =>
      d.message.includes("Focus filter") && d.message.includes("had no effect"),
    );
    expect(warning).toBeDefined();
    expect(warning?.level).toBe("warning");
  });

  it("does not emit no-effect warning when focus filter actually matches", () => {
    const state = makeState();
    // makeState includes a landmark with role "main"
    const result = analyze([state], genericMobileWebSrV0, {
      filter: { focus: ["main"] },
    });

    const warning = result.diagnostics.find((d) =>
      d.message.includes("Focus filter") && d.message.includes("had no effect"),
    );
    expect(warning).toBeUndefined();
  });

  it("promotes shared penalties to page-level diagnostic when >50% of findings share them", () => {
    // Create a state with 12 unnamed buttons — all will share the
    // "Target has no accessible name" penalty.
    const targets = Array.from({ length: 12 }, (_, i) => ({
      id: `t-button-${i}`,
      kind: "button" as const,
      role: "button",
      name: "",
      requiresBranchOpen: false,
    }));
    const state = makeState({ targets });
    const result = analyze([state], genericMobileWebSrV0);

    // Should emit shared-structural-issue diagnostic
    const sharedDiag = result.diagnostics.find(
      (d) => d.code === "shared-structural-issue",
    );
    expect(sharedDiag).toBeDefined();
    expect(sharedDiag?.level).toBe("warning");
    expect(sharedDiag?.message).toMatch(/of \d+ targets share/);
    expect(sharedDiag?.message).toContain("page-level structural problem");
  });

  it("does NOT promote shared penalties when fewer than 10 findings", () => {
    // 5 unnamed buttons — below the 10-finding threshold for promotion
    const targets = Array.from({ length: 5 }, (_, i) => ({
      id: `t-button-${i}`,
      kind: "button" as const,
      role: "button",
      name: "",
      requiresBranchOpen: false,
    }));
    const state = makeState({ targets });
    const result = analyze([state], genericMobileWebSrV0);

    const sharedDiag = result.diagnostics.find(
      (d) => d.code === "shared-structural-issue",
    );
    expect(sharedDiag).toBeUndefined();
  });

  it("emits redundant-tab-stops diagnostic when multiple links share one href", () => {
    // 5 links: 3 to /about (redundant), 2 to /contact (redundant).
    // Expected: 1 diagnostic reporting 3 savings (2 excess at /about + 1 at /contact)
    // across 2 duplicated destinations.
    const targets = [
      { id: "heading-1", kind: "heading" as const, role: "heading", name: "T", headingLevel: 1, requiresBranchOpen: false },
      { id: "link-a1", kind: "link" as const, role: "link", name: "About", requiresBranchOpen: false, _href: "https://example.com/about" },
      { id: "link-a2", kind: "link" as const, role: "link", name: "About us", requiresBranchOpen: false, _href: "https://example.com/about" },
      { id: "link-a3", kind: "link" as const, role: "link", name: "About", requiresBranchOpen: false, _href: "https://example.com/about" },
      { id: "link-c1", kind: "link" as const, role: "link", name: "Contact", requiresBranchOpen: false, _href: "https://example.com/contact" },
      { id: "link-c2", kind: "link" as const, role: "link", name: "Contact us", requiresBranchOpen: false, _href: "https://example.com/contact" },
      { id: "link-u", kind: "link" as const, role: "link", name: "Home", requiresBranchOpen: false, _href: "https://example.com/" },
    ];
    const state = makeState({ targets });
    const result = analyze([state], genericMobileWebSrV0);

    const diag = result.diagnostics.find((d) => d.code === "redundant-tab-stops");
    expect(diag).toBeDefined();
    expect(diag?.affectedCount).toBe(3); // 2 excess at /about + 1 at /contact
    expect(diag?.totalCount).toBe(2); // /about and /contact are the 2 duplicated destinations
    expect(diag?.message).toMatch(/3 redundant tab stops/);
    expect(diag?.message).toMatch(/2 duplicated link destinations/);
    expect(diag?.affectedTargetIds?.length).toBeGreaterThan(0);
  });

  it("does NOT emit redundant-tab-stops when every link has a unique href", () => {
    const targets = [
      { id: "heading-1", kind: "heading" as const, role: "heading", name: "T", headingLevel: 1, requiresBranchOpen: false },
      { id: "l-1", kind: "link" as const, role: "link", name: "A", requiresBranchOpen: false, _href: "https://example.com/a" },
      { id: "l-2", kind: "link" as const, role: "link", name: "B", requiresBranchOpen: false, _href: "https://example.com/b" },
    ];
    const state = makeState({ targets });
    const result = analyze([state], genericMobileWebSrV0);
    expect(result.diagnostics.find((d) => d.code === "redundant-tab-stops")).toBeUndefined();
  });

  it("emits data-flow-dependencies when a target flips from disabled to enabled across states", () => {
    const stateA = makeState({
      id: "state-a",
      targets: [
        { id: "h1", kind: "heading" as const, role: "heading", name: "Form", headingLevel: 1, requiresBranchOpen: false },
        { id: "submit", kind: "button" as const, role: "button", name: "Submit", requiresBranchOpen: false, _attributeValues: { "aria-disabled": "true" } },
      ],
    });
    const stateB = makeState({
      id: "state-b",
      targets: [
        { id: "h1", kind: "heading" as const, role: "heading", name: "Form", headingLevel: 1, requiresBranchOpen: false },
        { id: "submit", kind: "button" as const, role: "button", name: "Submit", requiresBranchOpen: false, _attributeValues: { "aria-disabled": "false" } },
      ],
    });
    const result = analyze([stateA, stateB], genericMobileWebSrV0);
    const diag = result.diagnostics.find((d) => d.code === "data-flow-dependencies");
    expect(diag).toBeDefined();
    expect(diag?.affectedCount).toBe(1);
    expect(diag?.message).toMatch(/"Submit"/);
  });

  it("does not promote degraded-content warnings from isolated explored branches when the primary capture is healthy", () => {
    const scripted = makeState({
      id: "scripted",
      targets: [
        { id: "main", kind: "landmark" as const, role: "main", name: "Main", requiresBranchOpen: false },
        { id: "h1", kind: "heading" as const, role: "heading", name: "Component docs", headingLevel: 1, requiresBranchOpen: false },
        { id: "h2", kind: "heading" as const, role: "heading", name: "Examples", headingLevel: 2, requiresBranchOpen: false },
        ...Array.from({ length: 30 }, (_, i) => ({
          id: `scripted-link-${i}`,
          kind: "link" as const,
          role: "link",
          name: `Link ${i}`,
          requiresBranchOpen: false,
        })),
      ],
      provenance: "scripted",
    });
    const explored = makeState({
      id: "explored-thin",
      targets: [
        { id: "branch-link-1", kind: "link" as const, role: "link", name: "Moved", requiresBranchOpen: false },
        { id: "branch-link-2", kind: "link" as const, role: "link", name: "Home", requiresBranchOpen: false },
      ],
      provenance: "explored",
    });

    const result = analyze([scripted, explored], genericMobileWebSrV0);

    expect(result.diagnostics.find((d) => d.code === "possibly-degraded-content")).toBeUndefined();
  });

  it("keeps degraded-content warnings when the scripted capture is also thin", () => {
    const scripted = makeState({
      id: "scripted-thin",
      targets: [
        { id: "h1", kind: "heading" as const, role: "heading", name: "Moved", requiresBranchOpen: false },
        { id: "home", kind: "link" as const, role: "link", name: "Home", requiresBranchOpen: false },
      ],
      provenance: "scripted",
    });
    const explored = makeState({
      id: "explored-thin",
      targets: [
        { id: "branch-link-1", kind: "link" as const, role: "link", name: "Moved", requiresBranchOpen: false },
        { id: "branch-link-2", kind: "link" as const, role: "link", name: "Home", requiresBranchOpen: false },
      ],
      provenance: "explored",
    });

    const result = analyze([scripted, explored], genericMobileWebSrV0);

    expect(result.diagnostics.find((d) => d.code === "possibly-degraded-content")).toBeDefined();
  });

  it("honors WCAG 2.5.8 spacing exception: small targets with no neighbor within 24px are exempt", () => {
    // Two small (16×16) buttons. The first is far from any neighbor —
    // exempted from the target-size penalty. The second sits next to
    // another small button (18px center-to-center) — still penalized.
    const targets = [
      { id: "h1", kind: "heading" as const, role: "heading", name: "T", headingLevel: 1, requiresBranchOpen: false },
      // Far-spaced small button — exempt
      { id: "lonely", kind: "button" as const, role: "button", name: "Lonely", requiresBranchOpen: false, _rect: { x: 0, y: 0, width: 16, height: 16 } },
      // Pair of close small buttons — both penalized
      { id: "near-a", kind: "button" as const, role: "button", name: "Near A", requiresBranchOpen: false, _rect: { x: 200, y: 200, width: 16, height: 16 } },
      { id: "near-b", kind: "button" as const, role: "button", name: "Near B", requiresBranchOpen: false, _rect: { x: 210, y: 200, width: 16, height: 16 } },
    ];
    const state = makeState({ targets });
    const result = analyze([state], genericMobileWebSrV0);

    const findingFor = (id: string) => result.findings.find((f) => f.targetId === id);
    const lonely = findingFor("lonely");
    const nearA = findingFor("near-a");
    const nearB = findingFor("near-b");

    const hasSizePenalty = (penalties: string[] | undefined) =>
      (penalties ?? []).some((p) => p.includes("WCAG 2.5.8"));

    expect(hasSizePenalty(lonely?.penalties)).toBe(false);
    expect(hasSizePenalty(nearA?.penalties)).toBe(true);
    expect(hasSizePenalty(nearB?.penalties)).toBe(true);
  });

  it("emits ambiguous-link-names when same name links go to different URLs", () => {
    // Two "Read more" links to /a and /b — same name, different hrefs.
    // This is the AMBIGUOUS case (vs the REDUNDANT case where both go to
    // the same href).
    const targets = [
      { id: "heading-1", kind: "heading" as const, role: "heading", name: "T", headingLevel: 1, requiresBranchOpen: false },
      { id: "rm-a", kind: "link" as const, role: "link", name: "Read more", requiresBranchOpen: false, _href: "https://example.com/a" },
      { id: "rm-b", kind: "link" as const, role: "link", name: "Read more", requiresBranchOpen: false, _href: "https://example.com/b" },
      { id: "rm-c", kind: "link" as const, role: "link", name: "Read more", requiresBranchOpen: false, _href: "https://example.com/c" },
      { id: "home", kind: "link" as const, role: "link", name: "Home", requiresBranchOpen: false, _href: "https://example.com/" },
    ];
    const state = makeState({ targets });
    const result = analyze([state], genericMobileWebSrV0);

    const diag = result.diagnostics.find((d) => d.code === "ambiguous-link-names");
    expect(diag).toBeDefined();
    expect(diag?.affectedCount).toBe(1); // one ambiguous group
    expect(diag?.message).toMatch(/Read more.*3 different URLs/);
  });

  it("does NOT flag ambiguous-link-names when same-name links share the same href (that's redundant, not ambiguous)", () => {
    const targets = [
      { id: "heading-1", kind: "heading" as const, role: "heading", name: "T", headingLevel: 1, requiresBranchOpen: false },
      { id: "rm-a1", kind: "link" as const, role: "link", name: "Read more", requiresBranchOpen: false, _href: "https://example.com/a" },
      { id: "rm-a2", kind: "link" as const, role: "link", name: "Read more", requiresBranchOpen: false, _href: "https://example.com/a" },
    ];
    const state = makeState({ targets });
    const result = analyze([state], genericMobileWebSrV0);
    expect(result.diagnostics.find((d) => d.code === "ambiguous-link-names")).toBeUndefined();
    // The redundant-tab-stops diagnostic catches this case instead.
    expect(result.diagnostics.find((d) => d.code === "redundant-tab-stops")).toBeDefined();
  });

  it("attaches a redundant-tab-stop penalty to each duplicate link finding", () => {
    // Two links named "About" reach the same href → both should carry the
    // per-target penalty. The link named "About us" reaches the same href
    // but with a different name; it should NOT be penalized (different
    // accessible name = legitimately distinct user-facing affordance).
    const targets = [
      { id: "heading-1", kind: "heading" as const, role: "heading", name: "T", headingLevel: 1, requiresBranchOpen: false },
      { id: "link-a1", kind: "link" as const, role: "link", name: "About", requiresBranchOpen: false, _href: "https://example.com/about" },
      { id: "link-a2", kind: "link" as const, role: "link", name: "About us", requiresBranchOpen: false, _href: "https://example.com/about" },
      { id: "link-a3", kind: "link" as const, role: "link", name: "About", requiresBranchOpen: false, _href: "https://example.com/about" },
      { id: "link-unique", kind: "link" as const, role: "link", name: "Home", requiresBranchOpen: false, _href: "https://example.com/" },
    ];
    const state = makeState({ targets });
    const result = analyze([state], genericMobileWebSrV0);

    const findingFor = (id: string) => result.findings.find((f) => f.targetId === id);
    const a1 = findingFor("link-a1");
    const a2 = findingFor("link-a2");
    const a3 = findingFor("link-a3");
    const unique = findingFor("link-unique");

    expect(a1?.penalties.some((p) => p.startsWith("Redundant tab stop"))).toBe(true);
    expect(a3?.penalties.some((p) => p.startsWith("Redundant tab stop"))).toBe(true);
    expect(a2?.penalties.some((p) => p.startsWith("Redundant tab stop"))).toBe(false);
    expect(unique?.penalties.some((p) => p.startsWith("Redundant tab stop"))).toBe(false);
  });
});
