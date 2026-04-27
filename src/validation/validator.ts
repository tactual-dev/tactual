/// <reference lib="dom" />
import type { Finding, PageState, Target } from "../core/types.js";

/**
 * Serializes validation calls across the process. @guidepup/virtual-screen-reader
 * is imported as a module-shared `virtual` object whose internal state is
 * mutated by start()/stop()/perform() — concurrent callers would corrupt
 * each other. On top of that, both entry points (the standalone
 * validate-url pipeline and inline --validate inside analyze-url) swap
 * globalThis.window/document across awaited work; without a lock, an
 * await boundary in call A lets call B set the globals before A has
 * restored them, so A sees B's DOM. The lock closes both races at once.
 */
let _validationLock: Promise<unknown> = Promise.resolve();

export function withValidationLock<T>(fn: () => Promise<T>): Promise<T> {
  const next = _validationLock.then(fn, fn);
  _validationLock = next.catch(() => {});
  return next;
}

/**
 * Run validateFindings against a JSDOM instance with the globalThis swap
 * and the virtual-SR mutation serialized under a process-wide lock.
 * Both the standalone validate-url pipeline and inline --validate
 * should use this rather than hand-rolling the global swap — otherwise
 * concurrent MCP calls can corrupt each other.
 */
export async function validateFindingsInJsdom(
  dom: { window: { document: { body: HTMLElement } } },
  state: PageState,
  findings: Finding[],
  options: ValidationOptions = {},
): Promise<ValidationResult[]> {
  return withValidationLock(async () => {
    const prev = {
      window: (globalThis as Record<string, unknown>).window,
      document: (globalThis as Record<string, unknown>).document,
    };
    (globalThis as Record<string, unknown>).window = dom.window;
    (globalThis as Record<string, unknown>).document = dom.window.document;
    try {
      return await validateFindings(
        dom.window.document.body,
        state,
        findings,
        options,
      );
    } finally {
      (globalThis as Record<string, unknown>).window = prev.window;
      (globalThis as Record<string, unknown>).document = prev.document;
    }
  });
}

export interface ValidationOptions {
  /** Maximum targets to validate (default: 20, worst scores first) */
  maxTargets?: number;
  /** Whether to log navigation steps */
  verbose?: boolean;
  /** Navigation strategy: "linear" uses next(), "semantic" uses heading/landmark commands */
  strategy?: "linear" | "semantic";
}

export interface ValidationResult {
  targetId: string;
  targetName: string;
  /** Number of actions in Tactual's predicted best path */
  predictedCost: number;
  /** Actual steps the virtual SR needed to reach the target */
  actualSteps: number;
  /** Tactual's predicted path description */
  predictedPath: string[];
  /** What the virtual SR actually announced at each step */
  actualAnnouncements: string[];
  /** Whether the target was reachable by the virtual SR */
  reachable: boolean;
  /** Predicted/actual ratio — closer to 1.0 means better calibration */
  accuracy: number;
  /** Navigation strategy used */
  strategy: string;
}

/**
 * Validate Tactual findings against a virtual screen reader.
 *
 * For each finding, navigates through the DOM using virtual SR commands
 * and counts how many steps it actually takes to reach the target.
 * Compares against Tactual's predicted navigation cost.
 *
 * Uses @guidepup/virtual-screen-reader which supports:
 * - Linear navigation: next/previous (equivalent to swipe right/left)
 * - Semantic navigation: moveToNextHeading, moveToNextLandmark,
 *   moveToNextLink (equivalent to rotor/quick keys)
 *
 * Targets that can't be meaningfully matched against SR announcements
 * (unnamed non-structural targets like generic buttons, icons, form fields
 * without labels) are filtered out *before* the worst-N slice — otherwise
 * the top-N would be full of unvalidatable findings and return all-zero
 * results even on healthy pages. The filter's job is "can we write a
 * deterministic matcher for this?", not "is this target important?".
 *
 * This is designed to be called from tests, not from the CLI.
 */
