/**
 * Pipeline: analyze a URL for screen-reader navigation cost.
 *
 * Shared across CLI (`tactual analyze-url`) and MCP (`analyze_url`). All
 * browser/context/probe/explore/analyze orchestration lives here — surfaces
 * only parse their own input, call this, then format and emit results.
 *
 * Per-surface default divergence (e.g., exploreBudget 50 CLI vs 30 MCP) is
 * preserved by having callers pass an already-resolved number; this pipeline
 * never fills in a default. The Zod schemas at each surface encode the
 * per-surface defaults so the drift is intentional and explicit.
 */

import type { Browser, BrowserContext, Page } from "playwright";
import type { AnalysisResult, PageState } from "../core/types.js";
import type { CaptureDiagnostic } from "../core/diagnostics.js";
import type { ATProfile } from "../profiles/types.js";
import type { ExploreResult } from "../playwright/explorer.js";
import type { RouteChange, RouteTracker } from "../playwright/route-tracker.js";
import type {
  AutoScrollResult,
  ContainerScrollResult,
  FrameAutoScrollResult,
} from "../playwright/auto-scroll.js";
import type { BannerDismissResult } from "../playwright/banner-dismiss.js";
import { getProfile } from "../profiles/index.js";
import { analyze } from "../core/analyzer.js";
import { globToRegex } from "../core/glob.js";
import { validateUrl } from "../core/url-validation.js";
import { acquireBrowser, applyStealthInit, buildContextOptions } from "../core/context-options.js";
import {
  makeProbingExploreHook,
  type ProbeBudgets,
  type ProbeStrategy,
  resolveProbeBudgets,
  runProbeFamilies,
} from "./probe-helpers.js";

// ---------------------------------------------------------------------------
// Public options / result
// ---------------------------------------------------------------------------

export interface AnalyzeUrlOptions {
  url: string;
  profileId?: string;
  device?: string;

  /**
   * Pre-built filter object passed to analyze(). CLI typically builds this
   * from its config-merge pipeline (configToFilter); MCP builds a small one
   * from its input schema fields. Opaque here so callers keep full control.
   */
  filter?: Record<string, unknown>;
  /** CSS selectors excluded at capture time (not analyze time). */
  excludeSelector?: string[];
  /** CSS selectors that define the subtree(s) included in capture, scoring, and probing. */
  scopeSelector?: string[];

  // Exploration
  explore?: boolean;
  exploreDepth?: number;
  exploreBudget?: number;
  exploreMaxTargets?: number;
  exploreTimeout?: number;
  allowAction?: string[];

  // Probing
  probe?: boolean;
  probeBudget?: number;
  probeMode?: "fast" | "standard" | "deep";
  /** CSS selectors that narrow probes without changing capture/scoring. */
  probeSelector?: string[];
  /** Activate this selector before capture/probe, then prioritize newly revealed targets. */
  entrySelector?: string;
  /** Exact-ish target/selector/name hint for goal-directed probing. */
  goalTarget?: string;
  /** Glob pattern for target id/name/role/kind/selector goal-directed probing. */
  goalPattern?: string;
  /** Probe family intent preset. */
  probeStrategy?: ProbeStrategy;

  // Inline validation (CLI/Action feature — MCP uses validate_url tool)
  validate?: boolean;
  validateMaxTargets?: number;
  validateStrategy?: "linear" | "semantic";

  /**
   * Visibility probe: re-emulate media per profile-declared visualMode and
   * sample per-icon contrast. Emits `hcm-icon-invisible`, `low-contrast-icon`,
   * and `hcm-substitution-risk` findings. Default behavior resolves in this
   * order: `checkVisibility === false` disables, `=== true` enables,
   * `undefined` defers to whether the profile declares `visualModes` (desktop
   * AT profiles yes, mobile/generic no).
   */
  checkVisibility?: boolean;

  /**
   * Record SPA route changes (history.pushState/replaceState, popstate,
   * hashchange) that fire during analysis. Surfaced on
   * AnalyzeUrlPipelineResult.routeChanges and as an `spa-route-changes`
   * info diagnostic. Off by default — adds an init script to the context.
   */
  detectRoutes?: boolean;

