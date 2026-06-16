/// <reference lib="dom" />
import type { CDPSession, Frame, Page } from "playwright";
import { createHash } from "crypto";
import type { PageState, Target, TargetKind } from "../core/types.js";
import {
  cdpAxTreeToAriaSnapshot,
  type CDPAXNode,
  type CDPAXNodeMetadata,
} from "./cdp-ax-serializer.js";

/** Hard cap on how many child frames we'll descend into per capture. Modern
 *  pages frequently have 30+ ad/tracking iframes; descending all of them
 *  blows out capture time without meaningful content gain. 20 covers normal
 *  micro-frontend / embed cases without runaway. */
const MAX_FRAME_DESCENT = 20;

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
  /** Descend into child iframes and merge their accessibility trees into the
   *  main capture. Frame targets get a `_frame: { url, name }` enrichment and
   *  IDs are prefixed `f<n>.` so they don't collide with main-frame IDs.
   *  Same-origin frames use Playwright's ariaSnapshot path; Chromium can fall
   *  back to CDP for cross-origin OOPIFs whose child tree is inaccessible from
   *  the parent. Enrichment runs in the frame's own scope, or through CDP
   *  backend node IDs for recovered OOPIFs, to avoid page-scope mis-attribution. */
  descendFrames?: boolean;
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

  // Wave 29: pre-snapshot framework-aware settle. Detection is cheap (DOM
  // marker probe) and runs only on Page (not Frame) — it informs which
  // settle strategy applies. The settle helper is bounded by a short
  // timeout and falls back gracefully when no framework is detected, so
  // it adds <100ms to plain pages.
  let earlyFrameworks: import("./framework-detect.js").FrameworkSignal[] = [];
  if ("context" in page) {
    try {
      const fd = await import("./framework-detect.js");
      earlyFrameworks = await fd.detectFrameworks(page as Page);
      if (earlyFrameworks.length > 0) {
        const fs = await import("./framework-settle.js");
        await fs.waitForFrameworkSettled(page as Page, earlyFrameworks, { timeout: 2000 });
      }
    } catch {
      // Framework settle is opportunistic — convergence still runs below.
    }
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

  // Attach ARIA relationship metadata (controls/owns/activedescendant,
  // popup and state hints) so the graph can model jumps that are present in
  // the real AT tree but are not visible from a flat target list alone.
  await enrichAriaRelationships(page, targets);

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

  // Detect tooltips via attribute scan: HTML title, Bootstrap
  // data-bs-original-title, Tippy.js data-tippy-content, generic
  // data-tooltip / data-balloon. Skips actually hovering each element
  // (would be N × ~800 ms) — the attribute is what gets rendered anyway
  // for these patterns. Pure-React hover-state tooltips with no attribute
  // hint are missed; documented as a limitation for v2.
  await enrichTooltips(page, targets);

  // Verify skip-link targets resolve. The no-skip-link diagnostic flags
  // missing skip links; this enrichment flags PRESENT-but-broken ones,
  // which are arguably worse (the user expects skip-link behaviour and
  // gets no destination).
  await enrichSkipLinkValidity(page, targets);

  // Count "fake interactive" elements — divs/spans with declarative
  // onclick attribute but no role=button/link/tabindex. Sighted users see
  // them as clickable (often styled with cursor:pointer) but keyboard /
  // SR users can't reach or operate them. Surface count as state-level
  // metadata so the analyzer can emit a diagnostic.
  const fakeInteractive = await detectFakeInteractive(page);

  // Per-form summary: total fields, required count, submit-button
  // presence, accessible name. Lets the analyzer report a form's overall
  // shape ("Email form: 3 fields, 1 required, no submit button") instead
  // of forcing users to piece it together from individual findings.
  const forms = await detectForms(page);

  // Text contrast scan for interactive targets + headings. Catches
  // low-contrast buttons/links/headings that fail WCAG 1.4.3 (4.5:1
  // normal, 3:1 large). Noisy on body text — restricted to targets the
  // analyzer already cares about.
  const lowContrastText = await detectLowContrastText(page);

  // Document-level metadata: <html lang>, document.title, viewport
  // zoom restrictions. All three are WCAG/axe-style checks that surface
  // real bugs but require document-scope (not target-scope) inspection.
  const docMetadata = await detectDocumentMetadata(page);

  // Image alt + iframe title presence. Both are direct SR navigation
  // signals: missing alt makes the SR announce filenames; missing iframe
  // title makes "frame" the only context.
  const mediaMetadata = await detectMediaMetadata(page);

  // Three structural-quality checks rolled into one helper because they
  // share a single document scan: duplicate id values (breaks
  // aria-labelledby resolution), nested interactive (button inside link
  // and similar), and meta-refresh (auto-reload disorients SR users).
  const structuralIssues = await detectStructuralIssues(page);

  // Wave 10: media controls + h1 count. Both pulled from the same DOM
  // pass to avoid yet another evaluate round trip.
  const mediaControls = await detectMediaControls(page);

  // Wave 13: ARIA validation. Catches typo'd role values, unknown
  // aria-* attributes, and invalid enum values (aria-checked="on").
  const { validateAriaUsage } = await import("./aria-validator.js");
  const ariaIssues = await validateAriaUsage(page);

  // CDP listener detection complements the JS-side addEventListener wrap: CDP
  // catches handlers attached before the wrap or via on-prop assignment. Only
  // runs on Page (not Frame) because CDP sessions are per-page.
  const cdpListeners =
    "context" in page
      ? await (await import("./cdp-listener-probe.js")).probeListenersViaCDP(page)
      : null;

  // Framework detection signals which SPA stack(s) are on the page and feeds
  // framework-aware settle/exploration behavior. Page-only markers are
  // top-frame. Reuses the early detection done above for the framework settle
  // pass to avoid a duplicate DOM scan.
  const frameworks = "context" in page ? earlyFrameworks : [];

  // Color-only conveyance heuristic. Inline text spans whose color differs from
  // parent but have no other differentiator are potentially conveying meaning
  // (for example, errors in red) using color
  // alone — fails WCAG 1.4.1.
  const colorOnly = await detectColorOnlyConveyance(page);

  // Wave 30: color-blindness contrast simulation. Re-runs WCAG 1.4.3
  // contrast under deuteranopia/protanopia/tritanopia matrix transforms.
  // Catches text that's fine for normal vision but unreadable for the
  // ~8% of viewers with color-vision deficiencies.
  const cvdContrast = await (await import("./cvd-simulation.js")).detectCvdContrastIssues(page);

  // Wave 20: lang-switch detection. Per-language word dictionaries
  // identify text in a different language than the page's html lang,
  // missing a `<… lang="…">` switch (WCAG 3.1.2). Page-only.
  const langSwitches =
    "context" in page
      ? await (await import("./lang-switch-detect.js")).detectLangSwitches(page)
      : null;

  // Descend into child iframes after main-frame enrichment finishes. Each
  // frame's targets are enriched in that frame's scope — using the page
  // scope would mis-attribute href/rect when main and frame share role+name
  // (e.g. both have a "Submit" button).
  let combinedYaml = snapshotYaml;
  let frameDescentSummary: ChildFrameSnapshots | undefined;
  if (options.descendFrames) {
    const frameOwnerOffsets = framePlaceholderInsertionOffsets(snapshotYaml);
    frameDescentSummary = await captureChildFrames(page, options.snapshotDepth);
    for (let i = 0; i < frameDescentSummary.results.length; i++) {
      const { frame, yaml, source, cdpMetadata, ownerRect } = frameDescentSummary.results[i];
      const frameTargets = parseAriaSnapshot(yaml);
      const idPrefix = `f${i + 1}.`;
      const frameMeta = {
        url: frame.url(),
        name: frame.name(),
        source,
        ...(ownerRect ? { ownerRect } : {}),
      };
      for (const t of frameTargets) {
        t.id = idPrefix + t.id;
        (t as Record<string, unknown>)._frame = frameMeta;
      }
      if (source === "ariaSnapshot") {
        await enrichFrameTargets(frame, frameTargets);
      } else if (cdpMetadata) {
        await enrichCdpRecoveredFrameTargets(page, frame, frameTargets, cdpMetadata);
      }
      insertFrameTargetsAtOwnerPosition(targets, frameTargets, frameOwnerOffsets[i], ownerRect);
      combinedYaml += `\n# frame[${i + 1}] ${frame.url()}\n${yaml}`;
    }
  }

  const snapshotHash = hash(combinedYaml);
  // Canonical hash for dedup: strip digits inside quoted names so dynamic
  // counts and timestamps ("Saved 5 minutes ago", "3 unread", "12:34 PM")
  // don't read as a fresh state on every snapshot. Limited to quoted
  // accessible names — preserves structural attrs like [level=1] and
  // ARIA attribute values intact.
  const canonicalSnapshotHash = hash(canonicalizeYaml(combinedYaml));

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
    canonicalSnapshotHash,
    ...(fakeInteractive.count > 0 ? { _fakeInteractive: fakeInteractive } : {}),
    ...(forms.length > 0 ? { _forms: forms } : {}),
    ...(lowContrastText.count > 0 ? { _lowContrastText: lowContrastText } : {}),
    _docMetadata: docMetadata,
    _mediaMetadata: mediaMetadata,
    _structuralIssues: structuralIssues,
    _mediaControls: mediaControls,
    ...(ariaIssues.invalidRoles.length > 0 ||
    ariaIssues.unknownAttrs.length > 0 ||
    ariaIssues.invalidAttrValues.length > 0 ||
    ariaIssues.missingRequiredAttrs.length > 0 ||
    ariaIssues.prohibitedNaming.length > 0 ||
    ariaIssues.unsupportedAttrsForRole.length > 0
      ? { _ariaIssues: ariaIssues }
      : {}),
    ...(cdpListeners && cdpListeners.withClickListener > 0
      ? { _cdpListeners: cdpListeners }
      : {}),
    ...(frameworks.length > 0 ? { _frameworks: frameworks } : {}),
    ...(colorOnly.count > 0 ? { _colorOnlyConveyance: colorOnly } : {}),
    ...(cvdContrast.totalUniqueElements > 0 ? { _cvdContrast: cvdContrast } : {}),
    ...(langSwitches && langSwitches.suspects.length > 0 ? { _langSwitches: langSwitches } : {}),
    ...(frameDescentSummary && (frameDescentSummary.skipped.length > 0 || frameDescentSummary.overflow > 0)
      ? {
          _framesSkipped: frameDescentSummary.skipped,
          _framesOverflow: frameDescentSummary.overflow,
        }
      : {}),
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
  const stack: ParsedTreeNode[] = [];

  for (const line of lines) {
    if (targets.length >= MAX_SNAPSHOT_TARGETS) break;
    const trimmed = line.trim();
    if (!trimmed || !trimmed.startsWith("- ")) continue;

    const indent = leadingSpaceCount(line);
    const content = trimmed.slice(2);

    const parsed = parseSnapshotLine(content);
    if (!parsed) continue;

    while (stack.length > 0 && stack[stack.length - 1].indent >= indent) {
      stack.pop();
    }
    const ancestors = stack.map((node) => ({
      role: node.role,
      ...(node.name ? { name: node.name } : {}),
    }));
    const parent = ancestors[ancestors.length - 1];
    const kind = roleToTargetKind(parsed.role);
    if (!kind) {
      stack.push({ indent, role: parsed.role, name: parsed.name ?? "" });
      continue;
    }

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
      _atTree: {
        depth: Math.floor(indent / 2),
        ...(parent ? { parent } : {}),
        ...(ancestors.length > 0 ? { ancestors } : {}),
      },
    } as Target);
    stack.push({ indent, role: parsed.role, name });
  }

  return targets;
}

