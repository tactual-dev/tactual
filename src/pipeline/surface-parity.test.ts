/**
 * Surface-parity contract tests.
 *
 * Locks in the CLI / MCP / Action parameter alignment achieved by the
 * surface-unification refactor. If a future PR adds a CLI flag without
 * the matching MCP field or Action input, one of these tests fails and
 * points the author at what to do.
 *
 * Intentionally tolerant about:
 *   - Command-local tools that don't exist on every surface (benchmark,
 *     init, presets, profiles, transcript are CLI-only by design;
 *     list_profiles is MCP-only).
 *   - Known per-surface drift that is intentional (e.g., includeStates
 *     is MCP-only, preset/config/quiet/userAgent/alsoJson are CLI-only).
 *
 * Tightening this later is easy: shrink the allow-list as more surfaces
 * close their gaps.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

function readCliSource(file: string): string {
  return readFileSync(resolve("src/cli/commands", file), "utf-8");
}

function readMcpSource(file: string): string {
  return readFileSync(resolve("src/mcp/tools", file), "utf-8");
}

function readActionYml(): string {
  return readFileSync(resolve("action.yml"), "utf-8");
}

/** Extract `--kebab-case` option names from a CLI command file. */
function extractCliFlags(source: string): Set<string> {
  const out = new Set<string>();
  // Matches `.option("-p, --profile <id>", ...)` or `.option("--flag", ...)`.
  const re = /\.option\(\s*"(?:-[a-z],\s*)?(--[a-z][a-z0-9-]*)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source))) out.add(m[1].slice(2));
  return out;
}

/** Extract Zod `inputSchema: { name: z... }` keys from an MCP tool file. */
function extractMcpFields(source: string): Set<string> {
  const out = new Set<string>();
  // Find the inputSchema: { ... } object and pull the top-level keys.
  const schemaMatch = source.match(/inputSchema:\s*\{([\s\S]*?)\n\s{6}\}/);
  if (!schemaMatch) return out;
  const body = schemaMatch[1];
  // Match `keyName: z` where `z` may be followed by `.` (same line) or a
  // newline (multi-line Zod declarations). Previously only the same-line
  // form was matched, so multi-line fields were missed.
  const keyRe = /^\s{8}([a-zA-Z][a-zA-Z0-9]*):\s*z(?:$|[\s.])/gm;
  let m: RegExpExecArray | null;
  while ((m = keyRe.exec(body))) out.add(m[1]);
  return out;
}

/** Positional arguments aren't flags — excluded from flag-parity checks. */
const POSITIONAL_ARGS = new Set(["url", "urls", "target", "analysis", "baseline", "candidate"]);

/** Extract input names from action.yml (top-level under `inputs:`). */
function extractActionInputs(): Set<string> {
  const source = readActionYml();
  const out = new Set<string>();
  // Match the inputs: block, then any two-space-indented key ending with colon.
  const inputsMatch = source.match(/^inputs:\s*\n([\s\S]*?)\n(?:outputs|runs):/m);
  if (!inputsMatch) return out;
  const body = inputsMatch[1];
  const re = /^\s{2}([a-z][a-z0-9-]*):\s*$/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body))) out.add(m[1]);
  return out;
}

/** Convert camelCase to kebab-case. */
function kebab(s: string): string {
  return s.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
}

// ---------------------------------------------------------------------------
// analyze-url — the biggest surface
// ---------------------------------------------------------------------------

