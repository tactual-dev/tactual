import { describe, expect, it } from "vitest";
import { resolve } from "path";
import { pathToFileURL } from "url";
import { runAnalyzePages } from "./pipeline/analyze-pages.js";
import { runAnalyzeUrl } from "./pipeline/analyze-url.js";

const fixtureUrl = (path: string): string =>
  pathToFileURL(resolve(path)).href;

describe("0.4.0 corpus validation", { timeout: 120_000 }, () => {
  it("surfaces measured widget and form contract failures end-to-end", async () => {
    const { result } = await runAnalyzeUrl({
      url: fixtureUrl("fixtures/corpus-widget-contracts.html"),
      probe: true,
      probeMode: "deep",
      profileId: "generic-mobile-web-sr-v0",
      checkVisibility: false,
    });

    const penalties = result.findings.flatMap((finding) => finding.penalties);
    expect(penalties).toContain(
      "APG combobox pattern: ArrowDown does not open the popup. Keyboard users cannot enter the option list predictably.",
    );
    expect(penalties).toContain(
      "APG listbox pattern: ArrowDown does not move to another option.",
    );
    expect(penalties).toContain(
      "Disclosure pattern: pressing Enter does not toggle aria-expanded. Screen-reader users cannot tell whether the controlled content opened.",
    );
    expect(penalties).toContain(
      "Form error flow: validation error text is not associated with the invalid field.",
    );

    const measuredFindings = result.findings.filter((finding) =>
      finding.evidenceSummary && finding.evidenceSummary.measured > 0,
    );
    expect(measuredFindings.length).toBeGreaterThanOrEqual(4);
  });

  it("groups repeated navigation costs across a local page corpus", async () => {
    const result = await runAnalyzePages({
      urls: [
        fixtureUrl("fixtures/corpus-repeated-nav-a.html"),
        fixtureUrl("fixtures/corpus-repeated-nav-b.html"),
        fixtureUrl("fixtures/corpus-repeated-nav-c.html"),
      ],
      profileId: "generic-mobile-web-sr-v0",
      timeout: 10_000,
    });

    const repeated = result.site.repeatedNavigation;
    expect(repeated?.repeatedTargets).toBeGreaterThanOrEqual(3);
    expect(repeated?.totalOccurrences).toBeGreaterThanOrEqual(9);
    expect(repeated?.worstGroups.some((group) =>
      group.label === "Documentation" && group.pageCount === 3,
    )).toBe(true);
    expect(repeated?.worstGroups.some((group) =>
      group.label === "Open command palette" && group.pageCount === 3,
    )).toBe(true);
  });
});
