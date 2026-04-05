import type { ATProfile } from "./types.js";

/**
 * TalkBack on Android profile (v0).
 *
 * Models TalkBack-specific navigation patterns on Android Chrome:
 * - Linear focus via swipe right/left
 * - Reading controls menu for navigation by headings, links, controls
 * - Double-tap to activate
 * - Back gesture (swipe from left edge or system back) to dismiss
 * - TalkBack menu (three-finger tap or L-shaped gesture)
 *
 * TalkBack's reading controls require an extra step to switch modes
 * (swipe up/down to cycle navigation granularity), making heading/link
 * navigation slightly more expensive than VoiceOver's rotor. However,
 * TalkBack's back gesture is more natural and cheaper than VoiceOver's
 * two-finger scrub.
 */
export const talkbackAndroidV0: ATProfile = {
  id: "talkback-android-v0",
  name: "TalkBack Android (v0)",
  description:
    "TalkBack on Android Chrome. " +
    "Models reading controls menu with swipe gestures. " +
    "Calibrated from TalkBack documentation and common usage patterns.",
  platform: "mobile",

  actionCosts: {
    // Swipe right/left — same as VoiceOver
    nextItem: 1.0,
    previousItem: 1.0,
    // Reading controls: swipe up/down to change granularity, then swipe
    // right/left. Two-step process makes it more expensive than VoiceOver's rotor.
    nextHeading: 1.7,
    nextLink: 1.7,
    nextControl: 1.7,
    // Double-tap — same as VoiceOver
    activate: 1.0,
    // System back gesture or swipe from edge — cheaper than VoiceOver's scrub
    dismiss: 1.2,
    // Android back button/gesture — natural and cheap
    back: 1.3,
    // TalkBack search or screen search — similar complexity to VoiceOver
    find: 3.5,
    // Container navigation requires reading controls adjustment
    groupEntry: 2.2,
    groupExit: 2.0,
    // No first-letter type-ahead on TalkBack
    firstLetter: 100,
  },

  weights: {
    discoverability: 0.25,
    reachability: 0.45,
    operability: 0.20,
    recovery: 0.10,
  },

  costSensitivity: 1.3,

  modifiers: [
    {
      condition: { type: "hiddenBranch" },
      multiplier: 1.5,
      reason:
        "Hidden branches are harder to discover in TalkBack. " +
        "Reading controls mode switching adds friction to exploration.",
    },
    {
      condition: { type: "unrelatedContentTax", minItems: 5 },
      multiplier: 1.35,
      reason:
        "TalkBack's reading controls mode switch makes skipping content " +
        "more expensive than VoiceOver's rotor. Linear swiping through " +
        "5+ unrelated items is particularly costly.",
    },
    {
      condition: { type: "contextSwitch" },
      multiplier: 1.4,
      reason:
        "TalkBack announces context changes but less prominently than " +
        "VoiceOver. Users may need extra exploration to confirm the new context.",
    },
    {
      condition: { type: "modeSwitch" },
      multiplier: 1.7,
      reason:
        "Switching reading controls granularity (headings → links → controls) " +
        "requires swipe up/down gestures that interrupt navigation flow.",
    },
    {
      condition: { type: "noStructuralAnchor" },
      multiplier: 1.4,
      reason:
        "Without headings or landmarks, TalkBack's reading controls have " +
        "nothing to navigate by, forcing linear traversal.",
    },
    {
      condition: { type: "focusTrap" },
      multiplier: 3.0,
      reason:
        "Focus traps in TalkBack often require the system back gesture, " +
        "which may not work consistently in WebView contexts.",
    },
  ],
};
