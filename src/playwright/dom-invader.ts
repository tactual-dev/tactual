/**
 * Burp DOM Invader-style canary injection (v1 framework).
 *
 * Standalone security-probing utility — NOT wired into the default
 * capture pipeline. Tactual is an accessibility tool; this module
 * exists for the subset of users who also care about DOM-XSS
 * surface area on the same pages.
 *
 * Algorithm:
 *   1. Generate a unique canary string (high-entropy, recognizable).
 *   2. For each target URL, navigate with the canary appended as a
 *      query parameter (and optionally fragment).
 *   3. After page load, scan the DOM for the canary appearing in
 *      "dangerous" sinks:
 *        - <script> textContent (reflected into inline JS)
 *        - on-* event-handler attributes (onclick, onerror, etc.)
 *        - href / src attributes starting with javascript:
 *   4. Report findings; flag risky if any sink class fires.
 *
 * What this MISSES (Burp DOM Invader does):
 *   - Source/sink taint propagation through JS execution
 *   - Postmessage-based attacks
 *   - Prototype pollution via __proto__ / constructor
 *   - CSP bypass attempts
 *   - Reflected canaries via fetch / XHR responses
 *
 * v1 catches the most common pattern (URL param echoed unsafely
 * into innerHTML / inline script). Real DOM-XSS testing should use
 * Burp DOM Invader.
 */

import type { Page } from "playwright";

export interface DomInvaderFinding {
  /** Where the canary appeared. */
  context:
    | "script-content"
    | "event-handler-attr"
    | "javascript-url"
    | "innerHTML-attr"
    | "other-attr";
  /** Element selector-ish description. */
  selector: string;
  /** Up to 80 chars of the surrounding text/value. */
  sample: string;
}

export interface DomInvaderResult {
  /** The canary string that was injected. */
  canary: string;
  /** URL that was probed (with canary appended). */
  probeUrl: string;
  /** All findings, sorted by risk (script-content highest). */
  findings: DomInvaderFinding[];
  /** True if any HIGH-risk context fired (script-content, event-handler,
   *  javascript-url). innerHTML-attr / other-attr are lower-confidence. */
  risky: boolean;
}

const CANARY_PARAM = "tactual_canary";

export interface DomInvaderOptions {
  /** Override the canary param name; default `tactual_canary`. */
  canaryParam?: string;
  /** Also inject into the URL fragment. Some sites parse window.location.hash
   *  unsafely. Default false. */
  alsoUseFragment?: boolean;
  /** Wave 27: multi-source taint propagation. When true, also inject
   *  unique canaries into localStorage, sessionStorage, document.cookie,
   *  and via window.postMessage — then track which source flows into
   *  which sink. Disabled by default to keep the basic probe fast. */
  multiSource?: boolean;
}

export interface MultiSourceCanary {
  source: "url-param" | "url-fragment" | "local-storage" | "session-storage" | "cookie" | "post-message";
  canary: string;
  /** Findings for THIS canary specifically. */
  findings: DomInvaderFinding[];
}

export interface MultiSourceResult {
  /** All canaries that were injected. */
  canaries: MultiSourceCanary[];
  /** Cross-source contamination summary: which sources reach which
   *  sinks (the most useful black-widow signal). */
  contamination: Array<{
    source: MultiSourceCanary["source"];
    sinkContext: DomInvaderFinding["context"];
    samples: string[];
  }>;
  risky: boolean;
}

/**
 * Wave 27 multi-source variant. Injects a unique canary into each of
 * URL param / fragment / localStorage / sessionStorage / cookie /
 * postMessage, then performs ONE scan looking for any of them in
 * dangerous sinks. Reports per-source findings + a cross-source
 * contamination map (which source reached which sink class). Costs
 * one extra page reload to seed storage / cookie before navigation,
 * plus a postMessage after load.
 */
