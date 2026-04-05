import type { ATProfile } from "./types.js";

/**
 * Generic mobile web screen-reader profile (v0).
 *
 * Models common navigation primitives shared across mobile screen readers
 * (VoiceOver iOS, TalkBack Android) without claiming exact fidelity to either.
 *
 * Cost values represent relative effort. 1.0 = one atomic swipe/tap action.
 * Higher costs represent actions that require more cognitive load or steps.
 */
export const genericMobileWebSrV0: ATProfile = {
  id: "generic-mobile-web-sr-v0",
  name: "Generic Mobile Web Screen Reader (v0)",
  description:
    "Normalized mobile screen-reader navigation model. " +
    "Covers common primitives shared by VoiceOver and TalkBack on mobile web. " +
    "Not calibrated to any specific AT; intended as a starting point for scoring.",
  platform: "mobile",

  actionCosts: {
    nextItem: 1.0,
    previousItem: 1.0,
    nextHeading: 1.5,
    nextLink: 1.5,
    nextControl: 1.5,
    activate: 1.0,
    dismiss: 1.5,
    back: 2.0,
    find: 3.0,
    groupEntry: 2.0,
    groupExit: 2.0,
    // No first-letter type-ahead on mobile — not available
    firstLetter: 100,
  },

  weights: {
    discoverability: 0.30,
    reachability: 0.40,
    operability: 0.20,
    recovery: 0.10,
  },

  costSensitivity: 1.0,

  modifiers: [
    {
      condition: { type: "hiddenBranch" },
      multiplier: 1.5,
      reason: "Target requires opening a hidden branch (menu, dialog, disclosure) before it becomes reachable",
    },
    {
      condition: { type: "unrelatedContentTax", minItems: 5 },
      multiplier: 1.3,
      reason: "Path passes through 5+ unrelated items, adding cognitive and navigation burden",
    },
    {
      condition: { type: "contextSwitch" },
      multiplier: 1.4,
      reason: "Navigation crosses a context boundary (dialog opens, tab panel changes, etc.)",
    },
    {
      condition: { type: "modeSwitch" },
      multiplier: 1.6,
      reason: "User must switch navigation mode (e.g., from heading nav to control nav)",
    },
    {
      condition: { type: "noStructuralAnchor" },
      multiplier: 1.3,
      reason: "Target has no nearby heading or landmark to serve as a navigation anchor",
    },
    {
      condition: { type: "focusTrap" },
      multiplier: 3.0,
      reason: "Focus is trapped or lost, requiring recovery actions",
    },
  ],
};
