import type { PageState } from "./types.js";

/**
 * Capture diagnostics — signals about whether the page was
 * successfully captured or if something went wrong.
 */
export interface CaptureDiagnostic {
  level: "info" | "warning" | "error";
  code: DiagnosticCode;
  message: string;
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
  | "no-skip-link"
  | "structural-summary"
  | "shared-structural-issue"
  | "landmark-demoted"
  | "possible-login-wall"
  | "possible-cookie-wall"
  | "redirect-detected"
  | "possibly-degraded-content"
  | "timeout-during-render"
  | "ok";

/** Common bot-block / challenge page signals */
const BLOCK_SIGNALS = [
  /you[''']ve been blocked/i,
  /access denied/i,
  /please verify you are (a )?human/i,
  /captcha/i,
  /cloudflare/i,
  /checking (if the site connection is secure|your browser)/i,
  /just a moment/i,
  /ray id/i,
  /attention required/i,
  /security check/i,
  /bot detection/i,
  /automated (access|traffic)/i,
];

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
  const diagnostics: CaptureDiagnostic[] = [];
  const targetNames = state.targets.map((t) => (t.name ?? "").toLowerCase()).join(" ");
  const fullText = (snapshotText + " " + targetNames).toLowerCase();

  // Empty page — no targets at all
  if (state.targets.length === 0) {
    diagnostics.push({
      level: "error",
      code: "empty-page",
      message:
        "No accessibility targets found. The page may be blank, " +
        "completely JS-rendered with no fallback, or blocked.",
    });
  }

  // Bot protection detected
  const blockMatch = findFirstMatch(BLOCK_SIGNALS, fullText);
  if (blockMatch) {
    diagnostics.push({
      level: "error",
      code: "blocked-by-bot-protection",
      message:
        `Page appears to be a bot-protection challenge (matched: "${blockMatch}"). ` +
        "Analysis results reflect the challenge page, not the actual site " +
        "content. Try with a non-headless browser or authenticated session.",
    });
  }

  // Very sparse content (might be partial render or block page)
  if (state.targets.length > 0 && state.targets.length < 5) {
    const hasOnlyLinks = state.targets.every(
      (t) => t.kind === "link" || t.kind === "statusMessage",
    );
    if (hasOnlyLinks) {
      diagnostics.push({
        level: "warning",
        code: "sparse-content",
        message:
          `Only ${state.targets.length} targets found (all links/status). ` +
          "The page may not have fully rendered, or may be showing an " +
          "error/challenge page instead of actual content.",
      });
    }
  }

  // Degraded content — suspiciously low target count for an http(s) page.
  // A real webpage almost always has > 30 interactive targets. If we only
  // found a handful, the site likely served stripped/gated content to the
  // headless browser (bot detection, geo-block, A/B test, login redirect).
  if (
    state.targets.length > 0 &&
    state.targets.length < 30 &&
    state.url.startsWith("http") &&
    !diagnostics.some((d) => d.code === "blocked-by-bot-protection")
  ) {
    const headings = state.targets.filter((t) => t.kind === "heading").length;
    const landmarks = state.targets.filter((t) => t.kind === "landmark").length;
    if (headings <= 1 && landmarks <= 2) {
      diagnostics.push({
        level: "warning",
        code: "possibly-degraded-content",
        message:
          `Only ${state.targets.length} targets found (${headings} headings, ` +
          `${landmarks} landmarks). The site may have served a stripped-down ` +
          "or gated version to the headless browser. Scores reflect what " +
          "was captured, not necessarily the full site. Try --no-headless " +
          "or an authenticated session for more complete results.",
      });
    }
  }

  // Login wall — path-based redirect is strong signal; content-based is weak.
  // A page with 100+ targets that has a "Sign in" link in the nav is NOT a login wall.
  // Only trigger content-based detection on sparse pages likely to be auth gates.
  const loginRedirect = detectLoginRedirect(requestedUrl, state.url);
  if (loginRedirect) {
    diagnostics.push({
      level: "warning",
      code: "possible-login-wall",
      message:
        `Redirected to login page (${new URL(state.url).pathname}). ` +
        "Analysis reflects the login/auth page, not the requested content. " +
        "Use an authenticated session or pre-login cookies for accurate results.",
    });
  } else {
    // Content-based: only on sparse pages where login content dominates
    const loginMatch = findFirstMatch(LOGIN_SIGNALS, fullText);
    if (loginMatch && state.targets.length < 30) {
      diagnostics.push({
        level: "warning",
        code: "possible-login-wall",
        message:
          `Page appears to require authentication (matched: "${loginMatch}"). ` +
          "Analysis may reflect a login page rather than the actual application content.",
      });
    }
  }

  // Cookie wall
  const cookieMatch = findFirstMatch(COOKIE_SIGNALS, fullText);
  if (cookieMatch) {
    diagnostics.push({
      level: "info",
      code: "possible-cookie-wall",
      message:
        `Cookie consent dialog detected (matched: "${cookieMatch}"). ` +
        "Some page content may be obscured or inaccessible until cookies are accepted.",
    });
  }

  // Redirect to different domain or path
  if (state.url) {
    try {
      const requested = new URL(requestedUrl);
      const actual = new URL(state.url);
      if (requested.hostname !== actual.hostname) {
        diagnostics.push({
          level: "warning",
          code: "redirect-detected",
          message:
            `Redirected from ${requested.hostname} to ${actual.hostname}. ` +
            "Analysis reflects the destination page.",
        });
      } else if (requested.pathname !== actual.pathname && !loginRedirect) {
        diagnostics.push({
          level: "info",
          code: "redirect-detected",
          message:
            `Redirected from ${requested.pathname} to ${actual.pathname}. ` +
            "Analysis reflects the destination page.",
        });
      }
    } catch {
      // URL parsing failed — skip this check
    }
  }

  // No landmarks (structural issue, not a block)
  if (
    state.targets.length >= 5 &&
    !state.targets.some((t) => t.kind === "landmark")
  ) {
    diagnostics.push({
      level: "warning",
      code: "no-landmarks",
      message: "No landmark regions found (main, nav, banner, etc.).",
    });
  }

  // No headings
  if (
    state.targets.length >= 5 &&
    !state.targets.some((t) => t.kind === "heading")
  ) {
    diagnostics.push({
      level: "warning",
      code: "no-headings",
      message:
        "No heading elements found. Screen-reader users rely heavily " +
        "on headings for navigation (71.6% start with headings per " +
        "WebAIM 2024 survey).",
    });
  }

  // No skip-to-content link
  if (
    state.targets.length >= 5 &&
    !state.targets.some(
      (t) => t.kind === "link" && /skip|jump to/i.test(t.name ?? ""),
    )
  ) {
    diagnostics.push({
      level: "warning",
      code: "no-skip-link",
      message:
        "No skip-to-content link found. Keyboard and screen-reader users " +
        "must Tab through all navigation elements to reach the main content. " +
        "A skip link is the single most impactful fix for navigation cost.",
    });
  }

  // Landmark completeness — specific missing landmark checks
  // Only fire when page has SOME landmarks (pages with zero landmarks
  // already get the "no-landmarks" warning above)
  if (state.targets.length >= 5) {
    const landmarkRoles = new Set(
      state.targets
        .filter((t) => t.kind === "landmark")
        .map((t) => t.role),
    );

    if (landmarkRoles.size > 0) {
      if (!landmarkRoles.has("main")) {
        diagnostics.push({
          level: "warning",
          code: "no-main-landmark",
          message:
            "No <main> landmark found. Screen-reader users cannot jump " +
            "directly to the primary content area.",
        });
      }
      if (!landmarkRoles.has("banner")) {
        diagnostics.push({
          level: "info",
          code: "no-banner-landmark",
          message:
            "No <header> / banner landmark found. Adding <header> helps " +
            "screen-reader users locate the site header.",
        });
      }
      if (!landmarkRoles.has("contentinfo")) {
        diagnostics.push({
          level: "info",
          code: "no-contentinfo-landmark",
          message:
            "No <footer> / contentinfo landmark found. Adding <footer> " +
            "helps screen-reader users locate site-wide links.",
        });
      }
      if (!landmarkRoles.has("navigation")) {
        diagnostics.push({
          level: "info",
          code: "no-nav-landmark",
          message:
            "No <nav> landmark found. Wrapping navigation links in <nav> " +
            "enables screen-reader users to jump to or skip navigation.",
        });
      }
    }
  }

  // Structural summary — always emitted as info for machine/LLM consumption
  if (state.targets.length >= 5) {
    const headingCount = state.targets.filter(
      (t) => t.kind === "heading",
    ).length;
    const landmarkRoles = [
      ...new Set(
        state.targets
          .filter((t) => t.kind === "landmark")
          .map((t) => t.role),
      ),
    ];
    const hasSkipLink = state.targets.some(
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
      `${state.targets.length} total targets`,
    ];

    diagnostics.push({
      level: "info",
      code: "structural-summary",
      message: `Structural overview: ${parts.join(" \u00B7 ")}`,
    });
  }

  // All clear
  if (diagnostics.length === 0) {
    diagnostics.push({
      level: "info",
      code: "ok",
      message: `Captured ${state.targets.length} targets successfully.`,
    });
  }

  return diagnostics;
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
    // like /login-help or /authentication-docs
    return loginPaths.some((lp) =>
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
