/// <reference lib="dom" />
import type { Page } from "playwright";
import { createHash } from "crypto";
import type { PageState, Target, TargetKind } from "../core/types.js";

export interface CaptureOptions {
  /** Device descriptor name (e.g., "iPhone 14") */
  device?: string;
  /** State provenance */
  provenance?: "scripted" | "explored" | "crawled";
  /** Max depth for aria snapshot */
  snapshotDepth?: number;
  /** Minimum target count to consider the page "rendered" (default: 3) */
  minTargets?: number;
  /** Max wait time in ms for SPA content to render (default: 15000) */
  spaWaitTimeout?: number;
  /** CSS selectors to exclude from the accessibility tree before capture */
  excludeSelectors?: string[];
  /** CSS selectors that define the subtree(s) to include in capture */
  scopeSelectors?: string[];
}

/**
 * Capture the current page state including accessibility snapshot and targets.
 * Uses Playwright's modern `page.ariaSnapshot()` API.
 *
 * For SPAs, uses convergence-based waiting: keeps snapshotting until
 * the target count stops growing, rather than relying on network idle
 * (which fails for WebSocket-heavy apps).
 */
export async function captureState(page: Page, options: CaptureOptions = {}): Promise<PageState> {
  const url = page.url();
  const route = new URL(url).pathname;
  const viewport = page.viewportSize() ?? undefined;

  const minTargets = options.minTargets ?? 3;
  const spaTimeout = options.spaWaitTimeout ?? 15000;

  // Hide out-of-scope and excluded elements from the accessibility tree before capture.
  // Uses aria-hidden=true so they don't appear in ariaSnapshot at all.
  if (options.scopeSelectors && options.scopeSelectors.length > 0) {
    await hideOutOfScopeElements(page, options.scopeSelectors);
  }
  if (options.excludeSelectors && options.excludeSelectors.length > 0) {
    await hideExcludedElements(page, options.excludeSelectors);
  }

  // First attempt
  let snapshotYaml = await page.ariaSnapshot({ depth: options.snapshotDepth });
  let targets = parseAriaSnapshot(snapshotYaml);

  // If the snapshot is too sparse, wait for SPA content via convergence.
  if (targets.length < minTargets) {
    const result = await waitForConvergence(page, minTargets, spaTimeout, options.snapshotDepth);
    // Only use convergence result if it found more targets
    if (result.targets.length > targets.length) {
      targets = result.targets;
      snapshotYaml = result.yaml;
    }
  } else if (await shouldWaitForLikelyHydration(page, targets.length)) {
    // Some JS-heavy apps expose a small but non-empty accessibility tree
    // before hydration completes. The normal minTargets gate would treat that
    // skeleton as usable, so give likely app shells one bounded growth window.
    const hydrationTimeout = Math.min(spaTimeout, 8000);
    const minWait = Math.min(4000, Math.max(1000, hydrationTimeout / 2));
    const result = await waitForConvergence(
      page,
      minTargets,
      hydrationTimeout,
      options.snapshotDepth,
      minWait,
    );
    if (result.targets.length > targets.length) {
      targets = result.targets;
      snapshotYaml = result.yaml;
    }
  }

  // Enrich targets with ARIA reference data (describedby text, labelledby
  // validity, live regions). Single DOM pass — adds ~50ms typical.
  await enrichWithAriaReferences(page, targets);

  // Enrich link targets with their resolved href — used by the analyzer to
  // detect redundant tab stops (multiple links reaching the same destination).
  await enrichLinkHrefs(page, targets);

  // Enrich interactive targets with bounding-rect sizes so the finding builder
  // can flag WCAG 2.5.8 target-size failures (interactive elements < 24×24).
  await enrichBoundingRects(page, targets);

  // Mark native HTML controls whose accessibility roles overlap custom ARIA
  // patterns. For example, a native <select> exposes as combobox/listbox in
  // the accessibility tree, but APG combobox/listbox contract checks should
  // not require aria-expanded or aria-activedescendant on the native element.
  await enrichNativeControlMetadata(page, targets);

  const snapshotHash = hash(snapshotYaml);

  // Hash interactive elements for state dedup
  const interactiveTargets = targets.filter((t) =>
    ["button", "link", "formField", "menuTrigger", "tab", "search"].includes(t.kind),
  );
  const interactiveHash = hash(
    JSON.stringify(interactiveTargets.map((t) => `${t.kind}:${t.name}`)),
  );

  // Detect open overlays (dialogs)
  const openOverlays = targets.filter((t) => t.kind === "dialog").map((t) => t.id);

  return {
    id: `state-${snapshotHash.slice(0, 12)}`,
    url,
    route,
    device: options.device,
    viewport: viewport ? { width: viewport.width, height: viewport.height } : undefined,
    snapshotHash,
    interactiveHash,
    openOverlays,
    targets,
    timestamp: Date.now(),
    provenance: options.provenance ?? "scripted",
  };
}