export async function probeDomInvaderMultiSource(
  page: Page,
  url: string,
): Promise<MultiSourceResult> {
  const stamp = Date.now().toString(36);
  const rand = () => Math.random().toString(36).slice(2, 8);
  const canaries: MultiSourceCanary[] = [
    { source: "url-param", canary: `TACTUAL_URL_${stamp}_${rand()}`, findings: [] },
    { source: "url-fragment", canary: `TACTUAL_FRAG_${stamp}_${rand()}`, findings: [] },
    { source: "local-storage", canary: `TACTUAL_LS_${stamp}_${rand()}`, findings: [] },
    { source: "session-storage", canary: `TACTUAL_SS_${stamp}_${rand()}`, findings: [] },
    { source: "cookie", canary: `TACTUAL_CK_${stamp}_${rand()}`, findings: [] },
    { source: "post-message", canary: `TACTUAL_PM_${stamp}_${rand()}`, findings: [] },
  ];

  // Seed storage / cookies via an init script (runs at document_start
  // on the next navigation).
  const seedingScript = `
    (function () {
      try { localStorage.setItem('tactual_canary_ls', ${JSON.stringify(canaries[2].canary)}); } catch (_) {}
      try { sessionStorage.setItem('tactual_canary_ss', ${JSON.stringify(canaries[3].canary)}); } catch (_) {}
      try { document.cookie = 'tactual_canary_ck=' + ${JSON.stringify(canaries[4].canary)} + '; path=/'; } catch (_) {}
    })();
  `;
  await page.context().addInitScript(seedingScript);

  // Construct probe URL with both query and fragment canaries
  let probeUrl: string;
  try {
    const u = new URL(url);
    u.searchParams.set("tactual_canary_url", canaries[0].canary);
    u.hash = `tactual_canary_frag=${encodeURIComponent(canaries[1].canary)}`;
    probeUrl = u.toString();
  } catch {
    return { canaries, contamination: [], risky: false };
  }

  await page.goto(probeUrl, { waitUntil: "domcontentloaded" }).catch(() => {});
  // Send postMessage canary after load — gives the page time to attach
  // any window.addEventListener('message') listeners.
  await page.waitForTimeout(300);
  await page
    .evaluate((c) => window.postMessage({ tactual_canary_pm: c }, "*"), canaries[5].canary)
    .catch(() => {});
  await page.waitForTimeout(300);

  // ONE scan across all canaries for efficiency
  const allFindings = await page
    .evaluate((cs: Array<{ source: string; canary: string }>) => {
      const out: Array<{
        source: string;
        finding: {
          context:
            | "script-content"
            | "event-handler-attr"
            | "javascript-url"
            | "innerHTML-attr"
            | "other-attr";
          selector: string;
          sample: string;
        };
      }> = [];
      const describe = (el: Element): string => {
        const id = el.id ? `#${el.id}` : "";
        return `${el.tagName.toLowerCase()}${id}`.slice(0, 80);
      };



      const scripts = document.querySelectorAll("script:not([src])");
      for (let i = 0; i < scripts.length; i++) {
        const text = scripts[i].textContent ?? "";
        for (const c of cs) {
          const idx = text.indexOf(c.canary);
          if (idx >= 0) {
            out.push({
              source: c.source,
              finding: {
                context: "script-content",
                selector: describe(scripts[i]),
                sample: text.slice(Math.max(0, idx - 20), idx + c.canary.length + 20),
              },
            });
          }
        }
      }

      const SCAN_CAP = 4000;
      const all = document.querySelectorAll("*");
      for (let i = 0; i < all.length && i < SCAN_CAP; i++) {
        const el = all[i];
        for (let j = 0; j < el.attributes.length; j++) {
          const attr = el.attributes[j];
          for (const c of cs) {
            if (!attr.value.includes(c.canary)) continue;
            const sample = attr.value.slice(0, 80);
            let context: typeof out[number]["finding"]["context"];
            if (attr.name.startsWith("on")) context = "event-handler-attr";
            else if (
              (attr.name === "href" || attr.name === "src") &&
              attr.value.toLowerCase().startsWith("javascript:")
            ) {
              context = "javascript-url";
            } else if (attr.name === "innerHTML") context = "innerHTML-attr";
            else context = "other-attr";
            out.push({
              source: c.source,
              finding: { context, selector: describe(el), sample },
            });
          }
        }
      }
      return out;
    }, canaries.map((c) => ({ source: c.source, canary: c.canary })))
    .catch(
      () =>
        [] as Array<{
          source: string;
          finding: DomInvaderFinding;
        }>,
    );

  // Distribute findings to per-source records
  const sourceMap = new Map<MultiSourceCanary["source"], MultiSourceCanary>();
  for (const c of canaries) sourceMap.set(c.source, c);
  for (const f of allFindings) {
    const c = sourceMap.get(f.source as MultiSourceCanary["source"]);
    if (c) c.findings.push(f.finding as DomInvaderFinding);
  }

  // Build cross-source contamination summary
  const contaminationMap = new Map<
    string,
    { source: MultiSourceCanary["source"]; sinkContext: DomInvaderFinding["context"]; samples: string[] }
  >();
  for (const c of canaries) {
    for (const f of c.findings) {
      const key = `${c.source}:${f.context}`;
      let entry = contaminationMap.get(key);
      if (!entry) {
        entry = { source: c.source, sinkContext: f.context, samples: [] };
        contaminationMap.set(key, entry);
      }
      if (entry.samples.length < 3) entry.samples.push(f.sample);
    }
  }

  const contamination = [...contaminationMap.values()];
  const RISKY_CONTEXTS = new Set([
    "script-content",
    "event-handler-attr",
    "javascript-url",
  ]);
  const risky = contamination.some((c) => RISKY_CONTEXTS.has(c.sinkContext));

  return { canaries, contamination, risky };
}

