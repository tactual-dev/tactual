/**
 * Wave 32: full JS-instrumented source→sink taint propagation.
 *
 * Sister to dom-invader.ts (DOM scan). That helper finds canaries that
 * happen to land in dangerous places in the FINAL DOM. This helper
 * runs at the JS layer:
 *
 *   1. Inject an init script (runs at document_start, before any page JS).
 *   2. Install a getter wrapper on each TAINT SOURCE: location.search /
 *      hash, document.cookie, document.referrer, window.name. The wrapper
 *      appends a unique canary marker to the returned string, so any
 *      page code that reads the source carries the marker through string
 *      concatenations.
 *   3. Wrap each TAINT SINK: innerHTML/outerHTML setters, insertAdjacentHTML,
 *      document.write/writeln, eval, Function constructor, setTimeout/
 *      setInterval (string-first-arg form), Element.setAttribute when the
 *      attribute name starts with "on".
 *   4. Each sink wrapper scans its arguments for any of the canary markers.
 *      A hit is recorded as `{source, sink, sample}` and bubbled to the
 *      Node side via window.__tactualTaintFlows.
 *   5. After the page settles, also send a tainted postMessage so any
 *      window.addEventListener("message") handler that pipes into a sink
 *      gets caught.
 *
 * Catches the class of bugs that the DOM-scan probe misses: code that
 * reads location.search → eval(...) without ever writing to the DOM, or
 * where the tainted value transits through a string transform that the
 * scan can't see.
 *
 * Limitations:
 *   - The canary marker becomes visible in the page; it may break
 *     functional behavior. Acceptable for security testing — this is
 *     not meant to leave running on a live user's browser.
 *   - Doesn't follow taint through `JSON.parse`, `atob`, custom string
 *     transforms — the marker is preserved across concatenation but
 *     not across functions that produce structurally different output.
 *   - Doesn't track flows through indirect property access (`obj[var]`).
 */

import type { Page } from "playwright";

export type TaintSource =
  | "location"
  | "cookie"
  | "referrer"
  | "window.name"
  | "postMessage";
export type TaintSink =
  | "innerHTML"
  | "outerHTML"
  | "insertAdjacentHTML"
  | "document.write"
  | "eval"
  | "Function"
  | "setTimeout-string"
  | "setInterval-string"
  | "event-handler-attr";

export interface TaintFlow {
  source: TaintSource;
  sink: TaintSink;
  /** Up to 80 chars showing the value that reached the sink. */
  sample: string;
  /** Stack trace at the sink site, when available (top 3 frames). */
  stack?: string[];
}

export interface TaintProbeResult {
  /** All distinct {source, sink} flows observed. */
  flows: TaintFlow[];
  /** True if any flow reaches a high-risk sink (eval, Function,
   *  innerHTML, document.write, setTimeout-string, setInterval-string,
   *  event-handler-attr). */
  risky: boolean;
}

const SOURCE_MARKERS: Record<TaintSource, string> = {
  location: "__TACTUAL_TAINT_location__",
  cookie: "__TACTUAL_TAINT_cookie__",
  referrer: "__TACTUAL_TAINT_referrer__",
  "window.name": "__TACTUAL_TAINT_window_name__",
  postMessage: "__TACTUAL_TAINT_postMessage__",
};

export interface TaintProbeOptions {
  /** Wait this long after navigation before scanning collected flows.
   *  Default 800ms — enough for synchronous + microtask + a couple of
   *  rAFs to flush. */
  postLoadWaitMs?: number;
}

