import { describe, expect, it } from "vitest";
import { resolve } from "path";
import { pathToFileURL } from "url";
import { runAnalyzeUrl } from "./pipeline/analyze-url.js";
import { formatReport } from "./reporters/index.js";

const fixtureUrl = (path: string): string => pathToFileURL(resolve(path)).href;

describe("release report goldens", { timeout: 90_000 }, () => {
  it("keeps bad-page JSON, markdown, and SARIF outputs actionable and stable", async () => {
    const { result } = await runAnalyzeUrl({
      url: fixtureUrl("fixtures/bad-page.html"),
      profileId: "generic-mobile-web-sr-v0",
      probe: true,
      probeMode: "fast",
      checkVisibility: false,
    });

    const json = JSON.parse(formatReport(result, "json")) as {
      stats: { targetCount: number; averageScore: number; p10Score: number; worstScore: number };
      severityCounts: Record<string, number>;
      diagnostics: Array<{ code: string }>;
      issueGroups: Array<{ issue: string; count: number; fix: string }>;
      remediationCandidates: Array<{ title: string; primaryFix: string }>;
      worstFindings: Array<{ targetId: string; severity: string; suggestedFixes: string[] }>;
    };

    expect(json.stats).toMatchObject({
      targetCount: 12,
      averageScore: 53.9,
      p10Score: 44,
      worstScore: 43,
    });
    expect(json.severityCounts).toMatchObject({ high: 9, moderate: 3, strong: 0 });
    expect(json.diagnostics.map((d) => d.code)).toEqual([
      "no-landmarks",
      "no-headings",
      "no-skip-link",
      "shared-structural-issue",
    ]);
    expect(json.issueGroups[0]).toMatchObject({
      issue: "Page has no heading structure for screen-reader navigation",
      count: 12,
      fix: "Add heading hierarchy to organize page content",
    });
    expect(json.remediationCandidates[0].title).toContain(
      "Reduce repeated screen-reader navigation cost",
    );
    expect(json.worstFindings[0]).toMatchObject({
      targetId: "link:privacy",
      severity: "high",
    });

    const markdown = formatReport(result, "markdown");
    expect(markdown).toContain("# Tactual Analysis:");
    expect(markdown).toContain("## Diagnostics");
    expect(markdown).toContain("## Remediation Candidates");
    expect(markdown).toContain("Add heading hierarchy to organize page content");
    expect(markdown).toContain("link:privacy");

    const sarif = JSON.parse(formatReport(result, "sarif")) as {
      version: string;
      runs: Array<{
        results: Array<{ ruleId: string; message: { text: string }; properties: Record<string, unknown> }>;
        tool: { driver: { rules: unknown[] } };
      }>;
    };
    expect(sarif.version).toBe("2.1.0");
    expect(sarif.runs[0].results).toHaveLength(12);
    expect(sarif.runs[0].tool.driver.rules.length).toBeGreaterThan(0);
    expect(sarif.runs[0].results[0].ruleId).toBe("tactual/high");
    expect(sarif.runs[0].results[0].message.text).toContain("Score: 43/100");
    expect(sarif.runs[0].results[0].properties.evidenceSummary).toBeDefined();
  });

  it("keeps the good-page fixture free of spurious landmark name fixes", async () => {
    const { result } = await runAnalyzeUrl({
      url: fixtureUrl("fixtures/good-page.html"),
      profileId: "generic-mobile-web-sr-v0",
      probe: true,
      probeMode: "fast",
      checkVisibility: false,
    });
    const json = JSON.parse(formatReport(result, "json")) as {
      stats: { targetCount: number; averageScore: number; p10Score: number; worstScore: number };
      severityCounts: Record<string, number>;
      issueGroups: Array<{ issue: string; fix: string }>;
      remediationCandidates: unknown[];
    };

    expect(json.stats).toMatchObject({
      targetCount: 19,
      averageScore: 96.9,
      p10Score: 93,
      worstScore: 91,
    });
    expect(json.severityCounts).toMatchObject({
      severe: 0,
      high: 0,
      moderate: 0,
      acceptable: 0,
      strong: 19,
    });
    expect(json.issueGroups.some((group) => /accessible name/i.test(group.issue))).toBe(false);
    expect(json.remediationCandidates).toHaveLength(0);
  });
});