// ---------------------------------------------------------------------------
// SPA convergence-based waiting
// ---------------------------------------------------------------------------

/**
 * Wait for SPA content by tracking convergence of the accessibility tree.
 *
 * Instead of relying on network idle (which fails for WebSocket-heavy SPAs
 * like Reddit), this approach:
 *
 * 1. Waits for framework render signals if available (React, Next.js, etc.)
 * 2. Repeatedly captures ariaSnapshot at intervals
 * 3. Stops when either:
 *    - The target count meets the minimum AND has stopped growing
 *      (two consecutive snapshots with same count = convergence)
 *    - The timeout is reached
 *
 * This handles progressive rendering (content streams in over time) and
 * client-rendered SPAs (content appears after JS executes).
 */
async function waitForConvergence(
  page: Page,
  minTargets: number,
  timeout: number,
  snapshotDepth?: number,
  minWaitMs: number = 0,
): Promise<{ targets: Target[]; yaml: string }> {
  const start = Date.now();
  let prevCount = -1;
  let stableRounds = 0;
  let bestTargets: Target[] = [];
  let bestYaml = "";

  // Phase 1: Wait for initial framework render signals
  await waitForFrameworkRender(page, Math.min(5000, timeout / 2));

  // Phase 2: Poll via convergence
  while (Date.now() - start < timeout) {
    await page.waitForTimeout(400);

    const yaml = await page.ariaSnapshot({ depth: snapshotDepth });
    const targets = parseAriaSnapshot(yaml);

    // Keep the best snapshot seen so far
    if (targets.length > bestTargets.length) {
      bestTargets = targets;
      bestYaml = yaml;
    }

    // Check convergence: target count stable for 2 consecutive polls
    if (targets.length === prevCount && targets.length > 0) {
      stableRounds++;
      const waitedLongEnough = Date.now() - start >= minWaitMs;
      if (stableRounds >= 2 && targets.length >= minTargets && waitedLongEnough) {
        return { targets: bestTargets, yaml: bestYaml };
      }
    } else {
      stableRounds = 0;
    }

    prevCount = targets.length;
  }

  return { targets: bestTargets, yaml: bestYaml };
}

async function shouldWaitForLikelyHydration(page: Page, targetCount: number): Promise<boolean> {
  if (targetCount >= 30) return false;
  return await page
    .evaluate((count) => {
      const body = document.body;
      if (!body) return false;

      const frameworkRoot = document.querySelector(
        "#__next, #root, #app, #__nuxt, [data-reactroot], [data-v-app], [ng-version], app-root, [data-sveltekit-hydrate], [data-svelte-h]",
      );
      const elementCount = body.querySelectorAll("*").length;
      const interactiveCount = body.querySelectorAll(
        "a[href], button, input, select, textarea, [role], [tabindex], [aria-expanded], [aria-haspopup]",
      ).length;

      return (
        Boolean(frameworkRoot) ||
        document.scripts.length >= 3 ||
        elementCount > Math.max(80, count * 20) ||
        interactiveCount > count * 3
      );
    }, targetCount)
    .catch(() => false);
}

