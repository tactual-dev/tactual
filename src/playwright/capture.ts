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
}

/**
 * Capture the current page state including accessibility snapshot and targets.
 * Uses Playwright's modern `page.ariaSnapshot()` API.
 *
 * For SPAs, uses convergence-based waiting: keeps snapshotting until
 * the target count stops growing, rather than relying on network idle
 * (which fails for WebSocket-heavy apps).
 */
export async function captureState(
  page: Page,
  options: CaptureOptions = {},
): Promise<PageState> {
  const url = page.url();
  const route = new URL(url).pathname;
  const viewport = page.viewportSize() ?? undefined;

  const minTargets = options.minTargets ?? 3;
  const spaTimeout = options.spaWaitTimeout ?? 15000;

  // Hide excluded elements from the accessibility tree before capture.
  // Uses aria-hidden=true so they don't appear in ariaSnapshot at all.
  if (options.excludeSelectors && options.excludeSelectors.length > 0) {
    await hideExcludedElements(page, options.excludeSelectors);
  }

  // First attempt
  let snapshotYaml = await page.ariaSnapshot({ depth: options.snapshotDepth });
  let targets = parseAriaSnapshot(snapshotYaml);

  // If the snapshot is too sparse, wait for SPA content via convergence
  if (targets.length < minTargets) {
    const result = await waitForConvergence(page, minTargets, spaTimeout, options.snapshotDepth);
    // Only use convergence result if it found more targets
    if (result.targets.length > targets.length) {
      targets = result.targets;
      snapshotYaml = result.yaml;
    }
  }

  const snapshotHash = hash(snapshotYaml);

  // Hash interactive elements for state dedup
  const interactiveTargets = targets.filter((t) =>
    ["button", "link", "formField", "menuTrigger", "tab", "search"].includes(t.kind),
  );
  const interactiveHash = hash(JSON.stringify(interactiveTargets.map((t) => `${t.kind}:${t.name}`)));

  // Detect open overlays (dialogs)
  const openOverlays = targets
    .filter((t) => t.kind === "dialog")
    .map((t) => t.id);

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
      if (stableRounds >= 2 && targets.length >= minTargets) {
        return { targets: bestTargets, yaml: bestYaml };
      }
    } else {
      stableRounds = 0;
    }

    prevCount = targets.length;
  }

  return { targets: bestTargets, yaml: bestYaml };
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
export function parseAriaSnapshot(yaml: string): Target[] {
  const targets: Target[] = [];
  let counter = 0;
  const seenIds = new Map<string, number>();
  const lines = yaml.split("\n");

  for (const line of lines) {
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
      banner: "header", contentinfo: "footer", main: "main",
      navigation: "nav", complementary: "aside", search: "search",
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
      ...(parsed.attributes && parsed.attributes.length > 0 ? { _attributes: parsed.attributes } : {}),
    } as Target);
  }

  return targets;
}

interface ParsedLine {
  role: string;
  name?: string;
  level?: number;
  /** Raw ARIA attribute names from the snapshot (e.g., ["selected", "expanded=false"]) */
  attributes?: string[];
}

function parseSnapshotLine(content: string): ParsedLine | null {
  const cleaned = content.replace(/:$/, "").trim();

  // Match role, optional "name", optional [attrs], optional : "value" (slider/spinbutton current value)
  const match = cleaned.match(
    /^(\w[\w-]*?)(?:\s+"([^"]*)")?(?:\s+\[([^\]]*)\])?(?::\s+"[^"]*")?$/,
  );
  if (!match) return null;

  const role = match[1];
  const name = match[2];
  const attrs = match[3];

  let level: number | undefined;
  const attributes: string[] = [];
  if (attrs) {
    const levelMatch = attrs.match(/level=(\d+)/);
    if (levelMatch) level = parseInt(levelMatch[1], 10);
    // Extract all attribute tokens (e.g., "selected", "expanded=false", "haspopup=menu")
    for (const token of attrs.split(/\s+/)) {
      const attrName = token.split("=")[0].trim();
      if (attrName) attributes.push(`aria-${attrName}`);
    }
  }

  return { role, name, level, attributes };
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
  // Validate selectors before passing to querySelectorAll.
  // Reject patterns that could indicate injection attempts.
  const validated = selectors.filter((s) => {
    const trimmed = s.trim();
    if (!trimmed) return false;
    // Block obvious injection: JS expressions, url(), import, etc.
    if (/[{}]|javascript:|url\s*\(|@import|expression\s*\(/i.test(trimmed)) return false;
    return true;
  });
  if (validated.length === 0) return;

  const selectorList = validated.join(", ");
  await page.evaluate(
    `document.querySelectorAll(${JSON.stringify(selectorList)}).forEach(el => el.setAttribute("aria-hidden", "true"))`,
  );
}

function hash(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}
