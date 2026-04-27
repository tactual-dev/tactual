import { describe, expect, it } from "vitest";
import type { Target } from "../core/types.js";
import {
  countWidgetProbeResults,
  resolveProbeBudgets,
} from "./probe-helpers.js";

const target = (probeFields: Record<string, unknown>): Target => ({
  id: "target",
  role: "button",
  kind: "button",
  name: "Target",
  requiresBranchOpen: false,
  ...probeFields,
});

describe("probe helpers", () => {
  it("resolves widget budgets alongside generic/menu/modal budgets", () => {
    expect(resolveProbeBudgets("fast", undefined)).toEqual({
      generic: 5,
      menu: 5,
      modal: 3,
      widget: 5,
    });
    expect(resolveProbeBudgets("deep", 7)).toEqual({
      generic: 7,
      menu: 40,
      modal: 20,
      widget: 40,
    });
  });

  it("counts each widget/form probe result as a budget unit", () => {
    expect(countWidgetProbeResults([
      target({ _tabProbe: { probeSucceeded: true } }),
      target({
        _comboboxProbe: { probeSucceeded: true },
        _formErrorProbe: { probeSucceeded: true },
      }),
      target({}),
    ])).toBe(3);
  });
});
