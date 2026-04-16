/**
 * Screen reader announcement simulator.
 *
 * Predicts what NVDA/VoiceOver would announce for each target based on
 * the accessibility tree AND HTML context rules that real screen readers
 * apply. This catches cases where the AT tree reports a role that the
 * SR would not actually announce (e.g., `<header>` inside `<section>`
 * loses its implicit `banner` landmark role in NVDA).
 *
 * Unlike the real SR integration (screen-reader.ts), this:
 * - Does NOT launch a screen reader
 * - Does NOT steal OS focus
 * - Works cross-platform (Windows, macOS, Linux, CI)
 * - Runs in milliseconds, not minutes
 */

import type { Page } from "playwright";
import type { Target } from "../core/types.js";

// ---------------------------------------------------------------------------
// NVDA announcement patterns
// ---------------------------------------------------------------------------

/** How NVDA announces each ARIA role */
const NVDA_ROLE_ANNOUNCEMENTS: Record<string, string> = {
  banner: "banner landmark",
  navigation: "navigation landmark",
  main: "main landmark",
  contentinfo: "content information landmark",
  complementary: "complementary landmark",
  region: "landmark",
  search: "search landmark",
  form: "form landmark",
  heading: "heading",
  link: "link",
  button: "button",
  checkbox: "check box",
  radio: "radio button",
  textbox: "edit",
  combobox: "combo box",
  listbox: "list box",
  slider: "slider",
  spinbutton: "spin button",
  switch: "switch",
  tab: "tab",
  tabpanel: "tab panel",
  dialog: "dialog",
  alertdialog: "alert dialog",
  alert: "alert",
  status: "status",
  menu: "menu",
  menubar: "menu bar",
  menuitem: "menu item",
  menuitemcheckbox: "menu item check box",
  menuitemradio: "menu item radio button",
  separator: "separator",
  progressbar: "progress bar",
};

// ---------------------------------------------------------------------------
// Context rules — when landmarks get demoted
// ---------------------------------------------------------------------------

export interface NestingContext {
  /** The landmark role as reported by the AT tree */
  role: string;
  /** Whether the HTML element is nested inside <section>, <article>, or <aside> */
  nestedInSectioning: boolean;
  /** Whether the element has an explicit role="..." attribute */
  hasExplicitRole: boolean;
  /** Whether the element has an aria-label or aria-labelledby */
  hasLabel: boolean;
}

/**
 * HTML spec rules for implicit landmark roles.
 *
 * These are cases where the AT tree reports a role, but NVDA would NOT
 * announce it as a landmark because the HTML context demotes it.
 *
 * Reference: https://www.w3.org/TR/html-aam-1.0/#el-header
 */
function isLandmarkDemoted(ctx: NestingContext): boolean {
  // Explicit role="banner" always works regardless of nesting
  if (ctx.hasExplicitRole) return false;

  // <header> inside <section>/<article>/<aside>/<nav> loses banner role
  if (ctx.role === "banner" && ctx.nestedInSectioning) return true;

  // <footer> inside <section>/<article>/<aside>/<nav> loses contentinfo role
  if (ctx.role === "contentinfo" && ctx.nestedInSectioning) return true;

  // <form> and <section> without aria-label are NOT landmarks
  if ((ctx.role === "form" || ctx.role === "region") && !ctx.hasLabel) return true;

  return false;
}

// ---------------------------------------------------------------------------
// Simulated announcement
// ---------------------------------------------------------------------------

export interface SimulatedAnnouncement {
  targetId: string;
  role: string;
  name: string;
  /** What NVDA would announce */
  announcement: string;
  /** Whether a landmark would actually be exposed (not demoted by context) */
  landmarkExposed: boolean;
  /** If the AT tree says landmark but NVDA wouldn't announce it */
  demoted: boolean;
  /** Reason for demotion */
  demotionReason?: string;
}

export interface SimulatorReport {
  /** All landmark targets with their simulated announcements */
  landmarks: SimulatedAnnouncement[];
  /** All heading targets with their simulated announcements */
  headings: SimulatedAnnouncement[];
  /** Landmarks that the AT tree reports but NVDA would NOT announce */
  demotedLandmarks: SimulatedAnnouncement[];
  /** Total targets analyzed */
  totalTargets: number;
}

/**
 * Query the page DOM to determine nesting context for landmark elements.
 * This checks whether `<header>` and `<footer>` elements are inside
 * sectioning content (`<section>`, `<article>`, `<aside>`, `<nav>`).
 */
