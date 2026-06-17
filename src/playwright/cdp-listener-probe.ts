/**
 * jÄk-style event-listener detection via Chrome DevTools Protocol.
 *
 * The event-listener-registry init script wraps EventTarget.prototype
 * .addEventListener at document_start and tracks click-like listeners. That
 * covers vanilla JS, jQuery, web components, and most React 17+ delegated event
 * paths.
 *
 * What it MISSES:
 *   - Listeners attached BEFORE the init script ran (browser extensions
 *     that inject early, scripts running with even earlier execution
 *     contexts).
 *   - Listeners attached via `el.onclick = …` direct property assignment
 *     (the wrap intercepts addEventListener, not the on-prop setter).
 *   - Listeners on elements that were created and had handlers attached
 *     before the wrap was in place (rare, but possible during init-race
 *     conditions in heavily-async startup).
 *
 * CDP's DOMDebugger.getEventListeners reports all of the above. This
 * module opens a per-page CDP session, walks visible non-interactive
 * elements, and counts how many actually have click-like listeners
 * regardless of how they were attached.
 *
 * Cost: ~3 CDP round-trips per candidate (Runtime.evaluate +
 * DOMDebugger.getEventListeners + cleanup). Budgeted at 50 candidates
 * by default — adds ~1-2 s under typical conditions, longer on big
 * pages. Always-on but cheap when no candidates exist.
 */

import type { CDPSession, Page } from "playwright";

// Each candidate costs ~3 CDP round-trips (Runtime.evaluate +
// DOMDebugger.getEventListeners + cleanup). 25 keeps p99 captureState
// time bounded; bigger pages can override via the explicit budget arg.
const DEFAULT_BUDGET = 25;
const TRACKED_TYPES = new Set(["click", "mousedown", "pointerdown"]);
const CANDIDATE_SELECTOR = "div, span, li, td, p, section";

export interface CDPListenerProbeResult {
  /** Elements considered (visible, non-interactive). */
  probed: number;
  /** Elements with at least one click-like listener attached. */
  withClickListener: number;
  /** Up to 5 sample tag-and-id descriptions. */
  samples: string[];
  /** True if the CDP session attach failed entirely (capture continues). */
  cdpUnavailable: boolean;
}

interface CDPListenerEntry {
  type: string;
}

interface CDPListenersResponse {
  listeners: CDPListenerEntry[];
}

interface CDPRuntimeEvaluateResponse {
  result: { objectId?: string };
}

export async function probeListenersViaCDP(
  page: Page,
  budget: number = DEFAULT_BUDGET,
): Promise<CDPListenerProbeResult> {
  let session: CDPSession;
  try {
    session = await page.context().newCDPSession(page);
  } catch {
    return { probed: 0, withClickListener: 0, samples: [], cdpUnavailable: true };
  }

  try {
    const candidates = await page
      .evaluate(
        ({ selector, cap }: { selector: string; cap: number }) => {
          const NATIVE_INTERACTIVE = new Set(["a", "button", "input", "select", "textarea", "summary"]);
          const ARIA_INTERACTIVE = new Set([
            "button",
            "link",
            "menuitem",
            "menuitemcheckbox",
            "menuitemradio",
            "tab",
            "option",
            "switch",
            "checkbox",
            "radio",
          ]);
          const out: Array<{ index: number; description: string }> = [];
          const els = document.querySelectorAll(selector);
          for (let i = 0; i < els.length && out.length < cap; i++) {
            const el = els[i];
            const tag = el.tagName.toLowerCase();
            if (NATIVE_INTERACTIVE.has(tag)) continue;
            const role = (el.getAttribute("role") ?? "").toLowerCase();
            if (ARIA_INTERACTIVE.has(role)) continue;
            const tabindex = el.getAttribute("tabindex");
            if (tabindex !== null && parseInt(tabindex, 10) >= 0) continue;
            const rect = el.getBoundingClientRect();
            if (rect.width === 0 || rect.height === 0) continue;
            const id = el.id ? `#${el.id}` : "";
            const cls = el.className && typeof el.className === "string"
              ? "." + el.className.split(/\s+/).filter(Boolean).slice(0, 2).join(".")
              : "";
            out.push({ index: i, description: `${tag}${id}${cls}`.slice(0, 80) });
          }
          return out;
        },
        { selector: CANDIDATE_SELECTOR, cap: budget },
      )
      .catch(() => [] as Array<{ index: number; description: string }>);

    if (candidates.length === 0) {
      return { probed: 0, withClickListener: 0, samples: [], cdpUnavailable: false };
    }

    const result: CDPListenerProbeResult = {
      probed: candidates.length,
      withClickListener: 0,
      samples: [],
      cdpUnavailable: false,
    };
    const objectGroup = "tactual-cdp-listener-probe";
    const candidateLookupExpr = (idx: number) =>
      `document.querySelectorAll(${JSON.stringify(CANDIDATE_SELECTOR)})[${idx}]`;

    for (const cand of candidates) {
      try {
        const evalRes = (await session.send("Runtime.evaluate", {
          expression: candidateLookupExpr(cand.index),
          objectGroup,
        })) as CDPRuntimeEvaluateResponse;
        const objectId = evalRes.result?.objectId;
        if (!objectId) continue;
        const listenersRes = (await session.send("DOMDebugger.getEventListeners", {
          objectId,
        })) as CDPListenersResponse;
        const hasClick = listenersRes.listeners.some((l) => TRACKED_TYPES.has(l.type));
        if (hasClick) {
          result.withClickListener++;
          if (result.samples.length < 5) result.samples.push(cand.description);
        }
      } catch {
        // CDP error on a single element (detached, cross-origin frame, etc.) — skip.
      }
    }

    await session
      .send("Runtime.releaseObjectGroup", { objectGroup })
      .catch(() => {});
    return result;
  } finally {
    if (session) await session.detach().catch(() => {});
  }
}
