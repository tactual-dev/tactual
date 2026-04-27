import type { ATProfile } from "./types.js";

/**
 * JAWS on Windows desktop profile (v0).
 *
 * Models JAWS's navigation patterns:
 * - Virtual cursor: arrow keys for linear reading
 * - Quick keys: H for headings, Tab for links/form fields, R for regions,
 *   Insert+F5 for form fields list, Insert+F6 for headings list,
 *   Insert+F7 for links list
 * - Forms mode: automatic entry when encountering form controls
 * - JAWS find: Ctrl+F or Insert+Ctrl+F
 * - PlaceMarkers: Insert+Ctrl+K for persistent markers
 *
 * JAWS has the most comprehensive quick key set and the best automatic
 * forms mode handling. Its navigation costs are generally the lowest
 * among desktop screen readers for well-structured content. However,
 * JAWS's automatic forms mode can be disorienting when it activates
 * unexpectedly.
 */
export const jawsDesktopV0: ATProfile = {
  id: "jaws-desktop-v0",
  name: "JAWS Windows Desktop (v0)",
  description:
    "JAWS on Windows with Chrome/IE/Edge. " +
    "Models virtual cursor with automatic forms mode. " +
    "Most comprehensive quick key support among desktop AT.",
  platform: "desktop",

  actionCosts: {
    // Virtual cursor: arrow keys
    nextItem: 1.0,
    previousItem: 1.0,
    // Quick keys: H, Tab, R — single keystroke
    nextHeading: 1.0,
    nextLink: 1.0,
    nextControl: 1.0, // Tab key in virtual cursor mode
    // Enter to activate
    activate: 1.0,
    // Escape exits menus/dialogs, very reliable in JAWS
    dismiss: 0.8,
    // Alt+Left for browser back
    back: 1.2,
    // Ctrl+F or Insert+Ctrl+F — standard find
    find: 2.0,
    // R for next region/landmark — single key
    groupEntry: 1.0,
    groupExit: 1.0,
    // First-letter type-ahead: single keypress in focused menus
    firstLetter: 1.0,
  },

  weights: {
    discoverability: 0.30,
    reachability: 0.25,
    operability: 0.35,
    recovery: 0.10,
  },

  costSensitivity: 0.6,

  modifiers: [
    {
      condition: { type: "hiddenBranch" },
      multiplier: 1.3,
      reason:
        "Hidden branches require discovery. JAWS's links/headings/form " +
        "field lists help but add a multi-key shortcut step.",
    },
    {
      condition: { type: "unrelatedContentTax", minItems: 5 },
      multiplier: 1.15,
      reason:
        "JAWS's comprehensive quick keys minimize the impact of unrelated " +
        "content, but 5+ items still add cognitive load.",
    },
    {
      condition: { type: "contextSwitch" },
      multiplier: 1.2,
      reason:
        "JAWS announces context changes clearly. Its automatic forms mode " +
        "handles most transitions well, but unexpected mode changes can " +
        "be confusing.",
    },
    {
      condition: { type: "modeSwitch" },
      multiplier: 1.8,
      reason:
        "JAWS's automatic forms mode reduces explicit mode switching, but " +
        "when it activates unexpectedly (entering a form field while " +
        "reading), it can be disorienting.",
    },
    {
      condition: { type: "noStructuralAnchor" },
      multiplier: 1.2,
      reason:
        "Without headings or landmarks, JAWS's quick keys and element " +
        "lists are ineffective. Content becomes linearly traversed.",
    },
    {
      condition: { type: "focusTrap" },
      multiplier: 1.5,
      reason:
        "JAWS is the most resilient to focus traps — Escape and " +
        "Insert+Z (pass-through) provide recovery. But the trap still " +
        "disrupts navigation flow.",
    },
  ],

  // JAWS is Windows-only; HCM is a common configuration. Same rationale
  // as the NVDA profile: hardcoded SVG fills stay at author color under
  // forced-colors, often rendering icons invisible in HCM-dark.
  visualModes: [
    { colorScheme: "light", forcedColors: "none" },
    { colorScheme: "light", forcedColors: "active" },
    { colorScheme: "dark", forcedColors: "none" },
    { colorScheme: "dark", forcedColors: "active" },
  ],
};
