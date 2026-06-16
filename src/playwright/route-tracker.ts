/**
 * SPA route-change tracker.
 *
 * Wraps history.pushState/replaceState and listens to popstate/hashchange in
 * the page; reports each event back to Node via context.exposeBinding so the
 * pipeline can attach the route history to the analysis result. Install once
 * on a BrowserContext before any page.goto — the binding and init script then
 * apply automatically to every page in the context.
 *
 * The init script is passed as a string literal rather than a function. When
 * passed as a function, Playwright serializes it via Function.prototype.
 * toString() — which captures whatever the JS runtime compiled, including
 * helpers like esbuild's __name() that aren't defined in the browser realm.
 * A literal string sidesteps that and is what actually runs in the page.
 */

import type { BrowserContext } from "playwright";

const BINDING = "__tactualRouteEmit";

export type RouteChangeKind = "pushState" | "replaceState" | "popstate" | "hashchange";

export interface RouteChange {
  kind: RouteChangeKind;
  /** Resolved absolute URL after the change. */
  url: string;
  /** Milliseconds since the tracker was started. */
  at: number;
}

export interface RouteTracker {
  /** Events recorded since start() was called. */
  readonly events: ReadonlyArray<RouteChange>;
  /** Begin recording. Subsequent calls are no-ops. */
  start(): void;
  /** Stop recording. Existing events are retained. */
  dispose(): void;
}

export async function installRouteTracker(context: BrowserContext): Promise<RouteTracker> {
  const events: RouteChange[] = [];
  let startedAt = 0;
  let active = false;

  await context.exposeBinding(BINDING, (_source, payload: unknown) => {
    if (!active) return;
    const change = coerceRouteChange(payload, Date.now() - startedAt);
    if (change) events.push(change);
  });

  await context.addInitScript(buildInitScript(BINDING));

  return {
    events,
    start() {
      if (startedAt !== 0) return;
      startedAt = Date.now();
      active = true;
    },
    dispose() {
      active = false;
    },
  };
}

export function coerceRouteChange(payload: unknown, at: number): RouteChange | null {
  if (!payload || typeof payload !== "object") return null;
  const p = payload as { kind?: unknown; url?: unknown };
  if (typeof p.kind !== "string" || typeof p.url !== "string") return null;
  if (
    p.kind !== "pushState" &&
    p.kind !== "replaceState" &&
    p.kind !== "popstate" &&
    p.kind !== "hashchange"
  ) {
    return null;
  }
  return { kind: p.kind, url: p.url, at };
}

function buildInitScript(bindingName: string): string {
  return `
(function () {
  var BINDING = ${JSON.stringify(bindingName)};
  var INSTALLED = BINDING + '__installed';
  if (window[INSTALLED]) return;
  window[INSTALLED] = true;

  function emit(kind, url) {
    var fn = window[BINDING];
    if (typeof fn !== 'function') return;
    try { fn({ kind: kind, url: url }); } catch (_) { /* binding may reject during teardown */ }
  }

  function wrap(method) {
    try {
      var orig = window.history[method].bind(window.history);
      window.history[method] = function (state, title, url) {
        var result = orig(state, title, url == null ? null : url);
        var resolved;
        try {
          resolved = (url == null) ? window.location.href : new URL(String(url), window.location.href).href;
        } catch (_) {
          resolved = window.location.href;
        }
        emit(method, resolved);
        return result;
      };
    } catch (_) { /* assignment can fail in unusual realms; binding stays untouched */ }
  }

  wrap('pushState');
  wrap('replaceState');
  window.addEventListener('popstate', function () { emit('popstate', window.location.href); });
  window.addEventListener('hashchange', function () { emit('hashchange', window.location.href); });
})();
`;
}
