import type { ATProfile } from "./types.js";

/**
 * VoiceOver on iOS profile (v0).
 *
 * Models VoiceOver-specific navigation patterns on mobile Safari:
 * - Rotor-based navigation (headings, links, form controls, landmarks)
 * - Swipe left/right for linear navigation
 * - Double-tap to activate
 * - Two-finger scrub to go back/dismiss
 * - Three-finger swipe for scroll
 *
 * VoiceOver's rotor makes heading and landmark navigation cheaper
 * than TalkBack's equivalent because the rotor is always available
 * without a menu. However, VoiceOver's gesture model means some
 * actions require multi-finger gestures that are more complex.
 */
export const voiceoverIosV0: ATProfile = {
  id: "voiceover-ios-v0",
  name: "VoiceOver iOS (v0)",
  description:
    "VoiceOver on iOS/iPadOS mobile Safari. " +
    "Models rotor-based navigation with swipe gestures. " +
    "Calibrated from VoiceOver documentation and common usage patterns.",
  platform: "mobile",

  actionCosts: {
    // Swipe right/left — single gesture, very natural
    nextItem: 1.0,
    previousItem: 1.0,
    // Rotor to headings, then swipe — rotor switch + swipe = slightly cheaper
    // than generic because rotor is always one gesture away
    nextHeading: 1.3,
    nextLink: 1.3,
    nextControl: 1.3,
    // Double-tap — natural but distinct from navigation
    activate: 1.0,
    // Two-finger scrub — specific gesture, moderate cognitive load
    dismiss: 1.8,
    // Two-finger scrub or navigate back — moderate
    back: 2.0,
    // Spotlight search or rotor search — more complex
    find: 3.5,
    // VoiceOver groups are navigated with rotor or vertical swipe
    groupEntry: 1.8,
    groupExit: 1.8,
    // No first-letter type-ahead on VoiceOver mobile
    firstLetter: 100,
  },

  weights: {
    discoverability: 0.30,
    reachability: 0.35,
    operability: 0.20,
    recovery: 0.15,
  },

  costSensitivity: 1.1,

  modifiers: [
    {
      condition: { type: "hiddenBranch" },
      multiplier: 1.4,
      reason:
        "Hidden branch requires discovery and activation before content is reachable. " +
        "VoiceOver announces role changes, slightly easing discovery.",
    },
    {
      condition: { type: "unrelatedContentTax", minItems: 5 },
      multiplier: 1.25,
      reason:
        "Swiping through 5+ unrelated items is tedious. " +
        "VoiceOver's rotor mitigates this if headings/landmarks are present.",
    },
    {
      condition: { type: "contextSwitch" },
      multiplier: 1.3,
      reason:
        "VoiceOver announces context changes clearly, but the user still must " +
        "reorient after a dialog or sheet opens.",
    },
    {
      condition: { type: "modeSwitch" },
      multiplier: 1.5,
      reason:
        "Switching rotor categories requires a two-finger rotation gesture, " +
        "which adds cognitive and motor cost.",
    },
    {
      condition: { type: "noStructuralAnchor" },
      multiplier: 1.3,
      reason: "Without headings or landmarks, VoiceOver's rotor has nothing to jump to.",
    },
    {
      condition: { type: "focusTrap" },
      multiplier: 2.5,
      reason:
        "Focus traps are recoverable via two-finger scrub in VoiceOver, " +
        "but the gesture is not discoverable for novice users.",
    },
  ],
};
