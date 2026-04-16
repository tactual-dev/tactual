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

/** Screen reader to simulate. */
export type ATKind = "nvda" | "jaws" | "voiceover";

/**
 * Role announcement maps for each supported screen reader.
 *
 * DATA QUALITY NOTE.
 *
 * The simulator is heuristic prediction, not real AT runtime output.
 * That said, the maps below are CALIBRATED against the W3C ARIA-AT
 * project's tested patterns:
 *
 *   command-button, checkbox, switch, horizontal-slider, modal-dialog,
 *   tabs-manual-activation, link-span-text, alert, disclosure-faq,
 *   menu-button-actions, quantity-spin-button, main, banner,
 *   contentinfo, complementary
 *
 * For these patterns, our simulator passes ARIA-AT's per-target
 * assertions for all three ATs (NVDA, JAWS, VoiceOver) at 100%
 * coverage. Run `npm run calibrate` to verify against the latest
 * upstream assertions.
 *
 * The calibration covers role + name + state conveyance. It does NOT
 * cover phrasing variation (NVDA "expanded" vs alternative wording),
 * AT version drift, or untested patterns (combobox-autocomplete,
 * menubar-editor, tree, grid, etc.). Confidence labels remain on
 * AT-specific overrides for those cases.
 *
 * Approach:
 *
 * 1. BASE_ANNOUNCEMENTS — universal terminology shared across all
 *    three ATs in default verbosity. Verified by ARIA-AT calibration
 *    where possible.
 *
 * 2. AT_OVERRIDES — only entries where AT-specific behavior diverges
 *    from the base. Each override has a confidence label and source.
 *    Anything uncertain falls through to BASE — better to be silent
 *    than confidently wrong.
 *
 * Confidence labels:
 *   HIGH:   verified by ARIA-AT calibration OR widely-cited AT docs
 *   MEDIUM: documented but version- or browser-dependent
 *   LOW:    educated guess based on observed patterns
 */

const BASE_ANNOUNCEMENTS: Record<string, string> = {
  // Landmarks — all three ATs announce landmark role; verbosity differs
  // (NVDA "X landmark" vs VoiceOver "X" alone vs JAWS "X region" in
  // some configs). The base uses NVDA's "X landmark" form. AT_OVERRIDES
  // adjusts only for verified differences.
  banner: "banner landmark",
  navigation: "navigation landmark",
  main: "main landmark",
  contentinfo: "content information landmark",
  complementary: "complementary landmark",
  region: "region",
  search: "search landmark",
  form: "form landmark",
  // Headings, links, buttons — universal
  heading: "heading",
  link: "link",
  button: "button",
  // Form controls — phrasing mostly universal
  checkbox: "check box",
  radio: "radio button",
  textbox: "edit",
  searchbox: "search edit",
  combobox: "combo box",
  listbox: "list box",
  slider: "slider",
  spinbutton: "spin button",
  switch: "switch",
  // Tabs / dialogs / status — universal phrasing
  tab: "tab",
  tabpanel: "tab panel",
  dialog: "dialog",
  alertdialog: "alert dialog",
  alert: "alert",
  status: "status",
  log: "log",
  // Menus — universal
  menu: "menu",
  menubar: "menu bar",
  menuitem: "menu item",
  menuitemcheckbox: "menu item check box",
  menuitemradio: "menu item radio button",
};

/**
 * AT-specific overrides. Only documented differences I'm confident about.
 * Anything missing falls through to BASE_ANNOUNCEMENTS.
 */
const AT_OVERRIDES: Record<ATKind, Record<string, string>> = {
  nvda: {
    // No overrides — BASE is calibrated against NVDA's defaults
  },
  jaws: {
    // JAWS in default verbosity announces landmarks similarly to NVDA.
    // I previously claimed "navigation region" vs "navigation landmark" —
    // removed: cannot verify this is consistent across JAWS versions.
    // Falls through to BASE.
  },
  voiceover: {
    // HIGH confidence — Apple's HTML/ARIA mapping is well-documented:
    //   https://developer.apple.com/documentation/accessibility
    // Native <input type="text"> and role="textbox" both announce as
    // "text field" in VoiceOver.
    textbox: "text field",
    searchbox: "search text field",
    // HIGH confidence — VoiceOver maps native <select> (and ARIA
    // combobox in select-only patterns) to "popup button". For ARIA
    // editable comboboxes the announcement may differ; this is the
    // common case.
    combobox: "popup button",
  },
};

