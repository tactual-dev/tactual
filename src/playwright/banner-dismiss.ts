/**
 * Cookie / consent / GDPR banner dismissal.
 *
 * A huge fraction of real-world sites greet headless browsers with a
 * cookie-consent overlay that obscures real content. captureState then sees
 * mostly the banner, exploration can't reach controls behind the overlay,
 * and `possible-cookie-wall` ends up as the dominant diagnostic. This
 * helper attempts a best-effort, safety-gated click on the banner's
 * "Accept" button so analysis can proceed against the actual page.
 *
 * Safety policy:
 *   - Only clicks buttons whose accessible name matches an ACCEPT_PATTERNS
 *     entry (Accept / Accept all / OK / Got it / Allow all / I agree /
 *     I understand / Continue / Yes / Close).
 *   - Explicitly skips buttons whose name matches SKIP_PATTERNS (Decline,
 *     Reject, Manage, Preferences, Settings, Customize) — those would lead
 *     the user into a deeper consent flow rather than dismissing it.
 *   - Caps total dismissals so a misclassified non-banner overlay doesn't
 *     turn into a click-everything spree.
 *
 * Opt-in via the pipeline's `dismissBanners` option; off by default
 * because the click is a side effect on the page that the user didn't
 * explicitly request.
 */

import type { Locator, Page } from "playwright";

const BANNER_SELECTORS = [
  '[id*="cookie" i]',
  '[id*="consent" i]',
  '[id*="gdpr" i]',
  '[class*="cookie" i]',
  '[class*="consent" i]',
  '[class*="gdpr" i]',
  "[data-cookieconsent]",
  "[data-consent]",
  '[aria-label*="cookie" i]',
  '[aria-label*="consent" i]',
].join(", ");

const ACCEPT_PATTERNS: RegExp[] = [
  /^accept(\s*all(\s*cookies?)?)?$/i,
  /^i\s*agree$/i,
  /^got\s*it$/i,
  /^ok(ay)?$/i,
  /^allow(\s*all(\s*cookies?)?)?$/i,
  /^i\s*understand$/i,
  /^continue$/i,
  /^yes$/i,
  /^close$/i,
  /^agree(\s*and\s*continue)?$/i,
  /^accept\s*&\s*continue$/i,
];

const SKIP_PATTERNS: RegExp[] = [
  /reject/i,
  /decline/i,
  /manage/i,
  /preferences/i,
  /settings/i,
  /customize/i,
  /cookie\s*details/i,
  /more\s*info/i,
  /learn\s*more/i,
];

const MAX_BANNERS_TO_PROCESS = 5;
const MAX_BUTTONS_PER_BANNER = 20;

export interface BannerDismissResult {
  /** How many banners were detected as candidates. */
  candidatesFound: number;
  /** How many we attempted to click an accept button on. */
  attempted: number;
  /** How many banners we believe were successfully dismissed. */
  dismissed: number;
  /** Short labels of the buttons we clicked, for the diagnostic. */
  clickedLabels: string[];
}

export async function dismissBanners(page: Page): Promise<BannerDismissResult> {
  const result: BannerDismissResult = {
    candidatesFound: 0,
    attempted: 0,
    dismissed: 0,
    clickedLabels: [],
  };

  const candidates = await findBannerCandidates(page);
  result.candidatesFound = candidates.length;

  for (const banner of candidates) {
    const acceptBtn = await findAcceptButton(banner);
    if (!acceptBtn) continue;

    const label = await readButtonLabel(acceptBtn);
    result.attempted++;

    try {
      await acceptBtn.click({ timeout: 2000 });
      // Give the banner a moment to animate out / be removed from the DOM.
      await page.waitForTimeout(300);
      const stillVisible = await banner
        .isVisible({ timeout: 200 })
        .catch(() => false);
      if (!stillVisible) {
        result.dismissed++;
        if (label) result.clickedLabels.push(label);
      }
    } catch {
      // Click failed (detached, intercepted, timeout) — leave the banner alone.
    }
  }

  return result;
}

async function findBannerCandidates(page: Page): Promise<Locator[]> {
  const all = page.locator(BANNER_SELECTORS);
  const count = await all.count().catch(() => 0);
  if (count === 0) return [];

  const candidates: Locator[] = [];
  for (let i = 0; i < count && candidates.length < MAX_BANNERS_TO_PROCESS; i++) {
    const el = all.nth(i);
    const visible = await el.isVisible({ timeout: 200 }).catch(() => false);
    if (visible) candidates.push(el);
  }
  return candidates;
}

async function findAcceptButton(banner: Locator): Promise<Locator | null> {
  const buttons = banner.locator('button, [role="button"], a[role="button"]');
  const count = Math.min(await buttons.count().catch(() => 0), MAX_BUTTONS_PER_BANNER);
  for (let i = 0; i < count; i++) {
    const btn = buttons.nth(i);
    const label = await readButtonLabel(btn);
    if (!label) continue;
    if (SKIP_PATTERNS.some((p) => p.test(label))) continue;
    if (ACCEPT_PATTERNS.some((p) => p.test(label))) return btn;
  }
  return null;
}

async function readButtonLabel(btn: Locator): Promise<string> {
  const ariaLabel = (await btn.getAttribute("aria-label").catch(() => null)) ?? "";
  if (ariaLabel.trim()) return ariaLabel.trim();
  const text = (await btn.textContent().catch(() => null)) ?? "";
  return text.trim().slice(0, 60);
}
