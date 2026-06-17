/**
 * Auto-scroll helper for surfacing lazy-loaded / infinite-scroll content
 * before capture. Modern content sites (Twitter, Reddit, news, e-commerce
 * listings) load most of their content via IntersectionObserver as the user
 * scrolls down — a single ariaSnapshot at page load only sees the content
 * that fit in the initial viewport.
 *
 * Strategy: scroll to bottom in viewport-sized steps, watch
 * document.scrollHeight stabilize for two consecutive rounds. Cap by both
 * scroll count and wall-clock time so pages with truly infinite scroll
 * (e.g., social feeds) terminate cleanly.
 */

import type { Frame, Page } from "playwright";

const DEFAULT_MAX_SCROLLS = 20;
const DEFAULT_TIMEOUT_MS = 30000;
const DEFAULT_PAUSE_MS = 300;

export interface AutoScrollOptions {
  /** Hard cap on scroll iterations (default: 20). */
  maxScrolls?: number;
  /** Wall-clock timeout (default: 30000 ms). */
  timeoutMs?: number;
  /** Pause between scroll-to-bottom and the next height check (default: 300 ms). */
  scrollPauseMs?: number;
}

export interface AutoScrollResult {
  /** Number of scroll-to-bottom iterations performed. */
  scrolls: number;
  /** True if scrollHeight stabilized; false if the budget cap was hit. */
  reachedBottom: boolean;
  /** Page scrollHeight before any scroll. */
  startHeight: number;
  /** Page scrollHeight after the last scroll. */
  finalHeight: number;
}

export async function autoScrollToBottom(
  page: Page | Frame,
  options: AutoScrollOptions = {},
): Promise<AutoScrollResult> {
  const maxScrolls = options.maxScrolls ?? DEFAULT_MAX_SCROLLS;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const pause = options.scrollPauseMs ?? DEFAULT_PAUSE_MS;

  const startHeight = await readScrollHeight(page);
  const start = Date.now();
  let prevHeight = startHeight;
  let stableRounds = 0;
  let scrolls = 0;

  while (scrolls < maxScrolls && Date.now() - start < timeoutMs) {
    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    await page.waitForTimeout(pause);
    scrolls++;

    const height = await readScrollHeight(page);
    if (height === prevHeight) {
      stableRounds++;
      if (stableRounds >= 2) {
        return { scrolls, reachedBottom: true, startHeight, finalHeight: height };
      }
    } else {
      stableRounds = 0;
    }
    prevHeight = height;
  }

  return { scrolls, reachedBottom: false, startHeight, finalHeight: prevHeight };
}

/**
 * Reset scroll position to top so the post-scroll capture sees consistent
 * spatial info (rect enrichment, viewport-relative measurements).
 */
export async function scrollToTop(page: Page | Frame): Promise<void> {
  await page.evaluate(() => window.scrollTo(0, 0));
}

async function readScrollHeight(page: Page | Frame): Promise<number> {
  return page.evaluate(() => document.documentElement.scrollHeight);
}

// ---------------------------------------------------------------------------
// Inner-container scrolling
// ---------------------------------------------------------------------------

const DEFAULT_MAX_CONTAINERS = 8;
const DEFAULT_MAX_SCROLLS_PER_CONTAINER = 10;
const DEFAULT_CONTAINER_PAUSE_MS = 200;

export interface ContainerScrollOptions {
  /** Maximum number of inner containers to scroll (default: 8). */
  maxContainers?: number;
  /** Per-container scroll iteration cap (default: 10). */
  maxScrollsPerContainer?: number;
  /** Pause between scroll and height read (default: 200 ms). */
  scrollPauseMs?: number;
}

export interface ContainerScrollResult {
  /** How many inner containers were scrolled. */
  containers: number;
  /** Sum of scroll iterations across all containers. */
  totalScrolls: number;
  /** How many of the scrolled containers reached the bottom. */
  reachedBottomCount: number;
}

