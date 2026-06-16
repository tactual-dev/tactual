/**
 * Wave 29: per-framework adaptive WAIT strategies.
 *
 * Generic capture/convergence already polls the aria snapshot until target
 * count stabilizes. That's framework-agnostic but slow — each poll waits
 * 400ms regardless of whether the framework has anything left to render.
 * For the cases where we KNOW which framework is on the page, we can ask
 * the framework directly: "are you done?" — and either short-circuit the
 * generic wait when it's done early, or extend it when it's still working.
 *
 * Strategies:
 *   - React: poll for the fiber's `current.alternate` to clear (means the
 *     last commit has finished — no in-flight render). Heuristic, since
 *     the React internals contract is private, but stable across versions
 *     when fiber roots are reachable from DOM elements.
 *   - Angular: use the public `getAllAngularTestabilities()` API and call
 *     `whenStable(cb)`. This is the same hook Protractor / TestBed use.
 *     Available on apps in dev mode and on production apps that haven't
 *     stripped testability.
 *   - Vue 3: wait for one rAF + microtask flush. Vue's reactivity flushes
 *     in a microtask after the trigger; rAF gives the next paint pass a
 *     chance to apply the resulting DOM mutations.
 *   - Svelte: wait for one rAF + microtask (Svelte's tick() also resolves
 *     after a microtask).
 *
 * For unknown / no framework: returns immediately. The generic convergence
 * polling in capture.ts then handles late-rendering content.
 *
 * All strategies share a budgeted timeout — if the framework never
 * reports "settled", we give up and report `settled: false`. Capture
 * still proceeds; the generic poll will catch what we missed.
 */

import type { Page } from "playwright";
import type { FrameworkSignal } from "./framework-detect.js";

export type SettleStrategy = "react" | "angular" | "vue" | "svelte" | "no-framework";

export interface SettleOptions {
  /** Hard cap on how long to wait. Default 3000ms. */
  timeout?: number;
}

export interface SettleResult {
  /** True if the framework reported settled within the budget. */
  settled: boolean;
  /** Which strategy was applied. */
  strategy: SettleStrategy;
  /** Wall-clock ms elapsed in this helper. */
  elapsedMs: number;
}

/**
 * Pick the most-specific strategy for the detected framework set, then
 * wait for it to report stable. If multiple frameworks are detected
 * (e.g. Next.js + React), prefer the most-restrictive strategy in this
 * order: angular > react > vue > svelte > no-framework.
 */
export async function waitForFrameworkSettled(
  page: Page,
  frameworks: FrameworkSignal[],
  options: SettleOptions = {},
): Promise<SettleResult> {
  const start = Date.now();
  const timeout = options.timeout ?? 3000;
  const strategy = pickStrategy(frameworks);

  if (strategy === "no-framework") {
    return { settled: true, strategy, elapsedMs: Date.now() - start };
  }

  let settled = false;
  try {
    if (strategy === "react") {
      settled = await waitForReact(page, timeout);
    } else if (strategy === "angular") {
      settled = await waitForAngular(page, timeout);
    } else if (strategy === "vue") {
      settled = await waitForVue(page, timeout);
    } else if (strategy === "svelte") {
      settled = await waitForVue(page, timeout); // same flush model
    }
  } catch {
    settled = false;
  }
  return { settled, strategy, elapsedMs: Date.now() - start };
}

function pickStrategy(frameworks: FrameworkSignal[]): SettleStrategy {
  const names = new Set(frameworks.map((f) => f.name));
  if (names.has("Angular")) return "angular";
  if (names.has("React") || names.has("Next.js") || names.has("Remix")) return "react";
  if (names.has("Vue 3") || names.has("Vue 2") || names.has("Nuxt")) return "vue";
  if (names.has("Svelte") || names.has("SvelteKit")) return "svelte";
  return "no-framework";
}

/**
 * React: poll until no fiber root has a non-null `current.alternate`.
 * `alternate` is the in-flight tree during a render; it's nulled once
 * the commit phase finishes. Polling cost is one querySelectorAll +
 * key scan per tick (~few ms).
 */