export async function probeDomInvader(
  page: Page,
  url: string,
  options: DomInvaderOptions = {},
): Promise<DomInvaderResult> {
  const canary = `TACTUAL_XSS_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
  const param = options.canaryParam ?? CANARY_PARAM;

  let probeUrl: string;
  try {
    const u = new URL(url);
    u.searchParams.set(param, canary);
    if (options.alsoUseFragment) {
      u.hash = `${param}=${encodeURIComponent(canary)}`;
    }
    probeUrl = u.toString();
  } catch {
    return { canary, probeUrl: url, findings: [], risky: false };
  }

  try {
    await page.goto(probeUrl, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(500);
  } catch {
    return { canary, probeUrl, findings: [], risky: false };
  }

  const findings = await page
    .evaluate((c: string) => {
      const out: Array<{
        context:
          | "script-content"
          | "event-handler-attr"
          | "javascript-url"
          | "innerHTML-attr"
          | "other-attr";
        selector: string;
        sample: string;
      }> = [];
      const describe = (el: Element): string => {
        const id = el.id ? `#${el.id}` : "";
        const cls = el.className && typeof el.className === "string"
          ? "." + el.className.split(/\s+/).filter(Boolean).slice(0, 2).join(".")
          : "";
        return `${el.tagName.toLowerCase()}${id}${cls}`.slice(0, 80);
      };

      // Inline script content — highest risk
      const scripts = document.querySelectorAll("script:not([src])");
      for (let i = 0; i < scripts.length; i++) {
        const s = scripts[i];
        const text = s.textContent ?? "";
        if (text.includes(c)) {
          const idx = text.indexOf(c);
          const start = Math.max(0, idx - 30);
          out.push({
            context: "script-content",
            selector: describe(s),
            sample: text.slice(start, idx + c.length + 30),
          });
        }
      }

      // Walk all elements for canary-in-attribute
      const SCAN_CAP = 5000;
      const all = document.querySelectorAll("*");
      for (let i = 0; i < all.length && i < SCAN_CAP; i++) {
        const el = all[i];
        for (let j = 0; j < el.attributes.length; j++) {
          const attr = el.attributes[j];
          if (!attr.value.includes(c)) continue;
          const sample = attr.value.slice(0, 80);
          if (attr.name.startsWith("on")) {
            out.push({ context: "event-handler-attr", selector: describe(el), sample });
          } else if (
            (attr.name === "href" || attr.name === "src") &&
            attr.value.toLowerCase().startsWith("javascript:")
          ) {
            out.push({ context: "javascript-url", selector: describe(el), sample });
          } else if (attr.name === "innerHTML") {
            // Rare but possible if author wrote it as a literal attribute
            out.push({ context: "innerHTML-attr", selector: describe(el), sample });
          } else {
            // Echoed into a regular attribute — usually safe but worth noting
            out.push({ context: "other-attr", selector: describe(el), sample });
          }
        }
      }
      return out;
    }, canary)
    .catch(() => [] as DomInvaderFinding[]);

  // Sort by risk: script-content > event-handler > javascript-url > innerHTML > other
  const RISK_ORDER: Record<DomInvaderFinding["context"], number> = {
    "script-content": 0,
    "event-handler-attr": 1,
    "javascript-url": 2,
    "innerHTML-attr": 3,
    "other-attr": 4,
  };
  findings.sort((a, b) => RISK_ORDER[a.context] - RISK_ORDER[b.context]);

  const risky = findings.some(
    (f) =>
      f.context === "script-content" ||
      f.context === "event-handler-attr" ||
      f.context === "javascript-url",
  );

  return { canary, probeUrl, findings, risky };
}
