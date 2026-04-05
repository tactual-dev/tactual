import { describe, it, expect } from "vitest";
import {
  findMatchingTargets,
  globToRegex,
  modelAnnouncement,
  SR_ROLE_MAP,
} from "./trace-helpers.js";
import type { Target } from "../core/types.js";

// ---------------------------------------------------------------------------
// Test data factory
// ---------------------------------------------------------------------------

function makeTarget(overrides: Partial<Target> & { id: string; name: string; role: string }): Target {
  return {
    kind: "other",
    requiresBranchOpen: false,
    ...overrides,
  };
}

const STATES = [
  {
    id: "root",
    targets: [
      makeTarget({ id: "btn:submit", name: "Submit", role: "button" }),
      makeTarget({ id: "link:home", name: "Home", role: "link" }),
      makeTarget({ id: "combobox:search", name: "Search", role: "combobox" }),
      makeTarget({ id: "nav:main", name: "(unnamed)", role: "navigation" }),
    ],
  },
  {
    id: "menu-branch",
    targets: [
      makeTarget({ id: "menuitem:file", name: "File", role: "menuitem" }),
      makeTarget({ id: "menuitem:edit", name: "Edit", role: "menuitem" }),
    ],
  },
];

// ---------------------------------------------------------------------------
// findMatchingTargets
// ---------------------------------------------------------------------------

describe("findMatchingTargets", () => {
  it("matches by exact ID", () => {
    const result = findMatchingTargets(STATES, "btn:submit");
    expect(result).toHaveLength(1);
    expect(result[0].target.id).toBe("btn:submit");
    expect(result[0].stateId).toBe("root");
  });

  it("matches by exact ID case-insensitively", () => {
    const result = findMatchingTargets(STATES, "BTN:SUBMIT");
    expect(result).toHaveLength(1);
    expect(result[0].target.id).toBe("btn:submit");
  });

  it("matches by glob pattern on name", () => {
    const result = findMatchingTargets(STATES, "*search*");
    expect(result).toHaveLength(1);
    expect(result[0].target.name).toBe("Search");
  });

  it("matches by glob pattern on ID", () => {
    const result = findMatchingTargets(STATES, "menuitem:*");
    expect(result).toHaveLength(2);
    expect(result.map((m) => m.target.name).sort()).toEqual(["Edit", "File"]);
  });

  it("matches by glob with ? wildcard", () => {
    const result = findMatchingTargets(STATES, "link:hom?");
    expect(result).toHaveLength(1);
    expect(result[0].target.id).toBe("link:home");
  });

  it("returns empty for no match", () => {
    const result = findMatchingTargets(STATES, "nonexistent");
    expect(result).toHaveLength(0);
  });

  it("searches across multiple states", () => {
    const result = findMatchingTargets(STATES, "*:*");
    expect(result.length).toBe(6); // all targets have : in ID
  });

  it("matches role via glob", () => {
    const result = findMatchingTargets(STATES, "*combobox*");
    expect(result).toHaveLength(1);
    expect(result[0].target.role).toBe("combobox");
  });
});

// ---------------------------------------------------------------------------
// globToRegex
// ---------------------------------------------------------------------------

describe("globToRegex", () => {
  it("converts * to .*", () => {
    const regex = globToRegex("*.js");
    expect(regex.test("file.js")).toBe(true);
    expect(regex.test("file.ts")).toBe(false);
  });

  it("converts ? to single char", () => {
    const regex = globToRegex("test?");
    expect(regex.test("test1")).toBe(true);
    expect(regex.test("test")).toBe(false);
    expect(regex.test("test12")).toBe(false);
  });

  it("escapes regex special chars", () => {
    const regex = globToRegex("file.name");
    expect(regex.test("file.name")).toBe(true);
    expect(regex.test("filexname")).toBe(false);
  });

  it("is case-insensitive", () => {
    const regex = globToRegex("Submit*");
    expect(regex.test("submit")).toBe(true);
    expect(regex.test("SUBMIT_FORM")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// modelAnnouncement
// ---------------------------------------------------------------------------

describe("modelAnnouncement", () => {
  it("announces headings", () => {
    expect(modelAnnouncement("nextHeading", "heading", "Introduction")).toBe(
      "Introduction, heading",
    );
  });

  it("announces unnamed headings", () => {
    expect(modelAnnouncement("nextHeading", "heading", "(unnamed)")).toBe(
      "heading",
    );
  });

  it("announces button activation", () => {
    expect(modelAnnouncement("activate", "button", "Submit")).toBe(
      "Activated: Submit",
    );
  });

  it("announces unnamed activation", () => {
    expect(modelAnnouncement("activate", "button", "(unnamed)")).toBe(
      "Activated button",
    );
  });

  it("announces dismiss", () => {
    expect(modelAnnouncement("dismiss", "dialog", "Settings")).toBe(
      "Dismissed dialog",
    );
  });

  it("announces nextLink", () => {
    expect(modelAnnouncement("nextLink", "link", "Home")).toBe("Home, link");
  });

  it("announces unnamed link", () => {
    expect(modelAnnouncement("nextLink", "link", "(unnamed)")).toBe("link");
  });

  it("announces nextControl with mapped role", () => {
    expect(modelAnnouncement("nextControl", "checkbox", "Accept terms")).toBe(
      "Accept terms, checkbox",
    );
  });

  it("announces find action", () => {
    expect(modelAnnouncement("find", "textbox", "Email")).toBe(
      "Found: Email, edit text",
    );
  });

  it("announces group entry", () => {
    expect(modelAnnouncement("groupEntry", "navigation", "Main menu")).toBe(
      "Entered Main menu",
    );
  });

  it("announces group exit", () => {
    expect(modelAnnouncement("groupExit", "navigation", "Main menu")).toBe(
      "Exited Main menu",
    );
  });

  it("falls through to default for unknown actions", () => {
    expect(modelAnnouncement("unknownAction", "button", "Click me")).toBe(
      "Click me, button",
    );
  });

  it("uses SR_ROLE_MAP for role names", () => {
    expect(modelAnnouncement("nextItem", "combobox", "Search")).toBe(
      "Search, combo box",
    );
    expect(modelAnnouncement("nextItem", "menuitem", "File")).toBe(
      "File, menu item",
    );
  });
});

// ---------------------------------------------------------------------------
// SR_ROLE_MAP coverage
// ---------------------------------------------------------------------------

describe("SR_ROLE_MAP", () => {
  it("maps common ARIA roles", () => {
    expect(SR_ROLE_MAP.button).toBe("button");
    expect(SR_ROLE_MAP.link).toBe("link");
    expect(SR_ROLE_MAP.textbox).toBe("edit text");
    expect(SR_ROLE_MAP.checkbox).toBe("checkbox");
    expect(SR_ROLE_MAP.tab).toBe("tab");
    expect(SR_ROLE_MAP.dialog).toBe("dialog");
    expect(SR_ROLE_MAP.navigation).toBe("navigation");
    expect(SR_ROLE_MAP.heading).toBe("heading");
    expect(SR_ROLE_MAP.slider).toBe("slider");
  });

  it("has at least 30 mapped roles", () => {
    expect(Object.keys(SR_ROLE_MAP).length).toBeGreaterThanOrEqual(30);
  });
});
