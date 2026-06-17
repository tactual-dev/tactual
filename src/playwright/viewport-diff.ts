/**
 * Wave 31: mobile-vs-desktop divergence diff.
 *
 * Capture the same URL at two viewports (default desktop 1280×800 and
 * mobile 375×667 = iPhone SE-2 logical resolution) then diff the
 * resulting target lists. Surfaces three classes of divergence:
 *
 *   - Targets present at one viewport but not the other (e.g. desktop
 *     nav links collapsed into a hamburger on mobile, sidebar hidden
 *     on small screens)
 *   - Landmarks present at one viewport but not the other (e.g.
 *     `<aside>` set to `display: none` on mobile)
 *   - Headings present at one viewport but not the other (less common
 *     but signals when whole sections vanish)
 *
 * Why this matters for accessibility: many SR users on mobile devices
 * are using the same site as desktop users. Content that's
 * `display: none` on mobile is genuinely missing for them — not just
 * visually hidden. An "Open menu" hamburger that hides nav links is
 * still operable (assuming the toggle is wired up), but a sidebar
 * with content that vanishes on small screens leaves a real
 * navigation gap.
 *
 * This helper navigates the page TWICE (one per viewport) and accepts
 * the original URL as input — it doesn't try to mutate the existing
 * page's viewport in-place because some sites do route-time SSR based
 * on UA / viewport hints, so a fresh navigation is the only reliable
 * way to get parity.
 */

import type { Page } from "playwright";
import { captureState, parseAriaSnapshot } from "./capture.js";
import type { PageState, Target } from "../core/types.js";

export interface ViewportSize {
  width: number;
  height: number;
}

export interface ViewportDiffOptions {
  /** URL to navigate to. Required because we re-navigate per viewport. */
  url: string;
  /** Default 1280×800. */
  desktopViewport?: ViewportSize;
  /** Default 375×667 (iPhone SE 2nd gen). */
  mobileViewport?: ViewportSize;
  /** SPA wait timeout per capture; default 12000ms. */
  spaWaitTimeout?: number;
  /** Optional UA string for the mobile capture (omitted by default — viewport
   *  width is usually enough to trigger responsive media queries). */
  mobileUserAgent?: string;
}

export interface ViewportSnapshot {
  viewport: ViewportSize;
  targetCount: number;
  /** Trimmed target records — only the fields needed for the diff so
   *  consumers don't accidentally rely on capture-only metadata. */
  targets: Array<{ id: string; kind: Target["kind"]; role?: string; name: string }>;
  landmarks: Array<{ role: string; name: string }>;
  headings: string[];
}

export interface ViewportDivergences {
  /** Targets in desktop but not mobile (matched by kind+name). */
  targetsOnlyOnDesktop: Array<{ kind: Target["kind"]; name: string }>;
  targetsOnlyOnMobile: Array<{ kind: Target["kind"]; name: string }>;
  landmarksOnlyOnDesktop: Array<{ role: string; name: string }>;
  landmarksOnlyOnMobile: Array<{ role: string; name: string }>;
  headingsOnlyOnDesktop: string[];
  headingsOnlyOnMobile: string[];
}

export interface ViewportDiffResult {
  desktop: ViewportSnapshot;
  mobile: ViewportSnapshot;
  divergences: ViewportDivergences;
  /** Heuristic count of "missing on mobile" issues — handy for one-line
   *  diagnostic messages. */
  missingOnMobileCount: number;
  missingOnDesktopCount: number;
}

const DEFAULT_DESKTOP: ViewportSize = { width: 1280, height: 800 };
const DEFAULT_MOBILE: ViewportSize = { width: 375, height: 667 };

