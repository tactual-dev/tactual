import { describe, it, expect, afterEach } from "vitest";
import { execSync } from "child_process";
import { existsSync, rmSync } from "fs";
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
  timeout = 10_000,
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

describe("CLI", { timeout: 15_000 }, () => {
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

  describe("diff command", () => {
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
