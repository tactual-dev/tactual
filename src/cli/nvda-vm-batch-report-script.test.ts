import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { resolve } from "path";

const script = resolve(__dirname, "../../scripts/nvda-vm-batch-report.mjs");
const outDir = resolve(__dirname, "../../__test_nvda_vm_batch_report");

describe("NVDA VM batch report script", () => {
  afterEach(() => {
    if (existsSync(outDir)) rmSync(outDir, { recursive: true, force: true });
  });

  it("shows help without requiring VirtualBox", () => {
    const stdout = execFileSync(process.execPath, [script, "--help"], {
      encoding: "utf-8",
      env: { ...process.env, NODE_NO_WARNINGS: "1" },
    });
    expect(stdout).toContain("NVDA VM calibration batch");
    expect(stdout).toContain("--batch");
  });

  it("turns batch artifacts into a review queue and markdown report", () => {
    const goodOut = resolve(outDir, "good-tab");
    const weakOut = resolve(outDir, "mapper-form-field");
    const silentOut = resolve(outDir, "silent-form-field");
    mkdirSync(goodOut, { recursive: true });
    mkdirSync(weakOut, { recursive: true });
    mkdirSync(silentOut, { recursive: true });
    mkdirSync(resolve(goodOut, "observer"), { recursive: true });

    writeFileSync(
      resolve(outDir, "batch-summary.json"),
      `\uFEFF${JSON.stringify(
        {
          schema: "tactual-nvda-vm-batch-calibration@1",
          results: [
            {
              name: "good-tab",
              fixture: "fixtures/good-page.html",
              mode: "tab",
              status: "passed",
              output: goodOut,
              plannedTargets: 2,
              matchedTargets: 2,
              missingTargets: 0,
              unmatchedSpeechBlocks: 1,
            },
            {
              name: "mapper-form-field",
              fixture: "fixtures/calibration-at-mapper-lab.html",
              mode: "form-field",
              status: "passed",
              output: weakOut,
              plannedTargets: 2,
              matchedTargets: 0,
              missingTargets: 2,
              unmatchedSpeechBlocks: 2,
            },
            {
              name: "silent-form-field",
              fixture: "fixtures/calibration-at-mapper-lab.html",
              mode: "form-field",
              status: "harness-blocked",
              output: silentOut,
              plannedTargets: 2,
              parsedSpeechBlocks: 0,
              matchedTargets: 0,
              missingTargets: 2,
              unmatchedSpeechBlocks: 0,
              harnessIssue: "no NVDA speech parsed after keyboard input",
            },
          ],
        },
        null,
        2,
      )}`,
    );
    writeFileSync(
      resolve(goodOut, "sequence-alignment.json"),
      JSON.stringify({
        summary: {
          plannedTargets: 2,
          matchedTargets: 2,
          missingTargets: 0,
          parsedSpeechBlocks: 3,
          unmatchedSpeechBlocks: 1,
        },
        missingTargets: [],
        unmatchedBlocks: [
          {
            line: 10,
            announcement: "Good Accessibility Example window",
            tokens: ["Good Accessibility Example window"],
          },
        ],
      }),
    );
    writeFileSync(
      resolve(goodOut, "observer", "observation-payloads.json"),
      JSON.stringify([
        {
          target: { name: "Search", role: "searchbox" },
          observation: { targetId: "state:search" },
          modeledAnnouncement: "Search, edit",
          observedAnnouncement: "form, Search, edit, orders",
          announcementMatch: true,
          missingAnnouncementTokens: [],
          unexpectedAnnouncementTokens: [],
        },
      ]),
    );
    writeFileSync(
      resolve(weakOut, "host-calibration-summary.json"),
      JSON.stringify({
        matchRatio: 0,
        ingestionSkipped: true,
        ingestionSkipReason: "match ratio 0 below minimum 0.5",
      }),
    );
    writeFileSync(
      resolve(weakOut, "analysis.full.json"),
      JSON.stringify({
        states: [
          {
            id: "initial",
            targets: [
              {
                id: "target-textbox-1",
                name: "Email address",
                role: "textbox",
                kind: "formField",
              },
            ],
          },
        ],
      }),
    );
    writeFileSync(
      resolve(weakOut, "sequence-alignment.json"),
      JSON.stringify({
        summary: {
          plannedTargets: 2,
          matchedTargets: 0,
          missingTargets: 2,
          parsedSpeechBlocks: 2,
          unmatchedSpeechBlocks: 2,
        },
        missingTargets: [
          {
            target: {
              stateId: "initial",
              id: "target-searchbox-1",
              name: "Site search",
              role: "searchbox",
              kind: "formField",
            },
            expectedTokens: ["site search", "edit"],
          },
          {
            target: {
              stateId: "initial",
              id: "target-textbox-1",
              name: "Email address",
              role: "textbox",
              kind: "formField",
            },
            expectedTokens: ["email address", "edit"],
          },
        ],
        unmatchedBlocks: [
          {
            line: 15,
            announcement: "No next form field",
            tokens: ["No next form field"],
          },
          {
            line: 16,
            announcement: "Email address, edit, invalid entry",
            tokens: ["Email address", "edit", "invalid entry"],
          },
        ],
      }),
    );
    writeFileSync(
      resolve(silentOut, "host-calibration-summary.json"),
      JSON.stringify({
        matchRatio: 0,
        ingestionSkipped: true,
        ingestionSkipReason: "NVDA logged keyboard gestures after the run offset but emitted no speech blocks.",
        harnessIssue: "input-received-no-speech",
        harnessIssueDetail: "NVDA logged keyboard gestures after the run offset but emitted no speech blocks.",
      }),
    );
    writeFileSync(
      resolve(silentOut, "sequence-alignment.json"),
      JSON.stringify({
        summary: {
          plannedTargets: 2,
          matchedTargets: 0,
          missingTargets: 2,
          parsedSpeechBlocks: 0,
          unmatchedSpeechBlocks: 0,
        },
        missingTargets: [
          {
            target: {
              stateId: "initial",
              id: "target-checkbox-1",
              name: "Daily summary",
              role: "checkbox",
              kind: "formField",
            },
            expectedTokens: ["daily summary", "check box", "checked"],
          },
        ],
        unmatchedBlocks: [],
      }),
    );

    const stdout = execFileSync(process.execPath, [script, "--batch", outDir], {
      encoding: "utf-8",
      env: { ...process.env, NODE_NO_WARNINGS: "1" },
    });
    const queue = JSON.parse(readFileSync(resolve(outDir, "review-queue.json"), "utf-8")) as {
      totals: { cases: number; weak: number; harnessBlocked: number; missingTargets: number };
      groups: {
        missingByModeRole: Array<{ role: string; count: number }>;
        unmatchedContentByMode: Array<{ count: number }>;
        unmatchedNoiseByMode: Array<{ count: number }>;
        unmatchedNegativeQuickNavByMode: Array<{ count: number }>;
        unmatchedTargetSpeech: Array<{ role: string; phase: string; count: number }>;
        extraObservedAnnouncementTokens: Array<{ token: string; count: number }>;
        extraObservedContextTokens: Array<{ token: string; count: number }>;
        extraObservedTargetNameTokens: Array<{ token: string; count: number }>;
        extraObservedValueTokens: Array<{ token: string; count: number }>;
      };
      scoringSignals: Array<{
        id: string;
        kind: string;
        dimension: string;
        status: string;
        confidence: number;
        summary: string;
        scoringImplication: string;
      }>;
    };
    const markdown = readFileSync(resolve(outDir, "batch-report.md"), "utf-8");

    expect(stdout).toContain("Batch report:");
    expect(queue.totals).toMatchObject({ cases: 3, weak: 1, harnessBlocked: 1, missingTargets: 4 });
    expect(queue.groups.missingByModeRole).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ role: "searchbox", count: 1 }),
        expect.objectContaining({ role: "textbox", count: 1 }),
      ]),
    );
    expect(queue.groups.missingByModeRole).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ role: "checkbox" })]),
    );
    expect(queue.groups.unmatchedContentByMode[0]).toMatchObject({ count: 1 });
    expect(queue.groups.unmatchedNoiseByMode[0]).toMatchObject({ count: 1 });
    expect(queue.groups.unmatchedNegativeQuickNavByMode[0]).toMatchObject({ count: 1 });
    expect(queue.groups.unmatchedTargetSpeech).toEqual(
      expect.arrayContaining([expect.objectContaining({ role: "textbox", phase: "no-matches", count: 1 })]),
    );
    expect(queue.groups.extraObservedAnnouncementTokens).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ token: "form", count: 1 }),
        expect.objectContaining({ token: "orders", count: 1 }),
      ]),
    );
    expect(queue.groups.extraObservedContextTokens).toEqual(
      expect.arrayContaining([expect.objectContaining({ token: "form", count: 1 })]),
    );
    expect(queue.groups.extraObservedValueTokens).toEqual(
      expect.arrayContaining([expect.objectContaining({ token: "orders", count: 1 })]),
    );
    expect(queue.scoringSignals).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "harness-health.blocked", status: "blocked" }),
        expect.objectContaining({ id: "reachability.quick-nav.observed-match", status: "review" }),
        expect.objectContaining({ id: "speech.context-verbosity", dimension: "reachability" }),
        expect.objectContaining({ id: "speech.target-name-coalescing", dimension: "discoverability" }),
        expect.objectContaining({ id: "speech.observed-values", status: "observed-only" }),
      ]),
    );
    expect(markdown).toContain("Harness Blockers");
    expect(markdown).toContain("Scoring Signals");
    expect(markdown).toContain("reachability.quick-nav.observed-match");
    expect(markdown).toContain("input-received-no-speech");
    expect(markdown).toContain("Unmatched Speech Referencing Captured Targets");
    expect(markdown).toContain("Extra Observed Context Tokens");
    expect(markdown).toContain("Extra Observed Value Tokens");
    expect(markdown).toContain("mapper-form-field");
  });
});