/**
 * Wait for common SPA framework render signals.
 * Falls back gracefully if none are detected — convergence polling (Phase 2)
 * will still catch content that renders after this check.
 *
 * Detected frameworks: React, Next.js, Vue, Nuxt, Angular, Svelte, SvelteKit.
 * Also checks generic HTML5 content signals (main, headings, nav, links).
 */
async function waitForFrameworkRender(page: Page, timeout: number): Promise<void> {
  try {
    await page.waitForFunction(
      `
      (() => {
        if (document.readyState !== 'complete') return false;

        // Generic content signals (framework-agnostic)
        const hasMain = !!document.querySelector('main, [role="main"]');
        const hasHeading = !!document.querySelector('h1, h2, [role="heading"]');
        const hasNav = !!document.querySelector('nav, [role="navigation"]');
        const hasLinks = document.querySelectorAll('a[href]').length > 3;

        // React / Next.js
        const reactRoot = document.getElementById('__next')
          || document.getElementById('root')
          || document.getElementById('app');
        const hasReact = !!(reactRoot && reactRoot.children.length > 0);

        // Vue / Nuxt
        const vueRoot = document.getElementById('__nuxt')
          || document.querySelector('[data-v-app]');
        const hasVue = !!(vueRoot && vueRoot.children.length > 0);

        // Angular
        const hasAngular = !!document.querySelector('[ng-version], app-root');

        // Svelte / SvelteKit
        const hasSvelte = !!document.querySelector('[data-sveltekit-hydrate], [data-svelte-h]');

        return (hasMain || hasHeading || hasNav || hasLinks
          || hasReact || hasVue || hasAngular || hasSvelte);
      })()
      `,
      { timeout },
    );
  } catch {
    // Timeout is fine — convergence polling handles late-rendering content
  }
}

// ---------------------------------------------------------------------------
// Aria snapshot YAML parser
// ---------------------------------------------------------------------------

/**
 * Parse Playwright's aria snapshot YAML format into Targets.
 */
/** Hard cap on targets from a single snapshot to prevent DoS on pathological pages. */
const MAX_SNAPSHOT_TARGETS = 5000;

export function parseAriaSnapshot(yaml: string): Target[] {
  const targets: Target[] = [];
  let counter = 0;
  const seenIds = new Map<string, number>();
  const lines = yaml.split("\n");

  for (const line of lines) {
    if (targets.length >= MAX_SNAPSHOT_TARGETS) break;
    const trimmed = line.trim();
    if (!trimmed || !trimmed.startsWith("- ")) continue;

    const content = trimmed.slice(2);

    const parsed = parseSnapshotLine(content);
    if (!parsed) continue;

    const kind = roleToTargetKind(parsed.role);
    if (!kind) continue;

    counter++;
    const name = parsed.name ?? "";
    const slug = slugify(name);
    let id = slug ? `${parsed.role}:${slug}` : `${parsed.role}-${counter}`;
    // Ensure unique IDs: append counter for duplicates (e.g., 3× "link:ad" → link:ad, link:ad-2, link:ad-3)
    const seenCount = seenIds.get(id) ?? 0;
    seenIds.set(id, seenCount + 1);
    if (seenCount > 0) id = `${id}-${seenCount + 1}`;
    // Build a Playwright-style locator for developer actionability.
    // For nameless landmarks, use the HTML element tag (more useful than nth(86)).
    const LANDMARK_TAGS: Record<string, string> = {
      banner: "header",
      contentinfo: "footer",
      main: "main",
      navigation: "nav",
      complementary: "aside",
      search: "search",
    };
    let selector: string;
    if (name) {
      selector = `getByRole('${parsed.role}'${name.length < 80 ? `, { name: '${name.replace(/'/g, "\\'")}' }` : ""})`;
    } else if (LANDMARK_TAGS[parsed.role]) {
      selector = LANDMARK_TAGS[parsed.role];
    } else {
      selector = `getByRole('${parsed.role}').nth(${counter - 1})`;
    }
    targets.push({
      id,
      kind,
      role: parsed.role,
      name,
      selector,
      headingLevel: kind === "heading" ? parsed.level : undefined,
      requiresBranchOpen: false,
      // Store raw ARIA attributes for interop risk calibration and feature detection
      ...(parsed.attributes && parsed.attributes.length > 0
        ? { _attributes: parsed.attributes }
        : {}),
      // State values for the SR simulator (e.g., aria-expanded=false, aria-checked=true)
      ...(parsed.attributeValues && Object.keys(parsed.attributeValues).length > 0
        ? { _attributeValues: parsed.attributeValues }
        : {}),
      // Slider/spinbutton/progressbar value (from trailing `: "75"` in ariaSnapshot)
      ...(parsed.value ? { _value: parsed.value } : {}),
    } as Target);
  }

  return targets;
}

