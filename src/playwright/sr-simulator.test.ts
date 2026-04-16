import { describe, it, expect } from "vitest";
import { isLandmarkDemoted, type NestingContext } from "./sr-simulator.js";

const ctx = (overrides: Partial<NestingContext>): NestingContext => ({
  role: "banner",
  nestedInSectioning: false,
  hasExplicitRole: false,
  hasLabel: false,
  ...overrides,
});

describe("isLandmarkDemoted", () => {
  it("explicit role= attribute always wins, even when nested", () => {
    expect(isLandmarkDemoted(ctx({
      role: "banner", nestedInSectioning: true, hasExplicitRole: true,
    }))).toBe(false);
  });

  it("<header> inside <section> loses implicit banner role", () => {
    expect(isLandmarkDemoted(ctx({
      role: "banner", nestedInSectioning: true,
    }))).toBe(true);
  });

  it("<header> at top level keeps banner role", () => {
    expect(isLandmarkDemoted(ctx({
      role: "banner", nestedInSectioning: false,
    }))).toBe(false);
  });

  it("<footer> inside <section> loses contentinfo role", () => {
    expect(isLandmarkDemoted(ctx({
      role: "contentinfo", nestedInSectioning: true,
    }))).toBe(true);
  });

  it("unlabeled <form> is not a landmark", () => {
    expect(isLandmarkDemoted(ctx({
      role: "form", hasLabel: false,
    }))).toBe(true);
  });

  it("labeled <form> IS a landmark", () => {
    expect(isLandmarkDemoted(ctx({
      role: "form", hasLabel: true,
    }))).toBe(false);
  });

  it("unlabeled <section> (region) is not a landmark", () => {
    expect(isLandmarkDemoted(ctx({
      role: "region", hasLabel: false,
    }))).toBe(true);
  });

  it("labeled <section> IS a landmark", () => {
    expect(isLandmarkDemoted(ctx({
      role: "region", hasLabel: true,
    }))).toBe(false);
  });

  it("<main> is never demoted regardless of nesting", () => {
    expect(isLandmarkDemoted(ctx({
      role: "main", nestedInSectioning: true,
    }))).toBe(false);
  });

  it("<nav> is not subject to header/footer demotion rules", () => {
    expect(isLandmarkDemoted(ctx({
      role: "navigation", nestedInSectioning: true,
    }))).toBe(false);
  });
});