interface ParsedTreeNode {
  indent: number;
  role: string;
  name: string;
}

function leadingSpaceCount(line: string): number {
  const match = line.match(/^\s*/);
  return match?.[0].length ?? 0;
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

  // Match role, optional "name", optional [attrs], optional : value where
  // value can be either quoted ("foo") or an unquoted suffix (Menu).
  // Unquoted suffix is what Playwright emits for elements where the
  // accessible name differs from text content — e.g.
  //   button "Open menu": Menu      (aria-label wins, text content shown after)
  //   slider "Volume": 50           (slider's current value)
  // Both forms must parse so capture matches the full set of targets,
  // not just the quoted-value subset.
  const match = cleaned.match(
    /^(\w[\w-]*?)(?:\s+"([^"]*)")?(?:\s+\[([^\]]*)\])?(?::\s+(?:"([^"]*)"|(\S.*)))?$/,
  );
  if (!match) return null;

  const role = match[1];
  const name = match[2];
  const attrs = match[3];
  const value = match[4] ?? match[5];

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
    table: "other",
    grid: "other",
    tree: "other",
    treegrid: "other",
    row: "other",
    columnheader: "other",
    rowheader: "other",
    gridcell: "other",
    cell: "other",
    treeitem: "other",
  };

  return map[role] ?? null;
}

function framePlaceholderInsertionOffsets(yaml: string): number[] {
  const offsets: number[] = [];
  let targetCount = 0;

  for (const line of yaml.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || !trimmed.startsWith("- ")) continue;

    const parsed = parseSnapshotLine(trimmed.slice(2));
    if (!parsed) continue;

    if (parsed.role === "iframe") {
      offsets.push(targetCount);
    } else if (roleToTargetKind(parsed.role)) {
      targetCount++;
    }
  }

  return offsets;
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

/**
 * Strip digits from quoted accessible names in an ariaSnapshot YAML, so
 * dynamic counts ("3 unread"), timestamps ("12:34 PM"), and relative dates
 * ("5 minutes ago") don't make every snapshot read as a fresh state. Used
 * by canonicalSnapshotHash for explorer dedup. Preserves digits outside
 * quoted names so structural attributes like [level=1] are unaffected.
 */
export function canonicalizeYaml(yaml: string): string {
  return yaml.replace(/"([^"]*)"/g, (_match, name: string) => `"${name.replace(/\d+/g, "N")}"`);
}

export interface FakeInteractiveSummary {
  count: number;
  /** Up to 5 short selectors describing samples (`div.btn[onclick]`). */
  samples: string[];
}

export interface FormSummary {
  /** Accessible name (aria-label, aria-labelledby, or fallback to "form #N"). */
  name: string;
  /** Total form fields (input/select/textarea, excluding submit/button types). */
  fieldCount: number;
  /** Number of fields with required attribute or aria-required="true". */
  requiredCount: number;
  /** True if the form contains at least one submit-typed button or
   *  <button type="submit"> equivalent. */
  hasSubmit: boolean;
}

export interface LowContrastTextSummary {
  count: number;
  /** Up to 5 sample descriptions: `tag "text" — 3.2:1 vs 4.5:1 needed`. */
  samples: string[];
}

export interface DocumentMetadata {
  /** Trimmed value of <html lang>, or empty string if missing. */
  htmlLang: string;
  /** document.title, trimmed. */
  title: string;
  /** True if a meta viewport has user-scalable=no, maximum-scale<=1, etc. */
  zoomRestricted: boolean;
  /** The raw viewport meta content, for context in the diagnostic. */
  viewportContent: string | null;
}

export interface MediaMetadata {
  /** Total <img> count in the document. */
  totalImages: number;
  /** Images with no alt attribute at all (SR will announce filename). */
  imagesMissingAlt: number;
  /** Images whose alt looks like filler ("image", "img", "picture", filename.ext). */
  imagesSuspiciousAlt: Array<{ alt: string; src: string }>;
  /** Total <iframe> count. */
  totalIframes: number;
  /** Iframes with no title attribute or empty title. */
  iframesMissingTitle: Array<{ src: string }>;
}

const SUSPICIOUS_ALT = /^(image|img|picture|photo|graphic|icon|logo|\d+|untitled)$/i;
const FILENAME_LIKE_ALT = /^[\w-]+\.(png|jpg|jpeg|gif|svg|webp|ico|bmp)$/i;

export interface StructuralIssues {
  /** id values that appear on multiple elements; breaks aria-labelledby. */
  duplicateIds: Array<{ id: string; count: number }>;
  /** Sample selectors of nested interactive (focusable inside focusable). */
  nestedInteractive: string[];
  /** True if the page declares an HTTP-equiv meta refresh that reloads. */
  metaRefresh: boolean;
}

export interface MediaControls {
  /** <audio>/<video> elements without `controls` attribute and not aria-hidden. */
  mediaWithoutControls: Array<{ tag: string; src: string }>;
  /** Total <h1> count on the page. */
  h1Count: number;
}

async function detectMediaControls(page: Page | Frame): Promise<MediaControls> {
  return page
    .evaluate(() => {
      const mediaWithoutControls: Array<{ tag: string; src: string }> = [];
      const media = document.querySelectorAll("audio, video");
      for (let i = 0; i < media.length; i++) {
        const el = media[i];
        if (el.hasAttribute("controls")) continue;
        if (el.getAttribute("aria-hidden") === "true") continue;
        // Auto-played, no controls, no JS API exposed → keyboard users can't
        // pause / mute. WCAG 1.4.2 (Audio Control).
        if (mediaWithoutControls.length < 5) {
          mediaWithoutControls.push({
            tag: el.tagName.toLowerCase(),
            src: (el.getAttribute("src") ?? "").slice(0, 100),
          });
        }
      }
      const h1Count = document.querySelectorAll("h1").length;
      return { mediaWithoutControls, h1Count };
    })
    .catch(() => ({ mediaWithoutControls: [], h1Count: 0 }) as MediaControls);
}

export interface ColorOnlyConveyanceSummary {
  count: number;
  /** Up to 5 short sample descriptions: `span "Error: invalid"`. */
  samples: string[];
}

/**
 * Heuristic detection of WCAG 1.4.1 (Use of Color) violations: inline
 * text spans whose ONLY visual differentiator from the surrounding
 * text is color. Common pattern: error messages in red without an
 * icon, prefix, font-weight bump, or aria-* hint.
 *
 * Filters that suppress false positives:
 *   - Element has interactive role (button/link) — color carries role
 *     redundantly with semantics.
 *   - Computed text-decoration includes underline/line-through.
 *   - Computed font-weight differs from parent by ≥ 200 units.
 *   - Computed font-style differs (italic vs normal).
 *   - Element has aria-* attribute (label, describedby, live, current).
 *   - Element contains an icon child (svg, img).
 *
 * Even with these filters, false positives are common. Reported as
 * a warning with the heuristic caveat in the diagnostic message.
 */
async function detectColorOnlyConveyance(page: Page | Frame): Promise<ColorOnlyConveyanceSummary> {
  return page
    .evaluate(() => {
      const out: { count: number; samples: string[] } = { count: 0, samples: [] };
      const SCAN_CAP = 1000;
      // Inline-ish elements likely to be used for spans of meaning.
      const els = document.querySelectorAll("span, em, i, b, strong, mark, small");
      for (let i = 0; i < els.length && i < SCAN_CAP; i++) {
        const el = els[i];
        const text = (el.textContent ?? "").trim();
        if (text.length < 4 || text.length > 120) continue;
        const parent = el.parentElement;
        if (!parent) continue;

        // Skip if the span has any aria-* hint or interactive role —
        // those carry meaning by other channels.
        let hasAriaHint = false;
        for (let k = 0; k < el.attributes.length; k++) {
          if (el.attributes[k].name.startsWith("aria-")) {
            hasAriaHint = true;
            break;
          }
        }
        if (hasAriaHint) continue;
        const role = (el.getAttribute("role") ?? "").toLowerCase();
        if (role === "button" || role === "link" || role === "alert" || role === "status") continue;
        // Skip if there's an icon (svg/img) inside the span.
        if (el.querySelector("svg, img")) continue;

        const style = getComputedStyle(el);
        const parentStyle = getComputedStyle(parent);

        // Skip if text-decoration distinguishes (underline / line-through).
        if (style.textDecorationLine && style.textDecorationLine !== "none" &&
            style.textDecorationLine !== parentStyle.textDecorationLine) {
          continue;
        }
        // Skip if font-weight differs significantly.
        const w = parseInt(style.fontWeight, 10) || 400;
        const pw = parseInt(parentStyle.fontWeight, 10) || 400;
        if (Math.abs(w - pw) >= 200) continue;
        // Skip if font-style differs (italic).
        if (style.fontStyle !== parentStyle.fontStyle) continue;

        // Final check: color must actually differ.
        if (style.color === parentStyle.color) continue;

        out.count++;
        if (out.samples.length < 5) {
          const trimmed = text.length > 40 ? text.slice(0, 37) + "…" : text;
          out.samples.push(`<${el.tagName.toLowerCase()}> "${trimmed}"`);
        }
      }
      return out;
    })
    .catch(() => ({ count: 0, samples: [] }) as ColorOnlyConveyanceSummary);
}

