import type { ATProfile } from "./types.js";

/**
 * NVDA on Windows desktop profile (v0).
 *
 * Models NVDA's navigation patterns in browse mode and focus mode:
 * - Browse mode: single-letter quick keys (H for headings, K for links,
 *   F for form fields, D for landmarks, etc.)
 * - Focus mode: Tab/Shift+Tab for form controls, Enter to activate
 * - Mode switching: NVDA+Space to toggle between browse/focus mode
 * - Find: NVDA+Ctrl+F for text search
 * - Element list: NVDA+F7 for all headings, links, landmarks, form fields
 *
 * Quick keys make heading/link/landmark navigation very cheap in NVDA
 * (single keystroke each). The main cost is mode switching between
 * browse mode and focus mode when interacting with form controls.
 */
export const nvdaDesktopV0: ATProfile = {
  id: "nvda-desktop-v0",
  name: "NVDA Windows Desktop (v0)",
  description:
    "NVDA on Windows with Chrome/Firefox. " +
    "Models browse mode quick keys and focus mode for forms. " +
    "Quick keys make heading/link/landmark nav very efficient.",
  platform: "desktop",

  actionCosts: {
    // Browse mode: arrow keys navigate linearly
    nextItem: 1.0,
    previousItem: 1.0,
    // Quick keys: single keystroke (H, K, F, D) — very cheap
    nextHeading: 1.0,
    nextLink: 1.0,
    nextControl: 1.2, // F for form field, slightly more specific
    // Enter in browse mode or Space for buttons
    activate: 1.0,
    // Escape exits menus/dialogs
    dismiss: 1.0,
    // Alt+Left or backspace for browser back
    back: 1.2,
    // NVDA+Ctrl+F for find — multi-key combo
    find: 2.5,
    // D for next landmark in browse mode
    groupEntry: 1.0,
    groupExit: 1.0,
    // First-letter type-ahead: single keypress in focused menus
    firstLetter: 1.0,
  },

  weights: {
    discoverability: 0.35,
    reachability: 0.25,
    operability: 0.30,
    recovery: 0.10,
  },

  costSensitivity: 0.7,

  modifiers: [
    {
      condition: { type: "hiddenBranch" },
      multiplier: 1.3,
      reason:
        "Hidden branches require discovery and activation. NVDA's element " +
        "list (NVDA+F7) helps but adds cognitive overhead.",
    },
    {
      condition: { type: "unrelatedContentTax", minItems: 5 },
      multiplier: 1.2,
      reason:
        "Quick keys mitigate linear traversal, but 5+ unrelated items " +
        "still add cognitive burden even with skip navigation.",
    },
    {
      condition: { type: "contextSwitch" },
      multiplier: 1.3,
      reason:
        "NVDA announces context changes, but modal dialogs and dynamic " +
        "content can confuse the virtual buffer.",
    },
    {
      condition: { type: "modeSwitch" },
      multiplier: 2.0,
      reason:
        "Switching between browse mode and focus mode (NVDA+Space) is the " +
        "most disruptive navigation action in NVDA. Form controls force " +
        "this switch, interrupting reading flow.",
    },
    {
      condition: { type: "noStructuralAnchor" },
      multiplier: 1.2,
      reason:
        "Without headings or landmarks, NVDA's quick keys (H, D) have " +
        "nothing to jump to. The element list also shows empty sections.",
    },
    {
      condition: { type: "focusTrap" },
      multiplier: 2.0,
      reason:
        "Focus traps in NVDA can usually be escaped with Escape or " +
        "NVDA+Space to return to browse mode, but this requires knowledge " +
        "of NVDA-specific commands.",
    },
  ],

  // Windows users running NVDA frequently use High Contrast Mode, often
  // in dark scheme. Author SVGs with hardcoded fill literals stay at the
  // author color under HCM (Chromium's `forced-color-adjust: preserve-parent-color`
  // default for SVG), which can render icons invisible against the
  // HCM-substituted Canvas background.
  visualModes: [
    { colorScheme: "light", forcedColors: "none" },
    { colorScheme: "light", forcedColors: "active" },
    { colorScheme: "dark", forcedColors: "none" },
    { colorScheme: "dark", forcedColors: "active" },
  ],
};