export async function validateFindings(
  container: HTMLElement,
  state: PageState,
  findings: Finding[],
  options: ValidationOptions = {},
): Promise<ValidationResult[]> {
  const maxTargets = options.maxTargets ?? 20;
  const strategy = options.strategy ?? "semantic";

  const { virtual } = await import("@guidepup/virtual-screen-reader");

  const findingsWithTargets = findings
    .map((f) => ({ finding: f, target: state.targets.find((t) => t.id === f.targetId) }))
    .filter(
      (pair): pair is { finding: Finding; target: Target } =>
        pair.target !== undefined && isValidatable(pair.target),
    );
  findingsWithTargets.sort((a, b) => a.finding.scores.overall - b.finding.scores.overall);
  const toValidate = findingsWithTargets.slice(0, maxTargets);

  const results: ValidationResult[] = [];

  for (const { finding, target } of toValidate) {
    const result = strategy === "semantic"
      ? await validateWithSemanticNav(virtual, container, target, finding, options.verbose ?? false)
      : await validateWithLinearNav(virtual, container, target, finding, options.verbose ?? false);
    results.push(result);
  }

  return results;
}

/**
 * A target is validatable if we can write a deterministic matcher for it
 * against SR announcement text. With no name, we need a distinctive role
 * the SR announces verbatim (landmarks, headings). Generic unnamed buttons,
 * links, and form fields fall through the matcher and always return false,
 * so we exclude them up-front rather than scoring them "unreachable".
 */
export function isValidatable(target: Target): boolean {
  if (target.name?.trim()) return true;
  return target.kind === "landmark" || target.kind === "heading";
}

/**
 * Match an SR announcement against a target. Primary path is accessible-name
 * substring; fallback is role word for unnamed landmarks/headings, which SRs
 * announce as e.g. "navigation landmark" / "heading level 2".
 */
export function announcementMatches(announcement: string, target: Target): boolean {
  const spoken = announcement.toLowerCase();
  const name = target.name?.toLowerCase().trim() ?? "";
  if (name) return spoken.includes(name);
  const role = target.role?.toLowerCase() ?? "";
  return role.length > 0 && spoken.includes(role);
}

// ---------------------------------------------------------------------------
// Semantic navigation — uses heading/landmark/link skip commands
// ---------------------------------------------------------------------------

async function validateWithSemanticNav(
  virtual: VirtualSR,
  container: HTMLElement,
  target: Target,
  finding: Finding,
  verbose: boolean,
): Promise<ValidationResult> {
  const maxSteps = 100;

  try {
    await virtual.start({ container });

    let steps = 0;
    let found = false;
    const announcements: string[] = [];

    // Try heading navigation first (most common strategy)
    if (target.kind === "heading" || hasHeadingInPath(finding)) {
      found = await navigateByCommand(virtual, "moveToNextHeading", target, maxSteps, announcements, verbose);
      steps = announcements.length;
    }

    // Try landmark navigation
    if (!found && (target.kind === "landmark" || hasLandmarkInPath(finding))) {
      await virtual.stop();
      await virtual.start({ container });
      announcements.length = 0;
      found = await navigateByCommand(virtual, "moveToNextLandmark", target, maxSteps, announcements, verbose);
      steps = announcements.length;
    }

    // Fall back to linear navigation
    if (!found) {
      await virtual.stop();
      await virtual.start({ container });
      announcements.length = 0;
      found = await navigateByLinear(virtual, target, maxSteps, announcements, verbose);
      steps = announcements.length;
    }

    await virtual.stop();

    const predictedCost = finding.bestPath.length;
    const accuracy = found && predictedCost > 0
      ? Math.min(predictedCost, steps) / Math.max(predictedCost, steps)
      : 0;

    return {
      targetId: target.id,
      targetName: target.name,
      predictedCost,
      actualSteps: steps,
      predictedPath: finding.bestPath,
      actualAnnouncements: announcements.slice(-5),
      reachable: found,
      accuracy,
      strategy: "semantic",
    };
  } catch {
    await virtual.stop().catch(() => {});
    return makeUnreachable(target, finding, "semantic");
  }
}