describe("analyze-url surface parity", () => {
  const cliFlags = extractCliFlags(readCliSource("analyze-url.ts"));
  const mcpFields = extractMcpFields(readMcpSource("analyze-url.ts"));
  const actionInputs = extractActionInputs();

  /**
   * CLI-only flags that MCP intentionally lacks. Each has a reason
   * described inline below.
   */
  const CLI_ONLY = new Set([
    // Output-file write & stdout control — MCP returns text in-band.
    "output",
    "also-json",
    // Human UX — MCP has no TTY to target.
    "quiet",
    // Preset+config-merge layer that only makes sense for file-driven CLI runs.
    "preset",
    "config",
    // MCP validation is a dedicated tool (validate_url), not an inline flag.
    "validate",
    "validate-max-targets",
    "validate-strategy",
    // Threshold is MCP-neutral; analyze_url returns the score and callers gate.
    "threshold",
    // MCP always headless.
    "no-headless",
    // User-agent override: low-value on MCP (agents run headless anyway).
    "user-agent",
    // commander --no-X negation syntax. `check-visibility` is the positive
    // form that pairs with MCP/action; `--no-check-visibility` is just the
    // CLI override path (same as --no-headless above).
    "no-check-visibility",
    // Diagnostic suppression is a filter knob; MCP uses minSeverity/exclude.
    "suppress",
    // Baseline diff + regression gate are CI-oriented. An LLM calling
    // analyze_url already has the current result and can compare itself.
    "baseline",
    "fail-on-regression",
  ]);

  /** MCP-only fields with no CLI peer — MCP-specific data shape. */
  const MCP_ONLY = new Set([
    // Compact states passed to trace_path later.
    "includeStates",
  ]);

  /** Action-only inputs that don't correspond to any CLI flag. */
  const ACTION_ONLY_ERGONOMICS = new Set([
    "node-version",
    "comment-on-pr",
    "fail-below", // wraps CLI --threshold via a separate step
    "headless", // mapped to --no-headless
  ]);

  it("every MCP input has a CLI flag (after kebab-normalization), except explicit MCP-only", () => {
    const missing: string[] = [];
    for (const field of mcpFields) {
      if (MCP_ONLY.has(field)) continue;
      if (POSITIONAL_ARGS.has(field)) continue;
      const flagName = kebab(field);
      // Known name aliases: MCP uses `maxFindings`, CLI uses `--top`.
      if (flagName === "max-findings" && cliFlags.has("top")) continue;
      if (!cliFlags.has(flagName)) missing.push(`${field} (expected --${flagName})`);
    }
    expect(missing).toEqual([]);
  });

  it("every CLI flag has an MCP field or is explicitly CLI-only", () => {
    const missing: string[] = [];
    for (const flag of cliFlags) {
      if (CLI_ONLY.has(flag)) continue;
      // Derive the expected camelCase key; `--top` maps to `maxFindings`.
      const expected = flag === "top" ? "maxFindings" : camel(flag);
      if (!mcpFields.has(expected)) missing.push(`${flag} (expected field ${expected})`);
    }
    expect(missing).toEqual([]);
  });

  it("every CLI flag has an Action input or is CLI-only (Action is CLI passthrough)", () => {
    const missing: string[] = [];
    for (const flag of cliFlags) {
      if (CLI_ONLY.has(flag)) continue;
      // `--top` maps to `max-findings`; `--threshold` maps to `fail-below`;
      // `--no-headless` maps to `headless: false`.
      if (flag === "top" && actionInputs.has("max-findings")) continue;
      if (flag === "threshold" && actionInputs.has("fail-below")) continue;
      if (flag === "no-headless" && actionInputs.has("headless")) continue;
      if (!actionInputs.has(flag)) missing.push(flag);
    }
    expect(missing).toEqual([]);
  });

  it("every Action input maps to a CLI flag or is documented ergonomics-only", () => {
    const missing: string[] = [];
    for (const input of actionInputs) {
      if (ACTION_ONLY_ERGONOMICS.has(input)) continue;
      if (POSITIONAL_ARGS.has(input)) continue;
      if (input === "max-findings" && cliFlags.has("top")) continue;
      if (!cliFlags.has(input)) missing.push(input);
    }
    expect(missing).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// validate-url — CLI name renamed to match MCP
// ---------------------------------------------------------------------------

describe("validate-url surface parity", () => {
  const cliFlags = extractCliFlags(readCliSource("validate.ts"));
  const mcpFields = extractMcpFields(readMcpSource("validate-url.ts"));

  const CLI_ONLY = new Set(["output", "format", "no-headless"]);

  it("every MCP input has a CLI flag", () => {
    const missing: string[] = [];
    for (const field of mcpFields) {
      if (POSITIONAL_ARGS.has(field)) continue;
      const flagName = kebab(field);
      if (!cliFlags.has(flagName)) missing.push(`${field} → --${flagName}`);
    }
    expect(missing).toEqual([]);
  });

  it("every CLI flag has an MCP field or is CLI-only", () => {
    const missing: string[] = [];
    for (const flag of cliFlags) {
      if (CLI_ONLY.has(flag)) continue;
      if (!mcpFields.has(camel(flag))) missing.push(flag);
    }
    expect(missing).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// analyze-pages
// ---------------------------------------------------------------------------

describe("analyze-pages surface parity", () => {
  const cliFlags = extractCliFlags(readCliSource("analyze-pages.ts"));
  const mcpFields = extractMcpFields(readMcpSource("analyze-pages.ts"));

  const CLI_ONLY = new Set(["format"]);

  it("every MCP input has a CLI flag", () => {
    const missing: string[] = [];
    for (const field of mcpFields) {
      if (POSITIONAL_ARGS.has(field)) continue;
      const flagName = kebab(field);
      if (!cliFlags.has(flagName)) missing.push(`${field} → --${flagName}`);
    }
    expect(missing).toEqual([]);
  });

  it("every CLI flag has an MCP field or is CLI-only", () => {
    const missing: string[] = [];
    for (const flag of cliFlags) {
      if (CLI_ONLY.has(flag)) continue;
      if (!mcpFields.has(camel(flag))) missing.push(flag);
    }
    expect(missing).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// trace-path
// ---------------------------------------------------------------------------

describe("trace-path surface parity", () => {
  const cliFlags = extractCliFlags(readCliSource("trace-path.ts"));
  const mcpFields = extractMcpFields(readMcpSource("trace-path.ts"));

  const MCP_ONLY = new Set(["statesJson"]);

  it("every MCP input has a CLI flag, except explicit MCP-only", () => {
    const missing: string[] = [];
    for (const field of mcpFields) {
      if (MCP_ONLY.has(field)) continue;
      if (POSITIONAL_ARGS.has(field)) continue;
      const flagName = kebab(field);
      if (!cliFlags.has(flagName)) missing.push(`${field} → --${flagName}`);
    }
    expect(missing).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// suggest-remediations — name drift locked in
// ---------------------------------------------------------------------------

describe("suggest-remediations surface parity", () => {
  const cliFlags = extractCliFlags(readCliSource("suggest-remediations.ts"));
  const mcpFields = extractMcpFields(readMcpSource("suggest-remediations.ts"));

  it("CLI exposes --max-suggestions (matching MCP maxSuggestions)", () => {
    expect(cliFlags.has("max-suggestions")).toBe(true);
    expect(mcpFields.has("maxSuggestions")).toBe(true);
  });

  it("legacy --max alias preserved", () => {
    expect(cliFlags.has("max")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Tool-name parity — commands line up across surfaces
// ---------------------------------------------------------------------------

describe("tool-name parity", () => {
  it("CLI `validate-url` command exists (renamed from `validate` with alias)", () => {
    const src = readCliSource("validate.ts");
    expect(src).toMatch(/\.command\("validate-url"\)/);
    expect(src).toMatch(/\.alias\("validate"\)/);
  });

  it("CLI `diff-results` command exists (renamed from `diff` with alias)", () => {
    const src = readCliSource("diff.ts");
    expect(src).toMatch(/\.command\("diff-results"\)/);
    expect(src).toMatch(/\.alias\("diff"\)/);
  });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function camel(kebab: string): string {
  return kebab.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
}
