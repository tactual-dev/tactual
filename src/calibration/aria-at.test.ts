import { describe, it, expect } from "vitest";
import { compareSimulatorToAriaAt, type AriaAtCase } from "./aria-at.js";
import type { Target } from "../core/types.js";

const target = (overrides: Partial<Target> & { kind: Target["kind"]; role: string }): Target =>
  ({ id: "t1", name: "", requiresBranchOpen: false, ...overrides } as Target);

describe("compareSimulatorToAriaAt", () => {
  it("returns 100% coverage when all predictions match", () => {
    const cases: AriaAtCase[] = [
      {
        pattern: "button",
        at: "nvda",
        atVersion: "2024.4",
        browser: "Firefox 122",
        command: "Read element",
        actualOutput: "Submit, button",
        target: target({ kind: "button", role: "button", name: "Submit" }),
      },
    ];
    const summary = compareSimulatorToAriaAt(cases);
    expect(summary.matched).toBe(1);
    expect(summary.mismatched).toBe(0);
    expect(summary.coverage).toBe(1);
    expect(summary.byAT.nvda.matched).toBe(1);
  });

  it("flags a mismatch when prediction text isn't in actual output", () => {
    const cases: AriaAtCase[] = [
      {
        pattern: "checkbox",
        at: "nvda",
        atVersion: "2024.4",
        browser: "Firefox 122",
        command: "Read element",
        // AT actually said "checkbox checked" without the name
        actualOutput: "checkbox checked",
        target: target({
          kind: "formField", role: "checkbox", name: "Subscribe",
          _attributeValues: { "aria-checked": "true" },
        } as Partial<Target> & { kind: Target["kind"]; role: string }),
      },
    ];
    const summary = compareSimulatorToAriaAt(cases);
    expect(summary.matched).toBe(0);
    expect(summary.mismatched).toBe(1);
    expect(summary.coverage).toBe(0);
    expect(summary.mismatches[0].predicted).toBe("Subscribe, check box, checked");
  });

  it("matches when AT output contains extra surrounding context", () => {
    const cases: AriaAtCase[] = [
      {
        pattern: "link",
        at: "nvda",
        atVersion: "2024.4",
        browser: "Firefox 122",
        command: "Read element",
        // AT output includes a "visited" annotation we don't simulate
        actualOutput: "Home, link, visited",
        target: target({ kind: "link", role: "link", name: "Home" }),
      },
    ];
    const summary = compareSimulatorToAriaAt(cases);
    // "Home" and "link" are both in the actual output, so this matches
    expect(summary.matched).toBe(1);
  });

  it("aggregates by AT", () => {
    const cases: AriaAtCase[] = [
      {
        pattern: "button", at: "nvda", atVersion: "2024.4",
        browser: "FF", command: "Read",
        actualOutput: "Save, button",
        target: target({ kind: "button", role: "button", name: "Save" }),
      },
      {
        pattern: "textbox", at: "voiceover", atVersion: "10",
        browser: "Safari", command: "Read",
        actualOutput: "Email, text field",
        target: target({ kind: "formField", role: "textbox", name: "Email" }),
      },
      {
        pattern: "textbox", at: "nvda", atVersion: "2024.4",
        browser: "FF", command: "Read",
        // Mismatch: AT didn't include the role
        actualOutput: "Email",
        target: target({ kind: "formField", role: "textbox", name: "Email" }),
      },
    ];
    const summary = compareSimulatorToAriaAt(cases);
    expect(summary.byAT.nvda).toEqual({ matched: 1, mismatched: 1 });
    expect(summary.byAT.voiceover).toEqual({ matched: 1, mismatched: 0 });
  });

  it("handles empty input", () => {
    const summary = compareSimulatorToAriaAt([]);
    expect(summary.totalCases).toBe(0);
    expect(summary.coverage).toBe(0);
  });
});