async function getLandmarkContexts(page: Page): Promise<Map<string, NestingContext>> {
  const contexts = await page.evaluate(() => {
    const results: Array<{
      role: string;
      name: string;
      nestedInSectioning: boolean;
      hasExplicitRole: boolean;
      hasLabel: boolean;
    }> = [];

    const sectioningTags = new Set(["SECTION", "ARTICLE", "ASIDE", "NAV"]);
    const landmarkElements = document.querySelectorAll(
      'header, footer, main, nav, aside, form, section, [role="banner"], [role="contentinfo"], [role="main"], [role="navigation"], [role="complementary"], [role="region"], [role="form"], [role="search"]',
    );

    for (const el of Array.from(landmarkElements)) {
      const tag = el.tagName;
      const explicitRole = el.getAttribute("role");
      const implicitRole: Record<string, string> = {
        HEADER: "banner",
        FOOTER: "contentinfo",
        MAIN: "main",
        NAV: "navigation",
        ASIDE: "complementary",
        FORM: "form",
        SECTION: "region",
      };

      const role = explicitRole || implicitRole[tag];
      if (!role) continue;

      // Check if nested in a sectioning element
      let parent = el.parentElement;
      let nestedInSectioning = false;
      while (parent) {
        if (sectioningTags.has(parent.tagName)) {
          nestedInSectioning = true;
          break;
        }
        parent = parent.parentElement;
      }

      const hasLabel = !!(
        el.getAttribute("aria-label") || el.getAttribute("aria-labelledby")
      );

      results.push({
        role,
        name: el.getAttribute("aria-label") || "",
        nestedInSectioning,
        hasExplicitRole: !!explicitRole,
        hasLabel,
      });
    }

    return results;
  });

  // Use array — multiple elements can share the same role+name (e.g., two unlabeled <header>s)
  const map = new Map<string, NestingContext>();
  for (let i = 0; i < contexts.length; i++) {
    const ctx = contexts[i];
    const key = `${ctx.role}:${ctx.name}:${i}`;
    map.set(key, ctx);
  }
  return map;
}

/**
 * Simulate screen reader announcements and detect demoted landmarks.
 *
 * Two functions:
 * 1. Predicts what NVDA would announce for each target
 * 2. Explains WHY expected landmarks are missing — checks the DOM for
 *    elements like `<header>` that exist but are demoted by HTML context
 *    rules (e.g., nested inside `<section>`)
 */
export async function simulateScreenReader(
  page: Page,
  targets: Target[],
): Promise<SimulatorReport> {
  const nestingContexts = await getLandmarkContexts(page);

  const landmarks: SimulatedAnnouncement[] = [];
  const headings: SimulatedAnnouncement[] = [];
  const demotedLandmarks: SimulatedAnnouncement[] = [];

  // --- Simulate announcements for existing targets ---
  for (const target of targets) {
    if (target.kind === "landmark") {
      const roleAnnouncement = NVDA_ROLE_ANNOUNCEMENTS[target.role] || target.role;
      const announcement = target.name
        ? `${target.name}, ${roleAnnouncement}`
        : roleAnnouncement;

      landmarks.push({
        targetId: target.id,
        role: target.role,
        name: target.name,
        announcement,
        landmarkExposed: true,
        demoted: false,
      });
    }

    if (target.kind === "heading") {
      const level = target.headingLevel ?? 2;
      const announcement = target.name
        ? `${target.name}, heading, level ${level}`
        : `heading, level ${level}`;

      headings.push({
        targetId: target.id,
        role: "heading",
        name: target.name,
        announcement,
        landmarkExposed: true,
        demoted: false,
      });
    }
  }

  // --- Detect demoted landmarks ---
  // Check the DOM for landmark elements that EXIST but were demoted
  // by HTML context rules (so they don't appear in the AT tree at all).
  // This explains why a developer's <header> or <footer> isn't working.
  const hasRole = (role: string) => targets.some(
    (t) => t.kind === "landmark" && t.role === role,
  );

  for (const [, ctx] of nestingContexts) {
    if (isLandmarkDemoted(ctx)) {
      let demotionReason: string;

      if (ctx.role === "banner" && ctx.nestedInSectioning) {
        if (hasRole("banner")) continue; // Already exposed via explicit role
        demotionReason =
          "<header> exists but is inside a <section>, <article>, <aside>, or <nav> — " +
          "this removes its implicit banner landmark role. " +
          "Fix: add role=\"banner\" to the <header> element.";
      } else if (ctx.role === "contentinfo" && ctx.nestedInSectioning) {
        if (hasRole("contentinfo")) continue;
        demotionReason =
          "<footer> exists but is inside a <section>, <article>, <aside>, or <nav> — " +
          "this removes its implicit contentinfo landmark role. " +
          "Fix: add role=\"contentinfo\" to the <footer> element.";
      } else if (!ctx.hasLabel) {
        demotionReason =
          `<${ctx.role === "form" ? "form" : "section"}> exists but has no aria-label — ` +
          "it is not exposed as a landmark without a label. " +
          "Fix: add aria-label to make it a landmark.";
      } else {
        continue;
      }

      demotedLandmarks.push({
        targetId: `demoted-${ctx.role}`,
        role: ctx.role,
        name: "",
        announcement: `(not announced — ${demotionReason})`,
        landmarkExposed: false,
        demoted: true,
        demotionReason,
      });
    }
  }

  return {
    landmarks,
    headings,
    demotedLandmarks,
    totalTargets: targets.length,
  };
}