  /**
   * Descend into child iframes during capture. Frame targets are appended
   * to the main state with `_frame: { url, name }` enrichment and IDs
   * prefixed `f<n>.` Capped at 20 frames per capture. Same-origin frames
   * use Playwright's frame snapshot; Chromium falls back to CDP for
   * recoverable cross-origin OOPIFs. Surfaces a `frames-descended` info
   * diagnostic when any frame content is captured.
   */
  descendFrames?: boolean;

  /**
   * Scroll to the bottom of the page in viewport-sized steps before
   * capture, surfacing IntersectionObserver-driven lazy content. Capped
   * at 20 scrolls / 30 s. Restores scroll position to top after so the
   * snapshot's spatial info is consistent. Surfaces an `auto-scrolled`
   * info diagnostic with stats. Off by default — adds wall time and can
   * interfere with scroll-snap or sticky layouts.
   */
  autoScroll?: boolean;

  /**
   * Best-effort dismiss of cookie / consent / GDPR banners before capture.
   * Detects overlays via id/class/aria-label containing cookie/consent/gdpr
   * and clicks safe-accept buttons (Accept / OK / Got it / Allow all),
   * explicitly skipping Decline/Reject/Manage/Customize. Surfaces a
   * `banners-dismissed` info diagnostic. Off by default — clicks are a
   * page side effect.
   */
  dismissBanners?: boolean;

  /**
   * Hover candidate triggers to surface hover-only popups/tooltips that
   * have no attribute hint (pure-React/Vue hover state). Diffs the
   * accessibility tree before/after each hover; new targets become
   * `_hoverContent: string` enrichment on the trigger. Default budget
   * 10 candidates; ~600 ms per candidate (~7-8 s total). Off by default
   * because of cost.
   */
  probeHover?: boolean;

  /**
   * Press Tab repeatedly (capped at 30) and record the focused element
   * sequence to detect tabindex-induced reorders, focus traps on the
   * page, or skip-link-style intentional rearrangements. Surfaces
   * `tab-order-walked` info diagnostic with summary stats. Off by
   * default — focus changes are page side effects.
   */
  walkTabOrder?: boolean;

  /**
   * Wave 31: capture the URL at both desktop (1280×800) and mobile
   * (375×667) viewports and diff the resulting target lists. Surfaces
   * `viewport-divergence` warning when content/landmarks/headings
   * present at one viewport are missing at the other. Off by default
   * because it requires a second navigation (~2-3s additional).
   */
  diffViewports?: boolean;

  // Browser
  headless?: boolean;
  channel?: string;
  stealth?: boolean;
  userAgent?: string;
  timeout?: number;
  waitForSelector?: string;
  waitTime?: number;
  storageState?: string;
  /** MCP callers set true; CLI false. */
  restrictStorageStateToCwd?: boolean;
  /** MCP callers set false; CLI/local fixture workflows keep the default true. */
  allowFileUrls?: boolean;
  /** Long-lived MCP/server callers can opt into the shared browser pool. */
  useSharedBrowserPool?: boolean;

  /** Optional callback for user-facing progress messages. */
  onProgress?: (phase: string) => void;
}

export interface AnalyzeUrlPipelineResult {
  /** The analyzer output, with SR diagnostics + validation already merged. */
  result: AnalysisResult;
  /** The canonical URL (post-validation). */
  url: string;
  /** The resolved profile. */
  profile: ATProfile;
  /** All states (initial + any explored). */
  states: PageState[];
  /** Non-fatal warnings surfaces may want to emit (timeouts, skipped elements). */
  warnings: string[];
  /** Skipped-unsafe elements from exploration, so CLI can print hints. */
  skippedElements: Array<{ id: string; reason: string }>;
  /** Pre-rendered SR snapshot text for SARIF/finding-builder enrichment. */
  snapshotText: string;
  /** SPA route changes captured during the run (when detectRoutes is true). */
  routeChanges?: RouteChange[];
  /** Wall-time ms from URL validation to final state. */
  elapsedMs: number;
}

export class AnalyzeUrlError extends Error {
  constructor(
    public readonly code:
      | "invalid-url"
      | "unknown-profile"
      | "unknown-device"
      | "bad-input"
      | "missing-playwright"
      | "runtime",
    message: string,
  ) {
    super(message);
    this.name = "AnalyzeUrlError";
  }
}

// ---------------------------------------------------------------------------
// Pipeline
// ---------------------------------------------------------------------------