export async function diffViewports(
  page: Page,
  options: ViewportDiffOptions,
): Promise<ViewportDiffResult> {
  const desktop = options.desktopViewport ?? DEFAULT_DESKTOP;
  const mobile = options.mobileViewport ?? DEFAULT_MOBILE;
  const timeout = options.spaWaitTimeout ?? 12000;

  const desktopSnap = await captureAtViewport(page, options.url, desktop, timeout);
  // Apply mobile UA (if any) before the second navigation so the server
  // can branch on it during SSR.
  if (options.mobileUserAgent) {
    await page.context().setExtraHTTPHeaders({ "User-Agent": options.mobileUserAgent });
  }
  const mobileSnap = await captureAtViewport(page, options.url, mobile, timeout);

  const divergences = computeDivergences(desktopSnap, mobileSnap);
  return {
    desktop: desktopSnap,
    mobile: mobileSnap,
    divergences,
    missingOnMobileCount:
      divergences.targetsOnlyOnDesktop.length +
      divergences.landmarksOnlyOnDesktop.length +
      divergences.headingsOnlyOnDesktop.length,
    missingOnDesktopCount:
      divergences.targetsOnlyOnMobile.length +
      divergences.landmarksOnlyOnMobile.length +
      divergences.headingsOnlyOnMobile.length,
  };
}

async function captureAtViewport(
  page: Page,
  url: string,
  viewport: ViewportSize,
  timeout: number,
): Promise<ViewportSnapshot> {
  await page.setViewportSize(viewport);
  await page.goto(url, { waitUntil: "domcontentloaded" });
  const state = await captureState(page, {
    spaWaitTimeout: timeout,
    provenance: "scripted",
  });
  return summarize(state, viewport);
}

function summarize(state: PageState, viewport: ViewportSize): ViewportSnapshot {
  const targets = state.targets.map((t) => ({
    id: t.id,
    kind: t.kind,
    role: (t as Record<string, unknown>).role as string | undefined,
    name: t.name ?? "",
  }));
  const landmarks: Array<{ role: string; name: string }> = [];
  const headings: string[] = [];
  for (const t of state.targets) {
    if (t.kind === "landmark") {
      landmarks.push({
        role: ((t as Record<string, unknown>).role as string) ?? "region",
        name: t.name ?? "",
      });
    } else if (t.kind === "heading") {
      headings.push(t.name ?? "");
    }
  }
  return {
    viewport,
    targetCount: targets.length,
    targets,
    landmarks,
    headings,
  };
}

function computeDivergences(
  desktop: ViewportSnapshot,
  mobile: ViewportSnapshot,
): ViewportDivergences {
  // Match targets by kind+name. Two targets that share both are treated
  // as the "same" content even if the IDs differ (id includes a counter
  // suffix that may shift between viewports).
  const desktopKeys = new Map<string, { kind: Target["kind"]; name: string }>();
  const mobileKeys = new Map<string, { kind: Target["kind"]; name: string }>();
  for (const t of desktop.targets) desktopKeys.set(`${t.kind}::${t.name}`, t);
  for (const t of mobile.targets) mobileKeys.set(`${t.kind}::${t.name}`, t);

  const targetsOnlyOnDesktop: Array<{ kind: Target["kind"]; name: string }> = [];
  const targetsOnlyOnMobile: Array<{ kind: Target["kind"]; name: string }> = [];
  for (const [k, v] of desktopKeys) {
    if (!mobileKeys.has(k)) targetsOnlyOnDesktop.push({ kind: v.kind, name: v.name });
  }
  for (const [k, v] of mobileKeys) {
    if (!desktopKeys.has(k)) targetsOnlyOnMobile.push({ kind: v.kind, name: v.name });
  }

  const desktopLandmarks = new Set(desktop.landmarks.map((l) => `${l.role}::${l.name}`));
  const mobileLandmarks = new Set(mobile.landmarks.map((l) => `${l.role}::${l.name}`));
  const landmarksOnlyOnDesktop = desktop.landmarks.filter(
    (l) => !mobileLandmarks.has(`${l.role}::${l.name}`),
  );
  const landmarksOnlyOnMobile = mobile.landmarks.filter(
    (l) => !desktopLandmarks.has(`${l.role}::${l.name}`),
  );

  const desktopHeadings = new Set(desktop.headings);
  const mobileHeadings = new Set(mobile.headings);
  const headingsOnlyOnDesktop = desktop.headings.filter((h) => !mobileHeadings.has(h));
  const headingsOnlyOnMobile = mobile.headings.filter((h) => !desktopHeadings.has(h));

  return {
    targetsOnlyOnDesktop,
    targetsOnlyOnMobile,
    landmarksOnlyOnDesktop,
    landmarksOnlyOnMobile,
    headingsOnlyOnDesktop,
    headingsOnlyOnMobile,
  };
}

// Re-export for downstream consumers that want to do their own scan.
export { parseAriaSnapshot };
