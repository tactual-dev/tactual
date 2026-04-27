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
  addLandmarkCompletenessDiagnostics(ctx);
  addStructuralSummaryDiagnostic(ctx);

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
