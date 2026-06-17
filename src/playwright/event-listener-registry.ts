/**
 * Event-listener interception for fake-interactive detection.
 *
 * `detectFakeInteractive` in capture.ts only sees the declarative
 * `onclick="…"` form. JS-attached click handlers via `addEventListener`
 * (the modern norm — React/Vue/Svelte/jQuery all use it) are invisible
 * to a DOM scan. This installs a context-level init script that wraps
 * EventTarget.addEventListener / removeEventListener and tracks a count
 * of click-like listeners per element in a WeakMap.
 *
 * After installation, `readRegistry(page, selector)` returns the set of
 * elements matching the selector that have at least one click-like
 * listener attached. capture.ts uses that to extend its fake-interactive
 * count.
 *
 * React caveat: React 17+ uses event delegation onto its root container,
 * not per-element addEventListener. Per-element React click handlers are
 * therefore NOT in the WeakMap. capture.ts compensates by also checking
 * `__reactProps$<key>` fiber-attached properties at scan time.
 *
 * Init script is passed as a string literal — passing a function would
 * leak esbuild's __name() helper into the page realm and break the
 * intercept silently (lesson from the route-tracker work).
 */

import type { BrowserContext } from "playwright";

const REGISTRY_KEY = "__tactualEventCounts";

export async function installEventListenerRegistry(context: BrowserContext): Promise<void> {
  await context.addInitScript(buildInitScript());
}

function buildInitScript(): string {
  return `
(function () {
  var KEY = ${JSON.stringify(REGISTRY_KEY)};
  if (window[KEY]) return;
  // WeakMap so element references don't pin GC.
  var registry = new WeakMap();
  window[KEY] = registry;

  var TRACKED_TYPES = { click: 1, mousedown: 1, pointerdown: 1, keydown: 1, keyup: 1 };

  var origAdd = EventTarget.prototype.addEventListener;
  var origRemove = EventTarget.prototype.removeEventListener;

  EventTarget.prototype.addEventListener = function (type, listener, options) {
    if (TRACKED_TYPES[type]) {
      try {
        var entry = registry.get(this);
        if (!entry) { entry = {}; registry.set(this, entry); }
        entry[type] = (entry[type] || 0) + 1;
      } catch (_) { /* registry write failed; continue with normal add */ }
    }
    return origAdd.call(this, type, listener, options);
  };

  EventTarget.prototype.removeEventListener = function (type, listener, options) {
    if (TRACKED_TYPES[type]) {
      try {
        var entry = registry.get(this);
        if (entry && entry[type] > 0) entry[type] -= 1;
      } catch (_) { /* ignored */ }
    }
    return origRemove.call(this, type, listener, options);
  };
})();
`;
}

export const REGISTRY_GLOBAL_KEY = REGISTRY_KEY;