interface ParsedLine {
  role: string;
  name?: string;
  level?: number;
  /** Slider/spinbutton/progressbar trailing `: "value"` (e.g., "75") */
  value?: string;
  /** Raw ARIA attribute names from the snapshot (e.g., ["aria-checked", "aria-expanded"]) */
  attributes?: string[];
  /** ARIA attribute values from the snapshot (e.g., { "aria-expanded": "false" }).
   *  Bare tokens like [checked] are recorded with value "true". */
  attributeValues?: Record<string, string>;
}

function parseSnapshotLine(content: string): ParsedLine | null {
  const cleaned = content.replace(/:$/, "").trim();

  // Match role, optional "name", optional [attrs], optional : "value" (slider/spinbutton current value)
  const match = cleaned.match(
    /^(\w[\w-]*?)(?:\s+"([^"]*)")?(?:\s+\[([^\]]*)\])?(?::\s+"([^"]*)")?$/,
  );
  if (!match) return null;

  const role = match[1];
  const name = match[2];
  const attrs = match[3];
  const value = match[4];

  let level: number | undefined;
  const attributes: string[] = [];
  const attributeValues: Record<string, string> = {};
  if (attrs) {
    const levelMatch = attrs.match(/level=(\d+)/);
    if (levelMatch) level = parseInt(levelMatch[1], 10);
    // Extract all attribute tokens (e.g., "selected", "expanded=false", "haspopup=menu")
    for (const token of attrs.split(/\s+/)) {
      const eqIdx = token.indexOf("=");
      const attrName = (eqIdx >= 0 ? token.slice(0, eqIdx) : token).trim();
      const attrVal = eqIdx >= 0 ? token.slice(eqIdx + 1).trim() : "true";
      if (attrName) {
        const ariaKey = `aria-${attrName}`;
        attributes.push(ariaKey);
        attributeValues[ariaKey] = attrVal;
      }
    }
  }

  return { role, name, level, value, attributes, attributeValues };
}

function roleToTargetKind(role: string): TargetKind | null {
  const map: Record<string, TargetKind> = {
    heading: "heading",
    banner: "landmark",
    navigation: "landmark",
    main: "landmark",
    contentinfo: "landmark",
    complementary: "landmark",
    region: "landmark",
    search: "search",
    form: "landmark",
    link: "link",
    button: "button",
    menubar: "menuTrigger",
    menu: "menuTrigger",
    menuitem: "menuItem",
    menuitemcheckbox: "menuItem",
    menuitemradio: "menuItem",
    tab: "tab",
    tabpanel: "tabPanel",
    dialog: "dialog",
    alertdialog: "dialog",
    textbox: "formField",
    searchbox: "formField",
    combobox: "formField",
    listbox: "formField",
    spinbutton: "formField",
    slider: "formField",
    checkbox: "formField",
    radio: "formField",
    switch: "formField",
    alert: "statusMessage",
    status: "statusMessage",
    log: "statusMessage",
  };

  return map[role] ?? null;
}

