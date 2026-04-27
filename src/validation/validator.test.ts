import { describe, it, expect } from "vitest";
import { JSDOM } from "jsdom";
import {
  isValidatable,
  announcementMatches,
  validateFindings,
  validateFindingsInJsdom,
  withValidationLock,
} from "./validator.js";
import type { Target, PageState, Finding, ScoreVector } from "../core/types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTarget(overrides: Partial<Target> = {}): Target {
  return {
    id: overrides.id ?? "t1",
    kind: overrides.kind ?? "button",
    role: overrides.role ?? "button",
    name: overrides.name ?? "Submit",
    requiresBranchOpen: false,
    ...overrides,
  };
}

function makeScores(overall: number): ScoreVector {
  return {
    discoverability: overall,
    reachability: overall,
    operability: overall,
    recovery: overall,
    interopRisk: 0,
    overall,
  };
}

function makeFinding(targetId: string, overall: number): Finding {
  return {
    targetId,
    profile: "test",
    scores: makeScores(overall),
    severity: overall >= 75 ? "acceptable" : "high",
    bestPath: [],
    alternatePaths: [],
    penalties: [],
    suggestedFixes: [],
    confidence: 1,
  };
}

function makeState(targets: Target[]): PageState {
  return {
    id: "s1",
    url: "https://example.com",
    route: "/",
    snapshotHash: "h",
    interactiveHash: "ih",
    openOverlays: [],
    targets,
    timestamp: 0,
    provenance: "scripted",
  };
}

// ---------------------------------------------------------------------------
// isValidatable — the pre-filter behavior that fixes the 0/N bug
// ---------------------------------------------------------------------------