async function detectStructuralIssues(page: Page | Frame): Promise<StructuralIssues> {
  return page
    .evaluate(() => {
      // Duplicate ids — naive: walk all [id] elements, count.
      const idCounts = new Map<string, number>();
      const idEls = document.querySelectorAll("[id]");
      for (let i = 0; i < idEls.length; i++) {
        const id = idEls[i].id;
        if (!id) continue;
        idCounts.set(id, (idCounts.get(id) ?? 0) + 1);
      }
      const duplicateIds: Array<{ id: string; count: number }> = [];
      for (const [id, count] of idCounts) {
        if (count > 1 && duplicateIds.length < 10) {
          duplicateIds.push({ id, count });
        }
      }

      // Nested interactive — focusable element inside another focusable.
      // Restrict the OUTER selector to specifically interactive controls
      // so we don't false-positive on tabindex=-1 wrappers.
      const FOCUSABLE = "a[href], button:not([disabled]), [role='button']:not([disabled]), [role='link']";
      const outerEls = document.querySelectorAll(FOCUSABLE);
      const nested: string[] = [];
      for (let i = 0; i < outerEls.length && nested.length < 5; i++) {
        const outer = outerEls[i];
        const inner = outer.querySelector(FOCUSABLE);
        if (!inner || inner === outer) continue;
        const desc = `${outer.tagName.toLowerCase()}${outer.id ? "#" + outer.id : ""} > ${inner.tagName.toLowerCase()}${inner.id ? "#" + inner.id : ""}`;
        nested.push(desc.slice(0, 80));
      }

      // Meta refresh — http-equiv="refresh" that reloads the same page or
      // a different URL after a delay. axe-core flags any meta-refresh.
      const metaRefreshEl = document.querySelector('meta[http-equiv="refresh"]');
      const metaRefresh = Boolean(metaRefreshEl);

      return { duplicateIds, nestedInteractive: nested, metaRefresh };
    })
    .catch(
      () =>
        ({
          duplicateIds: [],
          nestedInteractive: [],
          metaRefresh: false,
        }) as StructuralIssues,
    );
}

async function detectMediaMetadata(page: Page | Frame): Promise<MediaMetadata> {
  return page
    .evaluate(({ suspiciousPattern, filenamePattern }) => {
      const susRe = new RegExp(suspiciousPattern, "i");
      const fileRe = new RegExp(filenamePattern, "i");

      const out: {
        totalImages: number;
        imagesMissingAlt: number;
        imagesSuspiciousAlt: Array<{ alt: string; src: string }>;
        totalIframes: number;
        iframesMissingTitle: Array<{ src: string }>;
      } = {
        totalImages: 0,
        imagesMissingAlt: 0,
        imagesSuspiciousAlt: [],
        totalIframes: 0,
        iframesMissingTitle: [],
      };

      const imgs = document.querySelectorAll("img");
      for (let i = 0; i < imgs.length; i++) {
        const img = imgs[i];
        out.totalImages++;
        // Skip aria-hidden/decoratively-hidden — author already opted out
        if (img.getAttribute("aria-hidden") === "true") continue;
        const alt = img.getAttribute("alt");
        const src = (img.getAttribute("src") ?? "").slice(0, 100);
        if (alt === null) {
          out.imagesMissingAlt++;
          continue;
        }
        const trimmed = alt.trim();
        if (trimmed === "") continue; // empty alt = decorative, intentional
        if (susRe.test(trimmed) || fileRe.test(trimmed)) {
          if (out.imagesSuspiciousAlt.length < 5) {
            out.imagesSuspiciousAlt.push({ alt: trimmed, src });
          }
        }
      }

      const iframes = document.querySelectorAll("iframe");
      for (let i = 0; i < iframes.length; i++) {
        const frame = iframes[i];
        out.totalIframes++;
        const title = (frame.getAttribute("title") ?? "").trim();
        const ariaLabel = (frame.getAttribute("aria-label") ?? "").trim();
        if (!title && !ariaLabel) {
          if (out.iframesMissingTitle.length < 5) {
            out.iframesMissingTitle.push({ src: (frame.getAttribute("src") ?? "").slice(0, 100) });
          }
        }
      }

      return out;
    }, {
      suspiciousPattern: SUSPICIOUS_ALT.source,
      filenamePattern: FILENAME_LIKE_ALT.source,
    })
    .catch(
      () =>
        ({
          totalImages: 0,
          imagesMissingAlt: 0,
          imagesSuspiciousAlt: [],
          totalIframes: 0,
          iframesMissingTitle: [],
        }) as MediaMetadata,
    );
}

async function detectDocumentMetadata(page: Page | Frame): Promise<DocumentMetadata> {
  return page
    .evaluate(() => {
      const html = document.documentElement;
      const htmlLang = (html.getAttribute("lang") ?? "").trim();
      const title = (document.title ?? "").trim();
      const viewport = document.querySelector('meta[name="viewport"]');
      const viewportContent = viewport ? (viewport.getAttribute("content") ?? "") : null;

      let zoomRestricted = false;
      if (viewportContent) {
        const lower = viewportContent.toLowerCase();
        if (/user-scalable\s*=\s*(no|0)/.test(lower)) zoomRestricted = true;
        const maxScaleMatch = lower.match(/maximum-scale\s*=\s*([\d.]+)/);
        if (maxScaleMatch && parseFloat(maxScaleMatch[1]) < 2) zoomRestricted = true;
      }

      return { htmlLang, title, zoomRestricted, viewportContent };
    })
    .catch(
      () =>
        ({ htmlLang: "", title: "", zoomRestricted: false, viewportContent: null }) as DocumentMetadata,
    );
}

/**
 * Sample text contrast for buttons, links, and headings — the elements a
 * SR user navigates to and a sighted user reads. WCAG 1.4.3 AA threshold:
 * 4.5:1 for normal text, 3:1 for large text (24px+ or 18.66px+ bold).
 *
 * Walks ancestor chain for the effective background color (CSS doesn't
 * inherit background-color, so `body { background: black }` with a
 * transparent button on top means the button's effective bg is black).
 * Falls back to white when nothing opaque is found.
 *
 * Limitation: doesn't account for background images, gradients, or
 * partially-transparent overlays — those would need pixel sampling.
 */
async function detectLowContrastText(page: Page | Frame): Promise<LowContrastTextSummary> {
  return page
    .evaluate(() => {
      const SELECTOR =
        "button, a, h1, h2, h3, h4, h5, h6, [role='button'], [role='link'], " +
        // Body text: paragraphs / list items / table cells / blockquotes /
        // figcaptions. Capped tightly to keep cost bounded — one
        // getComputedStyle call per element is ~0.3 ms, so 500 elements
        // ≈ 150 ms.
        "p, li, td, blockquote, figcaption, dt, dd, label";
      const parseRgb = (str: string): { r: number; g: number; b: number; a: number } | null => {
        const m = str.match(/rgba?\(\s*(\d+(?:\.\d+)?)[,\s]+(\d+(?:\.\d+)?)[,\s]+(\d+(?:\.\d+)?)(?:[,\s/]+([\d.]+))?\s*\)/);
        if (!m) return null;
        return {
          r: parseFloat(m[1]),
          g: parseFloat(m[2]),
          b: parseFloat(m[3]),
          a: m[4] !== undefined ? parseFloat(m[4]) : 1,
        };
      };
      const luminance = (c: { r: number; g: number; b: number }): number => {
        const f = (channel: number): number => {
          const v = channel / 255;
          return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
        };
        return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b);
      };
      const ratio = (
        a: { r: number; g: number; b: number },
        b: { r: number; g: number; b: number },
      ): number => {
        const l1 = luminance(a);
        const l2 = luminance(b);
        const lighter = Math.max(l1, l2);
        const darker = Math.min(l1, l2);
        return (lighter + 0.05) / (darker + 0.05);
      };
      const effectiveBackground = (el: Element): { r: number; g: number; b: number } => {
        let p: Element | null = el;
        while (p && p !== document.documentElement) {
          const bg = getComputedStyle(p).backgroundColor;
          const parsed = parseRgb(bg);
          if (parsed && parsed.a > 0.5) return { r: parsed.r, g: parsed.g, b: parsed.b };
          p = p.parentElement;
        }
        // Document-level fallback. Most pages either set body background or
        // inherit white from the user agent stylesheet.
        const bodyBg = parseRgb(getComputedStyle(document.body || document.documentElement).backgroundColor);
        if (bodyBg && bodyBg.a > 0.5) return { r: bodyBg.r, g: bodyBg.g, b: bodyBg.b };
        return { r: 255, g: 255, b: 255 };
      };
      const isLargeText = (style: CSSStyleDeclaration): boolean => {
        const sizePx = parseFloat(style.fontSize);
        const weight = parseInt(style.fontWeight, 10) || 400;
        // WCAG: 18pt = 24px (at 96 DPI). Bold 14pt = 18.66px.
        if (sizePx >= 24) return true;
        if (sizePx >= 18.66 && weight >= 700) return true;
        return false;
      };

      const samples: string[] = [];
      let count = 0;
      const elements = document.querySelectorAll(SELECTOR);
      // 500-element cap keeps the scan under ~200 ms on heavy pages —
      // each iteration does one getComputedStyle call (fast individually,
      // expensive in bulk).
      for (let i = 0; i < elements.length && i < 500; i++) {
        const el = elements[i];
        const text = (el.textContent ?? "").trim();
        if (!text) continue;
        const rect = el.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) continue;
        const style = getComputedStyle(el);
        // Skip if visually hidden via opacity / clip / display
        if (style.display === "none" || style.visibility === "hidden") continue;
        const opacity = parseFloat(style.opacity);
        if (!isNaN(opacity) && opacity < 0.5) continue;

        const fg = parseRgb(style.color);
        if (!fg) continue;
        const bg = effectiveBackground(el);
        const r = ratio(fg, bg);
        const threshold = isLargeText(style) ? 3 : 4.5;
        if (r >= threshold) continue;

        count++;
        if (samples.length < 5) {
          const tag = el.tagName.toLowerCase();
          const trimmed = text.length > 30 ? text.slice(0, 27) + "…" : text;
          samples.push(`${tag} "${trimmed}" — ${r.toFixed(2)}:1 vs ${threshold}:1 needed`);
        }
      }
      return { count, samples };
    })
    .catch(() => ({ count: 0, samples: [] }) as LowContrastTextSummary);
}

/**
 * Enumerate <form> elements on the page and produce a per-form summary
 * for the analyzer to surface as a `form-summary` diagnostic. Fieldsets
 * are deliberately not included — they're sub-groupings within a form,
 * not standalone entities.
 */
