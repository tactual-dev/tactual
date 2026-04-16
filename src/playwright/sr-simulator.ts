/**
 * Screen reader announcement simulator.
 *
 * Heuristic prediction of what NVDA/VoiceOver would announce for each
 * target based on the accessibility tree AND HTML context rules that real
 * screen readers apply. This is NOT real SR output — it infers
 * announcements from ARIA/HTML spec rules and a partial role-to-speech
 * mapping. It catches cases where the AT tree reports a role that the SR
 * would not actually announce (e.g., `<header>` inside `<section>` loses
 * its implicit `banner` landmark role in NVDA).
 *
 * Design:
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

/**
 * How NVDA announces each ARIA role.
 *
 * Covers all roles emitted by the Tactual capture pipeline (see
 * roleToTargetKind in capture.ts). For state-bearing roles (checkbox,
 * combobox, switch, etc.), the announcement is the role text only —
 * state values are appended by buildAnnouncement().
 */
const NVDA_ROLE_ANNOUNCEMENTS: Record<string, string> = {
  // Landmarks
  banner: "banner landmark",
  navigation: "navigation landmark",
  main: "main landmark",
  contentinfo: "content information landmark",
  complementary: "complementary landmark",
  region: "landmark",
  search: "search landmark",
  form: "form landmark",
  // Heading
  heading: "heading",
  // Controls
  link: "link",
  button: "button",
  // Form fields
  checkbox: "check box",
  radio: "radio button",
  textbox: "edit",
  searchbox: "search edit",
  combobox: "combo box",
  listbox: "list box",
  slider: "slider",
  spinbutton: "spin button",
  switch: "switch",
  // Tabs
  tab: "tab",
  tabpanel: "tab panel",
  // Dialogs
  dialog: "dialog",
  alertdialog: "alert dialog",
  // Status messages
  alert: "alert",
  status: "status",
  log: "log",
  // Menus
  menu: "menu",
  menubar: "menu bar",
  menuitem: "menu item",
  menuitemcheckbox: "menu item check box",
  menuitemradio: "menu item radio button",
};

/**
 * Build a state-aware NVDA announcement string for a target.
 *
 * Examples:
 *   { role: "button", name: "Sign Up" }            → "Sign Up, button"
 *   { role: "checkbox", name: "Subscribe", checked } → "Subscribe, check box, checked"
 *   { role: "combobox", name: "Country", expanded=false } → "Country, combo box, collapsed"
 *   { role: "slider", name: "Volume", value: "75" }  → "Volume, slider, 75"
 *   { role: "heading", name: "Title", headingLevel: 2 } → "Title, heading, level 2"
 */