export async function probeDomInvaderTaint(
  page: Page,
  url: string,
  options: TaintProbeOptions = {},
): Promise<TaintProbeResult> {
  const wait = options.postLoadWaitMs ?? 800;

  // Build the init script as a string literal (the addInitScript-as-function
  // path leaks the esbuild __name helper into the page).
  const initScript = buildInitScript(SOURCE_MARKERS);
  await page.context().addInitScript(initScript);

  // window.name has to be set BEFORE navigation for the source hook to
  // see something to taint. It's a property on `window` itself — set it
  // via an init script too. (We could share the same script, but
  // splitting keeps the source-hook script self-contained.)
  await page.context().addInitScript(`
    try {
      if (typeof window.name === 'string' && window.name.length === 0) {
        window.name = 'tactual_seed_window_name';
      }
    } catch (_) {}
  `);

  // Inject the location canary into the URL (query + fragment). This
  // is how natural code that reads window.location.search /
  // window.location.hash picks up the marker — we can't wrap those
  // getters at the property level (Chromium blocks the redefine).
  let probeUrl = url;
  try {
    const u = new URL(url);
    u.searchParams.set("tactual_taint_url", `1${SOURCE_MARKERS.location}`);
    u.hash = `tactual_taint_frag=${SOURCE_MARKERS.location}`;
    probeUrl = u.toString();
  } catch {
    /* fall through with original URL */
  }

  try {
    await page.goto(probeUrl, { waitUntil: "domcontentloaded" });
  } catch {
    return { flows: [], risky: false };
  }

  // Active probe: send a tainted postMessage so any 'message' listeners
  // get a chance to pipe it into a sink.
  await page
    .evaluate((marker: string) => {
      try {
        window.postMessage("tactual_pm_seed_" + marker, "*");
      } catch {
        // postMessage may be blocked by COOP/COEP; ignore.
      }
    }, SOURCE_MARKERS.postMessage)
    .catch(() => {});

  await page.waitForTimeout(wait);

  // Collect flows the init script accumulated.
  const raw = await page
    .evaluate(() => {
      const w = window as unknown as { __tactualTaintFlows?: TaintFlow[] };
      return Array.isArray(w.__tactualTaintFlows) ? w.__tactualTaintFlows : [];
    })
    .catch(() => [] as TaintFlow[]);

  // De-duplicate by source+sink — multiple identical flows on the same
  // page don't add information.
  const seen = new Set<string>();
  const flows: TaintFlow[] = [];
  for (const f of raw) {
    const key = `${f.source}::${f.sink}`;
    if (seen.has(key)) continue;
    seen.add(key);
    flows.push(f);
  }

  const RISKY: ReadonlySet<TaintSink> = new Set([
    "eval",
    "Function",
    "innerHTML",
    "outerHTML",
    "document.write",
    "insertAdjacentHTML",
    "setTimeout-string",
    "setInterval-string",
    "event-handler-attr",
  ]);
  const risky = flows.some((f) => RISKY.has(f.sink));

  return { flows, risky };
}