async function detectForms(page: Page | Frame): Promise<FormSummary[]> {
  return page
    .evaluate(() => {
      const forms: Array<{
        name: string;
        fieldCount: number;
        requiredCount: number;
        hasSubmit: boolean;
      }> = [];
      const formEls = document.querySelectorAll("form");
      for (let i = 0; i < formEls.length; i++) {
        const form = formEls[i];
        // Accessible name resolution
        let name = (form.getAttribute("aria-label") ?? "").trim();
        if (!name) {
          const labelledBy = form.getAttribute("aria-labelledby");
          if (labelledBy) {
            const ref = document.getElementById(labelledBy.split(/\s+/)[0]);
            if (ref?.textContent) name = ref.textContent.trim();
          }
        }
        if (!name) {
          // No accessible name — fall back to a positional label so the
          // diagnostic can still distinguish multiple unnamed forms.
          name = `form #${i + 1}`;
        }

        const fields = form.querySelectorAll(
          'input:not([type="submit"]):not([type="button"]):not([type="reset"]):not([type="hidden"]),' +
            "select, textarea",
        );
        let requiredCount = 0;
        for (let j = 0; j < fields.length; j++) {
          const field = fields[j];
          if (
            (field as HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement).required ||
            field.getAttribute("aria-required") === "true"
          ) {
            requiredCount++;
          }
        }

        const submits = form.querySelectorAll(
          'button[type="submit"], button:not([type]), input[type="submit"], [role="button"][data-submit]',
        );
        forms.push({
          name,
          fieldCount: fields.length,
          requiredCount,
          hasSubmit: submits.length > 0,
        });
      }
      return forms;
    })
    .catch(() => [] as FormSummary[]);
}

/**
 * Find DOM elements that look interactive to sighted users (declarative
 * onclick attribute) but aren't reachable by keyboard or visible to a
 * screen reader (no button/link tag, no interactive role, no tabindex >= 0).
 *
 * Limitation: only catches the declarative `onclick="…"` form. Listeners
 * attached via addEventListener are invisible from outside the page — that
 * would require Chrome DevTools Protocol's getEventListeners and is left
 * for a future pass.
 */
async function detectFakeInteractive(page: Page | Frame): Promise<FakeInteractiveSummary> {
  return page
    .evaluate(() => {
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
        "treeitem",
      ]);
      const REGISTRY = (window as unknown as { __tactualEventCounts?: WeakMap<Element, Record<string, number>> })
        .__tactualEventCounts;

      // Returns true if the registry recorded any click-like listener
      // attached via addEventListener. False if the registry isn't
      // installed (capture was called outside the pipeline).
      const hasListenerInRegistry = (el: Element): boolean => {
        if (!REGISTRY) return false;
        try {
          const entry = REGISTRY.get(el);
          if (!entry) return false;
          return (entry.click ?? 0) > 0
            || (entry.mousedown ?? 0) > 0
            || (entry.pointerdown ?? 0) > 0;
        } catch {
          return false;
        }
      };

      // Returns true if the element has a React fiber-attached click
      // handler. React 17+ delegates events to a root container, so
      // per-element click handlers don't show up in addEventListener
      // tracking — they live on __reactProps$<key>.onClick.
      const hasReactClickHandler = (el: Element): boolean => {
        try {
          const obj = el as unknown as Record<string, unknown>;
          for (const key of Object.keys(obj)) {
            if (!key.startsWith("__reactProps$")) continue;
            const props = obj[key] as Record<string, unknown> | undefined;
            if (!props) continue;
            if (typeof props.onClick === "function") return true;
            if (typeof props.onMouseDown === "function") return true;
            if (typeof props.onPointerDown === "function") return true;
          }
        } catch {
          // some elements throw on Object.keys; ignore.
        }
        return false;
      };

      const samples: string[] = [];
      let count = 0;
      const seen = new Set<Element>();

      const considerCandidate = (el: Element, source: "onclick" | "addEventListener" | "react"): void => {
        if (seen.has(el)) return;
        seen.add(el);
        const tag = el.tagName.toLowerCase();
        if (NATIVE_INTERACTIVE.has(tag)) return;
        const role = (el.getAttribute("role") ?? "").toLowerCase();
        if (ARIA_INTERACTIVE.has(role)) return;
        const tabindex = el.getAttribute("tabindex");
        if (tabindex !== null && parseInt(tabindex, 10) >= 0) return;
        const rect = el.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) return;
        count++;
        if (samples.length < 5) {
          const id = el.id ? `#${el.id}` : "";
          const cls = el.className && typeof el.className === "string"
            ? "." + el.className.split(/\s+/).filter(Boolean).slice(0, 2).join(".")
            : "";
          samples.push(`${tag}${id}${cls}[${source}]`.slice(0, 80));
        }
      };

      // Pass 1: declarative onclick (cheap; covers static-HTML cases).
      const onclickEls = document.querySelectorAll("[onclick]");
      for (let i = 0; i < onclickEls.length; i++) {
        considerCandidate(onclickEls[i], "onclick");
      }

      // Pass 2: walk every element and check the registry + React fiber.
      // querySelectorAll('*') can be expensive on giant pages — cap the
      // scan so we don't pay 100s of ms on every captureState call. 2000
      // elements covers most realistic pages; bigger pages have bigger
      // problems anyway.
      const all = document.body ? document.body.querySelectorAll("*") : [];
      const SCAN_CAP = 2000;
      for (let i = 0; i < all.length && i < SCAN_CAP; i++) {
        const el = all[i];
        if (seen.has(el)) continue;
        if (hasListenerInRegistry(el)) {
          considerCandidate(el, "addEventListener");
          continue;
        }
        if (hasReactClickHandler(el)) {
          considerCandidate(el, "react");
        }
      }

      return { count, samples };
    })
    .catch(() => ({ count: 0, samples: [] }) as FakeInteractiveSummary);
}

// ---------------------------------------------------------------------------
// Child-frame snapshotting
// ---------------------------------------------------------------------------

/**
 * Snapshot every (non-main) frame in the page, up to MAX_FRAME_DESCENT.
 * Returns one entry per frame that produced a non-empty snapshot. Frames that
 * are detached, cross-origin without snapshot permissions, or otherwise
 * unsnapshottable are silently skipped — capture should still succeed when
 * a single embedded frame fails.
 */
/**
 * Run all four target enrichments inside a child frame's scope. Mirrors the
 * main-frame enrichment block in captureState; kept as a separate helper so
 * captureState's per-frame loop stays readable.
 */
async function enrichFrameTargets(frame: Frame, targets: Target[]): Promise<void> {
  await enrichWithAriaReferences(frame, targets);
  await enrichAriaRelationships(frame, targets);
  await enrichLinkHrefs(frame, targets);
  await enrichBoundingRects(frame, targets);
  await enrichNativeControlMetadata(frame, targets);
  await enrichTooltips(frame, targets);
  await enrichSkipLinkValidity(frame, targets);
}

const SKIP_LINK_NAME_PATTERN = /^(skip|jump\s*to)/i;

/**
 * For every link target whose accessible name matches a skip-link pattern,
 * resolve its href fragment and check the document for a matching element.
 * Sets `_skipLinkBroken: "target-missing"` on the link when the fragment
 * doesn't resolve. The `target-not-focusable` case is intentionally NOT
 * flagged — modern browsers move focus to non-focusable targets in many
 * cases, so the false-positive risk is too high without per-browser
 * verification.
 */
async function enrichSkipLinkValidity(page: Page | Frame, targets: Target[]): Promise<void> {
  const candidates = targets.filter(
    (t) => t.kind === "link" && t.name && SKIP_LINK_NAME_PATTERN.test(t.name),
  );
  if (candidates.length === 0) return;

  for (const link of candidates) {
    const href = (link as Record<string, unknown>)._href as string | undefined;
    if (!href) continue;
    let fragment: string;
    try {
      fragment = new URL(href, "http://placeholder/").hash.slice(1);
    } catch {
      continue;
    }
    if (!fragment) continue;

    const targetExists = await page
      .evaluate((id: string) => {
        try {
          return document.getElementById(id) !== null;
        } catch {
          return false;
        }
      }, fragment)
      .catch(() => true); // On evaluate failure, don't flag — avoid false positives

    if (!targetExists) {
      (link as Record<string, unknown>)._skipLinkBroken = "target-missing";
    }
  }
}

interface ChildFrameSnapshots {
  results: Array<{
    frame: Frame;
    yaml: string;
    source: "ariaSnapshot" | "cdp";
    cdpMetadata?: CDPAXNodeMetadata[];
    ownerRect?: CaptureRect;
  }>;
  /** Frames found beyond MAX_FRAME_DESCENT that we never tried. */
  overflow: number;
  /** Frames we tried to snapshot but couldn't (cross-origin, detached, empty). */
  skipped: Array<{ url: string; reason: "inaccessible" | "empty" }>;
}

interface CaptureRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

async function captureChildFrames(
  page: Page,
  snapshotDepth?: number,
): Promise<ChildFrameSnapshots> {
  const main = page.mainFrame();
  const allChildren = page.frames().filter((f) => f !== main);
  const overflow = Math.max(0, allChildren.length - MAX_FRAME_DESCENT);
  const childFrames = allChildren.slice(0, MAX_FRAME_DESCENT);

  const results: Array<{
    frame: Frame;
    yaml: string;
    source: "ariaSnapshot" | "cdp";
    cdpMetadata?: CDPAXNodeMetadata[];
    ownerRect?: CaptureRect;
  }> = [];
  const skipped: Array<{ url: string; reason: "inaccessible" | "empty" }> = [];

  for (const frame of childFrames) {
    const ownerRect = await readFrameOwnerPageRect(frame);
    try {
      const yaml = await frame.locator("html").ariaSnapshot({ depth: snapshotDepth });
      if (yaml.trim().length > 0) {
        results.push({ frame, yaml, source: "ariaSnapshot", ownerRect });
      } else {
        skipped.push({ url: frame.url(), reason: "empty" });
      }
    } catch {
      // Most common cause: a cross-origin OOPIF whose renderer will not
      // satisfy Playwright's frame-scoped ariaSnapshot call. Chromium still
      // exposes that renderer's accessibility tree through a CDP session
      // attached to the frame target, so recover it and feed the same YAML
      // parser as normal snapshots. Non-Chromium browsers, same-process
      // frames, and detached frames fall through to the existing skip path.
      const recovered = await recoverFrameSnapshotViaCDP(page, frame, snapshotDepth);
      if (recovered.yaml.trim().length > 0) {
        results.push({
          frame,
          yaml: recovered.yaml,
          source: "cdp",
          cdpMetadata: recovered.metadata,
          ownerRect,
        });
      } else {
        skipped.push({ url: frame.url(), reason: "inaccessible" });
      }
    }
  }
  return { results, overflow, skipped };
}

