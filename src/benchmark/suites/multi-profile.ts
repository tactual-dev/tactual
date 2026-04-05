import type { BenchmarkSuite } from "../types.js";

/**
 * Multi-profile benchmark suite.
 *
 * Runs the same well-structured fixture through all 5 AT profiles
 * to verify cross-profile consistency. Every profile should produce
 * a passing analysis without errors.
 */
export const multiProfileSuite: BenchmarkSuite = {
  name: "Multi-Profile",
  description:
    "Validates that good-page.html scores well across all 5 AT profiles",

  cases: [
    {
      id: "good-page-generic-mobile",
      name: "good-page.html with generic-mobile-web-sr-v0",
      description: "Generic mobile screen reader profile",
      source: { type: "file", path: "fixtures/good-page.html" },
      profile: "generic-mobile-web-sr-v0",
      assertions: [
        { type: "averageScoreInRange", min: 65, max: 100 },
        { type: "hasEdges" },
      ],
    },

    {
      id: "good-page-nvda",
      name: "good-page.html with nvda-desktop-v0",
      description: "NVDA desktop screen reader profile",
      source: { type: "file", path: "fixtures/good-page.html" },
      profile: "nvda-desktop-v0",
      assertions: [
        { type: "averageScoreInRange", min: 65, max: 100 },
        { type: "hasEdges" },
      ],
    },

    {
      id: "good-page-jaws",
      name: "good-page.html with jaws-desktop-v0",
      description: "JAWS desktop screen reader profile",
      source: { type: "file", path: "fixtures/good-page.html" },
      profile: "jaws-desktop-v0",
      assertions: [
        { type: "averageScoreInRange", min: 65, max: 100 },
        { type: "hasEdges" },
      ],
    },

    {
      id: "good-page-voiceover",
      name: "good-page.html with voiceover-ios-v0",
      description: "VoiceOver iOS screen reader profile",
      source: { type: "file", path: "fixtures/good-page.html" },
      profile: "voiceover-ios-v0",
      assertions: [
        { type: "averageScoreInRange", min: 65, max: 100 },
        { type: "hasEdges" },
      ],
    },

    {
      id: "good-page-talkback",
      name: "good-page.html with talkback-android-v0",
      description: "TalkBack Android screen reader profile",
      source: { type: "file", path: "fixtures/good-page.html" },
      profile: "talkback-android-v0",
      assertions: [
        { type: "averageScoreInRange", min: 65, max: 100 },
        { type: "hasEdges" },
      ],
    },
  ],

  comparisons: [],
};