export async function runAnalyzeUrl(opts: AnalyzeUrlOptions): Promise<AnalyzeUrlPipelineResult> {
  const start = Date.now();
  const warnings: string[] = [];
  const { url, profile } = resolveAnalysisInput(opts);
  const pw = await loadPlaywright();
  const { browser, owned } = await acquireBrowser(
    { channel: opts.channel, stealth: opts.stealth, headless: opts.headless },
    { useSharedPool: opts.useSharedBrowserPool === true },
  );

  let context: BrowserContext | undefined;
  let routeTracker: RouteTracker | undefined;
  try {
    context = await createAnalysisContext(browser, pw, opts);
    // Always-on: enables fake-interactive detection to also see
    // addEventListener-attached click handlers (vanilla JS, jQuery,
    // web components). Cost is one wrap per addEventListener call,
    // negligible at typical listener counts.
    {
      const { installEventListenerRegistry } = await import(
        "../playwright/event-listener-registry.js"
      );
      await installEventListenerRegistry(context);
    }
    if (opts.detectRoutes) {
      const { installRouteTracker } = await import("../playwright/route-tracker.js");
      routeTracker = await installRouteTracker(context);
    }

    const page = await context.newPage();
    const timeout = opts.timeout ?? 30000;
    routeTracker?.start();
    const { autoScrollSummary, bannerDismiss } = await openTargetPage(
      page,
      url,
      timeout,
      opts,
      warnings,
    );

    const { rawState, entryRevealedTargetIds } = await captureInitialState(
      page,
      timeout,
      opts,
      warnings,
    );

    if (opts.probeHover) {
      opts.onProgress?.("probing hover content");
      const { probeHoverContent } = await import("../playwright/hover-probe.js");
      rawState.targets = await probeHoverContent(page, rawState.targets);
    }

    let tabOrder: import("../playwright/tab-order.js").TabOrderResult | undefined;
    if (opts.walkTabOrder) {
      opts.onProgress?.("walking tab order");
      const { walkTabOrder } = await import("../playwright/tab-order.js");
      tabOrder = await walkTabOrder(page);
      // Stash on the state so analyzer-side diagnostics
      // (skip-link-not-first) can read it.
      (rawState as Record<string, unknown>)._tabOrder = tabOrder;
    }

    if (opts.diffViewports) {
      opts.onProgress?.("diffing viewports");
      const { diffViewports } = await import("../playwright/viewport-diff.js");
      try {
        const vpDiff = await diffViewports(page, { url });
        (rawState as Record<string, unknown>)._viewportDiff = vpDiff;
      } catch (err) {
        warnings.push(
          `viewport-diff failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    const exploreClock = createExploreClock(opts);
    const probePass = await runInitialProbePass(
      page,
      rawState,
      entryRevealedTargetIds,
      url,
      timeout,
      exploreClock,
      opts,
      warnings,
    );
    const probedTargets = probePass.state.targets;
    const state = await collectVisibilityEvidence(page, probePass.state, profile, opts);
    const { srDiagnostics, snapshotText } = await collectScreenReaderEvidence(
      page,
      probedTargets,
    );
    const exploration = await exploreStates(
      page,
      state,
      probePass.remainingProbeBudgets,
      exploreClock,
      opts,
      warnings,
    );
    const result = buildAnalysisResult(
      exploration.states,
      profile,
      url,
      opts,
      snapshotText,
      exploration.exploreResult,
      srDiagnostics,
    );

    await attachValidation(page, result, state, profile, opts);

    const routeChanges = routeTracker ? [...routeTracker.events] : undefined;
    if (routeChanges && routeChanges.length > 0) {
      result.diagnostics.push(buildRouteChangesDiagnostic(routeChanges));
    }

    if (opts.descendFrames) {
      const framesDiagnostic = buildFramesDescendedDiagnostic(exploration.states);
      if (framesDiagnostic) result.diagnostics.push(framesDiagnostic);
    }

    if (autoScrollSummary.main || autoScrollSummary.containers || autoScrollSummary.frames) {
      const diag = buildAutoScrollDiagnostic(autoScrollSummary);
      if (diag) result.diagnostics.push(diag);
    }

    if (bannerDismiss && bannerDismiss.candidatesFound > 0) {
      result.diagnostics.push(buildBannerDismissDiagnostic(bannerDismiss));
    }

    if (tabOrder) {
      result.diagnostics.push(buildTabOrderDiagnostic(tabOrder));
    }

    return {
      result,
      url,
      profile,
      states: exploration.states,
      warnings,
      skippedElements: exploration.skippedElements,
      snapshotText,
      routeChanges,
      elapsedMs: Date.now() - start,
    };
  } finally {
    routeTracker?.dispose();
    await context?.close().catch(() => {});
    await closeIfOwned(browser, owned);
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function resolveAnalysisInput(opts: AnalyzeUrlOptions): { url: string; profile: ATProfile } {
  const urlCheck = validateUrl(opts.url, { allowFileUrls: opts.allowFileUrls });
  if (!urlCheck.valid) {
    throw new AnalyzeUrlError("invalid-url", `Invalid URL: ${urlCheck.error}`);
  }

  const profileId = opts.profileId ?? "generic-mobile-web-sr-v0";
  const profile = getProfile(profileId);
  if (!profile) {
    throw new AnalyzeUrlError("unknown-profile", `Unknown profile: ${profileId}`);
  }

  return { url: urlCheck.url!, profile };
}

async function loadPlaywright(): Promise<typeof import("playwright")> {
  try {
    return await import("playwright");
  } catch (err) {
    throw new AnalyzeUrlError(
      "missing-playwright",
      `Playwright is required but could not be loaded from the installed Tactual package. Reinstall Tactual or run npm install. Underlying: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}

async function createAnalysisContext(
  browser: Browser,
  pw: typeof import("playwright"),
  opts: AnalyzeUrlOptions,
): Promise<BrowserContext> {
  const ctxBuild = buildContextOptions(
    {
      stealth: opts.stealth,
      userAgent: opts.userAgent,
      storageState: opts.storageState,
      restrictStorageStateToCwd: opts.restrictStorageStateToCwd,
      device: opts.device,
    },
    pw,
  );
  if (ctxBuild.error) {
    const code = ctxBuild.error.startsWith("Unknown device:") ? "unknown-device" : "bad-input";
    throw new AnalyzeUrlError(code, ctxBuild.error);
  }

  const context = await browser.newContext(ctxBuild.options);
  if (opts.stealth) await applyStealthInit(context);
  return context;
}

interface AutoScrollSummary {
  main?: AutoScrollResult;
  containers?: ContainerScrollResult;
  frames?: FrameAutoScrollResult;
}

interface OpenTargetPageResult {
  autoScrollSummary: AutoScrollSummary;
  bannerDismiss?: BannerDismissResult;
}

async function openTargetPage(
  page: Page,
  url: string,
  timeout: number,
  opts: AnalyzeUrlOptions,
  warnings: string[],
): Promise<OpenTargetPageResult> {
  opts.onProgress?.("navigating");
  await preparePage(page, url, timeout, opts, warnings);
  const bannerDismiss = await runBannerDismissIfRequested(page, opts);
  const autoScrollSummary = await runAutoScrollIfRequested(page, opts);
  return { autoScrollSummary, bannerDismiss };
}

async function runBannerDismissIfRequested(
  page: Page,
  opts: AnalyzeUrlOptions,
): Promise<BannerDismissResult | undefined> {
  if (!opts.dismissBanners) return undefined;
  opts.onProgress?.("dismissing banners");
  const { dismissBanners } = await import("../playwright/banner-dismiss.js");
  return dismissBanners(page);
}

async function runAutoScrollIfRequested(
  page: Page,
  opts: AnalyzeUrlOptions,
): Promise<AutoScrollSummary> {
  if (!opts.autoScroll) return {};
  opts.onProgress?.("auto-scrolling");
  const { autoScrollToBottom, scrollToTop, autoScrollContainers, autoScrollChildFrames } = await import(
    "../playwright/auto-scroll.js"
  );
  const main = await autoScrollToBottom(page);
  await scrollToTop(page);
  const containers = await autoScrollContainers(page);
  const frames = opts.descendFrames ? await autoScrollChildFrames(page) : undefined;
  return { main, containers, frames };
}

interface InitialCaptureResult {
  rawState: PageState;
  entryRevealedTargetIds?: Set<string>;
}

async function captureInitialState(
  page: Page,
  timeout: number,
  opts: AnalyzeUrlOptions,
  warnings: string[],
): Promise<InitialCaptureResult> {
  const { captureState } = await import("../playwright/capture.js");
  let entryBaseline: PageState | null = null;
  if (opts.entrySelector) {
    opts.onProgress?.("capturing entry baseline");
    entryBaseline = await captureState(page, {
      device: opts.device,
      provenance: "scripted",
      spaWaitTimeout: 20000,
      descendFrames: opts.descendFrames,
    });
    opts.onProgress?.("activating entry");
    await activateEntrySelector(page, opts.entrySelector, timeout, warnings);
  }

  opts.onProgress?.("capturing");
  const rawState = await captureState(page, {
    device: opts.device,
    provenance: "scripted",
    spaWaitTimeout: 20000,
    excludeSelectors: opts.excludeSelector,
    scopeSelectors: opts.scopeSelector,
    descendFrames: opts.descendFrames,
  });
  const entryRevealedTargetIds = findEntryRevealedTargetIds(rawState, entryBaseline);
  if (opts.entrySelector && entryRevealedTargetIds?.size === 0) {
    warnings.push(
      `entrySelector "${opts.entrySelector}" activated but did not reveal new accessibility targets; probes used the remaining selector/goal filters.`,
    );
  }

  return { rawState, entryRevealedTargetIds };
}

function findEntryRevealedTargetIds(
  rawState: PageState,
  entryBaseline: PageState | null,
): Set<string> | undefined {
  if (!entryBaseline) return undefined;

  const baselineIds = new Set(entryBaseline.targets.map((target) => target.id));
  return new Set(
    rawState.targets.filter((target) => !baselineIds.has(target.id)).map((target) => target.id),
  );
}

interface ExploreClock {
  timeoutMs: number;
  remainingMs: () => number;
}

function createExploreClock(opts: AnalyzeUrlOptions): ExploreClock {
  const timeoutMs = opts.exploreTimeout ?? 60000;
  const startedAt = opts.explore ? Date.now() : 0;
  return {
    timeoutMs,
    remainingMs: () =>
      opts.explore ? Math.max(0, timeoutMs - (Date.now() - startedAt)) : timeoutMs,
  };
}

interface ProbePassResult {
  state: PageState;
  remainingProbeBudgets: ProbeBudgets | null;
}

async function runInitialProbePass(
  page: Page,
  rawState: PageState,
  entryRevealedTargetIds: Set<string> | undefined,
  url: string,
  timeout: number,
  exploreClock: ExploreClock,
  opts: AnalyzeUrlOptions,
  warnings: string[],
): Promise<ProbePassResult> {
  let targets = rawState.targets;
  const remainingProbeBudgets: ProbeBudgets | null = opts.probe
    ? resolveProbeBudgets(opts.probeMode, opts.probeBudget)
    : null;
  if (opts.probe && remainingProbeBudgets) {
    opts.onProgress?.("probing");
    targets = await runProbeFamilies(page, targets, remainingProbeBudgets, {
      targetIds:
        entryRevealedTargetIds && entryRevealedTargetIds.size > 0
          ? entryRevealedTargetIds
          : undefined,
      scopeSelector: opts.scopeSelector,
      probeSelector: opts.probeSelector,
      goalTarget: opts.goalTarget,
      goalPattern: opts.goalPattern,
      strategy: opts.probeStrategy,
      shouldContinue: opts.explore ? () => exploreClock.remainingMs() > 5000 : undefined,
    });
    if (opts.explore) {
      opts.onProgress?.("resetting page after probes");
      await preparePage(page, url, timeout, opts, warnings);
      await runAutoScrollIfRequested(page, opts);
      if (opts.entrySelector) {
        await activateEntrySelector(page, opts.entrySelector, timeout, warnings);
      }
    }
  }

  return { state: { ...rawState, targets }, remainingProbeBudgets };
}

async function collectVisibilityEvidence(
  page: Page,
  state: PageState,
  profile: ATProfile,
  opts: AnalyzeUrlOptions,
): Promise<PageState> {
  const shouldCheckVisibility = opts.checkVisibility ?? Boolean(profile.visualModes?.length);
  if (!shouldCheckVisibility || !profile.visualModes?.length) return state;

  opts.onProgress?.("checking visibility");
  const { collectVisibility } = await import("../playwright/visibility-probe.js");
  return collectVisibility(page, state, profile.visualModes);
}

async function collectScreenReaderEvidence(
  page: Page,
  targets: PageState["targets"],
): Promise<{ srDiagnostics: CaptureDiagnostic[]; snapshotText: string }> {
  const { simulateScreenReader, aggregateDemotedLandmarks } =
    await import("../playwright/sr-simulator.js");
  const srSim = await simulateScreenReader(page, targets);
  return {
    srDiagnostics: aggregateDemotedLandmarks(srSim.demotedLandmarks),
    snapshotText: await page.ariaSnapshot().catch(() => ""),
  };
}

interface ExplorationRun {
  states: PageState[];
  skippedElements: Array<{ id: string; reason: string }>;
  exploreResult?: ExploreResult;
}

async function exploreStates(
  page: Page,
  state: PageState,
  remainingProbeBudgets: ProbeBudgets | null,
  exploreClock: ExploreClock,
  opts: AnalyzeUrlOptions,
  warnings: string[],
): Promise<ExplorationRun> {
  if (!opts.explore) {
    return { states: [state], skippedElements: [] };
  }

  opts.onProgress?.("exploring");
  const { explore: exploreState } = await import("../playwright/explorer.js");
  const remainingTimeout = exploreClock.remainingMs();
  if (remainingTimeout <= 5000) {
    warnings.push(
      `exploreTimeout ${exploreClock.timeoutMs}ms was mostly consumed before exploration; explored states may be shallow. Increase exploreTimeout or use probeStrategy/probeSelector to target the branch of interest.`,
    );
  }

  const allowPatterns = (opts.allowAction ?? []).map(globToRegex);
  const probeHookOptions = remainingProbeBudgets
    ? makeProbingExploreHook(remainingProbeBudgets, {
        runOptions: {
          scopeSelector: opts.scopeSelector,
          probeSelector: opts.probeSelector,
          goalTarget: opts.goalTarget,
          goalPattern: opts.goalPattern,
          strategy: opts.probeStrategy,
        },
      })
    : undefined;
  const exploreResult = await exploreState(page, state, {
    device: opts.device,
    maxDepth: opts.exploreDepth ?? 2,
    maxActions: opts.exploreBudget ?? 30,
    totalTimeout: Math.max(1000, remainingTimeout),
    maxTotalTargets: opts.exploreMaxTargets ?? 2000,
    allowActionPatterns: allowPatterns.length > 0 ? allowPatterns : undefined,
    scopeSelectors: opts.scopeSelector,
    descendFrames: opts.descendFrames,
    onStateRevealed: probeHookOptions,
  });

  return {
    states: exploreResult.states,
    skippedElements: exploreResult.skippedElements,
    exploreResult,
  };
}

function buildAnalysisResult(
  states: PageState[],
  profile: ATProfile,
  requestedUrl: string,
  opts: AnalyzeUrlOptions,
  snapshotText: string,
  exploreResult: ExploreResult | undefined,
  srDiagnostics: CaptureDiagnostic[],
): AnalysisResult {
  opts.onProgress?.("analyzing");
  const result = analyze(states, profile, {
    name: opts.url,
    requestedUrl,
    snapshotText,
    filter: opts.filter ?? {},
  });

  if (opts.explore && exploreResult) {
    const explorationDiagnostic = createExplorationNoNewStatesDiagnostic(
      exploreResult,
      opts.exploreBudget ?? 30,
    );
    if (explorationDiagnostic) result.diagnostics.push(explorationDiagnostic);
  }

  if (srDiagnostics.length > 0) result.diagnostics.push(...srDiagnostics);
  return result;
}

async function attachValidation(
  page: Page,
  result: AnalysisResult,
  state: PageState,
  profile: ATProfile,
  opts: AnalyzeUrlOptions,
): Promise<void> {
  if (!opts.validate) return;

  opts.onProgress?.("validating");
  const { runInlineValidation } = await import("./inline-validation.js");
  const vResult = await runInlineValidation(page, result, state, profile, {
    maxTargets: opts.validateMaxTargets ?? 10,
    strategy: opts.validateStrategy ?? "semantic",
  });
  if (vResult) {
    (result as Record<string, unknown>).validation = vResult;
  }
}

function buildTabOrderDiagnostic(
  result: import("../playwright/tab-order.js").TabOrderResult,
): CaptureDiagnostic {
  const { sequence, cycledBack, hitMax, hasPositiveTabindex } = result;
  const notes: string[] = [];
  if (hasPositiveTabindex) notes.push("positive tabindex present (anti-pattern)");
  if (cycledBack) notes.push("focus cycled back early (trap or wrap)");
  if (hitMax) notes.push("budget cap hit; sequence may be incomplete");
  const noteFragment = notes.length > 0 ? ` — ${notes.join("; ")}` : "";
  return {
    level: hasPositiveTabindex ? "warning" : "info",
    code: "tab-order-walked",
    message: `Tab traversal: ${sequence.length} stop${sequence.length === 1 ? "" : "s"} recorded${noteFragment}.`,
    affectedCount: hasPositiveTabindex
      ? sequence.filter((s) => s.tabIndex > 0).length
      : undefined,
  };
}

function buildBannerDismissDiagnostic(result: BannerDismissResult): CaptureDiagnostic {
  const labels = result.clickedLabels.length > 0
    ? `: ${result.clickedLabels.slice(0, 3).join(", ")}${result.clickedLabels.length > 3 ? ` (+${result.clickedLabels.length - 3} more)` : ""}`
    : "";
  return {
    level: "info",
    code: "banners-dismissed",
    message:
      `Cookie/consent banner dismiss: found ${result.candidatesFound} candidate${result.candidatesFound === 1 ? "" : "s"}, ` +
      `clicked accept on ${result.attempted}, ${result.dismissed} confirmed dismissed${labels}.`,
  };
}

function buildAutoScrollDiagnostic(summary: AutoScrollSummary): CaptureDiagnostic | null {
  const parts: string[] = [];

  if (summary.main && summary.main.scrolls > 0) {
    const grew = summary.main.finalHeight > summary.main.startHeight;
    const heightNote = grew
      ? `page grew from ${summary.main.startHeight}px to ${summary.main.finalHeight}px`
      : "no new content materialized";
    const cap = summary.main.reachedBottom
      ? "reached bottom"
      : "stopped at scroll/time cap (content may still be incomplete)";
    parts.push(
      `main page ${summary.main.scrolls}× (${cap}; ${heightNote})`,
    );
  }

  if (summary.containers && summary.containers.containers > 0) {
    parts.push(
      `${summary.containers.containers} inner container${summary.containers.containers === 1 ? "" : "s"} ` +
        `(${summary.containers.totalScrolls} scroll${summary.containers.totalScrolls === 1 ? "" : "s"} total, ` +
        `${summary.containers.reachedBottomCount} reached bottom)`,
    );
  }

  if (summary.frames && summary.frames.frames > 0) {
    const errors = summary.frames.details.filter((detail) => detail.error).length;
    const errorNote = errors > 0 ? `, ${errors} failed` : "";
    parts.push(
      `${summary.frames.framesScrolled}/${summary.frames.frames} iframe${summary.frames.frames === 1 ? "" : "s"} scrolled${errorNote}`,
    );
  }

  if (parts.length === 0) return null;
  return {
    level: "info",
    code: "auto-scrolled",
    message: `Auto-scrolled before capture: ${parts.join("; ")}.`,
  };
}

function buildFramesDescendedDiagnostic(states: PageState[]): CaptureDiagnostic | null {
  const frameUrls = new Set<string>();
  const skipped: Array<{ url: string; reason: string }> = [];
  let overflow = 0;
  for (const state of states) {
    for (const target of state.targets) {
      const frame = (target as Record<string, unknown>)._frame as
        | { url?: string }
        | undefined;
      if (frame?.url) frameUrls.add(frame.url);
    }
    const stateSkipped =
      ((state as Record<string, unknown>)._framesSkipped as
        | Array<{ url: string; reason: string }>
        | undefined) ?? [];
    skipped.push(...stateSkipped);
    overflow = Math.max(
      overflow,
      ((state as Record<string, unknown>)._framesOverflow as number | undefined) ?? 0,
    );
  }

  if (frameUrls.size === 0 && skipped.length === 0 && overflow === 0) return null;

  const parts: string[] = [];
  if (frameUrls.size > 0) {
    const sample = [...frameUrls].slice(0, 3).join(", ");
    const more = frameUrls.size > 3 ? ` (+${frameUrls.size - 3} more)` : "";
    parts.push(`captured ${frameUrls.size} iframe${frameUrls.size === 1 ? "" : "s"} (${sample}${more})`);
  }
  if (skipped.length > 0) {
    const inaccessible = skipped.filter((s) => s.reason === "inaccessible").length;
    const empty = skipped.filter((s) => s.reason === "empty").length;
    const skipParts: string[] = [];
    if (inaccessible > 0) skipParts.push(`${inaccessible} cross-origin/inaccessible`);
    if (empty > 0) skipParts.push(`${empty} empty`);
    parts.push(`skipped ${skipped.length} (${skipParts.join(", ")})`);
  }
  if (overflow > 0) {
    parts.push(`${overflow} additional frame${overflow === 1 ? "" : "s"} not descended (cap of 20 reached)`);
  }

  return {
    level: "info",
    code: "frames-descended",
    message: `Iframe descent: ${parts.join("; ")}.`,
  };
}

function buildRouteChangesDiagnostic(routeChanges: RouteChange[]): CaptureDiagnostic {
  const sample = routeChanges
    .slice(0, 5)
    .map((r) => `${r.kind} ${r.url}`)
    .join("; ");
  const more = routeChanges.length > 5 ? ` (+${routeChanges.length - 5} more)` : "";
  return {
    level: "info",
    code: "spa-route-changes",
    message: `Detected ${routeChanges.length} SPA route change${routeChanges.length === 1 ? "" : "s"} during analysis: ${sample}${more}`,
  };
}

export function createExplorationNoNewStatesDiagnostic(
  exploreResult: Pick<
    ExploreResult,
    "states" | "actionsPerformed" | "branchesExplored" | "skippedUnsafe" | "skippedBudget"
  >,
  maxActions: number,
): CaptureDiagnostic | null {
  if (exploreResult.states.length > 1) return null;

  let reason: string;
  let action: string;
  if (exploreResult.actionsPerformed === 0 && exploreResult.skippedUnsafe > 0) {
    reason = "no-safe-targets";
    action =
      "Review skipped unsafe controls or pass allowAction/--allow-action for known-safe widgets.";
  } else if (exploreResult.actionsPerformed >= maxActions || exploreResult.skippedBudget > 0) {
    reason = "budget-exhausted-on-repeats";
    action =
      "Increase exploreBudget/--explore-budget or lower exploreDepth to reduce repeated branches.";
  } else if (exploreResult.actionsPerformed > 0 || exploreResult.branchesExplored > 0) {
    reason = "convergence-missed";
    action =
      "Use waitForSelector/--wait-for-selector or waitTime/--wait-time if the page updates after activation.";
  } else {
    reason = "explore-not-attempted";
    action = "No explorable safe branch targets were found in the captured state.";
  }

  return {
    level: "warning",
    code: "exploration-no-new-states",
    message: `Exploration completed but no new states were captured. Reason: ${reason}. ` + action,
  };
}

async function preparePage(
  page: Page,
  url: string,
  timeout: number,
  opts: Pick<AnalyzeUrlOptions, "waitForSelector" | "waitTime">,
  warnings: string[],
): Promise<void> {
  await page.goto(url, { waitUntil: "domcontentloaded", timeout });
  await page.waitForTimeout(2000);

  if (opts.waitForSelector) {
    const found = await page.waitForSelector(opts.waitForSelector, { timeout }).catch(() => null);
    if (!found) {
      warnings.push(
        `waitForSelector "${opts.waitForSelector}" did not appear within ${timeout}ms — analysis may reflect incomplete content`,
      );
    }
  }
  if (opts.waitTime && opts.waitTime > 0) {
    await page.waitForTimeout(opts.waitTime);
  }
}

async function activateEntrySelector(
  page: Page,
  selector: string,
  timeout: number,
  warnings: string[],
): Promise<void> {
  const trigger = page.locator(selector).first();
  const waitTimeout = Math.min(timeout, 5000);
  const visible = await trigger
    .waitFor({ state: "visible", timeout: waitTimeout })
    .then(() => true)
    .catch(() => false);
  if (!visible) {
    warnings.push(
      `entrySelector "${selector}" was not visible within ${waitTimeout}ms; analysis continued without entry activation.`,
    );
    return;
  }

  try {
    await trigger.focus({ timeout: waitTimeout });
    await page.keyboard.press("Enter");
  } catch {
    await trigger.click({ timeout: waitTimeout }).catch(() => {
      warnings.push(
        `entrySelector "${selector}" could not be activated by keyboard or click; analysis may not include the intended branch.`,
      );
    });
  }
  await page.waitForTimeout(300);
}

async function closeIfOwned(browser: Browser, owned: boolean): Promise<void> {
  if (owned) await browser.close().catch(() => {});
}
