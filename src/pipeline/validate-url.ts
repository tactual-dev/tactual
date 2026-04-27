/**
 * Pipeline: validate a URL by running Tactual analysis and then driving
 * @guidepup/virtual-screen-reader over the captured DOM to compare
 * predicted-vs-actual navigation cost.
 *
 * Shared across CLI (`tactual validate-url`) and MCP (`validate_url`).
 * Surface code parses its own input shape, calls runValidateUrl, and
 * formats the result. All browser / JSDOM / stealth / storageState
 * orchestration lives here.
 */

import type { Browser } from "playwright";
import { getProfile } from "../profiles/index.js";
import { analyze } from "../core/analyzer.js";
import { validateUrl } from "../core/url-validation.js";
import {
  acquireBrowser,
  applyStealthInit,
  buildContextOptions,
} from "../core/context-options.js";
import type { ValidationResult } from "../validation/index.js";

export interface ValidateUrlOptions {
  url: string;
  /** Profile ID (default: nvda-desktop-v0). */
  profileId?: string;
  /** Max findings to validate, worst-first. Default 10. */
  maxTargets?: number;
  /** Navigation strategy for the virtual SR. Default semantic. */
  strategy?: "linear" | "semantic";
  /** Page-load timeout in ms. Default 30000. */
  timeout?: number;
  /** Additional wait after load in ms. */
  waitTime?: number;
  /** Browser channel (uses a dedicated launch because it requires launch options). */
  channel?: string;
  /** Apply stealth defaults. */
  stealth?: boolean;
  /** Run browser headed. CLI only. */
  headless?: boolean;
  /** storageState path for authenticated pages. */
  storageState?: string;
  /**
   * Whether to reject storageState paths outside the cwd. MCP callers
   * should pass true; CLI callers pass false (user wrote the flag).
   */
  restrictStorageStateToCwd?: boolean;
  /** When true, validator logs SR announcements to stderr. */
  verbose?: boolean;
  /** Long-lived MCP/server callers can opt into the shared browser pool. */
  useSharedBrowserPool?: boolean;
}

export interface ValidateUrlResult {
  url: string;
  profile: string;
  strategy: "linear" | "semantic";
  totalValidated: number;
  reachable: number;
  unreachable: number;
  /** Ratio of predicted to actual steps across reachable targets (1.0 = perfect). */
  meanAccuracy: number | null;
  results: ValidationResult[];
}

/**
 * Thrown for recoverable validation errors (bad URL, unknown profile,
 * missing optional deps). Surfaces catch and convert to their native
 * error shape (exit 1 for CLI, isError:true for MCP) rather than having
 * the pipeline decide how to fail.
 */
export class ValidateUrlError extends Error {
  constructor(
    public readonly code:
      | "invalid-url"
      | "unknown-profile"
      | "missing-deps"
      | "bad-input"
      | "runtime",
    message: string,
  ) {
    super(message);
    this.name = "ValidateUrlError";
  }
}

export async function runValidateUrl(
  opts: ValidateUrlOptions,
): Promise<ValidateUrlResult> {
  const urlCheck = validateUrl(opts.url);
  if (!urlCheck.valid) {
    throw new ValidateUrlError("invalid-url", `Invalid URL: ${urlCheck.error}`);
  }

  const profileId = opts.profileId ?? "nvda-desktop-v0";
  const profile = getProfile(profileId);
  if (!profile) {
    throw new ValidateUrlError(
      "unknown-profile",
      `Unknown profile: ${profileId}`,
    );
  }

  let JSDOM: typeof import("jsdom").JSDOM;
  try {
    ({ JSDOM } = await import("jsdom"));
    await import("@guidepup/virtual-screen-reader");
  } catch (err) {
    throw new ValidateUrlError(
      "missing-deps",
      "validate-url requires jsdom and @guidepup/virtual-screen-reader.\n" +
        "Install with: npm install jsdom @guidepup/virtual-screen-reader\n" +
        `Underlying: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const pw = await import("playwright");
  const { captureState } = await import("../playwright/capture.js");
  const { validateFindingsInJsdom } = await import("../validation/index.js");

  const { browser, owned } = await acquireBrowser(
    {
      channel: opts.channel,
      stealth: opts.stealth,
      headless: opts.headless,
    },
    { useSharedPool: opts.useSharedBrowserPool === true },
  );

  const ctxBuild = buildContextOptions(
    {
      stealth: opts.stealth,
      storageState: opts.storageState,
      restrictStorageStateToCwd: opts.restrictStorageStateToCwd,
    },
    pw,
  );
  if (ctxBuild.error) {
    await closeIfOwned(browser, owned);
    throw new ValidateUrlError("bad-input", ctxBuild.error);
  }

  const context = await browser.newContext(ctxBuild.options);
  if (opts.stealth) await applyStealthInit(context);

  try {
    const page = await context.newPage();
    const timeout = opts.timeout ?? 30000;
    await page.goto(urlCheck.url!, { waitUntil: "domcontentloaded", timeout });
    await page.waitForTimeout(2000);
    if (opts.waitTime && opts.waitTime > 0) {
      await page.waitForTimeout(opts.waitTime);
    }

    const state = await captureState(page);
    const html = await page.content();

    const result = analyze([state], profile);

    const dom = new JSDOM(html, { url: urlCheck.url! });
    const results: ValidationResult[] = await validateFindingsInJsdom(
      dom,
      state,
      result.findings,
      {
        maxTargets: opts.maxTargets ?? 10,
        strategy: opts.strategy ?? "semantic",
        verbose: opts.verbose,
      },
    );

    const reachable = results.filter((r) => r.reachable).length;
    const accuracies = results
      .filter((r) => r.reachable && r.actualSteps > 0)
      .map((r) => r.accuracy);
    const meanAccuracy =
      accuracies.length > 0
        ? accuracies.reduce((a, b) => a + b, 0) / accuracies.length
        : null;

    return {
      url: urlCheck.url!,
      profile: profile.id,
      strategy: opts.strategy ?? "semantic",
      totalValidated: results.length,
      reachable,
      unreachable: results.length - reachable,
      meanAccuracy,
      results,
    };
  } finally {
    await context.close().catch(() => {});
    await closeIfOwned(browser, owned);
  }
}

async function closeIfOwned(browser: Browser, owned: boolean): Promise<void> {
  if (owned) await browser.close().catch(() => {});
}