function insertFrameTargetsAtOwnerPosition(
  targets: Target[],
  frameTargets: Target[],
  ownerTargetOffset?: number,
  ownerRect?: CaptureRect,
): void {
  if (frameTargets.length === 0) return;
  const insertionIndex =
    ownerTargetOffset !== undefined
      ? frameTargetInsertionIndexFromSnapshotOffset(targets, ownerTargetOffset)
      : frameTargetInsertionIndexFromRect(targets, ownerRect);
  targets.splice(insertionIndex, 0, ...frameTargets);
}

function frameTargetInsertionIndexFromSnapshotOffset(
  targets: Target[],
  ownerTargetOffset: number,
): number {
  let mainFrameTargetsSeen = 0;
  for (let i = 0; i < targets.length; i++) {
    if ((targets[i] as Record<string, unknown>)._frame) continue;
    if (mainFrameTargetsSeen === ownerTargetOffset) return i;
    mainFrameTargetsSeen++;
  }
  return targets.length;
}

function frameTargetInsertionIndexFromRect(targets: Target[], ownerRect?: CaptureRect): number {
  if (!ownerRect) return targets.length;

  // Tactual stores frame target rects in the frame's own viewport. They are
  // correct for target-size findings, but not comparable with main-frame
  // coordinates. Use only main-frame targets as anchors so a previously
  // inserted frame cannot pull the next frame ahead of its iframe owner.
  for (let i = 0; i < targets.length; i++) {
    if ((targets[i] as Record<string, unknown>)._frame) continue;
    const rect = (targets[i] as Record<string, unknown>)._rect as CaptureRect | undefined;
    if (!rect) continue;
    if (rect.y > ownerRect.y + 1) return i;
    if (Math.abs(rect.y - ownerRect.y) <= 1 && rect.x > ownerRect.x + 1) return i;
  }

  return targets.length;
}

async function readFrameOwnerPageRect(frame: Frame): Promise<CaptureRect | undefined> {
  let current: Frame | null = frame;
  let x = 0;
  let y = 0;
  let leafSize: Pick<CaptureRect, "width" | "height"> | undefined;

  while (current) {
    const parent = current.parentFrame();
    if (!parent) break;
    const rect = await readFrameElementRect(current);
    if (!rect) return undefined;
    x += rect.x;
    y += rect.y;
    leafSize ??= { width: rect.width, height: rect.height };
    current = parent;
  }

  if (!leafSize) return undefined;
  return { x, y, width: leafSize.width, height: leafSize.height };
}

async function readFrameElementRect(frame: Frame): Promise<CaptureRect | undefined> {
  const handle = await frame.frameElement().catch(() => undefined);
  if (!handle) return undefined;
  try {
    return await handle
      .evaluate((el: Element) => {
        const r = el.getBoundingClientRect();
        return {
          x: Math.round(r.x),
          y: Math.round(r.y),
          width: Math.round(r.width),
          height: Math.round(r.height),
        };
      })
      .catch(() => undefined);
  } finally {
    await handle.dispose().catch(() => {});
  }
}

interface CDPAXTreeResponse {
  nodes?: CDPAXNode[];
}

async function recoverFrameSnapshotViaCDP(
  page: Page,
  frame: Frame,
  snapshotDepth?: number,
): Promise<{ yaml: string; metadata: CDPAXNodeMetadata[] }> {
  let session: CDPSession | undefined;
  try {
    session = await page.context().newCDPSession(frame);
    await session.send("Accessibility.enable");
    const { nodes } = (await session.send("Accessibility.getFullAXTree")) as CDPAXTreeResponse;
    if (!nodes || nodes.length === 0) return { yaml: "", metadata: [] };
    return cdpAxTreeToAriaSnapshot(nodes, { depth: snapshotDepth });
  } catch {
    return { yaml: "", metadata: [] };
  } finally {
    await session?.detach().catch(() => {});
  }
}

const CDP_TARGET_ROLES = new Set([
  "heading",
  "banner",
  "navigation",
  "main",
  "contentinfo",
  "complementary",
  "region",
  "search",
  "form",
  "link",
  "button",
  "menubar",
  "menu",
  "menuitem",
  "menuitemcheckbox",
  "menuitemradio",
  "tab",
  "tabpanel",
  "dialog",
  "alertdialog",
  "textbox",
  "searchbox",
  "combobox",
  "listbox",
  "spinbutton",
  "slider",
  "checkbox",
  "radio",
  "switch",
  "table",
  "grid",
  "tree",
  "treegrid",
  "row",
  "columnheader",
  "rowheader",
  "gridcell",
  "cell",
  "treeitem",
  "alert",
  "status",
  "log",
]);

interface RelatedAriaTarget {
  id: string;
  role: string;
  name: string;
}

interface AriaRelationshipMetadata {
  controls?: RelatedAriaTarget[];
  owns?: RelatedAriaTarget[];
  activeDescendant?: RelatedAriaTarget;
  flowto?: RelatedAriaTarget[];
  hasPopup?: string;
}

interface AriaRelationshipEnrichment {
  role: string;
  name: string;
  domId?: string;
  relationships?: AriaRelationshipMetadata;
  attributeValues?: Record<string, string>;
}

interface CdpElementEnrichment extends AriaRelationshipEnrichment {
  href?: string | null;
  description?: string;
  descriptionMissing?: boolean;
  labelledByMissing?: boolean;
  liveRegion?: string;
  tag?: string;
  inputType?: string;
  nativeHtmlControl?: string;
  required?: boolean;
  autocomplete?: string | null;
}

async function enrichCdpRecoveredFrameTargets(
  page: Page,
  frame: Frame,
  targets: Target[],
  metadata: CDPAXNodeMetadata[],
): Promise<void> {
  const aligned = alignCdpMetadataToTargets(targets, metadata);
  if (aligned.length === 0) return;

  let session: CDPSession | undefined;
  try {
    session = await page.context().newCDPSession(frame);
    for (const { target, meta } of aligned) {
      const record = target as Record<string, unknown>;
      record._cdpAxNodeId = meta.nodeId;
      if (!meta.backendDOMNodeId) continue;
      record._cdpBackendNodeId = meta.backendDOMNodeId;

      const rect = await readCdpBoxModel(session, meta.backendDOMNodeId);
      if (rect) record._rect = rect;

      const data = await readCdpElementEnrichment(session, meta.backendDOMNodeId);
      if (!data) continue;
      applyElementEnrichment(target, data);
    }
  } catch {
    // CDP enrichment is opportunistic. The recovered YAML is still useful
    // when a later DOM lookup fails because the frame navigated or detached.
  } finally {
    await session?.detach().catch(() => {});
  }
}

function alignCdpMetadataToTargets(
  targets: Target[],
  metadata: CDPAXNodeMetadata[],
): Array<{ target: Target; meta: CDPAXNodeMetadata }> {
  const usable = metadata.filter((meta) => CDP_TARGET_ROLES.has(meta.role));
  const aligned: Array<{ target: Target; meta: CDPAXNodeMetadata }> = [];
  let cursor = 0;
  for (const target of targets) {
    for (; cursor < usable.length; cursor++) {
      const meta = usable[cursor];
      if (meta.role === target.role && meta.name === (target.name ?? "")) {
        aligned.push({ target, meta });
        cursor++;
        break;
      }
    }
  }
  return aligned;
}

async function readCdpBoxModel(
  session: CDPSession,
  backendDOMNodeId: number,
): Promise<CaptureRect | null> {
  interface BoxModelResponse {
    model?: {
      border?: number[];
      content?: number[];
    };
  }
  try {
    const res = (await session.send("DOM.getBoxModel", { backendNodeId: backendDOMNodeId })) as BoxModelResponse;
    const quad = res.model?.border ?? res.model?.content;
    if (!quad || quad.length < 8) return null;
    const xs = [quad[0], quad[2], quad[4], quad[6]];
    const ys = [quad[1], quad[3], quad[5], quad[7]];
    const minX = Math.min(...xs);
    const maxX = Math.max(...xs);
    const minY = Math.min(...ys);
    const maxY = Math.max(...ys);
    return {
      x: Math.round(minX),
      y: Math.round(minY),
      width: Math.round(maxX - minX),
      height: Math.round(maxY - minY),
    };
  } catch {
    return null;
  }
}