async function waitForReact(page: Page, timeout: number): Promise<boolean> {
  const result = await page
    .evaluate(
      async (budget: number) => {
        const start = Date.now();
        const findFiberRoots = (): Array<{ current: { alternate: unknown } }> => {
          const roots: Array<{ current: { alternate: unknown } }> = [];
          const all = document.querySelectorAll("*");
          for (let i = 0; i < all.length && i < 200; i++) {
            const el = all[i] as unknown as Record<string, unknown>;
            for (const key of Object.keys(el)) {
              if (key.startsWith("__reactContainer$")) {
                const v = el[key];
                if (v && typeof v === "object" && "current" in (v as object)) {
                  roots.push(v as { current: { alternate: unknown } });
                }
              }
            }
          }
          return roots;
        };

        while (Date.now() - start < budget) {
          const roots = findFiberRoots();
          // No fiber root reachable from DOM → either pre-mount or already
          // unmounted; either way, nothing in-flight to wait for.
          if (roots.length === 0) {
            // Wait one more tick in case we caught the page mid-mount,
            // then return settled.
            await new Promise<void>((resolve) => setTimeout(resolve, 50));
            const second = findFiberRoots();
            if (second.length === 0) return true;
          } else {
            const anyInFlight = roots.some(
              (r) => r.current && r.current.alternate !== null && r.current.alternate !== undefined,
            );
            if (!anyInFlight) return true;
          }
          await new Promise<void>((resolve) => setTimeout(resolve, 50));
        }
        return false;
      },
      timeout,
    )
    .catch(() => false);
  return Boolean(result);
}

/**
 * Angular: use the public getAllAngularTestabilities() API. Each
 * testability instance exposes whenStable(cb), which fires once the
 * NgZone has no pending tasks. We resolve as soon as ALL testabilities
 * report stable, or when the budget elapses.
 */
async function waitForAngular(page: Page, timeout: number): Promise<boolean> {
  const result = await page
    .evaluate(
      async (budget: number) => {
        const w = window as unknown as {
          getAllAngularTestabilities?: () => Array<{
            isStable: () => boolean;
            whenStable: (cb: () => void) => void;
          }>;
        };
        const get = w.getAllAngularTestabilities;
        if (typeof get !== "function") {
          // No testability hook (production build that stripped it). Fall
          // back to a microtask flush + small delay so any sync work
          // settles before we proceed.
          await new Promise<void>((resolve) => setTimeout(resolve, 100));
          return true;
        }
        return await new Promise<boolean>((resolve) => {
          const deadline = Date.now() + budget;
          const tick = (): void => {
            const tests = get();
            if (!tests || tests.length === 0) {
              resolve(true);
              return;
            }
            let pending = tests.length;
            let resolved = false;
            const safetyTimer = setTimeout(() => {
              if (!resolved) {
                resolved = true;
                resolve(false);
              }
            }, Math.max(0, deadline - Date.now()));
            for (const t of tests) {
              t.whenStable(() => {
                pending--;
                if (pending === 0 && !resolved) {
                  resolved = true;
                  clearTimeout(safetyTimer);
                  resolve(true);
                }
              });
            }
          };
          tick();
        });
      },
      timeout,
    )
    .catch(() => false);
  return Boolean(result);
}

/**
 * Vue / Svelte: flush microtasks then one rAF to give the framework's
 * reactivity a chance to apply DOM mutations. Bounded to a short window
 * (200ms) regardless of timeout — these flushes are typically <16ms,
 * so a longer wait usually means the page is doing work outside the
 * framework's reactivity.
 */
async function waitForVue(page: Page, timeout: number): Promise<boolean> {
  const cap = Math.min(timeout, 200);
  const result = await page
    .evaluate(
      async (budget: number) => {
        const start = Date.now();
        // Two microtask + rAF cycles — Vue's nextTick flushes after one
        // microtask; the rAF gives the browser time to paint. Doing two
        // cycles catches secondary mutations queued by the first flush.
        for (let i = 0; i < 2; i++) {
          if (Date.now() - start >= budget) return false;
          await Promise.resolve();
          await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        }
        return true;
      },
      cap,
    )
    .catch(() => false);
  return Boolean(result);
}
