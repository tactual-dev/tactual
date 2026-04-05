import { describe, it, expect } from "vitest";
import { computeScores, scoreSeverity } from "./index.js";
import { genericMobileWebSrV0 } from "../profiles/generic-mobile.js";

describe("computeScores", () => {
  it("scores a well-structured, easily reachable target highly", () => {
    const scores = computeScores(
      {
        discoverability: {
          inHeadingStructure: true,
          headingLevel: 1,
          inLandmark: true,
          inControlNavigation: true,
          hasAccessibleName: true,
          hasRole: true,
          searchDiscoverable: true,
          requiresBranchOpen: false,
        },
        reachability: {
          shortestPathCost: 2,
          medianPathCost: 3,
          unrelatedItemsOnPath: 0,
          involvesContextSwitch: false,
          requiresBranchOpen: false,
          totalTargets: 20,
          usesSkipNavigation: true,
        },
        operability: {
          roleCorrect: true,
          stateChangesAnnounced: true,
          focusCorrectAfterActivation: true,
          keyboardCompatible: true,
        },
        recovery: {
          canDismiss: true,
          focusReturnsLogically: true,
          canRelocateContext: true,
          branchesPredictable: true,
        },
        interopRisk: 0,
      },
      genericMobileWebSrV0,
    );

    expect(scores.overall).toBeGreaterThanOrEqual(90);
    expect(scoreSeverity(scores)).toBe("strong");
  });

  it("scores a poorly structured, hard-to-reach target low", () => {
    const scores = computeScores(
      {
        discoverability: {
          inHeadingStructure: false,
          inLandmark: false,
          inControlNavigation: false,
          hasAccessibleName: false,
          hasRole: false,
          searchDiscoverable: false,
          requiresBranchOpen: true,
        },
        reachability: {
          shortestPathCost: 15,
          medianPathCost: 20,
          unrelatedItemsOnPath: 12,
          involvesContextSwitch: true,
          requiresBranchOpen: true,
          totalTargets: 20,
          usesSkipNavigation: false,
        },
        operability: {
          roleCorrect: false,
          stateChangesAnnounced: false,
          focusCorrectAfterActivation: false,
          keyboardCompatible: false,
        },
        recovery: {
          canDismiss: false,
          focusReturnsLogically: false,
          canRelocateContext: false,
          branchesPredictable: false,
        },
        interopRisk: 15,
      },
      genericMobileWebSrV0,
    );

    expect(scores.overall).toBeLessThanOrEqual(30);
    expect(scoreSeverity(scores)).toBe("severe");
  });

  it("applies profile weights correctly", () => {
    const scores = computeScores(
      {
        discoverability: {
          inHeadingStructure: true,
          headingLevel: 2,
          inLandmark: true,
          inControlNavigation: true,
          hasAccessibleName: true,
          hasRole: true,
          searchDiscoverable: false,
          requiresBranchOpen: false,
        },
        reachability: {
          shortestPathCost: 2,
          medianPathCost: 4,
          unrelatedItemsOnPath: 2,
          involvesContextSwitch: false,
          requiresBranchOpen: false,
          totalTargets: 20,
          usesSkipNavigation: true,
        },
        operability: {
          roleCorrect: true,
          stateChangesAnnounced: true,
          focusCorrectAfterActivation: true,
          keyboardCompatible: true,
        },
        recovery: {
          canDismiss: true,
          focusReturnsLogically: true,
          canRelocateContext: true,
          branchesPredictable: true,
        },
        interopRisk: 5,
      },
      genericMobileWebSrV0,
    );

    // Discoverability and reachability together are 70% of the score
    expect(scores.discoverability).toBeGreaterThan(0);
    expect(scores.reachability).toBeGreaterThan(0);
    expect(scores.overall).toBeGreaterThanOrEqual(60);
  });

  it("penalizes interop risk", () => {
    const base = {
      discoverability: {
        inHeadingStructure: true,
        headingLevel: 1,
        inLandmark: true,
        inControlNavigation: true,
        hasAccessibleName: true,
        hasRole: true,
        searchDiscoverable: true,
        requiresBranchOpen: false,
      },
      reachability: {
        shortestPathCost: 2,
        medianPathCost: 3,
        unrelatedItemsOnPath: 0,
        involvesContextSwitch: false,
        requiresBranchOpen: false,
        totalTargets: 20,
        usesSkipNavigation: true,
      },
      operability: {
        roleCorrect: true,
        stateChangesAnnounced: true,
        focusCorrectAfterActivation: true,
        keyboardCompatible: true,
      },
      recovery: {
        canDismiss: true,
        focusReturnsLogically: true,
        canRelocateContext: true,
        branchesPredictable: true,
      },
    };

    const noRisk = computeScores({ ...base, interopRisk: 0 }, genericMobileWebSrV0);
    const highRisk = computeScores({ ...base, interopRisk: 20 }, genericMobileWebSrV0);

    expect(noRisk.overall).toBeGreaterThan(highRisk.overall);
    expect(noRisk.overall - highRisk.overall).toBe(20);
  });
});
