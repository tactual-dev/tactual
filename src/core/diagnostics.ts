import type { PageState } from "./types.js";
import { CONTROL_KINDS } from "./types.js";

function isControlKind(kind: string): boolean {
  return CONTROL_KINDS.has(kind);
}

/**
 * Capture diagnostics — signals about whether the page was
 * successfully captured or if something went wrong.
 */
export interface CaptureDiagnostic {
  level: "info" | "warning" | "error";
  code: DiagnosticCode;
  message: string;
  /** Optional structured fields used by aggregating diagnostics. Absent on
   *  diagnostic codes that don't aggregate multiple targets. */
  affectedCount?: number;
  totalCount?: number;
  affectedTargetIds?: string[];
  representativeFix?: string;
}

export type DiagnosticCode =
  | "blocked-by-bot-protection"
  | "empty-page"
  | "sparse-content"
  | "no-landmarks"
  | "no-main-landmark"
  | "no-banner-landmark"
  | "no-contentinfo-landmark"
  | "no-nav-landmark"
  | "no-headings"
  | "heading-skip"
  | "no-skip-link"
  | "structural-summary"
  | "shared-structural-issue"
  | "landmark-demoted"
  | "possible-login-wall"
  | "possible-cookie-wall"
  | "redirect-detected"
  | "possibly-degraded-content"
  | "timeout-during-render"
  | "exploration-no-new-states"
  | "redundant-tab-stops"
  | "spa-route-changes"
  | "frames-descended"
  | "auto-scrolled"
  | "banners-dismissed"
  | "fake-interactive-elements"
  | "tab-order-walked"
  | "broken-skip-link"
  | "visual-order-divergence"
  | "form-summary"
  | "low-contrast-text"
  | "missing-autocomplete"
  | "missing-html-lang"
  | "poor-document-title"
  | "viewport-blocks-zoom"
  | "missing-image-alt"
  | "suspicious-image-alt"
  | "missing-iframe-title"
  | "duplicate-id"
  | "nested-interactive"
  | "meta-refresh"
  | "empty-heading"
  | "numeric-heading"
  | "skip-link-not-first"
  | "empty-interactive"
  | "h1-count"
  | "media-without-controls"
  | "ambiguous-link-names"
  | "invalid-aria-role"
  | "unknown-aria-attr"
  | "invalid-aria-attr-value"
  | "missing-required-aria-attr"
  | "aria-naming-prohibited"
  | "unsupported-aria-attr-for-role"
  | "cdp-click-listeners"
  | "framework-detected"
  | "color-only-conveyance"
  | "color-blindness-contrast-fail"
  | "viewport-divergence"
  | "data-flow-dependencies"
  | "lang-switch-without-marker"
  | "ok";

/** High-confidence bot-block / challenge page signals. Each of these alone
 *  is enough to flag — they only appear on challenge pages, not as regular
 *  site copy. */
