import { describe, expect, it } from "vitest";
import { createExplorationNoNewStatesDiagnostic } from "./analyze-url.js";

const oneState = [{ id: "state-1" }] as never;

describe("createExplorationNoNewStatesDiagnostic", () => {
  it("returns null when exploration captured a new state", () => {
    const diagnostic = createExplorationNoNewStatesDiagnostic({
      states: [{ id: "state-1" }, { id: "state-2" }] as never,
      actionsPerformed: 1,
      branchesExplored: 1,
      skippedUnsafe: 0,
      skippedBudget: 0,
    }, 30);

    expect(diagnostic).toBeNull();
  });

  it("explains when safety blocked all candidates", () => {
    const diagnostic = createExplorationNoNewStatesDiagnostic({
      states: oneState,
      actionsPerformed: 0,
      branchesExplored: 0,
      skippedUnsafe: 3,
      skippedBudget: 0,
    }, 30);

    expect(diagnostic?.code).toBe("exploration-no-new-states");
    expect(diagnostic?.level).toBe("warning");
    expect(diagnostic?.message).toContain("no-safe-targets");
  });

  it("explains when actions ran but no novel state converged", () => {
    const diagnostic = createExplorationNoNewStatesDiagnostic({
      states: oneState,
      actionsPerformed: 2,
      branchesExplored: 2,
      skippedUnsafe: 0,
      skippedBudget: 0,
    }, 30);

    expect(diagnostic?.message).toContain("convergence-missed");
  });

  it("explains when exploration consumed its budget without adding states", () => {
    const diagnostic = createExplorationNoNewStatesDiagnostic({
      states: oneState,
      actionsPerformed: 30,
      branchesExplored: 30,
      skippedUnsafe: 0,
      skippedBudget: 1,
    }, 30);

    expect(diagnostic?.message).toContain("budget-exhausted-on-repeats");
  });

  it("explains when no branch work was attempted", () => {
    const diagnostic = createExplorationNoNewStatesDiagnostic({
      states: oneState,
      actionsPerformed: 0,
      branchesExplored: 0,
      skippedUnsafe: 0,
      skippedBudget: 0,
    }, 30);

    expect(diagnostic?.message).toContain("explore-not-attempted");
  });
});