/**
 * Scroll every visible element with `overflow: auto/scroll/overlay` whose
 * scrollHeight exceeds clientHeight — Slack-style sidebars, virtualized
 * file trees, message logs, etc. Modern apps frequently put their primary
 * content inside one of these containers, leaving autoScrollToBottom (which
 * only scrolls the document) blind to anything past the visible area of
 * the inner scroll region.
 *
 * The whole scan + per-container scroll loop runs inside a single
 * page.evaluate to avoid N×M Node↔browser round-trips. Restores each
 * container's scrollTop to 0 after so the capture sees consistent
 * scroll-relative state.
 */
export async function autoScrollContainers(
  page: Page | Frame,
  options: ContainerScrollOptions = {},
): Promise<ContainerScrollResult> {
  const maxContainers = options.maxContainers ?? DEFAULT_MAX_CONTAINERS;
  const maxScrollsPerContainer = options.maxScrollsPerContainer ?? DEFAULT_MAX_SCROLLS_PER_CONTAINER;
  const pause = options.scrollPauseMs ?? DEFAULT_CONTAINER_PAUSE_MS;

  return page.evaluate(
    async ({ maxContainers, maxScrollsPerContainer, pause }) => {
      const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
      const isScrollableOverflow = (v: string): boolean =>
        v === "auto" || v === "scroll" || v === "overlay";

      // Find candidate containers. Skip the document root + body — those are
      // covered by autoScrollToBottom. Skip 0-size or detached elements.
      const candidates: Element[] = [];
      const all = document.body ? document.body.querySelectorAll("*") : [];
      for (const el of Array.from(all)) {
        if (candidates.length >= maxContainers) break;
        const rect = el.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) continue;
        const style = getComputedStyle(el);
        if (!isScrollableOverflow(style.overflowY) && !isScrollableOverflow(style.overflowX)) continue;
        if (el.scrollHeight <= el.clientHeight + 1) continue;
        candidates.push(el);
      }

      let totalScrolls = 0;
      let reachedBottomCount = 0;

      for (const el of candidates) {
        const original = el.scrollTop;
        let prev = el.scrollTop;
        let stable = 0;
        let scrolls = 0;
        let reachedBottom = false;

        while (scrolls < maxScrollsPerContainer) {
          el.scrollTop = el.scrollHeight;
          await sleep(pause);
          scrolls++;
          totalScrolls++;
          const here = el.scrollTop;
          if (here === prev) {
            stable++;
            if (stable >= 2) {
              reachedBottom = true;
              break;
            }
          } else {
            stable = 0;
          }
          prev = here;
        }
        if (reachedBottom) reachedBottomCount++;
        el.scrollTop = original;
      }

      return {
        containers: candidates.length,
        totalScrolls,
        reachedBottomCount,
      };
    },
    { maxContainers, maxScrollsPerContainer, pause },
  );
}

export interface FrameAutoScrollResult {
  /** Frames attempted, capped by maxFrames. */
  frames: number;
  /** Frames whose document or containers were scrolled at least once. */
  framesScrolled: number;
  /** Per-frame details for diagnostics and debugging. */
  details: Array<{
    url: string;
    name: string;
    main?: AutoScrollResult;
    containers?: ContainerScrollResult;
    error?: string;
  }>;
}

export interface FrameAutoScrollOptions extends AutoScrollOptions, ContainerScrollOptions {
  /** Maximum child frames to scroll (default: 20, matching capture descent). */
  maxFrames?: number;
}

export async function autoScrollChildFrames(
  page: Page,
  options: FrameAutoScrollOptions = {},
): Promise<FrameAutoScrollResult> {
  const maxFrames = options.maxFrames ?? 20;
  const frames = page.frames().filter((frame) => frame !== page.mainFrame()).slice(0, maxFrames);
  const details: FrameAutoScrollResult["details"] = [];

  for (const frame of frames) {
    try {
      const main = await autoScrollToBottom(frame, options);
      await frame.evaluate(() => window.scrollTo(0, 0)).catch(() => {});
      const containers = await autoScrollContainers(frame, options);
      details.push({
        url: frame.url(),
        name: frame.name(),
        main,
        containers,
      });
    } catch (err) {
      details.push({
        url: frame.url(),
        name: frame.name(),
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return {
    frames: details.length,
    framesScrolled: details.filter(
      (detail) =>
        (detail.main?.scrolls ?? 0) > 0 ||
        (detail.containers?.totalScrolls ?? 0) > 0,
    ).length,
    details,
  };
}