/**
 * Create a short, filesystem-safe slug from a target name.
 * Used for human-readable target IDs: "Main Navigation" → "main-navigation"
 */
function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}

/**
 * Hide elements matching CSS selectors from the accessibility tree
 * by setting aria-hidden="true". This removes them from the ariaSnapshot
 * without altering layout or visual appearance.
 */
async function hideExcludedElements(page: Page, selectors: string[]): Promise<void> {
  const validated = await validateCssSelectors(page, selectors);
  if (validated.length === 0) return;

  await page.evaluate((validSelectors) => {
    for (const selector of validSelectors) {
      document
        .querySelectorAll(selector)
        .forEach((el) => el.setAttribute("aria-hidden", "true"));
    }
  }, validated);
}

async function hideOutOfScopeElements(page: Page, selectors: string[]): Promise<void> {
  const validated = await validateCssSelectors(page, selectors);
  if (validated.length === 0) return;

  await page.evaluate((scopeSelectors) => {
    const scopeRoots = scopeSelectors.flatMap((selector) =>
      Array.from(document.querySelectorAll(selector)),
    );
    if (scopeRoots.length === 0) return;

    for (const el of Array.from(document.body.querySelectorAll("*"))) {
      const keep = scopeRoots.some((root) => root === el || root.contains(el) || el.contains(root));
      if (!keep) el.setAttribute("aria-hidden", "true");
    }
  }, validated);
}

