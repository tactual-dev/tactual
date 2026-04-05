/// <reference lib="dom" />
import type { Finding, PageState, Target } from "../core/types.js";

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

  const sorted = [...findings].sort((a, b) => a.scores.overall - b.scores.overall);
  const toValidate = sorted.slice(0, maxTargets);

  const results: ValidationResult[] = [];

  for (const finding of toValidate) {
    const target = state.targets.find((t) => t.id === finding.targetId);
    if (!target) continue;

    const result = strategy === "semantic"
      ? await validateWithSemanticNav(virtual, container, target, finding, options.verbose ?? false)
      : await validateWithLinearNav(virtual, container, target, finding, options.verbose ?? false);
    results.push(result);
  }

  return results;
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
  const targetName = target.name?.toLowerCase() ?? "";

  try {
    await virtual.start({ container });

    let steps = 0;
    let found = false;
    const announcements: string[] = [];

    // Try heading navigation first (most common strategy)
    if (target.kind === "heading" || hasHeadingInPath(finding)) {
      found = await navigateByCommand(virtual, "moveToNextHeading", targetName, maxSteps, announcements, verbose);
      steps = announcements.length;
    }

    // Try landmark navigation
    if (!found && (target.kind === "landmark" || hasLandmarkInPath(finding))) {
      await virtual.stop();
      await virtual.start({ container });
      announcements.length = 0;
      found = await navigateByCommand(virtual, "moveToNextLandmark", targetName, maxSteps, announcements, verbose);
      steps = announcements.length;
    }

    // Fall back to linear navigation
    if (!found) {
      await virtual.stop();
      await virtual.start({ container });
      announcements.length = 0;
      found = await navigateByLinear(virtual, targetName, maxSteps, announcements, verbose);
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
  const targetName = target.name?.toLowerCase() ?? "";

  try {
    await virtual.start({ container });

    const announcements: string[] = [];
    const found = await navigateByLinear(virtual, targetName, maxSteps, announcements, verbose);

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
  targetName: string,
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
      if (targetName && spoken.toLowerCase().includes(targetName)) return true;
    } catch {
      break;
    }
  }
  return false;
}

async function navigateByLinear(
  virtual: VirtualSR,
  targetName: string,
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
      if (targetName && announcement.toLowerCase().includes(targetName)) return true;
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
