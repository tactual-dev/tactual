import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { resolve } from "path";

const script = resolve(__dirname, "../../scripts/calibration-corpus.mjs");
const outDir = resolve(__dirname, "../../__test_calibration_corpus");
const batchDir = resolve(outDir, "batch");
const corpusDir = resolve(outDir, "corpus", "seed");

describe("calibration corpus script", () => {
  afterEach(() => {
    if (existsSync(outDir)) rmSync(outDir, { recursive: true, force: true });
  });

  it("shows help", () => {
    const stdout = execFileSync(process.execPath, [script, "--help"], {
      encoding: "utf-8",
      env: { ...process.env, NODE_NO_WARNINGS: "1" },
    });
    expect(stdout).toContain("Calibration corpus utility");
    expect(stdout).toContain("import-nvda-batch");
    expect(stdout).toContain("--derive-full-observations");
    expect(stdout).toContain("audit");
  });

  it("imports an NVDA batch into portable corpus form and audits coverage", () => {
    writeMiniBatch();

    const importOut = execFileSync(process.execPath, [
      script,
      "import-nvda-batch",
      "--batch",
      batchDir,
      "--out",
      corpusDir,
      "--label",
      "seeded-nvda",
      "--derive-full-observations",
    ], {
      encoding: "utf-8",
      env: { ...process.env, NODE_NO_WARNINGS: "1" },
    });

    expect(importOut).toContain("Announcement observations: 2");
    expect(importOut).toContain("Full observations: 1");
    const dataset = JSON.parse(readFileSync(resolve(corpusDir, "dataset.json"), "utf-8")) as {
      name: string;
      observations: Array<{
        url: string;
        targetName: string;
        actualStepsToReach: number;
        strategyUsed: string;
        observationSource: string;
      }>;
      announcementObservations: Array<{ url: string; targetName: string }>;
      corpusMetadata: { transientUrlsRewritten: boolean };
    };
    const analysis = JSON.parse(
      readFileSync(resolve(corpusDir, "analyses", "fixtures-mini.analysis.full.json"), "utf-8"),
    ) as { flow: { name: string }; states: Array<{ url: string }> };

    expect(dataset.name).toBe("seeded-nvda");
    expect(dataset.corpusMetadata.transientUrlsRewritten).toBe(true);
    expect(dataset.announcementObservations[0]).toMatchObject({
      url: "tactual-fixture://fixtures/mini.html",
      targetName: "Save",
    });
    expect(dataset.observations[0]).toMatchObject({
      url: "tactual-fixture://fixtures/mini.html",
      targetName: "Save",
      actualStepsToReach: 1,
      strategyUsed: "button",
      observationSource: "nvda-vm-scripted",
    });
    expect(existsSync(resolve(corpusDir, "evidence", "mini", "sequence-plan.json"))).toBe(true);
    const sequencePlan = JSON.parse(
      readFileSync(resolve(corpusDir, "evidence", "mini", "sequence-plan.json"), "utf-8"),
    ) as { url: string; analysisPath?: string };
    expect(sequencePlan.url).toBe("tactual-fixture://fixtures/mini.html");
    expect(sequencePlan.analysisPath).toBeUndefined();
    expect(existsSync(resolve(corpusDir, "evidence", "mini", "sequence-alignment.json"))).toBe(false);
    expect(existsSync(resolve(corpusDir, "evidence", "review-queue.json"))).toBe(false);
    expect(analysis.flow.name).toBe("tactual-fixture://fixtures/mini.html");
    expect(analysis.states[0].url).toBe("tactual-fixture://fixtures/mini.html");

    const auditJson = execFileSync(process.execPath, [
      script,
      "audit",
      "--root",
      resolve(outDir, "corpus"),
      "--format",
      "json",
      "--announcement-goal",
      "1",
      "--full-goal",
      "1",
    ], {
      encoding: "utf-8",
      env: { ...process.env, NODE_NO_WARNINGS: "1" },
    });
    const audit = JSON.parse(auditJson) as {
      totals: {
        corpora: number;
        fullObservations: number;
        scriptedFullObservations: number;
        manualFullObservations: number;
        announcementObservations: number;
      };
      readiness: {
        mapperConfidence: boolean;
        reachabilityTuning: boolean;
        subjectiveScoreTuning: boolean;
        mapper: boolean;
        scoreTuning: boolean;
      };
      profiles: Array<{
        profile: string;
        full: number;
        scriptedFull: number;
        manualFull: number;
        announcement: number;
      }>;
      repeatedTargets: Array<{ target: string; count: number; corpora: Record<string, number> }>;
      blockers: string[];
    };

    expect(audit.totals).toMatchObject({
      corpora: 1,
      fullObservations: 1,
      scriptedFullObservations: 1,
      manualFullObservations: 0,
      announcementObservations: 2,
    });
    expect(audit.readiness.mapperConfidence).toBe(true);
    expect(audit.readiness.reachabilityTuning).toBe(true);
    expect(audit.readiness.subjectiveScoreTuning).toBe(false);
    expect(audit.readiness.mapper).toBe(true);
    expect(audit.readiness.scoreTuning).toBe(false);
    expect(audit.profiles[0]).toMatchObject({
      profile: "nvda-desktop-v0",
      full: 1,
      scriptedFull: 1,
      manualFull: 0,
      announcement: 2,
    });
    expect(audit.repeatedTargets[0]).toMatchObject({
      target: "Save",
      count: 3,
      corpora: { seed: 3 },
    });
    expect(audit.blockers).toEqual(
      expect.arrayContaining([
        expect.stringContaining("manual full observations"),
      ]),
    );
  });
});

