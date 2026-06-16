/**
 * Tab-order walk.
 *
 * Tactual infers focusable order from DOM order (every interactive target
 * appears in state.targets in source-order). That inference breaks under
 * positive `tabindex` values, custom focus management, or skip-link
 * patterns that intentionally rearrange focus. This helper actually
 * presses Tab and records what the keyboard user traverses, so the
 * analyzer can flag divergence between the inferred and observed orders.
 *
 * Strategy: focus document.body, then press Tab up to MAX_TAB_PRESSES.
 * After each press, record the focused element's identity (tag, role,
 * accessible-name fragment, position). Stop early on:
 *   - Focus returns to body / null (end of focusable chain)
 *   - We see a previously-recorded element (cycle / focus trap)
 *
 * Cost: ~50–100 ms per Tab press × ~30 = 1.5–3 s. Opt-in via the
 * pipeline `walkTabOrder` option because of the side-effect (page focus
 * changes, possibly triggering blur/focus handlers).
 */

import type { Page } from "playwright";

const MAX_TAB_PRESSES = 30;

export interface TabStop {
  /** Lowercase tag name of the focused element. */
  tag: string;
  /** Explicit role attribute, or empty string if none. */
  role: string;
  /** First 60 chars of aria-label or text content, for human readability. */
  name: string;
  /** Effective tabIndex value (0 unless explicitly set). */
  tabIndex: number;
}

export interface TabOrderResult {
  /** Ordered focused elements as Tab is pressed from page start. */
  sequence: TabStop[];
  /** True if Tab ever produced a duplicate of a previous stop (focus trap / wrap). */
  cycledBack: boolean;
  /** True if the budget cap was hit before the chain ended naturally. */
  hitMax: boolean;
  /** True if at least one stop has tabIndex > 0 (positive-tabindex anti-pattern). */
  hasPositiveTabindex: boolean;
}

export async function walkTabOrder(page: Page): Promise<TabOrderResult> {
  // Reset focus to a known starting point so the walk is reproducible.
  await page.evaluate(() => {
    const body = document.body;
    if (body && typeof (body as HTMLElement).focus === "function") {
      (body as HTMLElement).focus({ preventScroll: true });
    }
  }).catch(() => {});

  const sequence: TabStop[] = [];
  const seen = new Set<string>();
  let cycledBack = false;
  let hitMax = false;

  for (let i = 0; i < MAX_TAB_PRESSES; i++) {
    await page.keyboard.press("Tab");
    const focused = await page
      .evaluate(() => {
        const el = document.activeElement as HTMLElement | null;
        if (!el || el === document.body) return null;
        // Identity key — id when present, otherwise an index-within-tag.
        const tag = el.tagName.toLowerCase();
        const id = el.id;
        let key = id ? `#${id}` : `${tag}@?`;
        if (!id) {
          const all = document.querySelectorAll(tag);
          for (let j = 0; j < all.length; j++) {
            if (all[j] === el) {
              key = `${tag}@${j}`;
              break;
            }
          }
        }
        const role = el.getAttribute("role") ?? "";
        const ariaLabel = el.getAttribute("aria-label") ?? "";
        const text = (el.textContent ?? "").trim();
        const name = (ariaLabel || text).slice(0, 60);
        return { tag, role, name, tabIndex: el.tabIndex, key };
      })
      .catch(() => null);

    if (!focused) break;
    if (seen.has(focused.key)) {
      cycledBack = true;
      break;
    }
    seen.add(focused.key);
    sequence.push({
      tag: focused.tag,
      role: focused.role,
      name: focused.name,
      tabIndex: focused.tabIndex,
    });

    if (i === MAX_TAB_PRESSES - 1) hitMax = true;
  }

  // Restore focus state so subsequent probes start clean.
  await page.evaluate(() => {
    const el = document.activeElement as HTMLElement | null;
    if (el && typeof el.blur === "function") el.blur();
  }).catch(() => {});

  const hasPositiveTabindex = sequence.some((s) => s.tabIndex > 0);
  return { sequence, cycledBack, hitMax, hasPositiveTabindex };
}