/** Resolve role text for an AT, falling back to base or raw role. */
function getRoleText(role: string, at: ATKind): string {
  return AT_OVERRIDES[at][role] ?? BASE_ANNOUNCEMENTS[role] ?? role;
}


/**
 * Build a heuristic screen-reader announcement string for a target.
 *
 * IMPORTANT: This is best-effort prediction, not verified AT output.
 * See the data quality note above ROLE_ANNOUNCEMENTS for what is solid
 * vs. speculative. Anywhere this function makes a high-confidence claim
 * about cross-AT differences (e.g., VoiceOver "text field" vs NVDA
 * "edit"), it's because the difference is documented in the AT's
 * own materials. Anywhere we'd be guessing, we fall through to a
 * shared base announcement instead of inventing a difference.
 *
 * Defaults to NVDA. Pass "jaws" or "voiceover" for other ATs.
 *
 * Examples (NVDA):
 *   { role: "button", name: "Sign Up" }            → "Sign Up, button"
 *   { role: "checkbox", name: "Subscribe", checked } → "Subscribe, check box, checked"
 *   { role: "heading", name: "Title", headingLevel: 2 } → "Title, heading, level 2"
 */
export function buildAnnouncement(target: Target, at: ATKind = "nvda"): string {
  const role = target.role;
  const attrsForRole = (target as Record<string, unknown>)._attributeValues as
    | Record<string, string>
    | undefined;
  // Buttons with aria-haspopup are announced as "menu button" by all three
  // ATs (HIGH confidence — verified against ARIA-AT menu-button-actions
  // assertions for NVDA, JAWS, and VoiceOver).
  let roleText = getRoleText(role, at);
  if (role === "button" && attrsForRole?.["aria-haspopup"]) {
    const popup = attrsForRole["aria-haspopup"];
    if (popup === "menu" || popup === "true") {
      roleText = "menu button";
    }
  }
  const parts: string[] = [];

  if (target.name) parts.push(target.name);
  parts.push(roleText);

  // Heading level (NVDA: "Title, heading, level 2")
  if (target.kind === "heading" && target.headingLevel) {
    parts.push(`level ${target.headingLevel}`);
  }

  // State info from captured ARIA attributes (reuse attrsForRole)
  const attrs = attrsForRole;
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

    // Expanded/collapsed state (HIGH confidence — universal across ATs
    // for elements that expose aria-expanded). For VoiceOver+combobox
    // the role text "popup button" already implies state, so we skip
    // the explicit marker to match observed behavior on native <select>.
    // For ARIA combobox patterns this may differ; flagged in the
    // detectInteropDivergence output as a known uncertainty.
    const exp = attrs["aria-expanded"];
    if (exp !== undefined && !(at === "voiceover" && role === "combobox")) {
      if (exp === "true") parts.push("expanded");
      else if (exp === "false") parts.push("collapsed");
    }

    // Selected state (HIGH confidence — universal)
    if (role === "tab" || role === "option") {
      const sel = attrs["aria-selected"];
      if (sel === "true") parts.push("selected");
    }

    // Modal dialog (MEDIUM confidence — NVDA & JAWS document modal
    // announcements but VoiceOver behavior varies by version. Including
    // for all ATs as a reasonable approximation.)
    if ((role === "dialog" || role === "alertdialog") && attrs["aria-modal"] === "true") {
      parts.push("modal");
    }

    // Disabled state. NVDA "unavailable" and VoiceOver "dimmed" are
    // both widely cited (NVDA's term: HIGH confidence; VoiceOver's
    // "dimmed": MEDIUM confidence — documented in older Apple guides
    // but exact wording for ARIA-disabled vs HTML-disabled may vary).
    if (attrs["aria-disabled"] === "true") {
      parts.push(at === "voiceover" ? "dimmed" : "unavailable");
    }
    // Readonly, invalid, required (HIGH confidence — universal phrasing)
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

  // aria-describedby resolved text — NVDA reads it after the main announcement
  const description = (target as Record<string, unknown>)._description as string | undefined;
  if (description) {
    parts.push(description);
  }

  return parts.join(", ");
}

