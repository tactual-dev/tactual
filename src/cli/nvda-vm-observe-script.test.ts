import { describe, expect, it, afterEach } from "vitest";
import { execFileSync } from "child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { resolve } from "path";

const script = resolve(__dirname, "../../scripts/nvda-vm-observe.mjs");
const outDir = resolve(__dirname, "../../__test_nvda_vm_observe");

describe("NVDA VM observe script", () => {
  afterEach(() => {
    if (existsSync(outDir)) rmSync(outDir, { recursive: true, force: true });
  });

  it("shows help without requiring a built CLI", () => {
    const stdout = execFileSync(process.execPath, [script, "--help"], {
      encoding: "utf-8",
      env: { ...process.env, NODE_NO_WARNINGS: "1" },
    });
    expect(stdout).toContain("Create a controlled NVDA VM observation folder");
    expect(stdout).toContain("--speech-log");
    expect(stdout).toContain("JSONL");
  });

  it("writes a manifest and target template for an existing analysis plan", () => {
    execFileSync(
      process.execPath,
      [
        script,
        "--analysis",
        "checkout-analysis.json",
        "--target",
        "Checkout",
        "--target",
        "Payment details",
        "--out",
        outDir,
      ],
      {
        encoding: "utf-8",
        env: { ...process.env, NODE_NO_WARNINGS: "1" },
      },
    );

    const manifest = JSON.parse(readFileSync(resolve(outDir, "manifest.json"), "utf-8")) as {
      schema: string;
      source: string;
      targetHints: string[];
      commands: { analyze: string };
    };
    const targets = readFileSync(resolve(outDir, "targets.tsv"), "utf-8");

    expect(manifest.schema).toBe("tactual-nvda-vm-observe@1");
    expect(manifest.source).toBe("nvda-vm");
    expect(manifest.targetHints).toEqual(["Checkout", "Payment details"]);
    expect(manifest.commands.analyze).toBe("analysis supplied");
    expect(targets).toContain("target\tobservedAnnouncement");
    expect(targets).toContain("Checkout\t\t\t\t");
  });

  it("plans run-analysis with full JSON so target states are available for ingestion", () => {
    execFileSync(
      process.execPath,
      [
        script,
        "--url",
        "https://example.test/checkout",
        "--target",
        "Checkout",
        "--out",
        outDir,
        "--dry-run",
      ],
      {
        encoding: "utf-8",
        env: { ...process.env, NODE_NO_WARNINGS: "1" },
      },
    );

    const manifest = JSON.parse(readFileSync(resolve(outDir, "manifest.json"), "utf-8")) as {
      commands: { analyze: string };
    };
    expect(manifest.commands.analyze).toContain("--full-json");
  });

  it("skips unfilled TSV observation rows in dry-run mode", () => {
    mkdirSync(outDir, { recursive: true });
    const speechLog = resolve(outDir, "speech.tsv");
    writeFileSync(
      speechLog,
      [
        "target\tobservedAnnouncement\tobservedAnnouncementTokens\ttargetSelector\tannouncementNotes",
        "Checkout\tCheckout, button\t\tbutton\tobserved",
        "Search\t\t\tinput\tunfinished",
        "",
      ].join("\n"),
    );

    const stdout = execFileSync(
      process.execPath,
      [
        script,
        "--analysis",
        "checkout-analysis.json",
        "--speech-log",
        speechLog,
        "--out",
        outDir,
        "--dry-run",
      ],
      {
        encoding: "utf-8",
        env: { ...process.env, NODE_NO_WARNINGS: "1" },
      },
    );

    const records = JSON.parse(readFileSync(resolve(outDir, "speech-records.json"), "utf-8")) as
      Array<{ target: string }>;
    const manifest = JSON.parse(readFileSync(resolve(outDir, "manifest.json"), "utf-8")) as {
      results: { speechRecordCount: number; skippedEmptySpeechRows: number };
    };

    expect(stdout).toContain("Parsed 1 speech record.");
    expect(stdout).toContain("Skipped 1 unfilled TSV row.");
    expect(records).toEqual([
      {
        target: "Checkout",
        observedAnnouncement: "Checkout, button",
        targetSelector: "button",
        announcementNotes: "observed",
      },
    ]);
    expect(manifest.results).toMatchObject({
      speechRecordCount: 1,
      skippedEmptySpeechRows: 1,
    });
  });
});
