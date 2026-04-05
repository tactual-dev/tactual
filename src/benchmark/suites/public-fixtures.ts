import type { BenchmarkSuite } from "../types.js";

/**
 * Public fixtures benchmark suite.
 *
 * Uses local HTML fixtures and validates that:
 * - Well-structured pages score high
 * - Poorly structured pages score low
 * - Interactive pages with exploration find more targets
 * - Good pages consistently outperform bad pages
 */
export const publicFixturesSuite: BenchmarkSuite = {
  name: "Public Fixtures",
  description:
    "Validates scoring differentiation using local good/bad/interactive fixtures",

  cases: [
    {
      id: "good-page",
      name: "Well-structured page (good-page.html)",
      description:
        "Page with proper headings, landmarks, ARIA labels, and semantic HTML",
      source: { type: "file", path: "fixtures/good-page.html" },
      profile: "generic-mobile-web-sr-v0",
      assertions: [
        { type: "averageScoreInRange", min: 70, max: 100 },
        { type: "targetCountInRange", min: 10, max: 50 },
        { type: "hasTargetKinds", kinds: ["heading", "landmark", "link", "button", "formField"] },
        { type: "hasEdges" },
        {
          type: "minFindingsAtSeverity",
          severity: "acceptable",
          count: 10,
        },
        { type: "hasTargetWithName", pattern: "Featured Products" },
        { type: "hasTargetWithName", pattern: "Add to Cart" },
        { type: "hasTargetWithName", pattern: "Main Navigation" },
      ],
    },

    {
      id: "bad-page",
      name: "Poorly structured page (bad-page.html)",
      description:
        "Page with no headings, no landmarks, div-based buttons, no ARIA",
      source: { type: "file", path: "fixtures/bad-page.html" },
      profile: "generic-mobile-web-sr-v0",
      assertions: [
        { type: "averageScoreInRange", min: 30, max: 80 },
        { type: "targetCountInRange", min: 5, max: 30 },
        { type: "hasEdges" },
        // Bad page should have no headings or landmarks
        // (divs with class names don't produce semantic roles)
      ],
    },

    {
      id: "interactive-page",
      name: "Interactive page without exploration",
      description:
        "Page with menus, tabs, disclosures — analyzed without exploration",
      source: { type: "file", path: "fixtures/interactive-page.html" },
      profile: "generic-mobile-web-sr-v0",
      assertions: [
        { type: "averageScoreInRange", min: 60, max: 100 },
        { type: "hasTargetKinds", kinds: ["heading", "landmark", "link", "button", "tab"] },
        { type: "hasEdges" },
        { type: "hasTargetWithName", pattern: "Options Menu" },
        { type: "hasTargetWithName", pattern: "Description" },
      ],
    },

    {
      id: "interactive-page-explored",
      name: "Interactive page with exploration",
      description:
        "Same page analyzed with exploration — should find hidden targets",
      source: { type: "file", path: "fixtures/interactive-page.html" },
      profile: "generic-mobile-web-sr-v0",
      explore: true,
      assertions: [
        { type: "targetCountInRange", min: 20, max: 500 },
        { type: "hasEdges" },
      ],
    },
  ],

  comparisons: [
    {
      id: "good-vs-bad",
      name: "Good page scores higher than bad page",
      description:
        "Well-structured HTML with headings and landmarks should consistently " +
        "outperform div-soup with no semantic structure",
      better: "good-page",
      worse: "bad-page",
      minGap: 5,
    },

    {
      id: "explored-finds-more",
      name: "Exploration discovers more targets",
      description:
        "Running with --explore should find targets hidden behind menus, " +
        "tabs, and disclosures that static capture misses",
      better: "interactive-page-explored",
      worse: "interactive-page",
      compareBy: "targetCount",
      minGap: 10,
    },
  ],
};