async function validateCssSelectors(page: Page, selectors: string[]): Promise<string[]> {
  const candidates = selectors.filter((s) => {
    const trimmed = s.trim();
    if (!trimmed) return false;
    if (/[{}]|javascript:|url\s*\(|@import|expression\s*\(/i.test(trimmed)) return false;
    return true;
  });
  if (candidates.length === 0) return [];

  return await page.evaluate((candidateSelectors) => {
    return candidateSelectors.filter((selector) => {
      try {
        document.querySelectorAll(selector);
        return true;
      } catch {
        return false;
      }
    });
  }, candidates);
}

function hash(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

// ---------------------------------------------------------------------------
// ARIA reference enrichment (describedby resolution, labelledby validity,
// live regions). Adds Target._description, _descriptionMissing,
// _labelledByMissing, _liveRegion.
// ---------------------------------------------------------------------------

interface AriaEnrichment {
  role: string;
  name: string;
  description?: string;
  descriptionMissing?: boolean;
  labelledByMissing?: boolean;
  liveRegion?: string;
}

/**
 * Attach `_rect` (width + height in CSS pixels) to interactive targets so the
 * finding builder can flag WCAG 2.5.8 "target size" failures (≥24×24 for AA).
 *
 * We only measure interactive kinds (button, link, formField, menuTrigger,
 * tab, search) — headings and landmarks don't need to meet the minimum.
 */
async function enrichBoundingRects(page: Page, targets: Target[]): Promise<void> {
  const interactiveKinds = new Set(["button", "link", "formField", "menuTrigger", "tab", "search"]);
  const interactiveTargets = targets.filter((t) => interactiveKinds.has(t.kind) && t.name);
  if (interactiveTargets.length === 0) return;

  const groups = new Map<string, Target[]>();
  for (const t of interactiveTargets) {
    const key = `${t.role}|${t.name}`;
    const list = groups.get(key) ?? [];
    list.push(t);
    groups.set(key, list);
  }

  for (const [, group] of groups) {
    const first = group[0];
    if (!first.role || !first.name) continue;
    try {
      const loc = page.getByRole(first.role as Parameters<Page["getByRole"]>[0], {
        name: first.name,
        exact: true,
      });
      const handles = await loc.elementHandles();
      for (let i = 0; i < handles.length && i < group.length; i++) {
        const data = await handles[i]
          .evaluate((el: Element) => {
            const r = el.getBoundingClientRect();
            // WCAG 2.5.8 exempts targets that are inline in a sentence/block
            // of text. We detect this by walking up to the nearest block-level
            // ancestor (p/li/td/dd/blockquote) and checking whether it
            // contains meaningfully more text than the link itself.
            let inlineInText = false;
            if (el.tagName === "A") {
              const blockTags = new Set(["P", "LI", "TD", "DD", "BLOCKQUOTE", "FIGCAPTION"]);
              let p: Element | null = el.parentElement;
              while (p && !blockTags.has(p.tagName)) p = p.parentElement;
              if (p) {
                const own = (el.textContent ?? "").trim().length;
                const parent = (p.textContent ?? "").trim().length;
                if (own > 0 && parent > own * 2) inlineInText = true;
              }
            }
            return {
              width: Math.round(r.width),
              height: Math.round(r.height),
              inlineInText,
            };
          })
          .catch(() => null);
        if (data) {
          (group[i] as Record<string, unknown>)._rect = {
            width: data.width,
            height: data.height,
          };
          if (data.inlineInText) {
            (group[i] as Record<string, unknown>)._inlineInText = true;
          }
        }
        await handles[i].dispose().catch(() => {});
      }
      for (let i = group.length; i < handles.length; i++) {
        await handles[i].dispose().catch(() => {});
      }
    } catch {
      // Skip on locator error
    }
  }
}

/**
 * Attach `_href` to every link target — the resolved absolute URL the link
 * points to. Used by the analyzer to detect redundant tab stops (N links
 * reaching the same destination should collapse to 1 reachable URL).
 *
 * Matching: group link targets by `name`; for each name, locate all matching
 * anchors via page.getByRole and distribute by DOM ordinal. Mirrors how the
 * visibility-probe handles the same name/DOM-ordinal problem.
 */
async function enrichLinkHrefs(page: Page, targets: Target[]): Promise<void> {
  const linkTargets = targets.filter((t) => t.kind === "link" && t.name);
  if (linkTargets.length === 0) return;

  const groups = new Map<string, Target[]>();
  for (const t of linkTargets) {
    const key = t.name ?? "";
    const list = groups.get(key) ?? [];
    list.push(t);
    groups.set(key, list);
  }

  for (const [name, group] of groups) {
    try {
      const loc = page.getByRole("link", { name, exact: true });
      const handles = await loc.elementHandles();
      for (let i = 0; i < handles.length && i < group.length; i++) {
        const href = await handles[i]
          .evaluate((el: Element) => (el as HTMLAnchorElement).href ?? null)
          .catch(() => null);
        if (href) {
          (group[i] as Record<string, unknown>)._href = href;
        }
        await handles[i].dispose().catch(() => {});
      }
      // Dispose overflow handles if any
      for (let i = group.length; i < handles.length; i++) {
        await handles[i].dispose().catch(() => {});
      }
    } catch {
      // Link not resolvable — skip
    }
  }
}

async function enrichNativeControlMetadata(page: Page, targets: Target[]): Promise<void> {
  const roles = new Set(["combobox", "listbox", "textbox", "searchbox", "checkbox", "radio"]);
  const formTargets = targets.filter((t) => t.role && roles.has(t.role) && t.name);
  if (formTargets.length === 0) return;

  const groups = new Map<string, Target[]>();
  for (const target of formTargets) {
    const key = `${target.role}\u0000${target.name}`;
    const group = groups.get(key) ?? [];
    group.push(target);
    groups.set(key, group);
  }

  for (const [, group] of groups) {
    const first = group[0];
    try {
      const loc = page.getByRole(first.role as Parameters<Page["getByRole"]>[0], {
        name: first.name,
        exact: true,
      });
      const handles = await loc.elementHandles();
      for (let i = 0; i < handles.length && i < group.length; i++) {
        const data = await handles[i]
          .evaluate((el: Element) => {
            const tag = el.tagName.toLowerCase();
            return {
              tag,
              inputType: el instanceof HTMLInputElement ? el.type.toLowerCase() : undefined,
              nativeHtmlControl:
                el instanceof HTMLSelectElement
                  ? "select"
                  : el instanceof HTMLTextAreaElement
                    ? "textarea"
                    : el instanceof HTMLInputElement
                      ? "input"
                      : undefined,
            };
          })
          .catch(() => null);
        if (data) {
          const target = group[i] as Record<string, unknown>;
          target._htmlTag = data.tag;
          if (data.inputType) target._inputType = data.inputType;
          if (data.nativeHtmlControl) target._nativeHtmlControl = data.nativeHtmlControl;
        }
        await handles[i].dispose().catch(() => {});
      }
      for (let i = group.length; i < handles.length; i++) {
        await handles[i].dispose().catch(() => {});
      }
    } catch {
      // Best-effort metadata; analysis remains valid without it.
    }
  }
}

async function enrichWithAriaReferences(page: Page, targets: Target[]): Promise<void> {
  const enrichments = await page
    .evaluate(() => {
      // DOM types not in tsconfig lib — declared via `as never` cast pattern.
      const doc = (
        globalThis as unknown as {
          document: {
            querySelectorAll(s: string): ArrayLike<{
              getAttribute(n: string): string | null;
              textContent: string | null;
              tagName: string;
            }>;
            getElementById(id: string): { textContent: string | null } | null;
          };
        }
      ).document;
      const results: Array<{
        role: string;
        name: string;
        description?: string;
        descriptionMissing?: boolean;
        labelledByMissing?: boolean;
        liveRegion?: string;
      }> = [];

      const elements = doc.querySelectorAll("[aria-describedby], [aria-labelledby], [aria-live]");

      for (let i = 0; i < elements.length; i++) {
        const el = elements[i];
        const role = (el.getAttribute("role") ?? el.tagName.toLowerCase()).trim();
        const name = (el.getAttribute("aria-label") ?? "").trim();

        const out: (typeof results)[number] = { role, name };

        const describedBy = el.getAttribute("aria-describedby");
        if (describedBy) {
          const ids = describedBy.split(/\s+/).filter(Boolean);
          const texts: string[] = [];
          let missing = false;
          for (const id of ids) {
            const ref = doc.getElementById(id);
            if (!ref) {
              missing = true;
            } else if (ref.textContent) {
              texts.push(ref.textContent.trim());
            }
          }
          if (texts.length > 0) out.description = texts.join(" ");
          if (missing) out.descriptionMissing = true;
        }

        const labelledBy = el.getAttribute("aria-labelledby");
        if (labelledBy) {
          const ids = labelledBy.split(/\s+/).filter(Boolean);
          const allMissing = ids.every((id) => !doc.getElementById(id));
          const someMissing = ids.some((id) => !doc.getElementById(id));
          if (allMissing) out.labelledByMissing = true;
          else if (someMissing) out.labelledByMissing = true;
        }

        const live = el.getAttribute("aria-live");
        if (live && (live === "polite" || live === "assertive")) {
          out.liveRegion = live;
        }

        if (out.description || out.descriptionMissing || out.labelledByMissing || out.liveRegion) {
          results.push(out);
        }
      }

      return results;
    })
    .catch(() => [] as AriaEnrichment[]);

  // Match enrichments to targets by role + name (best-effort, first-fit).
  // Multiple targets with same role+name will only match the first enrichment.
  const used = new Set<number>();
  for (const target of targets) {
    const targetName = (target.name ?? "").trim();
    const idx = enrichments.findIndex(
      (e, i) => !used.has(i) && e.role === target.role && e.name === targetName,
    );
    if (idx < 0) continue;
    used.add(idx);
    const e = enrichments[idx];
    const t = target as Record<string, unknown>;
    if (e.description) t._description = e.description;
    if (e.descriptionMissing) t._descriptionMissing = true;
    if (e.labelledByMissing) t._labelledByMissing = true;
    if (e.liveRegion) t._liveRegion = e.liveRegion;
  }
}
