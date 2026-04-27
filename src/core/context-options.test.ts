import { describe, it, expect } from "vitest";
import {
  buildLaunchOptions,
  buildContextOptions,
  STEALTH_USER_AGENT,
} from "./context-options.js";

const fakePw = {
  devices: {
    "iPhone 14": {
      userAgent: "iphone-ua",
      viewport: { width: 390, height: 844 },
      deviceScaleFactor: 3,
      isMobile: true,
      hasTouch: true,
    },
  } as Record<string, Record<string, unknown>>,
};

describe("buildLaunchOptions", () => {
  it("defaults headless to true", () => {
    expect(buildLaunchOptions({})).toEqual({ headless: true });
  });

  it("respects explicit headless=false", () => {
    expect(buildLaunchOptions({ headless: false })).toEqual({ headless: false });
  });

  it("passes channel through", () => {
    expect(buildLaunchOptions({ channel: "chrome" })).toEqual({
      headless: true,
      channel: "chrome",
    });
  });

  it("omits channel when undefined (Playwright rejects falsy channel)", () => {
    const result = buildLaunchOptions({});
    expect("channel" in result).toBe(false);
  });
});

describe("buildContextOptions", () => {
  it("produces empty options for a bare input", () => {
    const { options, error } = buildContextOptions({}, fakePw);
    expect(error).toBeUndefined();
    expect(options).toEqual({});
  });

  it("populates full stealth quadruple (UA + viewport + locale + timezone)", () => {
    const { options } = buildContextOptions({ stealth: true }, fakePw);
    // Earlier drift: some callers only set userAgent+viewport+locale, missing
    // timezone. We now always include timezone so stealth is uniform.
    expect(options.userAgent).toBe(STEALTH_USER_AGENT);
    expect(options.viewport).toEqual({ width: 1440, height: 900 });
    expect(options.locale).toBe("en-US");
    expect(options.timezoneId).toBe("America/New_York");
  });

  it("explicit userAgent overrides stealth UA", () => {
    const { options } = buildContextOptions(
      { stealth: true, userAgent: "custom-agent" },
      fakePw,
    );
    expect(options.userAgent).toBe("custom-agent");
    expect(options.viewport).toEqual({ width: 1440, height: 900 });
  });

  it("device emulation merges device descriptor onto options", () => {
    const { options } = buildContextOptions({ device: "iPhone 14" }, fakePw);
    expect(options.userAgent).toBe("iphone-ua");
    expect(options.isMobile).toBe(true);
  });

  it("returns an error for unknown devices without throwing", () => {
    const { error } = buildContextOptions({ device: "Nokia 3310" }, fakePw);
    expect(error).toMatch(/Unknown device: Nokia 3310/);
  });

  it("passes storageState through unchanged when not cwd-restricted", () => {
    const { options, error } = buildContextOptions(
      { storageState: "../outside.json" },
      fakePw,
    );
    expect(error).toBeUndefined();
    expect(options.storageState).toBe("../outside.json");
  });

  it("rejects storageState outside cwd when restrictStorageStateToCwd is true", () => {
    const { error } = buildContextOptions(
      { storageState: "../outside.json", restrictStorageStateToCwd: true },
      fakePw,
    );
    expect(error).toMatch(/within the current working directory/);
  });

  it("accepts a cwd-relative storageState under restriction (resolving to absolute)", () => {
    const { options, error } = buildContextOptions(
      { storageState: "tactual-auth.json", restrictStorageStateToCwd: true },
      fakePw,
    );
    expect(error).toBeUndefined();
    expect(typeof options.storageState).toBe("string");
    // Must be resolved to absolute — that's what we store for Playwright.
    expect(options.storageState).toMatch(/tactual-auth\.json$/);
  });
});
