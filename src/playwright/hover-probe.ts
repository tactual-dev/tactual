/**
 * Hover-driven popup probe.
 *
 * Pure-React/Vue tooltips and popovers that render only on hover (with no
 * `title`, `data-tooltip`, or other attribute hint) are completely
 * invisible to enrichTooltips' attribute scan and to the initial
 * ariaSnapshot. This probe hovers candidate triggers, snapshots before
 * and after, and diffs to find content that materialized — attaching it
 * as `_hoverContent: string` on the trigger target.
 *
 * Cost: each candidate adds ~600 ms hover delay + ~150 ms restore. With a
 * default budget of 10 candidates, runtime is ~7-8 s. Opt-in via the
 * pipeline's `probeHover` option.
 */

import type { Locator, Page } from "playwright";
import type { Target } from "../core/types.js";
import { parseAriaSnapshot } from "./capture.js";

const HOVER_DELAY_MS = 600;
const RESTORE_DELAY_MS = 150;
const DEFAULT_HOVER_BUDGET = 10;
const MAX_HOVER_CONTENT_CHARS = 200;

const HOVER_PROBEABLE_KINDS = new Set(["button", "link", "menuTrigger", "tab", "formField"]);

export async function probeHoverContent(
  page: Page,
  targets: Target[],
  budget: number = DEFAULT_HOVER_BUDGET,
): Promise<Target[]> {
  const candidates = pickHoverCandidates(targets, budget);
  if (candidates.length === 0) return targets;

  // Snapshot baseline before any hover so we can re-use it for the FIRST
  // candidate; subsequent candidates re-snapshot per-iteration since prior
  // hovers may have left subtle state changes (focus rings, hover counters).
  let baselineYaml = await page.ariaSnapshot().catch(() => "");
  let baselineIds = new Set(parseAriaSnapshot(baselineYaml).map((t) => t.id));

  const out = [...targets];
  for (const candidate of candidates) {
    const idx = out.findIndex((t) => t.id === candidate.id);
    if (idx < 0) continue;

    const hoverContent = await probeOneHover(page, candidate, baselineIds);
    if (hoverContent) {
      (out[idx] as Record<string, unknown>)._hoverContent = hoverContent;
    }

    // Refresh baseline after each probe so the next candidate's diff
    // doesn't pick up stale hover content from this iteration.
    baselineYaml = await page.ariaSnapshot().catch(() => baselineYaml);
    baselineIds = new Set(parseAriaSnapshot(baselineYaml).map((t) => t.id));
  }
  return out;
}

function pickHoverCandidates(targets: Target[], budget: number): Target[] {
  return targets
    .filter((t) => HOVER_PROBEABLE_KINDS.has(t.kind) && t.name)
    // Skip targets that already have an attribute-derived tooltip — we'd
    // just re-discover the same content via hover.
    .filter((t) => (t as Record<string, unknown>)._tooltip === undefined)
    .slice(0, budget);
}

async function probeOneHover(
  page: Page,
  target: Target,
  baselineIds: Set<string>,
): Promise<string | undefined> {
  try {
    const locator = await locatorFor(page, target);
    const visible = await locator.isVisible({ timeout: 1000 }).catch(() => false);
    if (!visible) return undefined;

    await locator.hover({ timeout: 2000 });
    await page.waitForTimeout(HOVER_DELAY_MS);

    const afterYaml = await page.ariaSnapshot().catch(() => "");
    const afterTargets = parseAriaSnapshot(afterYaml);
    const newTargets = afterTargets.filter((t) => !baselineIds.has(t.id));

    // Move mouse out of the way to dismiss the hover-triggered content
    // before the next probe.
    await page.mouse.move(0, 0).catch(() => {});
    await page.waitForTimeout(RESTORE_DELAY_MS);

    if (newTargets.length === 0) return undefined;
    return formatHoverContent(newTargets);
  } catch {
    return undefined;
  }
}

function formatHoverContent(newTargets: Target[]): string | undefined {
  // Prefer named text content (tooltip/popover usually has copy), fall back
  // to role labels for icon-only popovers.
  const named = newTargets.filter((t) => t.name).map((t) => t.name).filter(Boolean);
  if (named.length > 0) {
    const joined = named.join(" | ");
    return joined.length > MAX_HOVER_CONTENT_CHARS
      ? joined.slice(0, MAX_HOVER_CONTENT_CHARS - 1) + "…"
      : joined;
  }
  const roles = newTargets.map((t) => t.role).filter(Boolean);
  if (roles.length === 0) return undefined;
  return `[${roles.length} role-only target${roles.length === 1 ? "" : "s"}: ${roles.slice(0, 5).join(", ")}]`;
}

async function locatorFor(page: Page, target: Target): Promise<Locator> {
  if (target.role && target.name) {
    return page.getByRole(target.role as Parameters<Page["getByRole"]>[0], {
      name: target.name,
      exact: true,
    }).first();
  }
  if (target.selector) return page.locator(target.selector).first();
  // Should not happen — pickHoverCandidates filters to t.name elements.
  throw new Error(`Hover probe: target ${target.id} lacks role+name and selector`);
}