async function readCdpElementEnrichment(
  session: CDPSession,
  backendDOMNodeId: number,
): Promise<CdpElementEnrichment | null> {
  return callFunctionOnBackendNode<CdpElementEnrichment>(
    session,
    backendDOMNodeId,
    `function () {
      const el = this;
      const doc = el.ownerDocument || document;
      const escapeId = (globalThis.CSS && globalThis.CSS.escape)
        ? globalThis.CSS.escape
        : (s) => String(s).replace(/[^a-zA-Z0-9_-]/g, (ch) => "\\\\" + ch);

      const inferRole = (node) => {
        const explicit = node.getAttribute && node.getAttribute("role");
        if (explicit) return explicit.trim();
        const tag = node.tagName ? node.tagName.toLowerCase() : "";
        if (tag === "a") return node.hasAttribute("href") ? "link" : "generic";
        if (tag === "button") return "button";
        if (tag === "input") {
          const type = (node.getAttribute("type") || "text").toLowerCase();
          if (type === "button" || type === "submit" || type === "reset" || type === "image") return "button";
          if (type === "checkbox") return "checkbox";
          if (type === "radio") return "radio";
          if (type === "range") return "slider";
          if (type === "number") return "spinbutton";
          if (type === "search") return "searchbox";
          return "textbox";
        }
        if (tag === "select") return node.hasAttribute("multiple") ? "listbox" : "combobox";
        if (tag === "textarea") return "textbox";
        if (tag === "nav") return "navigation";
        if (tag === "main") return "main";
        if (tag === "aside") return "complementary";
        if (tag === "section" || tag === "form") {
          return node.hasAttribute("aria-label") || node.hasAttribute("aria-labelledby")
            ? (tag === "section" ? "region" : "form")
            : "generic";
        }
        if (tag === "dialog") return "dialog";
        if (tag === "header") return "banner";
        if (tag === "footer") return "contentinfo";
        if (tag === "img") return node.getAttribute("alt") !== null ? "img" : "presentation";
        if (/^h[1-6]$/.test(tag)) return "heading";
        return tag;
      };

      const computeName = (node) => {
        const labelledBy = node.getAttribute && node.getAttribute("aria-labelledby");
        if (labelledBy) {
          const texts = labelledBy.split(/\\s+/).filter(Boolean)
            .map((id) => doc.getElementById(id))
            .filter(Boolean)
            .map((ref) => (ref.textContent || "").trim())
            .filter(Boolean);
          if (texts.length > 0) return texts.join(" ");
        }
        const ariaLabel = node.getAttribute && node.getAttribute("aria-label");
        if (ariaLabel) return ariaLabel.trim();
        const tag = node.tagName ? node.tagName.toLowerCase() : "";
        const isFormField = tag === "input" || tag === "select" || tag === "textarea";
        if (isFormField) {
          const id = node.id;
          if (id) {
            const labelFor = doc.querySelector('label[for="' + escapeId(id) + '"]');
            if (labelFor && labelFor.textContent) return labelFor.textContent.trim();
          }
          let parent = node.parentElement;
          while (parent) {
            if (parent.tagName === "LABEL" && parent.textContent) return parent.textContent.trim();
            parent = parent.parentElement;
          }
        }
        if (tag === "input") {
          const type = (node.getAttribute("type") || "text").toLowerCase();
          if (type === "button" || type === "submit" || type === "reset") {
            const value = (node.getAttribute("value") || "").trim();
            if (value) return value;
            return type === "submit" ? "Submit" : type === "reset" ? "Reset" : "";
          }
          if (type === "image") return (node.getAttribute("alt") || "").trim();
        }
        if (tag === "img") return (node.getAttribute("alt") || "").trim();
        const text = (node.textContent || "").trim();
        if (text) return text;
        if (tag === "input" || tag === "textarea") {
          const ph = (node.getAttribute("placeholder") || "").trim();
          if (ph) return ph;
        }
        return (node.getAttribute && node.getAttribute("title") || "").trim();
      };

      const related = (value) => {
        if (!value) return [];
        return value.split(/\\s+/).filter(Boolean).map((id) => {
          const ref = doc.getElementById(id);
          return ref ? { id, role: inferRole(ref), name: computeName(ref) } : null;
        }).filter(Boolean);
      };

      const attrNames = [
        "aria-checked", "aria-controls", "aria-disabled", "aria-expanded",
        "aria-haspopup", "aria-invalid", "aria-owns", "aria-pressed",
        "aria-readonly", "aria-required", "aria-selected"
      ];
      const attributeValues = {};
      for (const attr of attrNames) {
        const value = el.getAttribute && el.getAttribute(attr);
        if (value !== null && value !== undefined) attributeValues[attr] = value;
      }
      const setNativeBoolean = (attr, nativeValue) => {
        if (attributeValues[attr] !== undefined || nativeValue === undefined) return;
        attributeValues[attr] = nativeValue ? "true" : "false";
      };
      const inputType = el instanceof HTMLInputElement ? el.type.toLowerCase() : undefined;
      const nativeRequired =
        (el instanceof HTMLInputElement || el instanceof HTMLSelectElement || el instanceof HTMLTextAreaElement) &&
        el.required;
      if (el instanceof HTMLInputElement && (inputType === "checkbox" || inputType === "radio")) {
        setNativeBoolean("aria-checked", el.checked);
      }
      if (el instanceof HTMLSelectElement && !el.multiple) {
        setNativeBoolean("aria-expanded", false);
      }
      if (nativeRequired) setNativeBoolean("aria-required", true);
      if (
        (el instanceof HTMLInputElement || el instanceof HTMLSelectElement || el instanceof HTMLTextAreaElement) &&
        el.disabled
      ) {
        setNativeBoolean("aria-disabled", true);
      }
      if ((el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) && el.readOnly) {
        setNativeBoolean("aria-readonly", true);
      }

      const relationships = {};
      const controls = related(el.getAttribute && el.getAttribute("aria-controls"));
      const owns = related(el.getAttribute && el.getAttribute("aria-owns"));
      const flowto = related(el.getAttribute && el.getAttribute("aria-flowto"));
      const active = related(el.getAttribute && el.getAttribute("aria-activedescendant"))[0];
      const hasPopup = el.getAttribute && el.getAttribute("aria-haspopup");
      if (controls.length) relationships.controls = controls;
      if (owns.length) relationships.owns = owns;
      if (flowto.length) relationships.flowto = flowto;
      if (active) relationships.activeDescendant = active;
      if (hasPopup) relationships.hasPopup = hasPopup;

      const describedBy = el.getAttribute && el.getAttribute("aria-describedby");
      const out = {
        role: inferRole(el),
        name: computeName(el),
        domId: el.id || undefined,
        href: el instanceof HTMLAnchorElement ? el.href : null,
        tag: el.tagName ? el.tagName.toLowerCase() : undefined,
        inputType,
        nativeHtmlControl: el instanceof HTMLSelectElement ? "select" :
          el instanceof HTMLTextAreaElement ? "textarea" :
          el instanceof HTMLInputElement ? "input" : undefined,
        required: nativeRequired || (el.getAttribute && el.getAttribute("aria-required") === "true"),
        autocomplete: el.getAttribute ? el.getAttribute("autocomplete") : null,
        attributeValues,
        relationships: Object.keys(relationships).length ? relationships : undefined,
        liveRegion: el.getAttribute && el.getAttribute("aria-live") || undefined,
      };

      if (describedBy) {
        const ids = describedBy.split(/\\s+/).filter(Boolean);
        const texts = [];
        let missing = false;
        for (const id of ids) {
          const ref = doc.getElementById(id);
          if (!ref) missing = true;
          else if (ref.textContent) texts.push(ref.textContent.trim());
        }
        if (texts.length) out.description = texts.join(" ");
        if (missing) out.descriptionMissing = true;
      }

      const labelledBy = el.getAttribute && el.getAttribute("aria-labelledby");
      if (labelledBy) {
        const ids = labelledBy.split(/\\s+/).filter(Boolean);
        if (ids.some((id) => !doc.getElementById(id))) out.labelledByMissing = true;
      }

      return out;
    }`,
  );
}

