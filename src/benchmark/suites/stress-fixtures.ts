import type { BenchmarkSuite } from "../types.js";
import { fixturePath } from "../fixture-path.js";

/**
 * Stress fixtures benchmark suite.
 *
 * Uses adversarial HTML fixtures to validate that the analyzer handles:
 * - Very large pages with many targets
 * - Deeply nested DOM structures
 * - Pages with minimal semantic structure
 * - Special characters in content and attributes
 * - Dialog/modal-heavy pages
 */
export const stressFixturesSuite: BenchmarkSuite = {
  name: "Stress Fixtures",
  description:
    "Validates analyzer robustness against adversarial and edge-case HTML fixtures",

  cases: [
    {
      id: "stress-large-page",
      name: "Large page with many targets (stress-large-page.html)",
      description:
        "Page with a high volume of headings, landmarks, links, buttons, and form fields",
      source: { type: "file", path: fixturePath("stress-large-page.html") },
      profile: "generic-mobile-web-sr-v0",
      assertions: [
        { type: "targetCountInRange", min: 100, max: 500 },
        { type: "hasEdges" },
        { type: "averageScoreInRange", min: 50, max: 100 },
        {
          type: "hasTargetKinds",
          kinds: ["heading", "landmark", "link", "button", "formField"],
        },
      ],
    },

    {
      id: "stress-deep-nesting",
      name: "Deeply nested DOM (stress-deep-nesting.html)",
      description:
        "Page with extremely deep element nesting to stress tree traversal",
      source: { type: "file", path: fixturePath("stress-deep-nesting.html") },
      profile: "generic-mobile-web-sr-v0",
      assertions: [
        { type: "targetCountInRange", min: 20, max: 300 },
        { type: "hasEdges" },
        { type: "averageScoreInRange", min: 40, max: 100 },
      ],
    },

    {
      id: "stress-minimal-structure",
      name: "Minimal semantic structure (stress-minimal-structure.html)",
      description:
        "Page with almost no semantic HTML — should produce few or zero targets",
      source: { type: "file", path: fixturePath("stress-minimal-structure.html") },
      profile: "generic-mobile-web-sr-v0",
      assertions: [
        // Zero targets is correct: divs without roles produce no ARIA nodes
        { type: "targetCountInRange", min: 0, max: 100 },
      ],
    },

    {
      id: "stress-special-chars",
      name: "Special characters in content (stress-special-chars.html)",
      description:
        "Page with unicode, RTL text, HTML entities, and emoji in names and labels",
      source: { type: "file", path: fixturePath("stress-special-chars.html") },
      profile: "generic-mobile-web-sr-v0",
      assertions: [
        { type: "targetCountInRange", min: 5, max: 50 },
        { type: "hasEdges" },
        { type: "averageScoreInRange", min: 50, max: 100 },
      ],
    },

    {
      id: "stress-dialogs",
      name: "Dialog-heavy page (stress-dialogs.html)",
      description:
        "Page with multiple dialogs, modals, and overlay patterns",
      source: { type: "file", path: fixturePath("stress-dialogs.html") },
      profile: "generic-mobile-web-sr-v0",
      assertions: [
        { type: "targetCountInRange", min: 10, max: 100 },
        { type: "hasEdges" },
        { type: "hasTargetKinds", kinds: ["heading", "button"] },
      ],
    },
  ],

  comparisons: [
    {
      id: "large-vs-minimal",
      name: "Large page has more targets than minimal structure",
      description:
        "A well-structured large page should discover far more targets " +
        "than a page with almost no semantic HTML",
      better: "stress-large-page",
      worse: "stress-minimal-structure",
      compareBy: "targetCount",
      minGap: 50,
    },
  ],
};