// ---------------------------------------------------------------------------
// Linear navigation — uses next() only
// ---------------------------------------------------------------------------

async function validateWithLinearNav(
  virtual: VirtualSR,
  container: HTMLElement,
  target: Target,
  finding: Finding,
  verbose: boolean,
): Promise<ValidationResult> {
  const maxSteps = 200;

  try {
    await virtual.start({ container });

    const announcements: string[] = [];
    const found = await navigateByLinear(virtual, target, maxSteps, announcements, verbose);

    await virtual.stop();

    const predictedCost = finding.bestPath.length;
    const accuracy = found && predictedCost > 0
      ? Math.min(predictedCost, announcements.length) / Math.max(predictedCost, announcements.length)
      : 0;

    return {
      targetId: target.id,
      targetName: target.name,
      predictedCost,
      actualSteps: announcements.length,
      predictedPath: finding.bestPath,
      actualAnnouncements: announcements.slice(-5),
      reachable: found,
      accuracy,
      strategy: "linear",
    };
  } catch {
    await virtual.stop().catch(() => {});
    return makeUnreachable(target, finding, "linear");
  }
}

// ---------------------------------------------------------------------------
// Navigation helpers
// ---------------------------------------------------------------------------

async function navigateByCommand(
  virtual: VirtualSR,
  command: string,
  target: Target,
  maxSteps: number,
  announcements: string[],
  verbose: boolean,
): Promise<boolean> {
  const commands = await virtual.commands;
  const cmd = commands[command];
  if (!cmd) return false;

  for (let i = 0; i < maxSteps; i++) {
    try {
      await virtual.perform(cmd);
      const spoken = await virtual.lastSpokenPhrase();
      announcements.push(spoken || "");
      if (verbose) process.stderr?.write?.(`  [${command} ${i + 1}] ${spoken}\n`);
      if (announcementMatches(spoken || "", target)) return true;
    } catch {
      break;
    }
  }
  return false;
}

async function navigateByLinear(
  virtual: VirtualSR,
  target: Target,
  maxSteps: number,
  announcements: string[],
  verbose: boolean,
): Promise<boolean> {
  for (let i = 0; i < maxSteps; i++) {
    try {
      await virtual.next();
      const spoken = await virtual.lastSpokenPhrase();
      const text = await virtual.itemText();
      const announcement = spoken || text || "";
      announcements.push(announcement);
      if (verbose) process.stderr?.write?.(`  [next ${i + 1}] ${announcement}\n`);
      if (announcementMatches(announcement, target)) return true;
    } catch {
      break;
    }
  }
  return false;
}

function hasHeadingInPath(finding: Finding): boolean {
  return finding.bestPath.some((p) => p.startsWith("nextHeading:"));
}

function hasLandmarkInPath(finding: Finding): boolean {
  return finding.bestPath.some((p) => p.startsWith("groupEntry:"));
}

function makeUnreachable(target: Target, finding: Finding, strategy: string): ValidationResult {
  return {
    targetId: target.id,
    targetName: target.name,
    predictedCost: finding.bestPath.length,
    actualSteps: 0,
    predictedPath: finding.bestPath,
    actualAnnouncements: [],
    reachable: false,
    accuracy: 0,
    strategy,
  };
}

// Minimal type for the virtual screen reader instance
interface VirtualSR {
  start(opts: { container: HTMLElement }): Promise<void>;
  stop(): Promise<void>;
  next(): Promise<void>;
  previous(): Promise<void>;
  act(): Promise<void>;
  perform(command: unknown): Promise<void>;
  commands: Record<string, unknown>;
  lastSpokenPhrase(): Promise<string>;
  itemText(): Promise<string>;
  spokenPhraseLog(): Promise<string[]>;
}
