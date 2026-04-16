import { describe, it, expect } from "vitest";
import { simulateAction, simulateSequence } from "./state-machine.js";
import type { Target } from "../core/types.js";

const t = (overrides: Partial<Target> & { kind: Target["kind"]; role: string }): Target =>
  ({ id: "t1", name: "", requiresBranchOpen: false, ...overrides } as Target);

const withAttrs = (target: Target, attrs: Record<string, string>): Target => {
  return { ...target, _attributeValues: attrs } as Target;
};

describe("simulateAction", () => {
  describe("checkbox", () => {
    it("Space toggles aria-checked from false to true", () => {
      const target = withAttrs(
        t({ kind: "formField", role: "checkbox", name: "Subscribe" }),
        { "aria-checked": "false" },
      );
      const result = simulateAction(target, "Space");
      expect(result.changed).toBe(true);
      expect(result.changes).toEqual([{ attr: "aria-checked", from: "false", to: "true" }]);
    });

    it("Space toggles aria-checked from true to false", () => {
      const target = withAttrs(
        t({ kind: "formField", role: "checkbox", name: "Subscribe" }),
        { "aria-checked": "true" },
      );
      const result = simulateAction(target, "Space");
      expect(result.changed).toBe(true);
      expect(result.changes[0].to).toBe("false");
    });

    it("Enter also toggles (some implementations)", () => {
      const target = withAttrs(
        t({ kind: "formField", role: "checkbox", name: "X" }),
        { "aria-checked": "false" },
      );
      expect(simulateAction(target, "Enter").changed).toBe(true);
    });

    it("ArrowUp does NOT toggle checkbox", () => {
      const target = withAttrs(
        t({ kind: "formField", role: "checkbox", name: "X" }),
        { "aria-checked": "false" },
      );
      expect(simulateAction(target, "ArrowUp").changed).toBe(false);
    });
  });

  describe("switch", () => {
    it("Space toggles aria-checked", () => {
      const target = withAttrs(
        t({ kind: "formField", role: "switch", name: "Notifications" }),
        { "aria-checked": "true" },
      );
      const result = simulateAction(target, "Space");
      expect(result.changes[0].to).toBe("false");
    });
  });

  describe("tri-state menuitemcheckbox", () => {
    it("cycles through false → true → mixed → false via Space", () => {
      const base = t({ kind: "menuItem", role: "menuitemcheckbox", name: "X" });
      const r1 = simulateAction(withAttrs(base, { "aria-checked": "false" }), "Space");
      expect(r1.changes[0].to).toBe("true");
      const r2 = simulateAction(withAttrs(base, { "aria-checked": "true" }), "Space");
      expect(r2.changes[0].to).toBe("mixed");
      const r3 = simulateAction(withAttrs(base, { "aria-checked": "mixed" }), "Space");
      expect(r3.changes[0].to).toBe("false");
    });
  });

  describe("toggle button (aria-pressed)", () => {
    it("Space toggles aria-pressed", () => {
      const target = withAttrs(
        t({ kind: "button", role: "button", name: "Mute" }),
        { "aria-pressed": "false" },
      );
      const result = simulateAction(target, "Space");
      expect(result.changes[0]).toEqual({ attr: "aria-pressed", from: "false", to: "true" });
    });

    it("Enter toggles aria-pressed", () => {
      const target = withAttrs(
        t({ kind: "button", role: "button", name: "Mute" }),
        { "aria-pressed": "true" },
      );
      expect(simulateAction(target, "Enter").changes[0].to).toBe("false");
    });
  });

  describe("disclosure button (aria-expanded)", () => {
    it("Space toggles aria-expanded from false to true", () => {
      const target = withAttrs(
        t({ kind: "button", role: "button", name: "Details" }),
        { "aria-expanded": "false" },
      );
      expect(simulateAction(target, "Space").changes[0].to).toBe("true");
    });

    it("button with neither pressed nor expanded does nothing", () => {
      const target = t({ kind: "button", role: "button", name: "Submit" });
      expect(simulateAction(target, "Space").changed).toBe(false);
    });
  });

  describe("combobox", () => {
    it("Space toggles aria-expanded", () => {
      const target = withAttrs(
        t({ kind: "formField", role: "combobox", name: "Country" }),
        { "aria-expanded": "false" },
      );
      expect(simulateAction(target, "Space").changes[0].to).toBe("true");
    });

    it("ArrowDown opens (always sets to true)", () => {
      const target = withAttrs(
        t({ kind: "formField", role: "combobox", name: "Country" }),
        { "aria-expanded": "false" },
      );
      expect(simulateAction(target, "ArrowDown").changes[0].to).toBe("true");
    });

    it("ArrowDown when already open does nothing", () => {
      const target = withAttrs(
        t({ kind: "formField", role: "combobox", name: "Country" }),
        { "aria-expanded": "true" },
      );
      expect(simulateAction(target, "ArrowDown").changed).toBe(false);
    });
  });

  describe("slider", () => {
    it("ArrowUp increments by default step of 1", () => {
      const target = { ...t({ kind: "formField", role: "slider", name: "Volume" }), _value: "20" } as Target;
      const result = simulateAction(target, "ArrowUp");
      expect(result.changed).toBe(true);
      expect(result.changes[0]).toEqual({ attr: "_value", from: "20", to: "21" });
    });

    it("ArrowDown decrements", () => {
      const target = { ...t({ kind: "formField", role: "slider", name: "Volume" }), _value: "20" } as Target;
      expect(simulateAction(target, "ArrowDown").changes[0].to).toBe("19");
    });

    it("uses aria-valuestep when provided", () => {
      const target = {
        ...withAttrs(t({ kind: "formField", role: "slider", name: "X" }), { "aria-valuestep": "5" }),
        _value: "20",
      } as Target;
      expect(simulateAction(target, "ArrowUp").changes[0].to).toBe("25");
    });

    it("clamps at aria-valuemax", () => {
      const target = {
        ...withAttrs(t({ kind: "formField", role: "slider", name: "X" }), { "aria-valuemax": "100" }),
        _value: "100",
      } as Target;
      expect(simulateAction(target, "ArrowUp").changed).toBe(false);
    });

    it("Home goes to aria-valuemin", () => {
      const target = {
        ...withAttrs(t({ kind: "formField", role: "slider", name: "X" }), { "aria-valuemin": "0" }),
        _value: "50",
      } as Target;
      expect(simulateAction(target, "Home").changes[0].to).toBe("0");
    });

    it("PageUp uses step * 10", () => {
      const target = {
        ...withAttrs(t({ kind: "formField", role: "slider", name: "X" }), { "aria-valuestep": "1" }),
        _value: "20",
      } as Target;
      expect(simulateAction(target, "PageUp").changes[0].to).toBe("30");
    });
  });

  describe("tab", () => {
    it("Space sets aria-selected=true (self-selection)", () => {
      const target = withAttrs(
        t({ kind: "tab", role: "tab", name: "Settings" }),
        { "aria-selected": "false" },
      );
      expect(simulateAction(target, "Space").changes[0].to).toBe("true");
    });
  });

  describe("radio", () => {
    it("Space selects the radio (sets aria-checked=true)", () => {
      const target = withAttrs(
        t({ kind: "formField", role: "radio", name: "Option A" }),
        { "aria-checked": "false" },
      );
      expect(simulateAction(target, "Space").changes[0].to).toBe("true");
    });
  });

  describe("unmodeled combinations", () => {
    it("unhandled role returns unchanged", () => {
      const target = t({ kind: "button", role: "treeitem", name: "Folder" });
      expect(simulateAction(target, "Space").changed).toBe(false);
    });

    it("unhandled key returns unchanged", () => {
      const target = withAttrs(
        t({ kind: "formField", role: "checkbox", name: "X" }),
        { "aria-checked": "false" },
      );
      expect(simulateAction(target, "Escape").changed).toBe(false);
    });
  });
});

describe("simulateSequence", () => {
  it("cycles tri-state via three Space presses", () => {
    const start = { ...t({ kind: "menuItem", role: "menuitemcheckbox", name: "X" }),
                    _attributeValues: { "aria-checked": "false" } } as Target;
    const result = simulateSequence(start, ["Space", "Space", "Space"]);
    expect(result.changed).toBe(true);
    expect(result.changes).toHaveLength(3);
    // After three cycles: false → true → mixed → false
    const finalAttrs = (result.target as Record<string, unknown>)._attributeValues as Record<string, string>;
    expect(finalAttrs["aria-checked"]).toBe("false");
  });

  it("accumulates slider increments", () => {
    const start = { ...t({ kind: "formField", role: "slider", name: "V" }), _value: "0" } as Target;
    const result = simulateSequence(start, ["ArrowUp", "ArrowUp", "ArrowUp"]);
    const finalValue = (result.target as Record<string, unknown>)._value;
    expect(finalValue).toBe("3");
  });
});