describe("isValidatable", () => {
  it("accepts any target with an accessible name", () => {
    expect(isValidatable(makeTarget({ name: "Submit" }))).toBe(true);
    expect(isValidatable(makeTarget({ kind: "link", name: "Home" }))).toBe(true);
    expect(isValidatable(makeTarget({ kind: "formField", name: "Email" }))).toBe(true);
  });

  it("accepts unnamed landmarks (SR announces role)", () => {
    expect(isValidatable(makeTarget({ kind: "landmark", role: "navigation", name: "" }))).toBe(true);
    expect(isValidatable(makeTarget({ kind: "landmark", role: "main", name: "" }))).toBe(true);
  });

  it("accepts unnamed headings (SR announces as 'heading level N')", () => {
    expect(isValidatable(makeTarget({ kind: "heading", role: "heading", name: "" }))).toBe(true);
  });

  it("rejects unnamed non-structural targets — no deterministic matcher exists", () => {
    expect(isValidatable(makeTarget({ kind: "button", name: "" }))).toBe(false);
    expect(isValidatable(makeTarget({ kind: "link", name: "" }))).toBe(false);
    expect(isValidatable(makeTarget({ kind: "formField", name: "" }))).toBe(false);
    expect(isValidatable(makeTarget({ kind: "menuItem", name: "" }))).toBe(false);
  });

  it("treats whitespace-only names as unnamed", () => {
    expect(isValidatable(makeTarget({ kind: "button", name: "   " }))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// announcementMatches — name substring + role fallback
// ---------------------------------------------------------------------------

describe("announcementMatches", () => {
  it("matches name substring case-insensitively", () => {
    const target = makeTarget({ name: "Submit Order" });
    expect(announcementMatches("Submit Order, button", target)).toBe(true);
    expect(announcementMatches("submit order, button", target)).toBe(true);
  });

  it("does not match unrelated announcements", () => {
    const target = makeTarget({ name: "Submit" });
    expect(announcementMatches("Cancel, button", target)).toBe(false);
  });

  it("falls back to role word for unnamed landmarks", () => {
    const landmark = makeTarget({ kind: "landmark", role: "navigation", name: "" });
    expect(announcementMatches("navigation landmark", landmark)).toBe(true);
    expect(announcementMatches("main landmark", landmark)).toBe(false);
  });

  it("falls back to role word for unnamed headings", () => {
    const heading = makeTarget({ kind: "heading", role: "heading", name: "" });
    expect(announcementMatches("heading level 2", heading)).toBe(true);
  });

  it("prefers name over role when name is present", () => {
    // If the target has a name, only the name matters — don't accidentally match
    // an announcement that contains the role word but is a different element.
    const named = makeTarget({ kind: "landmark", role: "navigation", name: "Primary" });
    expect(announcementMatches("navigation landmark", named)).toBe(false);
    expect(announcementMatches("Primary, navigation landmark", named)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// validateFindings — end-to-end against JSDOM + virtual screen reader
// ---------------------------------------------------------------------------

const VALIDATION_TEST_TIMEOUT = 15_000;

describe("validateFindings", () => {
  it("filters unvalidatable targets out before the worst-N slice", async () => {
    // This is the core bug-fix: if the worst 5 findings are all unnamed
    // non-structural targets, the old code returned 0/5. Now it should
    // validate the next-best validatable target instead.
    const unnamedButton1 = makeTarget({ id: "b1", kind: "button", name: "" });
    const unnamedButton2 = makeTarget({ id: "b2", kind: "button", name: "" });
    const namedHeading = makeTarget({ id: "h1", kind: "heading", role: "heading", name: "Welcome" });

    const html = `<h1>Welcome</h1><button></button><button></button>`;
    const dom = new JSDOM(html);
    const state = makeState([unnamedButton1, unnamedButton2, namedHeading]);
    const findings = [
      makeFinding("b1", 30), // worst
      makeFinding("b2", 35),
      makeFinding("h1", 80), // best, but the only validatable
    ];

    // biome-ignore lint: guidepup requires window/document as globals
    (globalThis as Record<string, unknown>).window = dom.window;
    (globalThis as Record<string, unknown>).document = dom.window.document;
    try {
      const results = await validateFindings(
        dom.window.document.body,
        state,
        findings,
        { maxTargets: 2, strategy: "semantic" },
      );
      // Only the heading is validatable; b1/b2 pre-filtered out.
      expect(results).toHaveLength(1);
      expect(results[0].targetId).toBe("h1");
      expect(results[0].reachable).toBe(true);
    } finally {
      (globalThis as Record<string, unknown>).window = undefined;
      (globalThis as Record<string, unknown>).document = undefined;
    }
  }, VALIDATION_TEST_TIMEOUT);

  it("finds an unnamed landmark via role fallback", async () => {
    const unnamedNav = makeTarget({
      id: "nav",
      kind: "landmark",
      role: "navigation",
      name: "",
    });
    const html = `<nav><a href="#">Home</a></nav>`;
    const dom = new JSDOM(html);
    const state = makeState([unnamedNav]);
    const findings = [makeFinding("nav", 50)];

    (globalThis as Record<string, unknown>).window = dom.window;
    (globalThis as Record<string, unknown>).document = dom.window.document;
    try {
      const results = await validateFindings(
        dom.window.document.body,
        state,
        findings,
        { maxTargets: 5, strategy: "semantic" },
      );
      expect(results).toHaveLength(1);
      expect(results[0].reachable).toBe(true);
    } finally {
      (globalThis as Record<string, unknown>).window = undefined;
      (globalThis as Record<string, unknown>).document = undefined;
    }
  }, VALIDATION_TEST_TIMEOUT);

  it("serializes concurrent validateFindingsInJsdom calls (no globalThis races)", async () => {
    // Two concurrent validations against different JSDOM instances must
    // not contaminate each other's globalThis.window/document — this was
    // the reentrancy bug the validation lock fixes. Before the fix, the
    // globals from whichever call ran its try{} last would be left in
    // place, and whichever call was awaiting inside validateFindings
    // would read the other's DOM.
    const h1 = makeTarget({ id: "h1", kind: "heading", role: "heading", name: "Alpha" });
    const h2 = makeTarget({ id: "h2", kind: "heading", role: "heading", name: "Beta" });
    const domA = new JSDOM(`<h1>Alpha</h1>`);
    const domB = new JSDOM(`<h1>Beta</h1>`);

    const [resA, resB] = await Promise.all([
      validateFindingsInJsdom(
        domA,
        makeState([h1]),
        [makeFinding("h1", 50)],
        { maxTargets: 1, strategy: "semantic" },
      ),
      validateFindingsInJsdom(
        domB,
        makeState([h2]),
        [makeFinding("h2", 50)],
        { maxTargets: 1, strategy: "semantic" },
      ),
    ]);

    // Each call must see its own DOM's heading. If globals leaked,
    // one would match "Alpha" against B's DOM (which only has "Beta") or
    // vice versa and become unreachable.
    expect(resA[0]?.reachable).toBe(true);
    expect(resA[0]?.targetId).toBe("h1");
    expect(resB[0]?.reachable).toBe(true);
    expect(resB[0]?.targetId).toBe("h2");
  }, VALIDATION_TEST_TIMEOUT);

  it("withValidationLock serializes user work around the shared virtual-SR", async () => {
    // Sanity-check the lock primitive itself: work enqueued later runs
    // after work enqueued earlier finishes, even if the earlier work
    // awaits. If the lock didn't hold, both resolvers would race.
    const order: string[] = [];
    const a = withValidationLock(async () => {
      await new Promise((r) => setTimeout(r, 10));
      order.push("a");
    });
    const b = withValidationLock(async () => {
      order.push("b");
    });
    await Promise.all([a, b]);
    expect(order).toEqual(["a", "b"]);
  }, VALIDATION_TEST_TIMEOUT);

  it("returns empty when no findings have validatable targets", async () => {
    const unnamed1 = makeTarget({ id: "b1", kind: "button", name: "" });
    const unnamed2 = makeTarget({ id: "b2", kind: "link", name: "" });
    const html = `<button></button><a href="#"></a>`;
    const dom = new JSDOM(html);
    const state = makeState([unnamed1, unnamed2]);
    const findings = [makeFinding("b1", 30), makeFinding("b2", 40)];

    (globalThis as Record<string, unknown>).window = dom.window;
    (globalThis as Record<string, unknown>).document = dom.window.document;
    try {
      const results = await validateFindings(
        dom.window.document.body,
        state,
        findings,
        { maxTargets: 5, strategy: "semantic" },
      );
      expect(results).toHaveLength(0);
    } finally {
      (globalThis as Record<string, unknown>).window = undefined;
      (globalThis as Record<string, unknown>).document = undefined;
    }
  }, VALIDATION_TEST_TIMEOUT);
});