function writeMiniBatch(): void {
  const caseDir = resolve(batchDir, "mini-case");
  mkdirSync(caseDir, { recursive: true });
  writeFileSync(
    resolve(batchDir, "review-queue.json"),
    JSON.stringify({
      schema: "tactual-nvda-vm-batch-review@1",
      totals: {
        cases: 1,
        plannedTargets: 2,
        matchedTargets: 2,
      },
      cases: [
        {
          name: "mini",
          fixture: "fixtures/mini.html",
          mode: "button",
          status: "passed",
          output: caseDir,
          plannedTargets: 2,
          matchedTargets: 2,
          missingTargets: 0,
          unmatchedSpeechBlocks: 0,
          evidenceUsable: true,
          hostUrl: "http://127.0.0.1:1234/fixtures/mini.html",
          guestUrl: "http://10.0.2.2:1234/fixtures/mini.html",
        },
      ],
      scoringSignals: [
        {
          id: "reachability.quick-nav.observed-match",
          status: "confirmed",
          kind: "observed-reachability",
          dimension: "reachability",
          summary: "2/2 matched",
        },
      ],
    }),
  );
  writeFileSync(
    resolve(batchDir, "calibration.json"),
    JSON.stringify({
      name: "announcement-observations",
      collectedAt: "2026-06-13T00:00:00Z",
      observations: [],
      announcementObservations: [
        {
          url: "http://127.0.0.1:1234/fixtures/mini.html",
          profileId: "nvda-desktop-v0",
          targetName: "Save",
          targetId: "state-1:button:save",
          targetSelector: "getByRole('button', { name: 'Save' })",
          observedAnnouncement: "Save, button",
          announcementSource: "nvda-vm",
          atVersion: "NVDA 2026.1.1",
          browser: "Microsoft Edge (guest)",
          testerId: "vm-nvda",
          announcementNotes: "mode=button; matched=save|button",
          timestamp: "2026-06-13T00:00:01Z",
        },
        {
          url: "http://127.0.0.1:1234/fixtures/mini.html",
          profileId: "nvda-desktop-v0",
          targetName: "Save",
          targetId: "state-1:button:save",
          targetSelector: "getByRole('button', { name: 'Save' })",
          observedAnnouncement: "Save button",
          announcementSource: "nvda-vm",
          atVersion: "NVDA 2026.1.1",
          browser: "Microsoft Edge (guest)",
          testerId: "vm-nvda",
          announcementNotes: "mode=button; matched=save|button",
          timestamp: "2026-06-13T00:00:02Z",
        },
      ],
    }),
  );
  writeFileSync(resolve(batchDir, "batch-report.md"), "# Batch\n");
  writeFileSync(
    resolve(caseDir, "sequence-plan.json"),
    JSON.stringify({
      schema: "tactual-nvda-vm-sequence-plan@1",
      createdAt: "2026-06-13T00:00:00Z",
      url: "http://10.0.2.2:1234/fixtures/mini.html",
      profile: "nvda-desktop-v0",
      mode: "button",
      targets: [
        {
          index: 1,
          mode: "button",
          stateId: "state-1",
          id: "button:save",
          kind: "button",
          role: "button",
          name: "Save",
          selector: "getByRole('button', { name: 'Save' })",
          expectedAnnouncement: "Save, button",
          expectedTokens: ["save", "button"],
        },
      ],
    }),
  );
  writeFileSync(
    resolve(caseDir, "sequence-alignment.json"),
    JSON.stringify({
      schema: "tactual-nvda-vm-sequence-alignment@1",
      generatedAt: "2026-06-13T00:00:02Z",
      plan: {
        mode: "button",
        url: "http://10.0.2.2:1234/fixtures/mini.html",
        targetCount: 1,
      },
      matches: [
        {
          target: {
            index: 1,
            mode: "button",
            stateId: "state-1",
            id: "button:save",
            kind: "button",
            role: "button",
            name: "Save",
            selector: "getByRole('button', { name: 'Save' })",
            expectedAnnouncement: "Save, button",
            expectedTokens: ["save", "button"],
          },
          block: {
            index: 0,
            line: 12,
            timestamp: "00:00:02.000",
            tokens: ["Save", "button"],
            announcement: "Save, button",
          },
          matchedTokens: ["save", "button"],
          missingTokens: [],
          score: 2,
        },
      ],
      missingTargets: [],
      unmatchedBlocks: [],
    }),
  );
  writeFileSync(
    resolve(caseDir, "host-calibration-summary.json"),
    JSON.stringify({
      schema: "tactual-nvda-vm-host-calibration@1",
      mode: "button",
      stepCount: 1,
      matchedTargets: 1,
      plannedTargets: 1,
    }),
  );
  writeFileSync(
    resolve(caseDir, "analysis.full.json"),
    JSON.stringify({
      flow: {
        id: "flow",
        name: "http://127.0.0.1:1234/fixtures/mini.html",
        states: ["initial"],
        profile: "nvda-desktop-v0",
        timestamp: Date.now(),
      },
      states: [
        {
          id: "initial",
          url: "http://127.0.0.1:1234/fixtures/mini.html",
          route: "/fixtures/mini.html",
          snapshotHash: "a",
          interactiveHash: "b",
          openOverlays: [],
          targets: [
            {
              id: "save",
              kind: "button",
              role: "button",
              name: "Save",
            },
          ],
          timestamp: Date.now(),
          provenance: "scripted",
        },
      ],
      findings: [],
      diagnostics: [],
      metadata: {
        version: "0.0.0-test",
        profile: "nvda-desktop-v0",
        duration: 1,
        stateCount: 1,
        targetCount: 1,
        findingCount: 0,
        edgeCount: 0,
      },
    }),
  );
}