function buildInitScript(markers: Record<TaintSource, string>): string {
  // Embed the marker map literally so the page-side script can use it
  // without a Node↔page round trip.
  const json = JSON.stringify(markers);
  return `
(function () {
  if (window.__tactualTaintInstalled) return;
  window.__tactualTaintInstalled = true;
  const MARKERS = ${json};
  const flows = [];
  window.__tactualTaintFlows = flows;
  const ALL_MARKERS = Object.entries(MARKERS);

  function findSources(value) {
    if (typeof value !== 'string') {
      try { value = String(value); } catch (_) { return []; }
    }
    const found = [];
    for (let i = 0; i < ALL_MARKERS.length; i++) {
      if (value.indexOf(ALL_MARKERS[i][1]) >= 0) found.push(ALL_MARKERS[i][0]);
    }
    return found;
  }
  function record(sink, value) {
    const sources = findSources(value);
    if (sources.length === 0) return;
    let stack;
    try {
      const e = new Error();
      if (e.stack) {
        stack = e.stack.split('\\n').slice(2, 5).map(function (s) { return s.trim(); });
      }
    } catch (_) {}
    let sample;
    try { sample = String(value).slice(0, 80); } catch (_) { sample = '<unstringifiable>'; }
    // Push one record per detected source, so multi-source flows into
    // a single sink are captured rather than collapsed.
    for (let i = 0; i < sources.length; i++) {
      flows.push({ source: sources[i], sink: sink, sample: sample, stack: stack });
    }
  }

  // ---- SOURCES ----
  function wrapGetter(target, prop, sourceName, originalGetter) {
    if (!originalGetter) return;
    try {
      Object.defineProperty(target, prop, {
        configurable: true,
        get: function () {
          let v;
          try { v = originalGetter.call(this); } catch (_) { return ''; }
          if (typeof v !== 'string' || v.length === 0) return v;
          if (v.indexOf(MARKERS[sourceName]) >= 0) return v;
          return v + MARKERS[sourceName];
        },
        set: function (v) {
          // Allow writes; clear the taint if the page reassigns.
          try {
            const setter = Object.getOwnPropertyDescriptor(target, prop);
            // If we have a real setter on the descriptor, use it; else
            // assign via the object directly.
            if (setter && setter.set) setter.set.call(this, v);
          } catch (_) {}
        },
      });
    } catch (_) {}
  }

  // location.search / location.hash CANNOT be wrapped at the property
  // level — Chromium throws "Cannot redefine property: search" because
  // Location is a [[CrossOriginIsolated]] object with non-configurable
  // descriptors on the instance. Instead we inject the canary marker
  // directly into the URL (as a query param + fragment) BEFORE
  // navigation, so any natural code that reads location.search /
  // location.hash will pick up a string that already contains the
  // marker. The probe driver code (Node side) handles the URL
  // mangling — this script just makes sure the rest of the
  // instrumentation doesn't blow up if the wrap target is unreachable.

  // document.cookie
  try {
    const cdesc = Object.getOwnPropertyDescriptor(Document.prototype, 'cookie');
    if (cdesc && cdesc.get) {
      const origGet = cdesc.get, origSet = cdesc.set;
      Object.defineProperty(Document.prototype, 'cookie', {
        configurable: true,
        get: function () {
          let v;
          try { v = origGet.call(this); } catch (_) { return ''; }
          if (typeof v !== 'string' || v.length === 0) return v;
          if (v.indexOf(MARKERS.cookie) >= 0) return v;
          return v + ';' + MARKERS.cookie;
        },
        set: function (v) {
          try { origSet.call(this, v); } catch (_) {}
        },
      });
    }
  } catch (_) {}

  // document.referrer
  try {
    const rdesc = Object.getOwnPropertyDescriptor(Document.prototype, 'referrer');
    if (rdesc && rdesc.get) {
      const origGet = rdesc.get;
      Object.defineProperty(Document.prototype, 'referrer', {
        configurable: true,
        get: function () {
          let v;
          try { v = origGet.call(this); } catch (_) { return ''; }
          if (typeof v !== 'string') v = String(v || '');
          if (v.indexOf(MARKERS.referrer) >= 0) return v;
          return v + MARKERS.referrer;
        },
      });
    }
  } catch (_) {}

  // window.name
  try {
    const original = window.name;
    let stored = (typeof original === 'string' ? original : '');
    if (stored.indexOf(MARKERS['window.name']) < 0) {
      stored = stored + MARKERS['window.name'];
    }
    Object.defineProperty(window, 'name', {
      configurable: true,
      get: function () { return stored; },
      set: function (v) { stored = String(v); },
    });
  } catch (_) {}

  // ---- SINKS ----

  // innerHTML / outerHTML setters
  function wrapHtmlSetter(prop) {
    try {
      const desc = Object.getOwnPropertyDescriptor(Element.prototype, prop);
      if (!desc || !desc.set) return;
      const origSet = desc.set;
      Object.defineProperty(Element.prototype, prop, {
        configurable: true,
        get: desc.get,
        set: function (v) {
          record(prop, v);
          try { origSet.call(this, v); } catch (e) { throw e; }
        },
      });
    } catch (_) {}
  }
  wrapHtmlSetter('innerHTML');
  wrapHtmlSetter('outerHTML');

  // insertAdjacentHTML
  try {
    const orig = Element.prototype.insertAdjacentHTML;
    Element.prototype.insertAdjacentHTML = function (where, html) {
      record('insertAdjacentHTML', html);
      return orig.call(this, where, html);
    };
  } catch (_) {}

  // document.write / writeln
  try {
    const ow = document.write.bind(document);
    document.write = function (str) {
      record('document.write', str);
      return ow(str);
    };
    const owl = document.writeln.bind(document);
    document.writeln = function (str) {
      record('document.write', str);
      return owl(str);
    };
  } catch (_) {}

  // eval — must replace the GLOBAL eval; the keyword 'eval' inside
  // user code uses the global slot.
  try {
    const oeval = window.eval;
    window.eval = function (code) {
      record('eval', code);
      return oeval(code);
    };
  } catch (_) {}

  // Function constructor
  try {
    const OFunc = window.Function;
    function TaintedFunction() {
      const args = Array.prototype.slice.call(arguments);
      // Last arg is the body
      if (args.length > 0) record('Function', args[args.length - 1]);
      return OFunc.apply(this, args);
    }
    TaintedFunction.prototype = OFunc.prototype;
    window.Function = TaintedFunction;
  } catch (_) {}

  // setTimeout / setInterval (string-first-arg form is the dangerous case).
  try {
    const ost = window.setTimeout;
    window.setTimeout = function (handler, ms) {
      if (typeof handler === 'string') record('setTimeout-string', handler);
      return ost.apply(window, arguments);
    };
    const osi = window.setInterval;
    window.setInterval = function (handler, ms) {
      if (typeof handler === 'string') record('setInterval-string', handler);
      return osi.apply(window, arguments);
    };
  } catch (_) {}

  // Element.setAttribute('on*', value)
  try {
    const osa = Element.prototype.setAttribute;
    Element.prototype.setAttribute = function (name, value) {
      try {
        if (typeof name === 'string' && name.toLowerCase().indexOf('on') === 0) {
          record('event-handler-attr', value);
        }
      } catch (_) {}
      return osa.call(this, name, value);
    };
  } catch (_) {}
})();
`;
}