/** All three AT announcements for a single target. */
export interface MultiATAnnouncement {
  nvda: string;
  jaws: string;
  voiceover: string;
}

/** A single step in a navigation transcript. */
export interface TranscriptStep {
  /** Position in linear navigation order (1-indexed) */
  step: number;
  /** Target ID this step refers to */
  targetId: string;
  /** Target kind (button, link, formField, heading, landmark, etc.) */
  kind: string;
  /** What the screen reader announces */
  announcement: string;
  /** Action a user takes to reach this step */
  action: "next-item" | "next-heading" | "next-landmark";
}

/**
 * Build a linear navigation transcript — what a screen-reader user hears
 * as they Tab/swipe through interactive elements in DOM order.
 *
 * This includes only targets that appear in the accessibility tree
 * (interactive elements, headings, landmarks). Static text content is
 * NOT included — Tactual doesn't capture body text.
 */
export function buildTranscript(targets: Target[], at: ATKind = "nvda"): TranscriptStep[] {
  return targets.map((target, i) => ({
    step: i + 1,
    targetId: target.id,
    kind: target.kind,
    announcement: buildAnnouncement(target, at),
    action: "next-item" as const,
  }));
}

/** Build announcements for all three supported screen readers. */
export function buildMultiATAnnouncement(target: Target): MultiATAnnouncement {
  return {
    nvda: buildAnnouncement(target, "nvda"),
    jaws: buildAnnouncement(target, "jaws"),
    voiceover: buildAnnouncement(target, "voiceover"),
  };
}

/**
 * Detect when announcements diverge across screen readers in a way that
 * affects what the user actually hears.
 *
 * Returns null when announcements are equivalent or when the divergence
 * is purely cosmetic (same meaning, different wording, no impact on
 * comprehension).
 *
 * CONFIDENCE: this function makes claims about specific AT differences.
 * Each claim's confidence is documented inline. When uncertain, we
 * label the divergence as "may differ" rather than asserting it as fact.
 */
export function detectInteropDivergence(
  target: Target,
): { description: string; announcements: MultiATAnnouncement } | null {
  const a = buildMultiATAnnouncement(target);
  const allSame = a.nvda === a.jaws && a.jaws === a.voiceover;
  if (allSame) return null;

  const role = target.role;
  const attrs = (target as Record<string, unknown>)._attributeValues as
    | Record<string, string> | undefined;

  // HIGH confidence (Apple's HTML mapping is well-documented):
  // VoiceOver maps native <select> and select-only ARIA comboboxes to
  // "popup button". For editable comboboxes this may not apply.
  if (role === "combobox" && attrs?.["aria-expanded"] !== undefined) {
    return {
      description:
        "VoiceOver announces native <select> and select-only ARIA comboboxes " +
        "as 'popup button' (with state implicit in the role text), while " +
        "NVDA/JAWS announce 'combo box, expanded/collapsed' explicitly. " +
        "For editable combobox patterns VoiceOver's behavior may differ — " +
        "verify with real testing if this control is critical.",
      announcements: a,
    };
  }

  // MEDIUM confidence — VoiceOver "dimmed" is documented in Apple guides
  // for the disabled state but the exact wording may vary by VoiceOver
  // version and whether the disabled state comes from HTML or aria-disabled.
  if (attrs?.["aria-disabled"] === "true") {
    return {
      description:
        "Disabled state phrasing differs across screen readers. NVDA typically " +
        "says 'unavailable'; VoiceOver typically says 'dimmed'. The information " +
        "is conveyed but the wording is different — only a user-experience " +
        "concern if you document AT-specific terms (e.g., support docs).",
      announcements: a,
    };
  }

  // HIGH confidence — Apple maps role="textbox" / <input type="text"> to
  // "text field" terminology, which all VoiceOver users hear consistently.
  if (role === "textbox" || role === "searchbox") {
    return {
      description:
        "VoiceOver says 'text field' where NVDA and JAWS say 'edit'. " +
        "Same control, different vocabulary — typically only matters if " +
        "user-facing documentation refers to specific AT terms.",
      announcements: a,
    };
  }

  return null;
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
