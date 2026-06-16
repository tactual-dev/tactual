import { describe, it, expect, afterEach } from "vitest";
import { execSync } from "child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { resolve } from "path";
import { pathToFileURL } from "url";

/**
 * CLI integration tests.
 *
 * These test the compiled CLI entrypoint via child_process.execSync,
 * verifying exit codes, stdout/stderr output, and config file creation.
 * Browser-heavy command behavior is mostly covered by e2e integration tests.
 * This file keeps one cheap local-file smoke test for process lifecycle:
 * one-shot CLI analysis must close its browser and exit.
 */

const CLI = resolve(__dirname, "../../dist/cli/index.js");

const exec = (
  args: string,
  expectFail = false,
  // 25 s default absorbs the cold-start + Tactual-import time when the OS
  // scheduler is busy with other workers' Chromium processes; raised from
  // 10 s after parallel-load timeouts on multi-core test runs.
  timeout = 25_000,
): { stdout: string; stderr: string; exitCode: number } => {
  try {
    const stdout = execSync(`node ${CLI} ${args}`, {
      encoding: "utf-8",
      timeout,
      env: { ...process.env, NODE_NO_WARNINGS: "1" },
    });
    return { stdout, stderr: "", exitCode: 0 };
  } catch (err: unknown) {
    const e = err as { stdout?: string; stderr?: string; status?: number };
    if (!expectFail) throw err;
    return {
      stdout: e.stdout ?? "",
      stderr: e.stderr ?? "",
      exitCode: e.status ?? 1,
    };
  }
};