const BLOCK_SIGNALS_STRONG = [
  /you[''']ve been blocked/i,
  /access denied/i,
  /please verify you are (a )?human/i,
  /checking (if the site connection is secure|your browser)/i,
  /just a moment/i,
  /attention required/i,
  /bot detection/i,
  /automated (access|traffic)/i,
];

/** Weak signals — words that sometimes appear on challenge pages but also
 *  in legitimate site copy (astro.build mentions "cloudflare" as a deploy
 *  target; every docs site mentions "captcha" or "security check" in
 *  tutorials). Flag these only when paired with a thin target count,
 *  which correlates strongly with challenge pages. */
const BLOCK_SIGNALS_WEAK = [/captcha/i, /cloudflare/i, /ray id/i, /security check/i];

/** Login / auth wall signals */
const LOGIN_SIGNALS = [
  /sign in/i,
  /log in/i,
  /create (an )?account/i,
  /authentication required/i,
];

/** Cookie consent wall signals (page may be obscured) */
const COOKIE_SIGNALS = [
  /cookie (consent|policy|preferences|settings)/i,
  /accept (all )?cookies/i,
  /we use cookies/i,
];

interface DiagnosticContext {
  state: PageState;
  requestedUrl: string;
  fullText: string;
  diagnostics: CaptureDiagnostic[];
}

/**
 * Analyze a captured state for signs of blocked, degraded, or
 * incomplete content. Returns diagnostics that explain why an
 * analysis may be unreliable.
 */
export function diagnoseCapture(
  state: PageState,
  requestedUrl: string,
  snapshotText: string,
): CaptureDiagnostic[] {
  const targetNames = state.targets.map((t) => (t.name ?? "").toLowerCase()).join(" ");
  const ctx: DiagnosticContext = {
    state,
    requestedUrl,
    fullText: (snapshotText + " " + targetNames).toLowerCase(),
    diagnostics: [],
  };

  addEmptyPageDiagnostic(ctx);
  addBotProtectionDiagnostic(ctx);
  addSparseContentDiagnostic(ctx);
  addDegradedContentDiagnostic(ctx);
  const loginRedirect = addLoginWallDiagnostic(ctx);
  addCookieWallDiagnostic(ctx);
  addRedirectDiagnostic(ctx, loginRedirect);
  addBasicStructuralDiagnostics(ctx);
  addHeadingSkipDiagnostic(ctx);
  addSkipLinkDiagnostic(ctx);
  addBrokenSkipLinkDiagnostic(ctx);
  addLandmarkCompletenessDiagnostics(ctx);
  addStructuralSummaryDiagnostic(ctx);
  addFakeInteractiveDiagnostic(ctx);
  addVisualOrderDivergenceDiagnostic(ctx);
  addFormSummaryDiagnostic(ctx);
  addLowContrastTextDiagnostic(ctx);
  addMissingAutocompleteDiagnostic(ctx);
  addDocumentMetadataDiagnostics(ctx);
  addMediaMetadataDiagnostics(ctx);
  addStructuralIssuesDiagnostics(ctx);
  addHeadingContentDiagnostics(ctx);
  addEmptyInteractiveDiagnostic(ctx);
  addH1CountDiagnostic(ctx);
  addMediaControlsDiagnostic(ctx);
  addAmbiguousLinkNamesDiagnostic(ctx);
  addAriaValidationDiagnostics(ctx);
  addCDPListenerDiagnostic(ctx);
  addFrameworkDetectedDiagnostic(ctx);
  addColorOnlyConveyanceDiagnostic(ctx);
  addCvdContrastDiagnostic(ctx);
  addViewportDivergenceDiagnostic(ctx);
  addLangSwitchDiagnostic(ctx);

  if (ctx.diagnostics.length === 0) {
    ctx.diagnostics.push({
      level: "info",
      code: "ok",
      message: `Captured ${state.targets.length} targets successfully.`,
    });
  }

  return ctx.diagnostics;
}

function addEmptyPageDiagnostic(ctx: DiagnosticContext): void {
  if (ctx.state.targets.length !== 0) return;

  ctx.diagnostics.push({
    level: "error",
    code: "empty-page",
    message:
      "No accessibility targets found. The page may be blank, " +
      "completely JS-rendered with no fallback, or blocked.",
  });
}

function addBotProtectionDiagnostic(ctx: DiagnosticContext): void {
  // Strong signals flag alone; weak signals require corroboration from a thin
  // target count (< 30) because challenge pages rarely have substantial content.
  const strongMatch = findFirstMatch(BLOCK_SIGNALS_STRONG, ctx.fullText);
  const weakMatch =
    ctx.state.targets.length < 30 ? findFirstMatch(BLOCK_SIGNALS_WEAK, ctx.fullText) : undefined;
  const blockMatch = strongMatch ?? weakMatch;
  if (!blockMatch) return;

  ctx.diagnostics.push({
    level: "error",
    code: "blocked-by-bot-protection",
    message:
      `Page appears to be a bot-protection challenge (matched: "${blockMatch}"). ` +
      "Analysis results reflect the challenge page, not the actual site " +
      "content. Try with a non-headless browser or authenticated session.",
  });
}

function addSparseContentDiagnostic(ctx: DiagnosticContext): void {
  if (ctx.state.targets.length === 0 || ctx.state.targets.length >= 5) return;
  const hasOnlyLinks = ctx.state.targets.every(
    (t) => t.kind === "link" || t.kind === "statusMessage",
  );
  if (!hasOnlyLinks) return;

  ctx.diagnostics.push({
    level: "warning",
    code: "sparse-content",
    message:
      `Only ${ctx.state.targets.length} targets found (all links/status). ` +
      "The page may not have fully rendered, or may be showing an " +
      "error/challenge page instead of actual content.",
  });
}

function addDegradedContentDiagnostic(ctx: DiagnosticContext): void {
  if (
    ctx.state.targets.length === 0 ||
    ctx.state.targets.length >= 30 ||
    !ctx.state.url.startsWith("http") ||
    ctx.diagnostics.some((d) => d.code === "blocked-by-bot-protection")
  ) {
    return;
  }

  const headings = ctx.state.targets.filter((t) => t.kind === "heading").length;
  const landmarks = ctx.state.targets.filter((t) => t.kind === "landmark").length;
  if (headings > 1 || landmarks > 2) return;

  ctx.diagnostics.push({
    level: "warning",
    code: "possibly-degraded-content",
    message:
      `Only ${ctx.state.targets.length} targets found (${headings} headings, ` +
      `${landmarks} landmarks). The site may have served a stripped-down ` +
      "or gated version to the headless browser. Scores reflect what " +
      "was captured, not necessarily the full site. Try --no-headless " +
      "or an authenticated session for more complete results.",
  });
}

function addLoginWallDiagnostic(ctx: DiagnosticContext): boolean {
  // Path-based redirect is strong signal; content-based is weak. A page with
  // 100+ targets that has a "Sign in" link in the nav is not a login wall.
  const loginRedirect = detectLoginRedirect(ctx.requestedUrl, ctx.state.url);
  if (loginRedirect) {
    ctx.diagnostics.push({
      level: "warning",
      code: "possible-login-wall",
      message:
        `Redirected to login page (${new URL(ctx.state.url).pathname}). ` +
        "Analysis reflects the login/auth page, not the requested content. " +
        "Use an authenticated session or pre-login cookies for accurate results.",
    });
    return true;
  }

  const loginMatch = findFirstMatch(LOGIN_SIGNALS, ctx.fullText);
  if (loginMatch && ctx.state.targets.length < 30) {
    ctx.diagnostics.push({
      level: "warning",
      code: "possible-login-wall",
      message:
        `Page appears to require authentication (matched: "${loginMatch}"). ` +
        "Analysis may reflect a login page rather than the actual application content.",
    });
  }
  return false;
}

function addCookieWallDiagnostic(ctx: DiagnosticContext): void {
  const cookieMatch = findFirstMatch(COOKIE_SIGNALS, ctx.fullText);
  if (!cookieMatch) return;

  ctx.diagnostics.push({
    level: "info",
    code: "possible-cookie-wall",
    message:
      `Cookie consent dialog detected (matched: "${cookieMatch}"). ` +
      "Some page content may be obscured or inaccessible until cookies are accepted.",
  });
}

function addRedirectDiagnostic(ctx: DiagnosticContext, loginRedirect: boolean): void {
  if (!ctx.state.url) return;

  try {
    const requested = new URL(ctx.requestedUrl);
    const actual = new URL(ctx.state.url);
    if (requested.hostname !== actual.hostname) {
      ctx.diagnostics.push({
        level: "warning",
        code: "redirect-detected",
        message:
          `Redirected from ${requested.hostname} to ${actual.hostname}. ` +
          "Analysis reflects the destination page.",
      });
    } else if (requested.pathname !== actual.pathname && !loginRedirect) {
      ctx.diagnostics.push({
        level: "info",
        code: "redirect-detected",
        message:
          `Redirected from ${requested.pathname} to ${actual.pathname}. ` +
          "Analysis reflects the destination page.",
      });
    }
  } catch {
    // URL parsing failed — skip this check.
  }
}

function addBasicStructuralDiagnostics(ctx: DiagnosticContext): void {
  if (ctx.state.targets.length < 5) return;

  if (!ctx.state.targets.some((t) => t.kind === "landmark")) {
    ctx.diagnostics.push({
      level: "warning",
      code: "no-landmarks",
      message: "No landmark regions found (main, nav, banner, etc.).",
    });
  }

  if (!ctx.state.targets.some((t) => t.kind === "heading")) {
    ctx.diagnostics.push({
      level: "warning",
      code: "no-headings",
      message:
        "No heading elements found. Screen-reader users rely heavily " +
        "on headings for navigation (71.6% start with headings per " +
        "WebAIM 2024 survey).",
    });
  }
}

function addHeadingSkipDiagnostic(ctx: DiagnosticContext): void {
  const headings = ctx.state.targets.filter(
    (t) => t.kind === "heading" && typeof t.headingLevel === "number",
  );
  if (headings.length < 2) return;

  const skips: string[] = [];
  for (let i = 1; i < headings.length; i++) {
    const prev = headings[i - 1].headingLevel as number;
    const curr = headings[i].headingLevel as number;
    // A "skip" is going from level N to level N+2 or deeper. Going back up
    // or staying flat is fine.
    if (curr > prev + 1) {
      skips.push(`h${prev} → h${curr} ("${headings[i].name || "(unnamed)"}")`);
    }
  }
  if (skips.length === 0) return;

  const examples = skips.slice(0, 3).join(", ");
  const more = skips.length > 3 ? ` and ${skips.length - 3} more` : "";
  ctx.diagnostics.push({
    level: "warning",
    code: "heading-skip",
    message:
      `Heading hierarchy skips detected: ${examples}${more}. ` +
      `This breaks screen-reader users' mental model of structure. ` +
      `Use sequential heading levels — h1 then h2, not h1 then h3.`,
  });
}

function addSkipLinkDiagnostic(ctx: DiagnosticContext): void {
  if (
    ctx.state.targets.length < 5 ||
    ctx.state.targets.some((t) => t.kind === "link" && /skip|jump to/i.test(t.name ?? ""))
  ) {
    return;
  }

  const mainIdx = ctx.state.targets.findIndex(
    (t) => t.kind === "landmark" && t.role === "main",
  );
  const controlsBeforeMain =
    mainIdx >= 0
      ? ctx.state.targets.slice(0, mainIdx).filter((t) => isControlKind(t.kind)).length
      : 0;
  const totalControls = ctx.state.targets.filter((t) => isControlKind(t.kind)).length;

  let extraContext = "";
  if (mainIdx >= 0 && controlsBeforeMain > 0) {
    extraContext =
      ` Concrete savings: a skip link would bypass ${controlsBeforeMain} control${controlsBeforeMain === 1 ? "" : "s"}` +
      (totalControls > 0
        ? ` (${Math.round((controlsBeforeMain / totalControls) * 100)}% of page interactive targets).`
        : ".");
  } else if (mainIdx === -1) {
    extraContext =
      " (Also: no <main> landmark found — a skip link needs a target; address that alongside the skip-link fix.)";
  }

  ctx.diagnostics.push({
    level: "warning",
    code: "no-skip-link",
    message:
      "No skip-to-content link found. Keyboard and screen-reader users " +
      "must Tab through all navigation elements to reach the main content. " +
      "A skip link is the single most impactful fix for navigation cost." +
      extraContext,
    ...(mainIdx >= 0 && controlsBeforeMain > 0
      ? { affectedCount: controlsBeforeMain, totalCount: totalControls }
      : {}),
  });
}

function addLandmarkCompletenessDiagnostics(ctx: DiagnosticContext): void {
  if (ctx.state.targets.length < 5) return;

  const landmarkRoles = new Set(
    ctx.state.targets.filter((t) => t.kind === "landmark").map((t) => t.role),
  );
  if (landmarkRoles.size === 0) return;

  if (!landmarkRoles.has("main")) {
    ctx.diagnostics.push({
      level: "warning",
      code: "no-main-landmark",
      message:
        "No <main> landmark found. Screen-reader users cannot jump " +
        "directly to the primary content area.",
    });
  }
  if (!landmarkRoles.has("banner")) {
    ctx.diagnostics.push({
      level: "info",
      code: "no-banner-landmark",
      message:
        "No <header> / banner landmark found. Adding <header> helps " +
        "screen-reader users locate the site header.",
    });
  }
  if (!landmarkRoles.has("contentinfo")) {
    ctx.diagnostics.push({
      level: "info",
      code: "no-contentinfo-landmark",
      message:
        "No <footer> / contentinfo landmark found. Adding <footer> " +
        "helps screen-reader users locate site-wide links.",
    });
  }
  if (!landmarkRoles.has("navigation")) {
    ctx.diagnostics.push({
      level: "info",
      code: "no-nav-landmark",
      message:
        "No <nav> landmark found. Wrapping navigation links in <nav> " +
        "enables screen-reader users to jump to or skip navigation.",
    });
  }
}

function addStructuralSummaryDiagnostic(ctx: DiagnosticContext): void {
  if (ctx.state.targets.length < 5) return;

  const headingCount = ctx.state.targets.filter((t) => t.kind === "heading").length;
  const landmarkRoles = [
    ...new Set(ctx.state.targets.filter((t) => t.kind === "landmark").map((t) => t.role)),
  ];
  const hasSkipLink = ctx.state.targets.some(
    (t) => t.kind === "link" && /skip|jump to/i.test(t.name ?? ""),
  );
  const expected = ["main", "banner", "contentinfo", "navigation"];
  const present = expected.filter((l) => landmarkRoles.includes(l));
  const missing = expected.filter((l) => !landmarkRoles.includes(l));

  const parts: string[] = [
    `${headingCount} heading${headingCount !== 1 ? "s" : ""}`,
    `landmarks: ${present.length > 0 ? present.join(", ") : "none"}`,
    ...(missing.length > 0 ? [`missing: ${missing.join(", ")}`] : []),
    `skip link: ${hasSkipLink ? "yes" : "no"}`,
    `${ctx.state.targets.length} total targets`,
  ];

  ctx.diagnostics.push({
    level: "info",
    code: "structural-summary",
    message: `Structural overview: ${parts.join(" · ")}`,
  });
}

function addBrokenSkipLinkDiagnostic(ctx: DiagnosticContext): void {
  const broken = ctx.state.targets.filter(
    (t) => t.kind === "link" && (t as Record<string, unknown>)._skipLinkBroken === "target-missing",
  );
  if (broken.length === 0) return;

  const names = broken.slice(0, 3).map((t) => `"${t.name}"`).join(", ");
  const more = broken.length > 3 ? ` (+${broken.length - 3} more)` : "";
  ctx.diagnostics.push({
    level: "warning",
    code: "broken-skip-link",
    message:
      `${broken.length} skip-style link${broken.length === 1 ? "" : "s"} ${broken.length === 1 ? "points" : "point"} to a fragment that doesn't resolve to any element on the page: ${names}${more}. ` +
      "Activating it will leave focus on the link with no destination — worse than not having a skip link at all. " +
      "Verify the href fragment matches an existing element id (e.g. href=\"#main\" → <main id=\"main\">).",
    affectedCount: broken.length,
    affectedTargetIds: broken.slice(0, 5).map((t) => t.id),
  });
}

/**
 * Detect when CSS reordering (order, flex-direction: row-reverse, grid-area)
 * pushes interactive elements into a visual sequence that diverges from
 * DOM order. Sighted users follow visual order; SR/keyboard users follow
 * DOM order — divergence means the two groups have different mental models
 * of "what's next."
 *
 * Algorithm: walk DOM-consecutive pairs of interactive targets. For each,
 * check whether the second is "visually after" the first (significantly
 * lower, or to the right within the same row). Count pairs where it's
 * neither — those are visual-order regressions.
 */
function addVisualOrderDivergenceDiagnostic(ctx: DiagnosticContext): void {
  const TOLERANCE = 30; // px wiggle for "same row"

  type RectFull = { x?: number; y?: number; width?: number; height?: number };
  const interactive = ctx.state.targets.filter((t) => {
    if (!isControlKind(t.kind)) return false;
    const r = (t as Record<string, unknown>)._rect as RectFull | undefined;
    return Boolean(
      r && r.width && r.width > 0 && r.height && r.height > 0 &&
      typeof r.x === "number" && typeof r.y === "number",
    );
  });
  if (interactive.length < 4) return; // need a few pairs to spot a pattern

  let mismatches = 0;
  const examples: string[] = [];
  for (let i = 0; i < interactive.length - 1; i++) {
    const a = interactive[i];
    const b = interactive[i + 1];
    const ar = (a as Record<string, unknown>)._rect as Required<RectFull>;
    const br = (b as Record<string, unknown>)._rect as Required<RectFull>;
    const ay = ar.y + ar.height / 2;
    const by = br.y + br.height / 2;
    const ax = ar.x + ar.width / 2;
    const bx = br.x + br.width / 2;

    const isBelow = by > ay + TOLERANCE;
    const isSameRow = Math.abs(by - ay) <= TOLERANCE;
    const isRightInRow = isSameRow && bx > ax;
    if (isBelow || isRightInRow) continue;

    mismatches++;
    if (examples.length < 3 && a.name && b.name) {
      examples.push(`"${a.name}" → "${b.name}"`);
    }
  }
  if (mismatches < 2) return;

  ctx.diagnostics.push({
    level: "warning",
    code: "visual-order-divergence",
    message:
      `${mismatches} consecutive interactive target pair${mismatches === 1 ? "" : "s"} ` +
      `appear out of visual reading order: ${examples.join(", ")}. ` +
      `CSS order/flex-direction/grid placement may have rearranged elements ` +
      `visually while DOM order (used by screen readers and Tab) stays unchanged. ` +
      `Verify that the SR navigation matches what sighted users expect.`,
    affectedCount: mismatches,
  });
}

/**
 * Three short document-metadata checks rolled into one entrypoint:
 *   - <html lang> present and looks like a BCP 47 tag
 *   - document.title is set, non-trivial, and not a generic placeholder
 *   - <meta name="viewport"> doesn't disable user zoom (WCAG 1.4.4)
 *
 * Each emits its own diagnostic so reporters can suppress / sort them
 * independently. Data comes from capture's _docMetadata passthrough.
 */
/**
 * Detect link targets that share an accessible name but point at different
 * URLs — the SR user hears the same announcement for each ("Read more")
 * but each goes somewhere different. The redundant-tab-stops diagnostic
 * covers same-name + same-href (truly redundant); this covers same-name
 * + different-href (ambiguous, harder to fix because they're not actually
 * duplicates).
 *
 * Mirrors axe-core's identical-links-same-purpose, but applied to the
 * inverse case (different purposes shown identically).
 */
function addLangSwitchDiagnostic(ctx: DiagnosticContext): void {
  const ls = (ctx.state as Record<string, unknown>)._langSwitches as
    | {
        pageLang: string;
        suspects: Array<{ detectedLang: string; confidence: number; sample: string }>;
      }
    | undefined;
  if (!ls || ls.suspects.length === 0) return;

  const samples = ls.suspects
    .slice(0, 3)
    .map(
      (s) =>
        `~${s.detectedLang} (${Math.round(s.confidence * 100)}%): "${s.sample}"`,
    )
    .join("; ");
  const more = ls.suspects.length > 3 ? ` (+${ls.suspects.length - 3} more)` : "";
  const pageLangFragment = ls.pageLang ? ` (page lang="${ls.pageLang}")` : " (no page lang set)";
  ctx.diagnostics.push({
    level: "warning",
    code: "lang-switch-without-marker",
    message:
      `Heuristic detected ${ls.suspects.length} text block${ls.suspects.length === 1 ? "" : "s"} ` +
      `whose dominant language appears to differ from the surrounding lang${pageLangFragment}: ${samples}${more}. ` +
      `Wrap the foreign-language text in <span lang="…"> so screen readers switch to the right speech voice (WCAG 3.1.2). ` +
      `Note: heuristic — false positives on technical jargon, code samples, brand names. Review each.`,
    affectedCount: ls.suspects.length,
  });
}

function addColorOnlyConveyanceDiagnostic(ctx: DiagnosticContext): void {
  const co = (ctx.state as Record<string, unknown>)._colorOnlyConveyance as
    | { count: number; samples: string[] }
    | undefined;
  if (!co || co.count === 0) return;

  const sample = co.samples.length > 0 ? `: ${co.samples.slice(0, 3).join(", ")}` : "";
  const more = co.samples.length > 3 ? ` (+${co.samples.length - 3} more shown)` : "";
  ctx.diagnostics.push({
    level: "warning",
    code: "color-only-conveyance",
    message:
      `Heuristic detected ${co.count} inline text span${co.count === 1 ? "" : "s"} whose only differentiator from surrounding text appears to be color${sample}${more}. ` +
      `WCAG 1.4.1 forbids using color as the sole conveyor of meaning. Add an icon, prefix marker (e.g. "Error:"), font-weight change, or aria-label for SR users and color-blind users. ` +
      `Note: this is a heuristic — false positives possible (link-styled text without underline, branding spans). Review each before treating as a true violation.`,
    affectedCount: co.count,
  });
}

function addViewportDivergenceDiagnostic(ctx: DiagnosticContext): void {
  const vp = (ctx.state as Record<string, unknown>)._viewportDiff as
    | {
        desktop: { viewport: { width: number; height: number }; targetCount: number };
        mobile: { viewport: { width: number; height: number }; targetCount: number };
        divergences: {
          targetsOnlyOnDesktop: Array<{ kind: string; name: string }>;
          targetsOnlyOnMobile: Array<{ kind: string; name: string }>;
          landmarksOnlyOnDesktop: Array<{ role: string; name: string }>;
          landmarksOnlyOnMobile: Array<{ role: string; name: string }>;
          headingsOnlyOnDesktop: string[];
          headingsOnlyOnMobile: string[];
        };
        missingOnMobileCount: number;
        missingOnDesktopCount: number;
      }
    | undefined;
  if (!vp) return;
  if (vp.missingOnMobileCount === 0 && vp.missingOnDesktopCount === 0) return;

  const desktopOnlySamples = [
    ...vp.divergences.targetsOnlyOnDesktop.slice(0, 3).map((t) => `${t.kind} "${t.name}"`),
    ...vp.divergences.landmarksOnlyOnDesktop.slice(0, 2).map((l) => `landmark[${l.role}]`),
    ...vp.divergences.headingsOnlyOnDesktop.slice(0, 2).map((h) => `heading "${h}"`),
  ].slice(0, 5);
  const mobileOnlySamples = [
    ...vp.divergences.targetsOnlyOnMobile.slice(0, 3).map((t) => `${t.kind} "${t.name}"`),
    ...vp.divergences.landmarksOnlyOnMobile.slice(0, 2).map((l) => `landmark[${l.role}]`),
    ...vp.divergences.headingsOnlyOnMobile.slice(0, 2).map((h) => `heading "${h}"`),
  ].slice(0, 5);

  const parts: string[] = [];
  if (vp.missingOnMobileCount > 0) {
    parts.push(
      `${vp.missingOnMobileCount} item${vp.missingOnMobileCount === 1 ? "" : "s"} present at desktop ${vp.desktop.viewport.width}×${vp.desktop.viewport.height} but missing at mobile ${vp.mobile.viewport.width}×${vp.mobile.viewport.height}` +
        (desktopOnlySamples.length > 0 ? ` (${desktopOnlySamples.join(", ")})` : ""),
    );
  }
  if (vp.missingOnDesktopCount > 0) {
    parts.push(
      `${vp.missingOnDesktopCount} item${vp.missingOnDesktopCount === 1 ? "" : "s"} present at mobile but missing at desktop` +
        (mobileOnlySamples.length > 0 ? ` (${mobileOnlySamples.join(", ")})` : ""),
    );
  }

  ctx.diagnostics.push({
    level: "warning",
    code: "viewport-divergence",
    message:
      `Cross-viewport diff: ${parts.join("; ")}. ` +
      `Mobile screen-reader users will hit the mobile rendering — content / landmarks set to 'display: none' at small viewports is genuinely missing for them, not just visually hidden. ` +
      `Some divergence is expected (hamburger menus, sidebar collapsing); review each to confirm content remains reachable via an alternative path on mobile.`,
    affectedCount: vp.missingOnMobileCount + vp.missingOnDesktopCount,
  });
}

function addCvdContrastDiagnostic(ctx: DiagnosticContext): void {
  const cvd = (ctx.state as Record<string, unknown>)._cvdContrast as
    | {
        byType: Record<
          "deuteranopia" | "protanopia" | "tritanopia",
          {
            count: number;
            samples: Array<{
              selector: string;
              text: string;
              normalRatio: number;
              cvdRatio: number;
              threshold: number;
            }>;
          }
        >;
        totalUniqueElements: number;
      }
    | undefined;
  if (!cvd || cvd.totalUniqueElements === 0) return;

  const types: Array<keyof typeof cvd.byType> = ["deuteranopia", "protanopia", "tritanopia"];
  const breakdown = types
    .filter((t) => cvd.byType[t].count > 0)
    .map((t) => `${t}: ${cvd.byType[t].count}`)
    .join(", ");

  // Build a few illustrative samples — pull from whichever CVD type
  // produced the most failures.
  const dominant = types.reduce((best, t) =>
    cvd.byType[t].count > cvd.byType[best].count ? t : best,
  );
  const sampleStrs = cvd.byType[dominant].samples
    .slice(0, 3)
    .map(
      (s) =>
        `${s.selector} "${s.text}" — ${s.normalRatio}:1 normal → ${s.cvdRatio}:1 ${dominant} (needs ${s.threshold}:1)`,
    )
    .join("; ");

  ctx.diagnostics.push({
    level: "warning",
    code: "color-blindness-contrast-fail",
    message:
      `${cvd.totalUniqueElements} text element${cvd.totalUniqueElements === 1 ? "" : "s"} ` +
      `lose contrast under simulated color-vision deficiency (${breakdown}). ` +
      `Examples (${dominant}): ${sampleStrs}. ` +
      `Approximately 8% of male and 0.5% of female users have a CVD; choose color combinations whose contrast survives the deuteranopia/protanopia/tritanopia transforms or rely on luminance + non-color cues.`,
    affectedCount: cvd.totalUniqueElements,
  });
}

function addFrameworkDetectedDiagnostic(ctx: DiagnosticContext): void {
  const frameworks = (ctx.state as Record<string, unknown>)._frameworks as
    | Array<{ name: string; version?: string; evidence: string }>
    | undefined;
  if (!frameworks || frameworks.length === 0) return;

  const stack = frameworks
    .map((f) => `${f.name}${f.version ? ` ${f.version}` : ""}`)
    .join(" + ");
  ctx.diagnostics.push({
    level: "info",
    code: "framework-detected",
    message: `Frontend stack detected: ${stack}.`,
  });
}

function addCDPListenerDiagnostic(ctx: DiagnosticContext): void {
  const cdp = (ctx.state as Record<string, unknown>)._cdpListeners as
    | { probed: number; withClickListener: number; samples: string[]; cdpUnavailable: boolean }
    | undefined;
  if (!cdp || cdp.cdpUnavailable || cdp.withClickListener === 0) return;

  const sampleFragment = cdp.samples.length > 0 ? `: ${cdp.samples.slice(0, 3).join(", ")}` : "";
  const more = cdp.samples.length > 3 ? ` (+${cdp.samples.length - 3} more)` : "";
  ctx.diagnostics.push({
    level: "warning",
    code: "cdp-click-listeners",
    message:
      `CDP scan found ${cdp.withClickListener} of ${cdp.probed} visible non-interactive elements with click-like listeners attached${sampleFragment}${more}. ` +
      `These are JS-attached handlers (addEventListener / on-property) on divs/spans/etc. that aren't reachable by keyboard. ` +
      `Overlaps with fake-interactive-elements above for declarative onclick; CDP catches the rest including extension-injected handlers.`,
    affectedCount: cdp.withClickListener,
    totalCount: cdp.probed,
  });
}

function addAriaValidationDiagnostics(ctx: DiagnosticContext): void {
  const issues = (ctx.state as Record<string, unknown>)._ariaIssues as
    | {
        invalidRoles: Array<{ selector: string; name: string; hint?: string }>;
        unknownAttrs: Array<{ selector: string; name: string; hint?: string }>;
        invalidAttrValues: Array<{ selector: string; name: string; value: string; hint?: string }>;
        missingRequiredAttrs?: Array<{ selector: string; name: string; value: string; hint?: string }>;
        prohibitedNaming?: Array<{ selector: string; name: string; value: string; hint?: string }>;
        unsupportedAttrsForRole?: Array<{ selector: string; name: string; value: string; hint?: string }>;
      }
    | undefined;
  if (!issues) return;

  if (issues.missingRequiredAttrs && issues.missingRequiredAttrs.length > 0) {
    const samples = issues.missingRequiredAttrs
      .slice(0, 3)
      .map((i) => `${i.selector} (role="${i.name}" missing ${i.value})`)
      .join("; ");
    const more = issues.missingRequiredAttrs.length > 3 ? ` (+${issues.missingRequiredAttrs.length - 3} more)` : "";
    ctx.diagnostics.push({
      level: "warning",
      code: "missing-required-aria-attr",
      message:
        `${issues.missingRequiredAttrs.length} element${issues.missingRequiredAttrs.length === 1 ? "" : "s"} declare an ARIA role but lack the role's required state/property: ${samples}${more}. ` +
        `Without these attributes, screen readers can't communicate the widget's current state to the user (e.g. a checkbox with no aria-checked is unreadable).`,
      affectedCount: issues.missingRequiredAttrs.length,
    });
  }

  if (issues.prohibitedNaming && issues.prohibitedNaming.length > 0) {
    const samples = issues.prohibitedNaming
      .slice(0, 3)
      .map((i) => `${i.selector} (role="${i.name}" with ${i.value})`)
      .join("; ");
    const more = issues.prohibitedNaming.length > 3 ? ` (+${issues.prohibitedNaming.length - 3} more)` : "";
    ctx.diagnostics.push({
      level: "warning",
      code: "aria-naming-prohibited",
      message:
        `${issues.prohibitedNaming.length} element${issues.prohibitedNaming.length === 1 ? "" : "s"} use a name (aria-label / aria-labelledby) on a role that prohibits naming per ARIA 1.2: ${samples}${more}. ` +
        `Browsers and AT may ignore the name; remove the naming attribute or change to a role that supports naming.`,
      affectedCount: issues.prohibitedNaming.length,
    });
  }

  if (issues.invalidRoles.length > 0) {
    const samples = issues.invalidRoles
      .slice(0, 3)
      .map((i) => `${i.selector} role="${i.name}"${i.hint ? ` (did you mean "${i.hint}"?)` : ""}`)
      .join("; ");
    const more = issues.invalidRoles.length > 3 ? ` (+${issues.invalidRoles.length - 3} more)` : "";
    ctx.diagnostics.push({
      level: "warning",
      code: "invalid-aria-role",
      message:
        `${issues.invalidRoles.length} element${issues.invalidRoles.length === 1 ? "" : "s"} use a non-standard ARIA role: ${samples}${more}. ` +
        `Browsers and screen readers ignore unknown roles, so the element falls back to its native semantics — usually a generic with no announcement at all.`,
      affectedCount: issues.invalidRoles.length,
    });
  }

  if (issues.unknownAttrs.length > 0) {
    const samples = issues.unknownAttrs
      .slice(0, 3)
      .map((i) => `${i.selector} ${i.name}${i.hint ? ` (did you mean ${i.hint}?)` : ""}`)
      .join("; ");
    const more = issues.unknownAttrs.length > 3 ? ` (+${issues.unknownAttrs.length - 3} more)` : "";
    ctx.diagnostics.push({
      level: "warning",
      code: "unknown-aria-attr",
      message:
        `${issues.unknownAttrs.length} element${issues.unknownAttrs.length === 1 ? "" : "s"} carry an aria-* attribute that isn't in the ARIA spec: ${samples}${more}. ` +
        `Likely a typo. Browsers do nothing with unknown ARIA attrs; assistive tech ignores them.`,
      affectedCount: issues.unknownAttrs.length,
    });
  }

  if (issues.invalidAttrValues.length > 0) {
    const samples = issues.invalidAttrValues
      .slice(0, 3)
      .map((i) => `${i.selector} ${i.name}="${i.value}"${i.hint ? ` (${i.hint})` : ""}`)
      .join("; ");
    const more = issues.invalidAttrValues.length > 3 ? ` (+${issues.invalidAttrValues.length - 3} more)` : "";
    ctx.diagnostics.push({
      level: "warning",
      code: "invalid-aria-attr-value",
      message:
        `${issues.invalidAttrValues.length} aria-* attribute${issues.invalidAttrValues.length === 1 ? "" : "s"} use a value not in the spec's enumerated set: ${samples}${more}. ` +
        `Browsers fall back to the default state; the developer's intent is silently lost.`,
      affectedCount: issues.invalidAttrValues.length,
    });
  }

  if (issues.unsupportedAttrsForRole && issues.unsupportedAttrsForRole.length > 0) {
    const samples = issues.unsupportedAttrsForRole
      .slice(0, 3)
      .map((i) => `${i.selector} (${i.name} on role="${i.value}")`)
      .join("; ");
    const more = issues.unsupportedAttrsForRole.length > 3 ? ` (+${issues.unsupportedAttrsForRole.length - 3} more)` : "";
    ctx.diagnostics.push({
      level: "warning",
      code: "unsupported-aria-attr-for-role",
      message:
        `${issues.unsupportedAttrsForRole.length} aria-* attribute${issues.unsupportedAttrsForRole.length === 1 ? "" : "s"} appear on roles that don't support them per ARIA 1.2: ${samples}${more}. ` +
        `Browsers ignore the attribute or expose unpredictable state; remove it or move it onto a role from the attribute's "Used in Roles" list.`,
      affectedCount: issues.unsupportedAttrsForRole.length,
    });
  }
}

function addAmbiguousLinkNamesDiagnostic(ctx: DiagnosticContext): void {
  const linksByName = new Map<string, Set<string>>();
  const linksByNameWithIds = new Map<string, string[]>();
  for (const t of ctx.state.targets) {
    if (t.kind !== "link") continue;
    const name = (t.name ?? "").trim();
    if (!name) continue;
    const href = (t as Record<string, unknown>)._href as string | undefined;
    if (!href) continue;
    const set = linksByName.get(name) ?? new Set<string>();
    set.add(href);
    linksByName.set(name, set);
    const ids = linksByNameWithIds.get(name) ?? [];
    ids.push(t.id);
    linksByNameWithIds.set(name, ids);
  }

  const ambiguous: Array<{ name: string; destinationCount: number; ids: string[] }> = [];
  for (const [name, hrefs] of linksByName) {
    if (hrefs.size <= 1) continue;
    ambiguous.push({
      name,
      destinationCount: hrefs.size,
      ids: linksByNameWithIds.get(name) ?? [],
    });
  }
  if (ambiguous.length === 0) return;

  // Sort worst-first so samples are the most-divergent groups
  ambiguous.sort((a, b) => b.destinationCount - a.destinationCount);
  const samples = ambiguous
    .slice(0, 3)
    .map((a) => `"${a.name}" → ${a.destinationCount} different URLs`)
    .join(", ");
  const more = ambiguous.length > 3 ? ` (+${ambiguous.length - 3} more)` : "";
  ctx.diagnostics.push({
    level: "warning",
    code: "ambiguous-link-names",
    message:
      `${ambiguous.length} group${ambiguous.length === 1 ? "" : "s"} of links share an accessible name but point to different destinations: ${samples}${more}. ` +
      `Screen-reader users hear the same announcement for each but each goes somewhere different — they have no way to distinguish them. ` +
      `Differentiate the names ("Read more about X" / "Read more about Y") or use aria-describedby pointing to surrounding context.`,
    affectedCount: ambiguous.length,
    affectedTargetIds: ambiguous.flatMap((a) => a.ids).slice(0, 5),
  });
}

function addEmptyInteractiveDiagnostic(ctx: DiagnosticContext): void {
  const empty = ctx.state.targets.filter((t) => {
    if (t.kind !== "button" && t.kind !== "link") return false;
    return !(t.name ?? "").trim();
  });
  if (empty.length === 0) return;

  const sample = empty.slice(0, 3).map((t) => t.role).join(", ");
  ctx.diagnostics.push({
    level: "warning",
    code: "empty-interactive",
    message:
      `${empty.length} interactive element${empty.length === 1 ? "" : "s"} (${sample}) ` +
      `${empty.length === 1 ? "has" : "have"} no accessible name. ` +
      `Screen-reader users hear "button" or "link" with no further context — they have no idea what activating it will do. ` +
      `Add visible text inside, or aria-label="…", or aria-labelledby="…" pointing to label text.`,
    affectedCount: empty.length,
    affectedTargetIds: empty.slice(0, 5).map((t) => t.id),
  });
}

function addH1CountDiagnostic(ctx: DiagnosticContext): void {
  const mc = (ctx.state as Record<string, unknown>)._mediaControls as
    | { h1Count: number }
    | undefined;
  if (!mc) return;
  // We only flag missing H1 when the page has at least one OTHER heading
  // — that signals "this page has structure but no top-level identity."
  // Tiny pages with no headings at all already trigger no-headings.
  const otherHeadings = ctx.state.targets.filter((t) => t.kind === "heading").length;
  if (mc.h1Count === 0 && otherHeadings > 0) {
    ctx.diagnostics.push({
      level: "warning",
      code: "h1-count",
      message:
        "Page has no <h1> element. The H1 is the top-level page identity for screen readers and " +
        "search engines; without one, users navigating by heading levels have no anchor. Add a single, " +
        "descriptive <h1> at the start of the main content.",
    });
  } else if (mc.h1Count > 1) {
    ctx.diagnostics.push({
      level: "info",
      code: "h1-count",
      message:
        `Page has ${mc.h1Count} <h1> elements. The HTML5 spec allows multiple H1s in sectioning ` +
        `contexts, but most assistive tech still treats H1 as a single page-identity heading. Consider ` +
        `consolidating to one H1 for the page and using H2/H3 for section identity.`,
      affectedCount: mc.h1Count,
    });
  }
}

function addMediaControlsDiagnostic(ctx: DiagnosticContext): void {
  const mc = (ctx.state as Record<string, unknown>)._mediaControls as
    | { mediaWithoutControls: Array<{ tag: string; src: string }> }
    | undefined;
  if (!mc || mc.mediaWithoutControls.length === 0) return;

  const samples = mc.mediaWithoutControls
    .slice(0, 3)
    .map((m) => `<${m.tag}${m.src ? ` src="${m.src}"` : ""}>`)
    .join(", ");
  ctx.diagnostics.push({
    level: "warning",
    code: "media-without-controls",
    message:
      `${mc.mediaWithoutControls.length} <audio>/<video> element${mc.mediaWithoutControls.length === 1 ? "" : "s"} ` +
      `${mc.mediaWithoutControls.length === 1 ? "lacks" : "lack"} the controls attribute and ${mc.mediaWithoutControls.length === 1 ? "isn't" : "aren't"} aria-hidden: ${samples}. ` +
      `Keyboard users can't pause or mute (WCAG 1.4.2). Add controls or expose a custom keyboard-accessible UI.`,
    affectedCount: mc.mediaWithoutControls.length,
  });
}

function addHeadingContentDiagnostics(ctx: DiagnosticContext): void {
  const headings = ctx.state.targets.filter((t) => t.kind === "heading");
  if (headings.length === 0) return;

  const empty = headings.filter((h) => !(h.name ?? "").trim());
  // Heading whose entire text is digits / symbols / single chars — useless
  // to SR users navigating by H key.
  const NUMERIC_OR_TRIVIAL = /^[\s\d.,:;!?#$%&*()_+=/\\|<>~`'"-]*$/;
  const numericOrTrivial = headings.filter((h) => {
    const name = (h.name ?? "").trim();
    if (!name) return false;
    if (name.length <= 2) return true;
    return NUMERIC_OR_TRIVIAL.test(name);
  });

  if (empty.length > 0) {
    const sample = empty
      .slice(0, 3)
      .map((h) => `h${h.headingLevel ?? "?"}`)
      .join(", ");
    ctx.diagnostics.push({
      level: "warning",
      code: "empty-heading",
      message:
        `${empty.length} heading${empty.length === 1 ? "" : "s"} (${sample}) ` +
        `${empty.length === 1 ? "has" : "have"} no text content. ` +
        `Screen-reader users navigating by heading land on these and hear nothing — total loss of orientation. ` +
        `Either add text or remove the empty <h*> element.`,
      affectedCount: empty.length,
      affectedTargetIds: empty.slice(0, 5).map((h) => h.id),
    });
  }

  if (numericOrTrivial.length > 0) {
    const sample = numericOrTrivial
      .slice(0, 3)
      .map((h) => `h${h.headingLevel ?? "?"} "${h.name}"`)
      .join(", ");
    ctx.diagnostics.push({
      level: "warning",
      code: "numeric-heading",
      message:
        `${numericOrTrivial.length} heading${numericOrTrivial.length === 1 ? "" : "s"} ` +
        `consist only of digits / punctuation / a single letter: ${sample}. ` +
        `These convey no structure to SR users. Use full descriptive text (e.g. "Q4 revenue: $2.3M" instead of "$2.3M").`,
      affectedCount: numericOrTrivial.length,
      affectedTargetIds: numericOrTrivial.slice(0, 5).map((h) => h.id),
    });
  }

  // skip-link-not-first: when --walk-tab-order recorded a sequence AND
  // a skip-style link exists in targets, verify the first 1-2 tab stops
  // ARE the skip link. (Some sites put a logo before the skip link;
  // accept skip in slot 1 or 2.)
  const tabOrder = (ctx.state as Record<string, unknown>)._tabOrder as
    | { sequence: Array<{ name: string }> }
    | undefined;
  const SKIP_PATTERN = /^(skip|jump\s*to)/i;
  const hasSkipLink = ctx.state.targets.some(
    (t) => t.kind === "link" && t.name && SKIP_PATTERN.test(t.name),
  );
  if (tabOrder && hasSkipLink) {
    const firstTwo = tabOrder.sequence.slice(0, 2);
    const skipInFirstTwo = firstTwo.some((s) => s.name && SKIP_PATTERN.test(s.name));
    if (!skipInFirstTwo) {
      const reached = firstTwo.length === 0 ? "(no Tab stops recorded)" : firstTwo.map((s) => `"${s.name}"`).join(" → ");
      ctx.diagnostics.push({
        level: "warning",
        code: "skip-link-not-first",
        message:
          `A skip-style link exists but isn't reachable in the first two Tab presses (Tab order starts: ${reached}). ` +
          `Skip links are only useful if they're the FIRST focusable element — otherwise users have to Tab through ` +
          `the very content they're trying to skip. Move the skip link to the top of the DOM or give it positive tabindex carefully.`,
      });
    }
  }
}

function addStructuralIssuesDiagnostics(ctx: DiagnosticContext): void {
  const s = (ctx.state as Record<string, unknown>)._structuralIssues as
    | {
        duplicateIds: Array<{ id: string; count: number }>;
        nestedInteractive: string[];
        metaRefresh: boolean;
      }
    | undefined;
  if (!s) return;

  if (s.duplicateIds.length > 0) {
    const samples = s.duplicateIds
      .slice(0, 3)
      .map((d) => `#${d.id} (${d.count}×)`)
      .join(", ");
    const more = s.duplicateIds.length > 3 ? ` (+${s.duplicateIds.length - 3} more)` : "";
    ctx.diagnostics.push({
      level: "warning",
      code: "duplicate-id",
      message:
        `${s.duplicateIds.length} id value${s.duplicateIds.length === 1 ? "" : "s"} appear on multiple elements: ${samples}${more}. ` +
        `aria-labelledby="…" / aria-describedby="…" / <label for="…"> all resolve via getElementById, ` +
        `which returns only the FIRST match — every duplicate-id reference silently points at the wrong element.`,
      affectedCount: s.duplicateIds.length,
    });
  }

  if (s.nestedInteractive.length > 0) {
    const samples = s.nestedInteractive.slice(0, 3).join("; ");
    const more = s.nestedInteractive.length > 3 ? ` (+${s.nestedInteractive.length - 3} more)` : "";
    ctx.diagnostics.push({
      level: "warning",
      code: "nested-interactive",
      message:
        `${s.nestedInteractive.length} focusable element${s.nestedInteractive.length === 1 ? "" : "s"} ` +
        `contain another focusable inside (button-in-link / link-in-button / similar): ${samples}${more}. ` +
        `Browsers and screen readers disagree about which element receives focus and clicks; the result is unpredictable, ` +
        `often making the inner control unreachable by keyboard. Restructure so interactive controls are siblings, not nested.`,
      affectedCount: s.nestedInteractive.length,
    });
  }

  if (s.metaRefresh) {
    ctx.diagnostics.push({
      level: "warning",
      code: "meta-refresh",
      message:
        `Page declares <meta http-equiv="refresh"> which auto-reloads or redirects without warning. ` +
        `Screen-reader users mid-read get yanked back to the top with no notice (WCAG 2.2.1 Timing Adjustable). ` +
        `Replace with a navigation link the user can choose to follow, or a JS redirect with at least 20 s notice.`,
    });
  }
}

function addMediaMetadataDiagnostics(ctx: DiagnosticContext): void {
  const media = (ctx.state as Record<string, unknown>)._mediaMetadata as
    | {
        totalImages: number;
        imagesMissingAlt: number;
        imagesSuspiciousAlt: Array<{ alt: string; src: string }>;
        totalIframes: number;
        iframesMissingTitle: Array<{ src: string }>;
      }
    | undefined;
  if (!media) return;

  if (media.imagesMissingAlt > 0) {
    ctx.diagnostics.push({
      level: "warning",
      code: "missing-image-alt",
      message:
        `${media.imagesMissingAlt} of ${media.totalImages} <img> element${media.totalImages === 1 ? "" : "s"} ` +
        `have no alt attribute. Screen readers fall back to announcing the filename, which is rarely ` +
        `useful. Add alt="…" with a meaningful description for informative images, or alt="" for ` +
        `purely decorative ones.`,
      affectedCount: media.imagesMissingAlt,
      totalCount: media.totalImages,
    });
  }

  if (media.imagesSuspiciousAlt.length > 0) {
    const samples = media.imagesSuspiciousAlt
      .slice(0, 3)
      .map((s) => `"${s.alt}"${s.src ? ` (src: ${s.src})` : ""}`)
      .join(", ");
    const more = media.imagesSuspiciousAlt.length > 3 ? ` (+${media.imagesSuspiciousAlt.length - 3} more)` : "";
    ctx.diagnostics.push({
      level: "warning",
      code: "suspicious-image-alt",
      message:
        `${media.imagesSuspiciousAlt.length} <img> alt value${media.imagesSuspiciousAlt.length === 1 ? "" : "s"} ` +
        `look like filler text rather than descriptions: ${samples}${more}. Replace with text that ` +
        `conveys the image's meaning, or use alt="" if the image is purely decorative.`,
      affectedCount: media.imagesSuspiciousAlt.length,
    });
  }

  if (media.iframesMissingTitle.length > 0) {
    const samples = media.iframesMissingTitle
      .slice(0, 3)
      .map((f) => f.src || "(no src)")
      .join(", ");
    const more = media.iframesMissingTitle.length > 3 ? ` (+${media.iframesMissingTitle.length - 3} more)` : "";
    ctx.diagnostics.push({
      level: "warning",
      code: "missing-iframe-title",
      message:
        `${media.iframesMissingTitle.length} of ${media.totalIframes} <iframe> element${media.totalIframes === 1 ? "" : "s"} ` +
        `have no title attribute (and no aria-label): ${samples}${more}. Screen readers announce them ` +
        `as "frame" with no context. Add title="Brief description of the embed" to each iframe.`,
      affectedCount: media.iframesMissingTitle.length,
      totalCount: media.totalIframes,
    });
  }
}

function addDocumentMetadataDiagnostics(ctx: DiagnosticContext): void {
  const meta = (ctx.state as Record<string, unknown>)._docMetadata as
    | {
        htmlLang: string;
        title: string;
        zoomRestricted: boolean;
        viewportContent: string | null;
      }
    | undefined;
  if (!meta) return;

  // <html lang>
  const lang = meta.htmlLang;
  if (!lang) {
    ctx.diagnostics.push({
      level: "warning",
      code: "missing-html-lang",
      message:
        "Page is missing the <html lang> attribute. Screen readers use it to pick the right speech " +
        "synthesizer voice; without it, English text gets pronounced with the user's default-voice " +
        "rules (e.g. an English page read with French phonetics). Add lang=\"en\" (or the appropriate " +
        "BCP 47 tag) to <html>.",
    });
  } else if (!/^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/.test(lang)) {
    // Best-effort BCP 47 sanity check — allow primary tag plus subtags.
    // Not a full parser; catches obvious typos like lang="english".
    ctx.diagnostics.push({
      level: "warning",
      code: "missing-html-lang",
      message:
        `<html lang="${lang}"> doesn't look like a valid BCP 47 language tag. Examples: ` +
        `lang="en", lang="en-US", lang="zh-Hant".`,
    });
  }

  // document.title
  const title = meta.title;
  const GENERIC_TITLES = /^(untitled|new tab|home|page|document|index|default)$/i;
  if (!title) {
    ctx.diagnostics.push({
      level: "warning",
      code: "poor-document-title",
      message:
        "<title> is empty or missing. The document title is the first thing a screen reader announces " +
        "when a page loads — without one, AT users have no orientation. Add a unique, descriptive title " +
        "(typically '<page name> | <site name>').",
    });
  } else if (title.length < 3 || GENERIC_TITLES.test(title)) {
    ctx.diagnostics.push({
      level: "warning",
      code: "poor-document-title",
      message:
        `<title>${title}</title> is too generic or too short to orient screen-reader users. Use a unique, ` +
        `descriptive title that identifies both the page and the site.`,
    });
  }

  // <meta name="viewport"> zoom block (WCAG 1.4.4)
  if (meta.zoomRestricted) {
    ctx.diagnostics.push({
      level: "warning",
      code: "viewport-blocks-zoom",
      message:
        `<meta name="viewport" content="${meta.viewportContent ?? ""}"> blocks the user from zooming ` +
        `(user-scalable=no or maximum-scale<2). Low-vision users routinely zoom to 200%+ to read; ` +
        `blocking zoom violates WCAG 1.4.4. Remove user-scalable=no and let maximum-scale default ` +
        `(or set it to >=5).`,
    });
  }
}

function addMissingAutocompleteDiagnostic(ctx: DiagnosticContext): void {
  // Standard input types where autocomplete is expected. Missing
  // autocomplete on a password field breaks every password manager;
  // missing on email/tel breaks autofill for assistive tech that depends
  // on it. autocomplete="off" on these is also an anti-pattern (some
  // browsers ignore it, but stating intent to disable is itself a smell).
  const EXPECTS_AUTOCOMPLETE = new Set(["password", "email", "tel", "url"]);
  const missing: Array<{ name: string; inputType: string }> = [];
  for (const t of ctx.state.targets) {
    if (t.kind !== "formField") continue;
    const meta = t as Record<string, unknown>;
    const inputType = meta._inputType as string | undefined;
    if (!inputType || !EXPECTS_AUTOCOMPLETE.has(inputType)) continue;
    const autocomplete = meta._autocomplete as string | undefined;
    if (!autocomplete || autocomplete === "off") {
      missing.push({ name: t.name ?? "(unnamed)", inputType });
    }
  }
  if (missing.length === 0) return;

  const sample = missing
    .slice(0, 3)
    .map((m) => `${m.inputType} "${m.name}"`)
    .join(", ");
  const more = missing.length > 3 ? ` (+${missing.length - 3} more)` : "";
  ctx.diagnostics.push({
    level: "warning",
    code: "missing-autocomplete",
    message:
      `${missing.length} form field${missing.length === 1 ? "" : "s"} of standard input ` +
      `types lack a useful autocomplete attribute (or use autocomplete="off"): ${sample}${more}. ` +
      `Password managers and SR autofill rely on autocomplete tokens (e.g. ` +
      `autocomplete="current-password", autocomplete="email"); without them, users ` +
      `re-type values they shouldn't have to.`,
    affectedCount: missing.length,
  });
}

function addLowContrastTextDiagnostic(ctx: DiagnosticContext): void {
  const lct = (ctx.state as Record<string, unknown>)._lowContrastText as
    | { count: number; samples: string[] }
    | undefined;
  if (!lct || lct.count === 0) return;

  const sampleFragment =
    lct.samples.length > 0
      ? `: ${lct.samples.slice(0, 3).join("; ")}${lct.samples.length > 3 ? ` (+${lct.samples.length - 3} more shown)` : ""}`
      : "";
  ctx.diagnostics.push({
    level: "warning",
    code: "low-contrast-text",
    message:
      `${lct.count} interactive element${lct.count === 1 ? "" : "s"} or heading${lct.count === 1 ? "" : "s"} ` +
      `fail WCAG 1.4.3 text contrast (4.5:1 normal / 3:1 large)${sampleFragment}. ` +
      `Low-vision and aging users can't read this text reliably; raise the foreground/background contrast.`,
    affectedCount: lct.count,
  });
}

function addFormSummaryDiagnostic(ctx: DiagnosticContext): void {
  const forms = (ctx.state as Record<string, unknown>)._forms as
    | Array<{ name: string; fieldCount: number; requiredCount: number; hasSubmit: boolean }>
    | undefined;
  if (!forms || forms.length === 0) return;

  const parts = forms.map((f) => {
    const submitNote = f.hasSubmit ? "" : ", no submit button";
    const requiredNote = f.requiredCount > 0
      ? `, ${f.requiredCount} required`
      : "";
    return `${f.name} (${f.fieldCount} field${f.fieldCount === 1 ? "" : "s"}${requiredNote}${submitNote})`;
  });
  // Flag warning if any form lacks a submit button — sighted users can
  // sometimes press Enter to submit, but SR/keyboard users may not realize
  // they can.
  const anyMissingSubmit = forms.some((f) => f.fieldCount > 0 && !f.hasSubmit);
  ctx.diagnostics.push({
    level: anyMissingSubmit ? "warning" : "info",
    code: "form-summary",
    message: `Forms on this page: ${parts.join("; ")}.`,
    affectedCount: forms.length,
  });
}

function addFakeInteractiveDiagnostic(ctx: DiagnosticContext): void {
  // _fakeInteractive is set by capture.ts when the page has elements with
  // a declarative onclick attribute that aren't reachable by keyboard or
  // exposed as buttons/links to the accessibility tree.
  const fake = (ctx.state as Record<string, unknown>)._fakeInteractive as
    | { count: number; samples: string[] }
    | undefined;
  if (!fake || fake.count === 0) return;

  const sample = fake.samples.length > 0 ? `: ${fake.samples.slice(0, 3).join(", ")}` : "";
  const more = fake.samples.length > 3 ? ` (+${fake.samples.length - 3} more shown)` : "";
  ctx.diagnostics.push({
    level: "warning",
    code: "fake-interactive-elements",
    message:
      `${fake.count} element${fake.count === 1 ? "" : "s"} with declarative onclick but no role=button/link or tabindex >= 0` +
      `${sample}${more}. ` +
      `Sighted users see these as clickable; keyboard and screen-reader users can't reach or operate them. ` +
      `Replace with <button>/<a> or add role="button" + tabindex="0" + Enter/Space keydown handler.`,
    affectedCount: fake.count,
  });
}

/**
 * Detect path-based login redirects.
 * Matches patterns like /login, /signin, /auth with an optional redirect param.
 */
function detectLoginRedirect(requestedUrl: string, actualUrl: string): boolean {
  try {
    const requested = new URL(requestedUrl);
    const actual = new URL(actualUrl);
    if (requested.hostname !== actual.hostname) return false;
    if (requested.pathname === actual.pathname) return false;

    const loginPaths = ["/login", "/signin", "/sign-in", "/auth", "/authenticate", "/sso"];
    const actualPath = actual.pathname.toLowerCase();
    // Require exact match or path boundary (/ or ?) to avoid false positives
    // like /login-help or /authentication-docs.
    return loginPaths.some(
      (lp) =>
        actualPath === lp || actualPath.startsWith(lp + "/") || actualPath.startsWith(lp + "?"),
    );
  } catch {
    return false;
  }
}

/**
 * Return the first matching text fragment from a list of signal patterns,
 * or null if none match. Used to include trigger context in diagnostics.
 */
function findFirstMatch(signals: RegExp[], text: string): string | null {
  for (const pattern of signals) {
    const m = pattern.exec(text);
    if (m) return m[0];
  }
  return null;
}

/**
 * Check if diagnostics indicate the analysis is unreliable.
 */
export function hasBlockingDiagnostic(diagnostics: CaptureDiagnostic[]): boolean {
  return diagnostics.some((d) => d.level === "error");
}