async function callFunctionOnBackendNode<T>(
  session: CDPSession,
  backendDOMNodeId: number,
  functionDeclaration: string,
): Promise<T | null> {
  interface ResolveNodeResponse {
    object?: { objectId?: string };
  }
  interface RuntimeCallResponse {
    result?: { value?: T };
    exceptionDetails?: unknown;
  }
  const resolved = (await session.send("DOM.resolveNode", { backendNodeId: backendDOMNodeId })) as ResolveNodeResponse;
  const objectId = resolved.object?.objectId;
  if (!objectId) return null;
  try {
    const res = (await session.send("Runtime.callFunctionOn", {
      objectId,
      functionDeclaration,
      returnByValue: true,
      silent: true,
    })) as RuntimeCallResponse;
    if (res.exceptionDetails) return null;
    return res.result?.value ?? null;
  } catch {
    return null;
  } finally {
    await session.send("Runtime.releaseObject", { objectId }).catch(() => {});
  }
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

async function enrichAriaRelationships(page: Page | Frame, targets: Target[]): Promise<void> {
  const enrichments = await page
    .evaluate(() => {
      type LooseEl = {
        getAttribute(n: string): string | null;
        hasAttribute(n: string): boolean;
        textContent: string | null;
        tagName: string;
        id?: string;
        parentElement?: LooseEl | null;
      };
      const doc = (
        globalThis as unknown as {
          document: {
            querySelectorAll(s: string): ArrayLike<LooseEl>;
            getElementById(id: string): LooseEl | null;
            querySelector(s: string): LooseEl | null;
          };
          CSS?: { escape?: (s: string) => string };
        }
      ).document;
      const escapeId = (
        globalThis as unknown as { CSS?: { escape?: (s: string) => string } }
      ).CSS?.escape ?? ((s: string) => s.replace(/[^a-zA-Z0-9_-]/g, (ch) => "\\" + ch));

      const inferRole = (el: LooseEl): string => {
        const explicit = el.getAttribute("role");
        if (explicit) return explicit.trim();
        const tag = el.tagName.toLowerCase();
        if (tag === "a") return el.hasAttribute("href") ? "link" : "generic";
        if (tag === "button") return "button";
        if (tag === "input") {
          const type = (el.getAttribute("type") ?? "text").toLowerCase();
          if (type === "button" || type === "submit" || type === "reset" || type === "image") return "button";
          if (type === "checkbox") return "checkbox";
          if (type === "radio") return "radio";
          if (type === "range") return "slider";
          if (type === "number") return "spinbutton";
          if (type === "search") return "searchbox";
          return "textbox";
        }
        if (tag === "select") return el.hasAttribute("multiple") ? "listbox" : "combobox";
        if (tag === "textarea") return "textbox";
        if (tag === "nav") return "navigation";
        if (tag === "main") return "main";
        if (tag === "aside") return "complementary";
        if (tag === "section" || tag === "form")
          return el.hasAttribute("aria-label") || el.hasAttribute("aria-labelledby")
            ? tag === "section" ? "region" : "form"
            : "generic";
        if (tag === "dialog") return "dialog";
        if (tag === "header") return "banner";
        if (tag === "footer") return "contentinfo";
        if (tag === "img") return el.getAttribute("alt") !== null ? "img" : "presentation";
        if (/^h[1-6]$/.test(tag)) return "heading";
        return tag;
      };

      const computeAccessibleName = (el: LooseEl): string => {
        const labelledBy = el.getAttribute("aria-labelledby");
        if (labelledBy) {
          const texts = labelledBy
            .split(/\s+/)
            .filter(Boolean)
            .map((id) => doc.getElementById(id))
            .filter((ref): ref is LooseEl => Boolean(ref))
            .map((ref) => (ref.textContent ?? "").trim())
            .filter(Boolean);
          if (texts.length > 0) return texts.join(" ");
        }
        const ariaLabel = el.getAttribute("aria-label");
        if (ariaLabel) return ariaLabel.trim();
        const tag = el.tagName.toLowerCase();
        const isFormField = tag === "input" || tag === "select" || tag === "textarea";
        if (isFormField) {
          const id = el.id;
          if (id) {
            const labelFor = doc.querySelector(`label[for="${escapeId(id)}"]`);
            if (labelFor?.textContent) return labelFor.textContent.trim();
          }
          let parent: LooseEl | null | undefined = el.parentElement;
          while (parent) {
            if (parent.tagName === "LABEL" && parent.textContent) {
              return parent.textContent.trim();
            }
            parent = parent.parentElement;
          }
        }
        if (tag === "input") {
          const type = (el.getAttribute("type") ?? "text").toLowerCase();
          if (type === "button" || type === "submit" || type === "reset") {
            const value = (el.getAttribute("value") ?? "").trim();
            if (value) return value;
            return type === "submit" ? "Submit" : type === "reset" ? "Reset" : "";
          }
          if (type === "image") return (el.getAttribute("alt") ?? "").trim();
        }
        if (tag === "img") return (el.getAttribute("alt") ?? "").trim();
        const text = (el.textContent ?? "").trim();
        if (text) return text;
        if (tag === "input" || tag === "textarea") {
          const ph = (el.getAttribute("placeholder") ?? "").trim();
          if (ph) return ph;
        }
        return (el.getAttribute("title") ?? "").trim();
      };

      const related = (value: string | null): RelatedAriaTarget[] => {
        if (!value) return [];
        const out: RelatedAriaTarget[] = [];
        for (const id of value.split(/\s+/).filter(Boolean)) {
          const ref = doc.getElementById(id);
          if (!ref) continue;
          out.push({ id, role: inferRole(ref), name: computeAccessibleName(ref) });
        }
        return out;
      };

      const selector = [
        "[aria-activedescendant]",
        "[aria-checked]",
        "[aria-controls]",
        "[aria-disabled]",
        "[aria-expanded]",
        "[aria-flowto]",
        "[aria-haspopup]",
        "[aria-invalid]",
        "[aria-owns]",
        "[aria-pressed]",
        "[aria-readonly]",
        "[aria-required]",
        "[aria-selected]",
      ].join(",");
      const elements = doc.querySelectorAll(selector);
      const results: AriaRelationshipEnrichment[] = [];

      for (let i = 0; i < elements.length; i++) {
        const el = elements[i];
        const relationships: AriaRelationshipMetadata = {};
        const controls = related(el.getAttribute("aria-controls"));
        const owns = related(el.getAttribute("aria-owns"));
        const flowto = related(el.getAttribute("aria-flowto"));
        const activeDescendant = related(el.getAttribute("aria-activedescendant"))[0];
        const hasPopup = el.getAttribute("aria-haspopup") ?? undefined;
        if (controls.length > 0) relationships.controls = controls;
        if (owns.length > 0) relationships.owns = owns;
        if (flowto.length > 0) relationships.flowto = flowto;
        if (activeDescendant) relationships.activeDescendant = activeDescendant;
        if (hasPopup) relationships.hasPopup = hasPopup;

        const attributeValues: Record<string, string> = {};
        for (const attr of [
          "aria-checked",
          "aria-controls",
          "aria-disabled",
          "aria-expanded",
          "aria-haspopup",
          "aria-invalid",
          "aria-owns",
          "aria-pressed",
          "aria-readonly",
          "aria-required",
          "aria-selected",
        ]) {
          const value = el.getAttribute(attr);
          if (value !== null) attributeValues[attr] = value;
        }

        results.push({
          role: inferRole(el),
          name: computeAccessibleName(el),
          ...(el.id ? { domId: el.id } : {}),
          ...(Object.keys(relationships).length > 0 ? { relationships } : {}),
          ...(Object.keys(attributeValues).length > 0 ? { attributeValues } : {}),
        });
      }

      return results;
    })
    .catch(() => [] as AriaRelationshipEnrichment[]);

  const used = new Set<number>();
  for (const target of targets) {
    const targetName = (target.name ?? "").trim();
    const idx = enrichments.findIndex(
      (e, i) => !used.has(i) && e.role === target.role && e.name === targetName,
    );
    if (idx < 0) continue;
    used.add(idx);
    applyElementEnrichment(target, enrichments[idx]);
  }
}

function applyElementEnrichment(
  target: Target,
  enrichment: Partial<CdpElementEnrichment>,
): void {
  const out = target as Record<string, unknown>;
  if (enrichment.href) out._href = enrichment.href;
  if (enrichment.description) out._description = enrichment.description;
  if (enrichment.descriptionMissing) out._descriptionMissing = true;
  if (enrichment.labelledByMissing) out._labelledByMissing = true;
  if (enrichment.liveRegion === "polite" || enrichment.liveRegion === "assertive") {
    out._liveRegion = enrichment.liveRegion;
  }
  if (enrichment.domId) out._domId = enrichment.domId;
  if (enrichment.tag) out._htmlTag = enrichment.tag;
  if (enrichment.inputType) out._inputType = enrichment.inputType;
  if (enrichment.nativeHtmlControl) out._nativeHtmlControl = enrichment.nativeHtmlControl;
  if (enrichment.required) out._required = true;
  if (enrichment.autocomplete) out._autocomplete = enrichment.autocomplete.trim().toLowerCase();
  if (enrichment.relationships) out._ariaRelationships = enrichment.relationships;
  if (enrichment.attributeValues && Object.keys(enrichment.attributeValues).length > 0) {
    const existing = (out._attributeValues as Record<string, string> | undefined) ?? {};
    out._attributeValues = { ...existing, ...enrichment.attributeValues };
    const existingAttrs = new Set((out._attributes as string[] | undefined) ?? []);
    for (const attr of Object.keys(enrichment.attributeValues)) existingAttrs.add(attr);
    out._attributes = [...existingAttrs];
  }
}

/**
 * Attach `_rect` (width + height in CSS pixels) to interactive targets so the
 * finding builder can flag WCAG 2.5.8 "target size" failures (≥24×24 for AA).
 *
 * We only measure interactive kinds (button, link, formField, menuTrigger,
 * tab, search) — headings and landmarks don't need to meet the minimum.
 */
async function enrichBoundingRects(page: Page | Frame, targets: Target[]): Promise<void> {
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
              x: Math.round(r.x),
              y: Math.round(r.y),
              width: Math.round(r.width),
              height: Math.round(r.height),
              inlineInText,
            };
          })
          .catch(() => null);
        if (data) {
          (group[i] as Record<string, unknown>)._rect = {
            x: data.x,
            y: data.y,
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
async function enrichLinkHrefs(page: Page | Frame, targets: Target[]): Promise<void> {
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

async function enrichNativeControlMetadata(page: Page | Frame, targets: Target[]): Promise<void> {
  const roles = new Set([
    "combobox",
    "listbox",
    "textbox",
    "searchbox",
    "checkbox",
    "radio",
    "spinbutton",
    "slider",
  ]);
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
            const ariaRequired = el.getAttribute("aria-required");
            // HTMLInputElement / SelectElement / TextAreaElement all expose
            // a `.required` boolean. The aria-required attribute also
            // applies to custom widgets (e.g., <div role="textbox"
            // aria-required="true">), so we OR them together.
            const nativeRequired =
              (el instanceof HTMLInputElement ||
                el instanceof HTMLSelectElement ||
                el instanceof HTMLTextAreaElement) &&
              el.required;
            const autocompleteAttr = el.getAttribute("autocomplete");
            const attributeValues: Record<string, string> = {};
            const setExplicitOrNativeBoolean = (
              attr: string,
              nativeValue: boolean | undefined,
            ): void => {
              const explicit = el.getAttribute(attr);
              if (explicit !== null) {
                attributeValues[attr] = explicit;
              } else if (nativeValue !== undefined) {
                attributeValues[attr] = nativeValue ? "true" : "false";
              }
            };
            const inputType = el instanceof HTMLInputElement ? el.type.toLowerCase() : undefined;

            if (el instanceof HTMLInputElement && (inputType === "checkbox" || inputType === "radio")) {
              setExplicitOrNativeBoolean("aria-checked", el.checked);
            }
            if (el instanceof HTMLSelectElement && !el.multiple) {
              setExplicitOrNativeBoolean("aria-expanded", false);
            }
            setExplicitOrNativeBoolean(
              "aria-required",
              nativeRequired ? true : undefined,
            );
            setExplicitOrNativeBoolean(
              "aria-disabled",
              el instanceof HTMLInputElement ||
                el instanceof HTMLSelectElement ||
                el instanceof HTMLTextAreaElement
                ? el.disabled
                  ? true
                  : undefined
                : undefined,
            );
            setExplicitOrNativeBoolean(
              "aria-readonly",
              el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement
                ? el.readOnly
                  ? true
                  : undefined
                : undefined,
            );
            return {
              tag,
              inputType,
              nativeHtmlControl:
                el instanceof HTMLSelectElement
                  ? "select"
                  : el instanceof HTMLTextAreaElement
                    ? "textarea"
                    : el instanceof HTMLInputElement
                      ? "input"
                      : undefined,
              required: nativeRequired || ariaRequired === "true",
              autocomplete: autocompleteAttr ? autocompleteAttr.trim().toLowerCase() : null,
              attributeValues,
            };
          })
          .catch(() => null);
        if (data) {
          const target = group[i] as Record<string, unknown>;
          target._htmlTag = data.tag;
          if (data.inputType) target._inputType = data.inputType;
          if (data.nativeHtmlControl) target._nativeHtmlControl = data.nativeHtmlControl;
          if (data.required) target._required = true;
          if (data.autocomplete) target._autocomplete = data.autocomplete;
          if (data.attributeValues && Object.keys(data.attributeValues).length > 0) {
            const existing = (target._attributeValues as Record<string, string> | undefined) ?? {};
            target._attributeValues = { ...existing, ...data.attributeValues };
            const attrs = new Set((target._attributes as string[] | undefined) ?? []);
            for (const attr of Object.keys(data.attributeValues)) attrs.add(attr);
            target._attributes = [...attrs];
          }
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

/**
 * Detect tooltips via attribute scan and attach `_tooltip: string` to the
 * matched target. Catches HTML title, Bootstrap data-bs-original-title,
 * Tippy.js data-tippy-content, and generic data-tooltip / data-balloon
 * attributes. Skips actually hovering each candidate (would be N × ~800 ms);
 * for these patterns the rendered tooltip text equals the attribute value.
 *
 * Limitation: pure-React/Vue hover-state tooltips that don't encode the
 * tooltip text in any attribute are missed. They'd require live-hover probing.
 */
async function enrichTooltips(page: Page | Frame, targets: Target[]): Promise<void> {
  interface TooltipEnrichment {
    role: string;
    name: string;
    tooltip: string;
  }

  const tooltips = await page
    .evaluate(() => {
      type LooseEl = {
        getAttribute(n: string): string | null;
        hasAttribute(n: string): boolean;
        textContent: string | null;
        tagName: string;
        id?: string;
        parentElement?: LooseEl | null;
      };
      const doc = (
        globalThis as unknown as {
          document: {
            querySelectorAll(s: string): ArrayLike<LooseEl>;
            getElementById(id: string): LooseEl | null;
            querySelector(s: string): LooseEl | null;
          };
        }
      ).document;
      const escapeId = (
        globalThis as unknown as { CSS?: { escape?: (s: string) => string } }
      ).CSS?.escape ?? ((s: string) => s.replace(/[^a-zA-Z0-9_-]/g, (ch) => "\\" + ch));
      // Both helpers duplicate enrichWithAriaReferences's versions because
      // page.evaluate functions are serialized independently and can't share
      // Node-side helpers. Keep them in sync if either changes.
      const inferRole = (el: LooseEl): string => {
        const explicit = el.getAttribute("role");
        if (explicit) return explicit.trim();
        const tag = el.tagName.toLowerCase();
        if (tag === "a") return el.hasAttribute("href") ? "link" : "generic";
        if (tag === "button") return "button";
        if (tag === "input") {
          const type = (el.getAttribute("type") ?? "text").toLowerCase();
          if (type === "button" || type === "submit" || type === "reset" || type === "image") return "button";
          if (type === "checkbox") return "checkbox";
          if (type === "radio") return "radio";
          if (type === "range") return "slider";
          if (type === "number") return "spinbutton";
          if (type === "search") return "searchbox";
          return "textbox";
        }
        if (tag === "select") return el.hasAttribute("multiple") ? "listbox" : "combobox";
        if (tag === "textarea") return "textbox";
        if (tag === "nav") return "navigation";
        if (tag === "main") return "main";
        if (tag === "aside") return "complementary";
        if (tag === "section" || tag === "form")
          return el.hasAttribute("aria-label") || el.hasAttribute("aria-labelledby")
            ? tag === "section" ? "region" : "form"
            : "generic";
        if (tag === "dialog") return "dialog";
        if (tag === "header") return "banner";
        if (tag === "footer") return "contentinfo";
        if (tag === "img") return el.getAttribute("alt") !== null ? "img" : "presentation";
        if (/^h[1-6]$/.test(tag)) return "heading";
        return tag;
      };
      const computeAccessibleName = (el: LooseEl): string => {
        const labelledBy = el.getAttribute("aria-labelledby");
        if (labelledBy) {
          const ids = labelledBy.split(/\s+/).filter(Boolean);
          const texts: string[] = [];
          for (const id of ids) {
            const ref = doc.getElementById(id);
            if (ref?.textContent) texts.push(ref.textContent.trim());
          }
          if (texts.length > 0) return texts.join(" ");
        }
        const ariaLabel = el.getAttribute("aria-label");
        if (ariaLabel) return ariaLabel.trim();
        const tag = el.tagName.toLowerCase();
        const isFormField = tag === "input" || tag === "select" || tag === "textarea";
        if (isFormField) {
          const id = el.id;
          if (id) {
            const labelFor = doc.querySelector(`label[for="${escapeId(id)}"]`);
            if (labelFor?.textContent) return labelFor.textContent.trim();
          }
          let parent: LooseEl | null | undefined = el.parentElement;
          while (parent) {
            if (parent.tagName === "LABEL" && parent.textContent) {
              return parent.textContent.trim();
            }
            parent = parent.parentElement;
          }
        }
        if (tag === "input") {
          const type = (el.getAttribute("type") ?? "text").toLowerCase();
          if (type === "button" || type === "submit" || type === "reset") {
            const value = (el.getAttribute("value") ?? "").trim();
            if (value) return value;
            return type === "submit" ? "Submit" : type === "reset" ? "Reset" : "";
          }
          if (type === "image") return (el.getAttribute("alt") ?? "").trim();
        }
        if (tag === "img") return (el.getAttribute("alt") ?? "").trim();
        const text = (el.textContent ?? "").trim();
        if (text) return text;
        if (tag === "input" || tag === "textarea") {
          const ph = (el.getAttribute("placeholder") ?? "").trim();
          if (ph) return ph;
        }
        return (el.getAttribute("title") ?? "").trim();
      };

      const results: Array<{ role: string; name: string; tooltip: string }> = [];
      const els = doc.querySelectorAll(
        "[title]:not([title='']), [data-tooltip], [data-tippy-content], [data-balloon], [data-bs-original-title], [data-original-title]",
      );
      for (let i = 0; i < els.length; i++) {
        const el = els[i];
        const tooltip = (
          el.getAttribute("data-bs-original-title") ??
          el.getAttribute("data-original-title") ??
          el.getAttribute("data-tippy-content") ??
          el.getAttribute("data-tooltip") ??
          el.getAttribute("data-balloon") ??
          el.getAttribute("title") ??
          ""
        ).trim();
        if (!tooltip) continue;
        const role = inferRole(el);
        const name = computeAccessibleName(el);
        results.push({ role, name, tooltip });
      }
      return results;
    })
    .catch(() => [] as TooltipEnrichment[]);

  if (tooltips.length === 0) return;

  // Match by role + name, first-fit. Targets share the same role+name when
  // the page has duplicate buttons/links — the first-fit heuristic is the
  // same one enrichWithAriaReferences uses, with the same caveat.
  const used = new Set<number>();
  for (const target of targets) {
    if ((target as Record<string, unknown>)._tooltip !== undefined) continue;
    const targetName = (target.name ?? "").trim();
    const idx = tooltips.findIndex(
      (e, i) => !used.has(i) && e.role === target.role && e.name === targetName,
    );
    if (idx < 0) continue;
    used.add(idx);
    (target as Record<string, unknown>)._tooltip = tooltips[idx].tooltip;
  }
}

async function enrichWithAriaReferences(page: Page | Frame, targets: Target[]): Promise<void> {
  const enrichments = await page
    .evaluate(() => {
      // DOM types not in tsconfig lib — declared via `as never` cast pattern.
      // Loosely-typed Element so the helpers can read parents/queries that
      // the original narrow shape didn't expose.
      type LooseEl = {
        getAttribute(n: string): string | null;
        hasAttribute(n: string): boolean;
        textContent: string | null;
        tagName: string;
        id?: string;
        parentElement?: LooseEl | null;
      };
      const doc = (
        globalThis as unknown as {
          document: {
            querySelectorAll(s: string): ArrayLike<LooseEl>;
            getElementById(id: string): LooseEl | null;
            querySelector(s: string): LooseEl | null;
          };
        }
      ).document;
      const escapeId = (
        globalThis as unknown as { CSS?: { escape?: (s: string) => string } }
      ).CSS?.escape ?? ((s: string) => s.replace(/[^a-zA-Z0-9_-]/g, (ch) => "\\" + ch));
      // Map common HTML tags to their computed accessible roles. Falling back
      // to tagName.toLowerCase() (the prior behaviour) caused matching to
      // fail for any native control whose computed role differs from its
      // tag — most importantly <input>/<textarea>/<select>/<a>.
      const inferRole = (el: LooseEl): string => {
        const explicit = el.getAttribute("role");
        if (explicit) return explicit.trim();
        const tag = el.tagName.toLowerCase();
        if (tag === "a") return el.hasAttribute("href") ? "link" : "generic";
        if (tag === "button") return "button";
        if (tag === "input") {
          const type = (el.getAttribute("type") ?? "text").toLowerCase();
          if (type === "button" || type === "submit" || type === "reset" || type === "image") return "button";
          if (type === "checkbox") return "checkbox";
          if (type === "radio") return "radio";
          if (type === "range") return "slider";
          if (type === "number") return "spinbutton";
          if (type === "search") return "searchbox";
          return "textbox";
        }
        if (tag === "select") return el.hasAttribute("multiple") ? "listbox" : "combobox";
        if (tag === "textarea") return "textbox";
        if (tag === "nav") return "navigation";
        if (tag === "main") return "main";
        if (tag === "aside") return "complementary";
        if (tag === "section" || tag === "form")
          return el.hasAttribute("aria-label") || el.hasAttribute("aria-labelledby")
            ? tag === "section" ? "region" : "form"
            : "generic";
        if (tag === "dialog") return "dialog";
        if (tag === "header") return "banner";
        if (tag === "footer") return "contentinfo";
        if (tag === "img") return el.getAttribute("alt") !== null ? "img" : "presentation";
        if (/^h[1-6]$/.test(tag)) return "heading";
        return tag;
      };
      // Compute accessible name following the standard chain (simplified to
      // the cases ariaSnapshot's name extractor handles in practice).
      // Without this, the prior code returned aria-label-or-empty and
      // missed every native input labeled via <label for>, every button
      // whose name is its text content, etc. — so the matching loop below
      // never set _description / _labelledByMissing / _liveRegion on those.
      const computeAccessibleName = (el: LooseEl): string => {
        // 1. aria-labelledby chain
        const labelledBy = el.getAttribute("aria-labelledby");
        if (labelledBy) {
          const ids = labelledBy.split(/\s+/).filter(Boolean);
          const texts: string[] = [];
          for (const id of ids) {
            const ref = doc.getElementById(id);
            if (ref?.textContent) texts.push(ref.textContent.trim());
          }
          if (texts.length > 0) return texts.join(" ");
        }
        // 2. aria-label
        const ariaLabel = el.getAttribute("aria-label");
        if (ariaLabel) return ariaLabel.trim();
        // 3+4. <label for>/wrapping <label> for form controls
        const tag = el.tagName.toLowerCase();
        const isFormField = tag === "input" || tag === "select" || tag === "textarea";
        if (isFormField) {
          const id = el.id;
          if (id) {
            const labelFor = doc.querySelector(`label[for="${escapeId(id)}"]`);
            if (labelFor?.textContent) return labelFor.textContent.trim();
          }
          let parent: LooseEl | null | undefined = el.parentElement;
          while (parent) {
            if (parent.tagName === "LABEL" && parent.textContent) {
              return parent.textContent.trim();
            }
            parent = parent.parentElement;
          }
        }
        // 5. Element-specific defaults
        if (tag === "input") {
          const type = (el.getAttribute("type") ?? "text").toLowerCase();
          if (type === "button" || type === "submit" || type === "reset") {
            const value = (el.getAttribute("value") ?? "").trim();
            if (value) return value;
            return type === "submit" ? "Submit" : type === "reset" ? "Reset" : "";
          }
          if (type === "image") return (el.getAttribute("alt") ?? "").trim();
        }
        if (tag === "img") return (el.getAttribute("alt") ?? "").trim();
        // 6. Text content (buttons, links, headings, generic widgets)
        const text = (el.textContent ?? "").trim();
        if (text) return text;
        // 7. placeholder (text-like inputs/textareas)
        if (tag === "input" || tag === "textarea") {
          const ph = (el.getAttribute("placeholder") ?? "").trim();
          if (ph) return ph;
        }
        // 8. title attribute (last-resort accessible-name source)
        return (el.getAttribute("title") ?? "").trim();
      };

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
        const role = inferRole(el);
        const name = computeAccessibleName(el);

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