export function buildAnnouncement(target: Target): string {
  const role = target.role;
  const roleText = NVDA_ROLE_ANNOUNCEMENTS[role] ?? role;
  const parts: string[] = [];

  if (target.name) parts.push(target.name);
  parts.push(roleText);

  // Heading level (NVDA: "Title, heading, level 2")
  if (target.kind === "heading" && target.headingLevel) {
    parts.push(`level ${target.headingLevel}`);
  }

  // State info from captured ARIA attributes
  const attrs = (target as Record<string, unknown>)._attributeValues as
    | Record<string, string>
    | undefined;
  const value = (target as Record<string, unknown>)._value as string | undefined;

  if (attrs) {
    // Checked state (checkbox, radio, switch, menuitemcheckbox, menuitemradio)
    if (
      role === "checkbox" || role === "radio" || role === "switch" ||
      role === "menuitemcheckbox" || role === "menuitemradio"
    ) {
      const c = attrs["aria-checked"];
      if (c === "true") parts.push("checked");
      else if (c === "false") parts.push("not checked");
      else if (c === "mixed") parts.push("partially checked");
    }

    // Expanded state (combobox, listbox, button with menu, menu, etc.)
    const exp = attrs["aria-expanded"];
    if (exp === "true") parts.push("expanded");
    else if (exp === "false") parts.push("collapsed");

    // Selected state (tab, option)
    if (role === "tab" || role === "option") {
      const sel = attrs["aria-selected"];
      if (sel === "true") parts.push("selected");
    }

    // Modal dialog
    if ((role === "dialog" || role === "alertdialog") && attrs["aria-modal"] === "true") {
      parts.push("modal");
    }

    // Required, invalid, readonly, disabled states (form fields)
    if (attrs["aria-disabled"] === "true") parts.push("unavailable");
    if (attrs["aria-readonly"] === "true") parts.push("read only");
    if (attrs["aria-invalid"] === "true" || attrs["aria-invalid"] === "grammar" || attrs["aria-invalid"] === "spelling") {
      parts.push("invalid entry");
    }
    if (attrs["aria-required"] === "true") parts.push("required");
  }

  // Slider/spinbutton/progressbar value
  if (value && (role === "slider" || role === "spinbutton" || role === "progressbar")) {
    parts.push(value);
  }

  return parts.join(", ");
}

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
export function isLandmarkDemoted(ctx: NestingContext): boolean {
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
  /** Buttons and links */
  controls: SimulatedAnnouncement[];
  /** Form fields (textbox, checkbox, radio, combobox, etc.) */
  formFields: SimulatedAnnouncement[];
  /** Dialogs and alert dialogs */
  dialogs: SimulatedAnnouncement[];
  /** Status messages, alerts, logs */
  statusMessages: SimulatedAnnouncement[];
  /** Menus and menu items */
  menus: SimulatedAnnouncement[];
  /** Tabs and tab panels */
  tabs: SimulatedAnnouncement[];
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
// The page.evaluate callbacks run in the browser, where DOM globals
// are available. Our tsconfig doesn't include DOM in lib, so we
// declare a minimal Element/Document surface to satisfy type-checking.
// (Runtime behavior is unchanged — the browser provides real DOM.)
interface MinimalEl {
  tagName: string;
  parentElement: MinimalEl | null;
  getAttribute(name: string): string | null;
}
interface MinimalDocument {
  querySelectorAll(selector: string): ArrayLike<MinimalEl>;
}
declare const document: MinimalDocument;

async function getLandmarkContexts(page: Page): Promise<NestingContext[]> {
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

  return contexts;
}

/**
 * Simulate screen reader announcements and detect demoted landmarks.
 *
 * Two functions:
 * 1. Predicts what NVDA would announce for each target, including
 *    state info (checked, expanded, selected, modal, value, etc.)
 *    when captured ARIA attributes are present
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
  const controls: SimulatedAnnouncement[] = [];
  const formFields: SimulatedAnnouncement[] = [];
  const dialogs: SimulatedAnnouncement[] = [];
  const statusMessages: SimulatedAnnouncement[] = [];
  const menus: SimulatedAnnouncement[] = [];
  const tabs: SimulatedAnnouncement[] = [];
  const demotedLandmarks: SimulatedAnnouncement[] = [];

  // --- Simulate announcements for existing targets ---
  const announce = (target: Target): SimulatedAnnouncement => ({
    targetId: target.id,
    role: target.role,
    name: target.name,
    announcement: buildAnnouncement(target),
    landmarkExposed: true,
    demoted: false,
  });

  for (const target of targets) {
    switch (target.kind) {
      case "landmark":
      case "search":
        landmarks.push(announce(target));
        break;
      case "heading":
        headings.push(announce(target));
        break;
      case "button":
      case "link":
        controls.push(announce(target));
        break;
      case "formField":
        formFields.push(announce(target));
        break;
      case "dialog":
        dialogs.push(announce(target));
        break;
      case "statusMessage":
        statusMessages.push(announce(target));
        break;
      case "menuTrigger":
      case "menuItem":
        menus.push(announce(target));
        break;
      case "tab":
      case "tabPanel":
        tabs.push(announce(target));
        break;
    }
  }

  // --- Detect demoted landmarks ---
  // Check the DOM for landmark elements that EXIST but were demoted
  // by HTML context rules (so they don't appear in the AT tree at all).
  // This explains why a developer's <header> or <footer> isn't working.
  const hasRole = (role: string) => targets.some(
    (t) => t.kind === "landmark" && t.role === role,
  );

  let demotedIndex = 0;
  for (const ctx of nestingContexts) {
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
          `Element with role="${ctx.role}" exists but has no aria-label — ` +
          "it is not exposed as a landmark without a label. " +
          "Fix: add aria-label to make it a landmark.";
      } else {
        continue;
      }

      demotedIndex++;
      demotedLandmarks.push({
        targetId: `demoted-${ctx.role}-${demotedIndex}`,
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
    controls,
    formFields,
    dialogs,
    statusMessages,
    menus,
    tabs,
    demotedLandmarks,
    totalTargets: targets.length,
  };
}
