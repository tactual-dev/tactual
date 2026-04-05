import { describe, it, expect } from "vitest";
import { genericMobileWebSrV0 } from "./generic-mobile.js";
import { getProfile, listProfiles, registerProfile } from "./index.js";
import type { ATProfile } from "./types.js";

describe("profile registry", () => {
  it("registers and retrieves the built-in mobile profile", () => {
    const profile = getProfile("generic-mobile-web-sr-v0");
    expect(profile).toBeDefined();
    expect(profile!.id).toBe("generic-mobile-web-sr-v0");
    expect(profile!.platform).toBe("mobile");
  });

  it("lists registered profiles", () => {
    const ids = listProfiles();
    expect(ids).toContain("generic-mobile-web-sr-v0");
  });

  it("allows registering custom profiles", () => {
    const custom: ATProfile = {
      ...genericMobileWebSrV0,
      id: "test-custom-profile",
      name: "Test Custom",
    };
    registerProfile(custom);
    expect(getProfile("test-custom-profile")).toBeDefined();
  });

  it("returns undefined for unknown profiles", () => {
    expect(getProfile("nonexistent")).toBeUndefined();
  });
});

describe("generic-mobile-web-sr-v0", () => {
  it("has costs for all navigation actions", () => {
    const actions = [
      "nextItem", "previousItem", "nextHeading", "nextLink",
      "nextControl", "activate", "dismiss", "back",
      "find", "groupEntry", "groupExit",
    ] as const;

    for (const action of actions) {
      expect(genericMobileWebSrV0.actionCosts[action]).toBeGreaterThan(0);
    }
  });

  it("weights sum to 1.0", () => {
    const w = genericMobileWebSrV0.weights;
    const sum = w.discoverability + w.reachability + w.operability + w.recovery;
    expect(sum).toBeCloseTo(1.0);
  });

  it("emphasizes discoverability and reachability", () => {
    const w = genericMobileWebSrV0.weights;
    expect(w.discoverability + w.reachability).toBeGreaterThanOrEqual(0.7);
  });

  it("has modifiers with valid conditions", () => {
    expect(genericMobileWebSrV0.modifiers.length).toBeGreaterThan(0);
    for (const mod of genericMobileWebSrV0.modifiers) {
      expect(mod.multiplier).toBeGreaterThan(0);
      expect(mod.reason.length).toBeGreaterThan(0);
    }
  });
});
