import { describe, it, expect, afterEach } from "vitest";
import {
  loadConfig,
  mergeConfigWithFlags,
  configToFilter,
  type TactualConfig,
} from "./config.js";
import { writeFileSync, unlinkSync, mkdtempSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

// ---------------------------------------------------------------------------
// Temp file management
// ---------------------------------------------------------------------------

const tempFiles: string[] = [];

function writeTempConfig(content: string): string {
  const dir = mkdtempSync(join(tmpdir(), "tactual-config-test-"));
  const path = join(dir, "tactual.json");
  writeFileSync(path, content, "utf-8");
  tempFiles.push(path);
  return path;
}

afterEach(() => {
  for (const f of tempFiles) {
    try {
      unlinkSync(f);
    } catch {
      // ignore cleanup errors
    }
  }
  tempFiles.length = 0;
});

// ---------------------------------------------------------------------------
// loadConfig tests
// ---------------------------------------------------------------------------

describe("loadConfig", () => {
  it("returns empty object with no config file", () => {
    // loadConfig with no path auto-detects from CWD.
    // Calling loadConfig() without an explicit path in a dir without tactual.json:
    const result = loadConfig();
    // If no config file found at CWD, it returns {}
    expect(result).toBeDefined();
    expect(typeof result).toBe("object");
  });

  it("throws for explicit path that does not exist", () => {
    expect(() => loadConfig("/nonexistent/path/tactual.json")).toThrow();
  });

  it("throws for malformed JSON", () => {
    const path = writeTempConfig("{invalid json}");
    expect(() => loadConfig(path)).toThrow();
  });

  it("loads valid JSON config", () => {
    const path = writeTempConfig(
      JSON.stringify({ profile: "nvda-desktop-v0", threshold: 70 }),
    );
    const config = loadConfig(path);
    expect(config.profile).toBe("nvda-desktop-v0");
    expect(config.threshold).toBe(70);
  });

  it("preserves unknown fields without crashing", () => {
    const path = writeTempConfig(
      JSON.stringify({ unknownField: true, profile: "nvda-desktop-v0" }),
    );
    const config = loadConfig(path);
    expect(config.profile).toBe("nvda-desktop-v0");
    // Unknown field passes through (no validation strip)
    expect((config as Record<string, unknown>).unknownField).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// mergeConfigWithFlags tests
// ---------------------------------------------------------------------------

describe("mergeConfigWithFlags", () => {
  it("CLI overrides config", () => {
    const config: TactualConfig = { profile: "nvda-desktop-v0" };
    const flags: Partial<TactualConfig> = { profile: "jaws-desktop-v0" };
    const merged = mergeConfigWithFlags(config, flags);
    expect(merged.profile).toBe("jaws-desktop-v0");
  });

  it("undefined flags do not override", () => {
    const config: TactualConfig = { threshold: 70 };
    const flags: Partial<TactualConfig> = { threshold: undefined };
    const merged = mergeConfigWithFlags(config, flags);
    expect(merged.threshold).toBe(70);
  });

  it("arrays merge (do not replace) for exclude", () => {
    const config: TactualConfig = { exclude: ["foo"] };
    const flags: Partial<TactualConfig> = { exclude: ["bar"] };
    const merged = mergeConfigWithFlags(config, flags);
    expect(merged.exclude).toEqual(["foo", "bar"]);
  });

  it("focus merges like other arrays", () => {
    const config: TactualConfig = { focus: ["main"] };
    const flags: Partial<TactualConfig> = { focus: ["nav"] };
    const merged = mergeConfigWithFlags(config, flags);
    expect(merged.focus).toEqual(["main", "nav"]);
  });

  it("arrays merge for excludeSelectors", () => {
    const config: TactualConfig = { excludeSelectors: [".ad"] };
    const flags: Partial<TactualConfig> = { excludeSelectors: [".banner"] };
    const merged = mergeConfigWithFlags(config, flags);
    expect(merged.excludeSelectors).toEqual([".ad", ".banner"]);
  });

  it("arrays merge for suppress", () => {
    const config: TactualConfig = { suppress: ["diag-1"] };
    const flags: Partial<TactualConfig> = { suppress: ["diag-2"] };
    const merged = mergeConfigWithFlags(config, flags);
    expect(merged.suppress).toEqual(["diag-1", "diag-2"]);
  });

  it("threshold edge values are preserved (no clamping)", () => {
    const base: TactualConfig = {};

    const merged0 = mergeConfigWithFlags(base, { threshold: 0 });
    expect(merged0.threshold).toBe(0);

    const merged100 = mergeConfigWithFlags(base, { threshold: 100 });
    expect(merged100.threshold).toBe(100);

    const mergedNeg = mergeConfigWithFlags(base, { threshold: -1 });
    expect(mergedNeg.threshold).toBe(-1);
  });
});

// ---------------------------------------------------------------------------
// configToFilter tests
// ---------------------------------------------------------------------------

describe("configToFilter", () => {
  it("produces valid filter from full config", () => {
    const config: TactualConfig = {
      exclude: ["banner*"],
      excludeSelectors: [".ad"],
      focus: ["main"],
      suppress: ["redirect-detected"],
      priority: { "btn-*": "critical" },
      threshold: 80,
      maxFindings: 20,
      minSeverity: "moderate",
    };

    const filter = configToFilter(config);
    expect(filter.exclude).toEqual(["banner*"]);
    expect(filter.excludeSelectors).toEqual([".ad"]);
    expect(filter.focus).toEqual(["main"]);
    expect(filter.suppress).toEqual(["redirect-detected"]);
    expect(filter.priority).toEqual({ "btn-*": "critical" });
    expect(filter.threshold).toBe(80);
    expect(filter.maxFindings).toBe(20);
    expect(filter.minSeverity).toBe("moderate");
  });

  it("handles empty config without crashing", () => {
    const filter = configToFilter({});
    expect(filter).toBeDefined();
    expect(filter.exclude).toBeUndefined();
    expect(filter.excludeSelectors).toBeUndefined();
    expect(filter.focus).toBeUndefined();
    expect(filter.suppress).toBeUndefined();
    expect(filter.threshold).toBeUndefined();
    expect(filter.maxFindings).toBeUndefined();
    expect(filter.minSeverity).toBeUndefined();
  });
});
