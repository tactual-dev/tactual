/**
 * Detect the SPA framework(s) present on a page.
 *
 * Used to inform per-framework adaptive strategies: e.g. wait for
 * React fiber commits, expect Vue's __vnode markers, recognize
 * Next.js / Nuxt routing patterns. Initial value: surface as a
 * `framework-detected` info diagnostic so users can see what stack
 * Tactual thinks they're on. Future: feed into capture/explore
 * strategy choices.
 *
 * Detection signals are conservative — only DOM markers that are
 * unambiguously framework-specific. We avoid `window.React` /
 * `window.Vue` checks because those vary by build and bundling.
 */

import type { Page } from "playwright";

export interface FrameworkSignal {
  name: string;
  /** Detected version, if discoverable from DOM markers (rare). */
  version?: string;
  /** Short reason for the detection — e.g. `[ng-version="17.3.0"]`. */
  evidence: string;
}

export interface DetectFrameworksOptions {
  /** Total time to retry when no framework is detected initially. Some
   *  frameworks (Next.js App Router with React Server Components, late
   *  client hydration) install fiber keys / data-* attrs only AFTER
   *  the load event. Default 800ms total, polled every 200ms. */
  hydrationWaitMs?: number;
}

export async function detectFrameworks(
  page: Page,
  options: DetectFrameworksOptions = {},
): Promise<FrameworkSignal[]> {
  const budget = options.hydrationWaitMs ?? 800;
  const start = Date.now();
  let result = await runDetect(page);
  // If we found nothing on the first probe but the page has scripts
  // (likely an SPA/SSR shell still hydrating), retry briefly.
  while (result.length === 0 && Date.now() - start < budget) {
    await page.waitForTimeout(200);
    result = await runDetect(page);
  }
  return result;
}

async function runDetect(page: Page): Promise<FrameworkSignal[]> {
  return page
    .evaluate(() => {
      const signals: Array<{ name: string; version?: string; evidence: string }> = [];

      // React (any version): __reactContainer$, __reactFiber$, __reactProps$
      // Or the data-reactroot attribute (React 16 SSR).
      // Modern Next.js App Router puts fiber keys directly on <body> with
      // no #__next root, so we have to scan body and html themselves —
      // not just descendants.
      const reactRoot = document.querySelector("[data-reactroot]");
      if (reactRoot) signals.push({ name: "React", evidence: "[data-reactroot] present" });
      else {
        const candidates: Element[] = [];
        if (document.body) candidates.push(document.body);
        if (document.documentElement) candidates.push(document.documentElement);
        if (document.body) {
          const desc = document.body.querySelectorAll("*");
          for (let i = 0; i < Math.min(desc.length, 80); i++) candidates.push(desc[i]);
        }
        for (const el of candidates) {
          const obj = el as unknown as Record<string, unknown>;
          for (const key of Object.keys(obj)) {
            if (
              key.startsWith("__reactContainer$") ||
              key.startsWith("__reactFiber$") ||
              key.startsWith("__reactProps$")
            ) {
              signals.push({ name: "React", evidence: `${key} fiber prop on DOM element` });
              break;
            }
          }
          if (signals.some((s) => s.name === "React")) break;
        }
      }

      // Next.js: #__next root, __NEXT_DATA__ script (no version in
      // __NEXT_DATA__ — only buildId, which we don't surface)
      if (document.getElementById("__next")) {
        signals.push({ name: "Next.js", evidence: "#__next root + __NEXT_DATA__ script" });
      }

      // Vue 3: __vue_app__ on root, [data-v-app] marker, or VitePress shell
      const vueAppEl = document.querySelector("[data-v-app]");
      if (vueAppEl) signals.push({ name: "Vue 3", evidence: "[data-v-app] marker" });
      else {
        // VitePress (vuejs.org, vitepress sites) doesn't set [data-v-app]
        // but does install __vue_app__ as a JS prop on the mounted root.
        // Scan body/html and a small sample for the prop.
        const probes: Element[] = [];
        if (document.body) probes.push(document.body);
        if (document.documentElement) probes.push(document.documentElement);
        const candidates = document.querySelectorAll("#app, [id^='app'], main");
        for (let i = 0; i < Math.min(candidates.length, 5); i++) probes.push(candidates[i]);
        for (const el of probes) {
          const obj = el as unknown as Record<string, unknown>;
          if (obj.__vue_app__) {
            signals.push({ name: "Vue 3", evidence: "__vue_app__ JS prop on mount root" });
            break;
          }
        }
      }
      // Vue 2: vnode-key attributes
      const vue2El = document.querySelector("[data-v-]");
      if (vue2El && !signals.some((s) => s.name.startsWith("Vue"))) {
        signals.push({ name: "Vue 2", evidence: "[data-v-] scoped style attr" });
      }

      // Nuxt: #__nuxt root
      if (document.getElementById("__nuxt")) {
        signals.push({ name: "Nuxt", evidence: "#__nuxt root" });
      }

      // Angular: [ng-version="…"] on root
      const ngEl = document.querySelector("[ng-version]");
      if (ngEl) {
        const version = ngEl.getAttribute("ng-version") ?? undefined;
        signals.push({ name: "Angular", version, evidence: `[ng-version="${version}"]` });
      }

      // Svelte / SvelteKit: original marker attrs (Svelte 4) + modern
      // SvelteKit 2 markers (data-sveltekit-preload-data on html, scoped
      // style classes svelte-XXXXXX on rendered elements).
      const svelteH = document.querySelector("[data-svelte-h]");
      const svelteHydrate = document.querySelector("[data-sveltekit-hydrate]");
      const svelteKitAttr =
        document.documentElement.hasAttribute("data-sveltekit-preload-data") ||
        document.documentElement.hasAttribute("data-sveltekit-preload-code") ||
        !!document.querySelector("[data-sveltekit-preload-data], [data-sveltekit-preload-code]");
      let svelteScoped = false;
      if (!svelteH && !svelteHydrate) {
        // Cheap check: query any element with a class starting "svelte-".
        // Use [class*="svelte-"] which matches substring; cap by stopping
        // at the first match (querySelector returns single).
        if (document.querySelector('[class*="svelte-"]')) svelteScoped = true;
      }
      if (svelteH || svelteHydrate || svelteKitAttr || svelteScoped) {
        const isKit = svelteHydrate || svelteKitAttr;
        const evidence = svelteH
          ? "data-svelte-h marker"
          : svelteHydrate
            ? "data-sveltekit-hydrate marker"
            : svelteKitAttr
              ? "data-sveltekit-preload-* attr"
              : "svelte-XXXXXX scoped style class";
        signals.push({ name: isKit ? "SvelteKit" : "Svelte", evidence });
      }

      // Remix: __remixContext script
      if (document.querySelector("script:not([src])[data-remix]") || document.getElementById("remix-context")) {
        signals.push({ name: "Remix", evidence: "remix-context / data-remix script" });
      }

      // Astro: data-astro-cid-* attributes
      if (document.querySelector("[data-astro-cid-]")) {
        signals.push({ name: "Astro", evidence: "data-astro-cid-* marker" });
      }

      // SolidJS / Preact / Lit: harder to detect reliably; skip for v1.

      return signals;
    })
    .catch(() => [] as FrameworkSignal[]);
}