describe("CLI", { timeout: 30_000 }, () => {
  describe("help and version", () => {
    it("shows help text with --help", () => {
      const { stdout } = exec("--help");
      expect(stdout).toContain("tactual");
      expect(stdout).toContain("Screen-reader navigation cost analyzer");
      expect(stdout).toContain("analyze-url");
      expect(stdout).toContain("profiles");
      expect(stdout).toContain("diff");
      expect(stdout).toContain("init");
      expect(stdout).toContain("benchmark");
      expect(stdout).toContain("calibration-report");
    });

    it("shows version with --version", () => {
      const { stdout } = exec("--version");
      expect(stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
    });
  });

  describe("profiles command", () => {
    it("lists available profiles", () => {
      const { stdout } = exec("profiles");
      expect(stdout).toContain("Available profiles:");
      expect(stdout).toContain("generic-mobile-web-sr-v0");
      expect(stdout).toContain("nvda-desktop-v0");
      expect(stdout).toContain("jaws-desktop-v0");
      expect(stdout).toContain("voiceover-ios-v0");
      expect(stdout).toContain("talkback-android-v0");
    });
  });

  describe("analyze-url command", () => {
    it("shows help for analyze-url", () => {
      const { stdout } = exec("analyze-url --help");
      expect(stdout).toContain("Analyze a single URL");
      expect(stdout).toContain("--profile");
      expect(stdout).toContain("--format");
      expect(stdout).toContain("--full-json");
      expect(stdout).toContain("--explore");
      expect(stdout).toContain("--explore-timeout");
      expect(stdout).toContain("--threshold");
      expect(stdout).toContain("--exclude");
      expect(stdout).toContain("--focus");
      expect(stdout).toContain("--min-severity");
      expect(stdout).toContain("--explore-max-targets");
    });

    it("rejects missing URL argument", () => {
      const { stderr, exitCode } = exec("analyze-url", true);
      expect(exitCode).not.toBe(0);
      expect(stderr).toContain("missing required argument");
    });

    it("exposes --probe-mode, --probe-budget flags in help", () => {
      // Both probe-depth controls are public CLI options and must stay documented.
      const { stdout } = exec("analyze-url --help");
      expect(stdout).toContain("--probe-mode");
      expect(stdout).toContain("--probe-budget");
      // Canonical mode names appear in the help description
      expect(stdout).toContain("fast");
      expect(stdout).toContain("standard");
      expect(stdout).toContain("deep");
    });

    it("exposes goal-directed probe controls in help", () => {
      const { stdout } = exec("analyze-url --help");
      expect(stdout).toContain("--scope-selector");
      expect(stdout).toContain("--probe-selector");
      expect(stdout).toContain("--entry-selector");
      expect(stdout).toContain("--goal-target");
      expect(stdout).toContain("--goal-pattern");
      expect(stdout).toContain("--probe-strategy");
      expect(stdout).toContain("modal-return-focus");
    });

    it("exposes --stealth, --channel, --user-agent for bot-protected sites", () => {
      const { stdout } = exec("analyze-url --help");
      expect(stdout).toContain("--stealth");
      expect(stdout).toContain("--channel");
      expect(stdout).toContain("--user-agent");
    });

    it("exposes --validate and related flags", () => {
      const { stdout } = exec("analyze-url --help");
      expect(stdout).toContain("--validate");
      expect(stdout).toContain("--validate-max-targets");
      expect(stdout).toContain("--validate-strategy");
    });

    it("exposes --baseline and --fail-on-regression for CI gating", () => {
      const { stdout } = exec("analyze-url --help");
      expect(stdout).toContain("--baseline");
      expect(stdout).toContain("--fail-on-regression");
    });

    // Note: behavioral testing of --fail-on-regression (exit code on
    // regression detection) requires a live browser + two JSON files to
    // diff, so it is covered outside these command-surface tests.

    it("closes the browser and exits after a local-file analysis", () => {
      const fixtureUrl = pathToFileURL(resolve(__dirname, "../../fixtures/good-page.html")).href;
      const { stdout, exitCode } = exec(
        `analyze-url "${fixtureUrl}" --format json --summary-only --no-check-visibility`,
        false,
        30_000,
      );
      const parsed = JSON.parse(stdout) as { stats: { targetCount: number } };
      expect(exitCode).toBe(0);
      expect(parsed.stats.targetCount).toBeGreaterThan(0);
    }, 35_000);

    it("can emit a full analysis JSON result for calibration consumers", () => {
      const fixtureUrl = pathToFileURL(resolve(__dirname, "../../fixtures/good-page.html")).href;
      const { stdout, exitCode } = exec(
        `analyze-url "${fixtureUrl}" --format json --full-json --no-check-visibility`,
        false,
        30_000,
      );
      const parsed = JSON.parse(stdout) as { states?: unknown[]; metadata?: { targetCount: number } };
      expect(exitCode).toBe(0);
      expect(Array.isArray(parsed.states)).toBe(true);
      expect(parsed.metadata?.targetCount).toBeGreaterThan(0);
    }, 35_000);
  });

  describe("validate command", () => {
    it("shows help with flag surface", () => {
      const { stdout } = exec("validate --help");
      expect(stdout).toContain("Validate Tactual's predicted paths");
      expect(stdout).toContain("--max-targets");
      expect(stdout).toContain("--strategy");
      expect(stdout).toContain("--channel");
      expect(stdout).toContain("--stealth");
    });

    it("rejects missing URL argument", () => {
      const { exitCode } = exec("validate", true);
      expect(exitCode).not.toBe(0);
    });
  });

  describe("observe-announcement command", () => {
    const observeDir = resolve(__dirname, "../../__test_tactual_observe");
    const analysisPath = resolve(observeDir, "analysis.json");

    afterEach(() => {
      if (existsSync(observeDir)) rmSync(observeDir, { recursive: true, force: true });
    });

    it("shows help with observation flags", () => {
      const { stdout } = exec("observe-announcement --help");
      expect(stdout).toContain("Compare Tactual's modeled screen-reader announcement");
      expect(stdout).toContain("--analysis");
      expect(stdout).toContain("--observed");
      expect(stdout).toContain("--observed-token");
      expect(stdout).toContain("--source");
      expect(stdout).toContain("nvda-vm");
    });

    it("emits announcement observation JSON from a saved analysis", () => {
      mkdirSync(observeDir, { recursive: true });
      writeFileSync(
        analysisPath,
        JSON.stringify({
          flow: {
            id: "flow",
            name: "https://example.test/checkout",
            states: ["initial"],
            profile: "nvda-desktop-v0",
            timestamp: Date.now(),
          },
          states: [
            {
              id: "initial",
              url: "https://example.test/checkout",
              route: "/checkout",
              snapshotHash: "a",
              interactiveHash: "b",
              openOverlays: [],
              targets: [
                {
                  id: "button-1",
                  kind: "button",
                  role: "button",
                  name: "Checkout",
                  selector: "button",
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

      const { stdout } = exec(
        `observe-announcement Checkout --analysis "${analysisPath}" --observed "Checkout, link" --source nvda-vm --format json`,
      );
      const parsed = JSON.parse(stdout) as {
        modeledAnnouncement: string;
        observedAnnouncement: string;
        announcementMatch: boolean;
        missingAnnouncementTokens: string[];
        announcementAssumptions: Array<{ id: string; status: string; expected: string }>;
        observation: { observedAnnouncement: string; announcementSource: string };
      };
      expect(parsed.modeledAnnouncement).toBe("Checkout, button");
      expect(parsed.observedAnnouncement).toBe("Checkout, link");
      expect(parsed.announcementMatch).toBe(false);
      expect(parsed.missingAnnouncementTokens).toEqual(["button"]);
      expect(parsed.announcementAssumptions).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: "announcement.nvda.name.accessible-name",
            status: "confirmed",
            expected: "checkout",
          }),
          expect.objectContaining({
            id: "announcement.nvda.role.button",
            status: "missing",
            expected: "button",
          }),
        ]),
      );
      expect(parsed.observation).toMatchObject({
        observedAnnouncement: "Checkout, link",
        announcementSource: "nvda-vm",
      });
    });

    it("matches observed announcement text with name punctuation separators", () => {
      mkdirSync(observeDir, { recursive: true });
      writeFileSync(
        analysisPath,
        JSON.stringify({
          flow: {
            id: "flow",
            name: "https://example.test/search",
            states: ["initial"],
            profile: "nvda-desktop-v0",
            timestamp: Date.now(),
          },
          states: [
            {
              id: "initial",
              url: "https://example.test/search",
              route: "/search",
              snapshotHash: "a",
              interactiveHash: "b",
              openOverlays: [],
              targets: [
                {
                  id: "searchbox-1",
                  kind: "formField",
                  role: "searchbox",
                  name: "Search:",
                  selector: "input[type=search]",
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

      const { stdout } = exec(
        `observe-announcement "Search:" --analysis "${analysisPath}" --observed "Search: edit blank" --source fixture --format json`,
      );
      const parsed = JSON.parse(stdout) as {
        modeledAnnouncement: string;
        announcementMatch: boolean;
        missingAnnouncementTokens: string[];
      };
      expect(parsed.modeledAnnouncement).toBe("Search:, edit");
      expect(parsed.announcementMatch).toBe(true);
      expect(parsed.missingAnnouncementTokens).toEqual([]);
    });
  });

  describe("calibration-report command", () => {
    const calibrationDir = resolve(__dirname, "../../__test_tactual_calibration_report");
    const datasetPath = resolve(calibrationDir, "dataset.json");
    const analysisPath = resolve(calibrationDir, "analysis.json");

    afterEach(() => {
      if (existsSync(calibrationDir)) rmSync(calibrationDir, { recursive: true, force: true });
    });

    it("shows help with calibration inputs", () => {
      const { stdout } = exec("calibration-report --help");
      expect(stdout).toContain("Run a calibration dataset");
      expect(stdout).toContain("--analysis");
      expect(stdout).toContain("--analysis-dir");
      expect(stdout).toContain("--format");
      expect(stdout).toContain("emit scoring");
      expect(stdout).toContain("signals");
    });

    it("emits structured scoring signals from a dataset and saved analysis", () => {
      writeCalibrationFixture();

      const { stdout, exitCode } = exec(
        `calibration-report "${datasetPath}" --analysis "${analysisPath}" --format json`,
      );
      const parsed = JSON.parse(stdout) as {
        datasetName: string;
        observationCount: number;
        scoringSignals: Array<{ id: string; status: string }>;
      };

      expect(exitCode).toBe(0);
      expect(parsed.datasetName).toBe("cli-calibration");
      expect(parsed.observationCount).toBe(1);
      expect(parsed.scoringSignals).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: "navigation.strategy-switch-pressure" }),
          expect.objectContaining({ id: "score.overall-bias", status: "review" }),
        ]),
      );
    });

    it("emits the human calibration report by default", () => {
      writeCalibrationFixture();

      const { stdout } = exec(`calibration-report "${datasetPath}" --analysis-dir "${calibrationDir}"`);

      expect(stdout).toContain("# Calibration Report: cli-calibration");
      expect(stdout).toContain("## Scoring Signals");
      expect(stdout).toContain("navigation.strategy-switch-pressure");
    });

    it("rejects datasets without matching analysis URLs by default", () => {
      writeCalibrationFixture({ datasetUrl: "https://example.test/missing" });

      const { stderr, exitCode } = exec(
        `calibration-report "${datasetPath}" --analysis "${analysisPath}"`,
        true,
      );

      expect(exitCode).not.toBe(0);
      expect(stderr).toContain("Missing analysis JSON");
      expect(stderr).toContain("https://example.test/missing");
    });

    function writeCalibrationFixture(opts: { datasetUrl?: string } = {}): void {
      const url = opts.datasetUrl ?? "https://example.test/checkout";
      mkdirSync(calibrationDir, { recursive: true });
      writeFileSync(
        datasetPath,
        JSON.stringify({
          name: "cli-calibration",
          collectedAt: "2026-06-13T00:00:00Z",
          observations: [
            {
              url,
              profileId: "nvda-desktop-v0",
              targetId: "initial:checkout",
              targetName: "Checkout",
              observedAnnouncement: "Checkout, button",
              announcementSource: "fixture",
              actualStepsToReach: 9,
              strategyUsed: "mixed",
              requiredStrategySwitch: true,
              knewTargetExisted: true,
              timeToDiscoverSeconds: 8,
              discoveryMethod: "linear-scan",
              couldOperate: true,
              couldRecover: true,
              difficultyRating: 4,
              testerId: "cli-test",
              timestamp: "2026-06-13T00:01:00Z",
            },
          ],
        }),
      );
      writeFileSync(
        analysisPath,
        JSON.stringify({
          flow: {
            id: "flow",
            name: "https://example.test/checkout",
            states: ["initial"],
            profile: "nvda-desktop-v0",
            timestamp: Date.now(),
          },
          states: [
            {
              id: "initial",
              url: "https://example.test/checkout",
              route: "/checkout",
              snapshotHash: "a",
              interactiveHash: "b",
              openOverlays: [],
              targets: [
                {
                  id: "checkout",
                  kind: "button",
                  role: "button",
                  name: "Checkout",
                  selector: "button",
                },
              ],
              timestamp: Date.now(),
              provenance: "scripted",
            },
          ],
          findings: [
            {
              targetId: "initial:checkout",
              profile: "nvda-desktop-v0",
              scores: {
                discoverability: 96,
                reachability: 94,
                operability: 92,
                recovery: 90,
                interopRisk: 88,
                overall: 95,
              },
              severity: "strong",
              bestPath: ["initial", "initial:checkout"],
              alternatePaths: [],
              penalties: [],
              suggestedFixes: [],
              confidence: 0.9,
            },
          ],
          diagnostics: [],
          metadata: {
            version: "0.0.0-test",
            profile: "nvda-desktop-v0",
            duration: 1,
            stateCount: 1,
            targetCount: 1,
            findingCount: 1,
            edgeCount: 1,
          },
        }),
      );
    }
  });

  describe("diff command", () => {
    const diffDir = resolve(__dirname, "../../__test_tactual_diff");
    const baselinePath = resolve(diffDir, "baseline.json");
    const candidatePath = resolve(diffDir, "candidate.json");

    afterEach(() => {
      if (existsSync(diffDir)) rmSync(diffDir, { recursive: true, force: true });
    });

    it("shows help for diff", () => {
      const { stdout } = exec("diff --help");
      expect(stdout).toContain("Compare two analysis results");
      expect(stdout).toContain("baseline");
      expect(stdout).toContain("candidate");
    });

    it("exits non-zero for missing files", () => {
      const { exitCode } = exec("diff nonexistent-a.json nonexistent-b.json", true);
      expect(exitCode).not.toBe(0);
    });

    it("honors --format json", () => {
      mkdirSync(diffDir, { recursive: true });
      writeFileSync(
        baselinePath,
        JSON.stringify({
          findings: [
            {
              targetId: "button:checkout",
              scores: { overall: 50 },
              severity: "high",
              penalties: ["Hard to reach"],
            },
          ],
        }),
      );
      writeFileSync(
        candidatePath,
        JSON.stringify({
          findings: [
            {
              targetId: "button:checkout",
              scores: { overall: 82 },
              severity: "acceptable",
              penalties: [],
            },
          ],
        }),
      );

      const { stdout } = exec(`diff-results "${baselinePath}" "${candidatePath}" --format json`);
      const parsed = JSON.parse(stdout) as {
        summary: { improved: number; regressed: number; unchanged: number; total: number };
        changes: Array<{ targetId: string; delta: number; status: string; penaltiesResolved: string[] }>;
      };
      expect(parsed.summary).toEqual({ improved: 1, regressed: 0, unchanged: 0, total: 1 });
      expect(parsed.changes[0]).toMatchObject({
        targetId: "button:checkout",
        delta: 32,
        status: "improved",
        penaltiesResolved: ["Hard to reach"],
      });
    });
  });

  describe("init command", () => {
    const configPath = resolve(__dirname, "../../__test_tactual_init.json");

    afterEach(() => {
      if (existsSync(configPath)) rmSync(configPath);
    });

    it("shows help for init", () => {
      const { stdout } = exec("init --help");
      expect(stdout).toContain("Create a tactual.json config file");
    });
  });

  describe("benchmark command", () => {
    it("shows help for benchmark", () => {
      const { stdout } = exec("benchmark --help");
      expect(stdout).toContain("Run benchmark suite");
      expect(stdout).toContain("--suite");
      expect(stdout).toContain("stress-fixtures");
      expect(stdout).toContain("all");
    });
  });

  describe("trace-path command", () => {
    it("shows help for trace-path", () => {
      const { stdout } = exec("trace-path --help");
      expect(stdout).toContain("Trace the step-by-step");
      expect(stdout).toContain("<url>");
      expect(stdout).toContain("<target>");
      expect(stdout).toContain("--profile");
      expect(stdout).toContain("--explore");
      expect(stdout).toContain("--wait-for-selector");
    });

    it("rejects missing arguments", () => {
      const { exitCode } = exec("trace-path", true);
      expect(exitCode).not.toBe(0);
    });
  });

  describe("save-auth command", () => {
    it("shows help for save-auth", () => {
      const { stdout } = exec("save-auth --help");
      expect(stdout).toContain("Authenticate with a web app");
      expect(stdout).toContain("--click");
      expect(stdout).toContain("--fill");
      expect(stdout).toContain("--wait-for-url");
      expect(stdout).toContain("--output");
    });

    it("rejects missing URL argument", () => {
      const { exitCode } = exec("save-auth", true);
      expect(exitCode).not.toBe(0);
    });
  });

  describe("analyze-pages command", () => {
    it("shows help for analyze-pages", () => {
      const { stdout } = exec("analyze-pages --help");
      expect(stdout).toContain("Analyze multiple pages");
      expect(stdout).toContain("<urls...>");
      expect(stdout).toContain("--profile");
      expect(stdout).toContain("--storage-state");
      expect(stdout).toContain("--wait-for-selector");
    });

    it("rejects missing URLs argument", () => {
      const { exitCode } = exec("analyze-pages", true);
      expect(exitCode).not.toBe(0);
    });
  });

  describe("suggest-remediations command", () => {
    it("shows help for suggest-remediations", () => {
      const { stdout } = exec("suggest-remediations --help");
      expect(stdout).toContain("remediation suggestions");
      expect(stdout).toContain("<file>");
      expect(stdout).toContain("--max");
    });

    it("exits non-zero for missing file", () => {
      const { exitCode } = exec("suggest-remediations nonexistent.json", true);
      expect(exitCode).not.toBe(0);
    });
  });

  describe("analyze-url new flags", () => {
    it("help shows new flags", () => {
      const { stdout } = exec("analyze-url --help");
      expect(stdout).toContain("--wait-for-selector");
      expect(stdout).toContain("--wait-time");
      expect(stdout).toContain("--storage-state");
      expect(stdout).toContain("--summary-only");
      expect(stdout).toContain("--full-json");
      expect(stdout).toContain("--probe");
    });
  });

  describe("help lists all commands", () => {
    it("shows all top-level commands", () => {
      const { stdout } = exec("--help");
      const expected = [
        "analyze-url",
        "analyze-pages",
        "trace-path",
        "save-auth",
        "suggest-remediations",
        "diff",
        "profiles",
        "presets",
        "init",
        "benchmark",
        "transcript",
        "validate",
        "observe-announcement",
        "calibration-report",
      ];
      for (const cmd of expected) expect(stdout).toContain(cmd);
    });
  });

  describe("unknown command", () => {
    it("shows error for unknown command", () => {
      const { stderr, exitCode } = exec("nonexistent-command", true);
      expect(exitCode).not.toBe(0);
      expect(stderr).toContain("unknown command");
    });
  });
});
