import { describe, it, expect } from "vitest";
import { computeInteropRisk, roleInteropRisk, attributeInteropRisk } from "./interop.js";

describe("computeInteropRisk", () => {
  it("returns 0 risk for well-supported roles", () => {
    const wellSupported = ["button", "link", "heading", "textbox", "checkbox", "radio", "main", "navigation"];
    for (const role of wellSupported) {
      const result = computeInteropRisk(role);
      expect(result.risk).toBeLessThanOrEqual(1);
      expect(result.issues.length).toBe(result.risk > 0 ? 1 : 0);
    }
  });

  it("returns moderate risk for dialog", () => {
    const result = computeInteropRisk("dialog");
    expect(result.risk).toBe(5);
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0]).toContain("Focus management");
  });

  it("returns high risk for combobox", () => {
    const result = computeInteropRisk("combobox");
    expect(result.risk).toBe(8);
    expect(result.issues[0]).toContain("verify critical flows");
  });

  it("returns high risk for tree", () => {
    const result = computeInteropRisk("tree");
    expect(result.risk).toBe(10);
  });

  it("returns very high risk for application role", () => {
    const result = computeInteropRisk("application");
    expect(result.risk).toBe(15);
    expect(result.issues[0]).toContain("dangerous");
  });

  it("returns very high risk for treegrid", () => {
    const result = computeInteropRisk("treegrid");
    expect(result.risk).toBe(12);
  });

  it("returns 0 for unknown roles", () => {
    const result = computeInteropRisk("customwidget");
    expect(result.risk).toBe(0);
    expect(result.issues).toHaveLength(0);
  });

  it("handles all moderate-risk roles", () => {
    const moderateRoles = [
      { role: "switch", minRisk: 3 },
      { role: "slider", minRisk: 4 },
      { role: "spinbutton", minRisk: 4 },
      { role: "listbox", minRisk: 4 },
      { role: "alertdialog", minRisk: 5 },
      { role: "feed", minRisk: 7 },
      { role: "grid", minRisk: 8 },
    ];
    for (const { role, minRisk } of moderateRoles) {
      const result = computeInteropRisk(role);
      expect(result.risk, `${role} risk should be >= ${minRisk}`).toBeGreaterThanOrEqual(minRisk);
      expect(result.issues.length, `${role} should have issues`).toBeGreaterThan(0);
      expect(result.issues[0]).toContain(role);
    }
  });

  it("handles tab-related roles", () => {
    const tabResult = computeInteropRisk("tab");
    expect(tabResult.risk).toBe(3);
    const tabpanelResult = computeInteropRisk("tabpanel");
    expect(tabpanelResult.risk).toBe(3);
  });

  it("handles menu-related roles", () => {
    const menuResult = computeInteropRisk("menu");
    expect(menuResult.risk).toBe(4);
    const menuitemResult = computeInteropRisk("menuitem");
    expect(menuitemResult.risk).toBe(4);
  });

  it("caps risk at 20", () => {
    // Even the worst single role should not exceed 20
    for (const role of Object.keys(roleInteropRisk)) {
      const result = computeInteropRisk(role);
      expect(result.risk).toBeLessThanOrEqual(20);
    }
  });
});

describe("roleInteropRisk", () => {
  it("has entries for common interactive roles", () => {
    const expected = ["button", "link", "dialog", "menu", "tab", "combobox", "slider"];
    for (const role of expected) {
      expect(roleInteropRisk[role]).toBeDefined();
    }
  });

  it("includes affected combos for risky roles", () => {
    const risky = Object.entries(roleInteropRisk).filter(([_, v]) => v.risk >= 4);
    for (const [role, entry] of risky) {
      expect(entry.affectedCombos, `${role} should have affected combos`).toBeDefined();
      expect(entry.affectedCombos!.length).toBeGreaterThan(0);
    }
  });
});

describe("attributeInteropRisk", () => {
  it("has entries for key ARIA attributes", () => {
    const expected = ["aria-live", "aria-errormessage", "aria-description"];
    for (const attr of expected) {
      expect(attributeInteropRisk[attr]).toBeDefined();
    }
  });

  it("flags aria-errormessage as high risk", () => {
    expect(attributeInteropRisk["aria-errormessage"].risk).toBeGreaterThanOrEqual(8);
  });

  it("flags aria-keyshortcuts as high risk", () => {
    expect(attributeInteropRisk["aria-keyshortcuts"].risk).toBeGreaterThanOrEqual(10);
  });
});
