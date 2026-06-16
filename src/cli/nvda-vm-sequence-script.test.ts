import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { resolve } from "path";

const script = resolve(__dirname, "../../scripts/nvda-vm-sequence.mjs");
const outDir = resolve(__dirname, "../../__test_nvda_vm_sequence");

describe("NVDA VM sequence script", () => {
  afterEach(() => {
    if (existsSync(outDir)) rmSync(outDir, { recursive: true, force: true });
  });

  it("shows help without touching the VM", () => {
    const stdout = execFileSync(process.execPath, [script, "--help"], {
      encoding: "utf-8",
      env: { ...process.env, NODE_NO_WARNINGS: "1" },
    });
    expect(stdout).toContain("NVDA VM sequence");
    expect(stdout).toContain("plan");
    expect(stdout).toContain("extract");
    expect(stdout).toContain("--max-window-blocks");
    expect(stdout).toContain("--require-navigation-input");
  });

  it("plans Tab and quick-nav sequences from a full analysis result", () => {
    mkdirSync(outDir, { recursive: true });
    const analysisPath = resolve(outDir, "analysis.json");
    const tabPlanPath = resolve(outDir, "tab-plan.json");
    const headingPlanPath = resolve(outDir, "heading-plan.json");
    const formPlanPath = resolve(outDir, "form-plan.json");
    writeFileSync(analysisPath, JSON.stringify(makeAnalysis(), null, 2));

    execFileSync(process.execPath, [
      script,
      "plan",
      "--analysis",
      analysisPath,
      "--mode",
      "tab",
      "--max-steps",
      "2",
      "--out",
      tabPlanPath,
    ]);
    execFileSync(process.execPath, [
      script,
      "plan",
      "--analysis",
      analysisPath,
      "--mode",
      "heading",
      "--out",
      headingPlanPath,
    ]);
    execFileSync(process.execPath, [
      script,
      "plan",
      "--analysis",
      analysisPath,
      "--mode",
      "form-field",
      "--out",
      formPlanPath,
    ]);

    const tabPlan = JSON.parse(readFileSync(tabPlanPath, "utf-8")) as {
      mode: string;
      navigation: { scancodes: string[] };
      targets: Array<{ name: string; expectedTokens: string[] }>;
    };
    const headingPlan = JSON.parse(readFileSync(headingPlanPath, "utf-8")) as {
      navigation: { keyName: string; preludeScancodes?: string[] };
      targets: Array<{ name: string; expectedTokens: string[] }>;
    };
    const formPlan = JSON.parse(readFileSync(formPlanPath, "utf-8")) as {
      targets: Array<{ name: string; expectedTokens: string[] }>;
    };

    expect(tabPlan.mode).toBe("tab");
    expect(tabPlan.navigation.scancodes).toEqual(["0f", "8f"]);
    expect(tabPlan.targets.map((target) => target.name)).toEqual(["Start order", "Help center"]);
    expect(tabPlan.targets[0].expectedTokens).toEqual(["start order", "button"]);
    expect(headingPlan.navigation.keyName).toBe("h");
    expect(headingPlan.navigation.preludeScancodes).toEqual([
      "01",
      "81",
      "1d",
      "e0",
      "47",
      "e0",
      "c7",
      "9d",
    ]);
    expect(headingPlan.targets).toEqual([
      expect.objectContaining({
        name: "Checkout smoke",
        expectedTokens: ["checkout smoke", "heading", "level 1"],
      }),
    ]);
    expect(formPlan.targets.map((target) => target.name)).toEqual([
      "Start order",
      "Email address",
      "Assignee",
      "Seats",
      "Plan",
      "Card number",
      "Mute alerts",
    ]);
    expect(formPlan.targets[0].expectedTokens).toEqual(["start order", "button"]);
    expect(formPlan.targets[1].expectedTokens).toEqual(["email address", "edit"]);
    expect(formPlan.targets[2].expectedTokens).toEqual(["assignee", "combo box"]);
    expect(formPlan.targets[3].expectedTokens).toEqual(["seats", "spin button"]);
    expect(formPlan.targets[4].expectedTokens).toEqual(["plan", "combo box"]);
    expect(formPlan.targets[5].expectedTokens).toEqual(["card number", "edit"]);
    expect(formPlan.targets[6].expectedTokens).toEqual(["mute alerts", "toggle button", "not pressed"]);
  });

  it("extracts matched calibration records and preserves unmatched NVDA speech", () => {
    mkdirSync(outDir, { recursive: true });
    const planPath = resolve(outDir, "plan.json");
    const logPath = resolve(outDir, "nvda-io.log");
    const jsonlPath = resolve(outDir, "speech.jsonl");
    const alignmentPath = resolve(outDir, "alignment.json");
    const unmatchedPath = resolve(outDir, "unmatched.json");

    writeFileSync(
      planPath,
      JSON.stringify(
        {
          schema: "tactual-nvda-vm-sequence-plan@1",
          mode: "tab",
          url: "https://example.test",
          targets: [
            {
              index: 1,
              id: "button-1",
              name: "Start order",
              role: "button",
              kind: "button",
              selector: "#start",
              expectedTokens: ["start order", "button"],
            },
            {
              index: 2,
              id: "email-1",
              name: "Email address",
              role: "textbox",
              kind: "formField",
              selector: "#email",
              expectedTokens: ["email address", "edit", "enter your account email"],
            },
          ],
        },
        null,
        2,
      ),
    );
    writeFileSync(
      logPath,
      [
        "IO - speech.speech.speak (10:00:00.000) - MainThread (1):",
        "Speaking [LangChangeCommand ('en_US'), 'Tactual NVDA smoke', 'document']",
        "IO - speech.speech.speak (10:00:01.000) - MainThread (1):",
        "Speaking [LangChangeCommand ('en_US'), 'main landmark', 'Start order', 'button']",
        "IO - speech.speech.speak (10:00:02.000) - MainThread (1):",
        "Speaking [LangChangeCommand ('en_US'), 'Email address']",
        "IO - speech.speech.speak (10:00:03.000) - MainThread (1):",
        "Speaking [LangChangeCommand ('en_US'), 'edit', 'tester@example.com']",
        "IO - speech.speech.speak (10:00:04.000) - MainThread (1):",
        "Speaking [LangChangeCommand ('en_US'), 'Enter your account email']",
        "IO - speech.speech.speak (10:00:05.000) - MainThread (1):",
        "Speaking [LangChangeCommand ('en_US'), 'Extra browse-mode text']",
        "",
      ].join("\n"),
    );

    const stdout = execFileSync(process.execPath, [
      script,
      "extract",
      "--plan",
      planPath,
      "--log",
      logPath,
      "--offset",
      "0",
      "--jsonl-out",
      jsonlPath,
      "--alignment-out",
      alignmentPath,
      "--unmatched-out",
      unmatchedPath,
      "--at-version",
      "NVDA 2026.1.1",
      "--browser",
      "Edge 137",
    ], {
      encoding: "utf-8",
      env: { ...process.env, NODE_NO_WARNINGS: "1" },
    });

    const records = readFileSync(jsonlPath, "utf-8")
      .trim()
      .split(/\r?\n/)
      .map((line) => JSON.parse(line)) as Array<{
      target: string;
      observedAnnouncement: string;
      announcementNotes: string;
    }>;
    const alignment = JSON.parse(readFileSync(alignmentPath, "utf-8")) as {
      summary: { matchedTargets: number; unmatchedSpeechBlocks: number };
    };
    const unmatched = JSON.parse(readFileSync(unmatchedPath, "utf-8")) as Array<{
      announcement: string;
    }>;

    expect(stdout).toContain("Matched 2/2 planned targets");
    expect(records).toHaveLength(2);
    expect(records[0]).toMatchObject({
      target: "button-1",
      targetName: "Start order",
      targetSelector: "#start",
      observedAnnouncement: "main landmark, Start order, button",
    });
    expect(records[0].observedAnnouncement).not.toContain("en_US");
    expect(records[1]).toMatchObject({
      target: "email-1",
      targetName: "Email address",
      observedAnnouncement: "Email address, edit, tester@example.com, Enter your account email",
    });
    expect(records[1].announcementNotes).toContain("speechLine=6-10");
    expect(alignment.summary).toMatchObject({
      matchedTargets: 2,
      unmatchedSpeechBlocks: 2,
    });
    expect(unmatched.map((block) => block.announcement)).toEqual([
      "Tactual NVDA smoke, document",
      "Extra browse-mode text",
    ]);
  });

  it("matches terse NVDA landmark speech against explicit landmark model tokens", () => {
    mkdirSync(outDir, { recursive: true });
    const planPath = resolve(outDir, "landmark-plan.json");
    const logPath = resolve(outDir, "landmark-nvda-io.log");
    const jsonlPath = resolve(outDir, "landmark-speech.jsonl");

    writeFileSync(
      planPath,
      JSON.stringify(
        {
          schema: "tactual-nvda-vm-sequence-plan@1",
          mode: "landmark",
          url: "https://example.test",
          targets: [
            {
              index: 1,
              id: "form-1",
              name: "Form controls",
              role: "form",
              kind: "landmark",
              expectedTokens: ["form controls", "form landmark"],
            },
          ],
        },
        null,
        2,
      ),
    );
    writeFileSync(
      logPath,
      [
        "IO - speech.speech.speak (10:00:00.000) - MainThread (1):",
        "Speaking [LangChangeCommand ('en_US'), 'Form controls', 'form', 'heading', 'level 2']",
        "",
      ].join("\n"),
    );

    const stdout = execFileSync(process.execPath, [
      script,
      "extract",
      "--plan",
      planPath,
      "--log",
      logPath,
      "--offset",
      "0",
      "--jsonl-out",
      jsonlPath,
    ], {
      encoding: "utf-8",
      env: { ...process.env, NODE_NO_WARNINGS: "1" },
    });

    const records = readFileSync(jsonlPath, "utf-8")
      .trim()
      .split(/\r?\n/)
      .map((line) => JSON.parse(line)) as Array<{
      targetName: string;
      observedAnnouncement: string;
      announcementNotes: string;
    }>;

    expect(stdout).toContain("Matched 1/1 planned target");
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      targetName: "Form controls",
      observedAnnouncement: "Form controls, form, heading, level 2",
    });
    expect(records[0].announcementNotes).toContain("matched=form controls|form landmark");
  });

  it("can ignore page-load and prelude speech when calibrating navigation input", () => {
    mkdirSync(outDir, { recursive: true });
    const planPath = resolve(outDir, "navigation-input-plan.json");
    const logPath = resolve(outDir, "navigation-input-nvda-io.log");
    const jsonlPath = resolve(outDir, "navigation-input-speech.jsonl");
    const alignmentPath = resolve(outDir, "navigation-input-alignment.json");

    writeFileSync(
      planPath,
      JSON.stringify(
        {
          schema: "tactual-nvda-vm-sequence-plan@1",
          mode: "heading",
          navigation: { keyName: "h" },
          url: "https://example.test",
          targets: [
            {
              index: 1,
              id: "heading-1",
              name: "Payment details",
              role: "heading",
              kind: "heading",
              expectedTokens: ["payment details", "heading", "level 2"],
            },
          ],
        },
        null,
        2,
      ),
    );
    writeFileSync(
      logPath,
      [
        "IO - speech.speech.speak (10:00:00.000) - MainThread (1):",
        "Speaking [LangChangeCommand ('en_US'), 'Payment details', 'heading', 'level 2']",
        "IO - inputCore.InputManager.executeGesture (10:00:01.000) - MainThread (1):",
        "Input: kb(desktop):control+home",
        "IO - speech.speech.speak (10:00:02.000) - MainThread (1):",
        "Speaking [LangChangeCommand ('en_US'), 'Payment details', 'heading', 'level 2']",
        "IO - inputCore.InputManager.executeGesture (10:00:03.000) - MainThread (1):",
        "Input: kb(desktop):h",
        "IO - speech.speech.speak (10:00:04.000) - MainThread (1):",
        "Speaking [LangChangeCommand ('en_US'), 'Payment details', 'heading', 'level 2']",
        "",
      ].join("\n"),
    );

    const stdout = execFileSync(process.execPath, [
      script,
      "extract",
      "--plan",
      planPath,
      "--log",
      logPath,
      "--offset",
      "0",
      "--jsonl-out",
      jsonlPath,
      "--alignment-out",
      alignmentPath,
      "--require-navigation-input",
    ], {
      encoding: "utf-8",
      env: { ...process.env, NODE_NO_WARNINGS: "1" },
    });

    const records = readFileSync(jsonlPath, "utf-8")
      .trim()
      .split(/\r?\n/)
      .map((line) => JSON.parse(line)) as Array<{
      observedAnnouncement: string;
      announcementNotes: string;
    }>;
    const alignment = JSON.parse(readFileSync(alignmentPath, "utf-8")) as {
      summary: {
        matchedTargets: number;
        parsedSpeechBlocks: number;
        consideredSpeechBlocks: number;
        ignoredSpeechBlocks: number;
        inputEventCount: number;
        navigationInputGesture: string;
      };
    };

    expect(stdout).toContain("Matched 1/1 planned target");
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      observedAnnouncement: "Payment details, heading, level 2",
    });
    expect(records[0].announcementNotes).toContain("input=h@8");
    expect(alignment.summary).toMatchObject({
      matchedTargets: 1,
      parsedSpeechBlocks: 3,
      consideredSpeechBlocks: 1,
      ignoredSpeechBlocks: 2,
      inputEventCount: 2,
      navigationInputGesture: "h",
    });
  });
});

function makeAnalysis() {
  return {
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
            id: "main-1",
            kind: "landmark",
            role: "main",
            name: "Main",
            selector: "main",
          },
          {
            id: "heading-1",
            kind: "heading",
            role: "heading",
            name: "Checkout smoke",
            headingLevel: 1,
            selector: "h1",
          },
          {
            id: "button-1",
            kind: "button",
            role: "button",
            name: "Start order",
            selector: "#start",
          },
          {
            id: "link-1",
            kind: "link",
            role: "link",
            name: "Help center",
            selector: "#help",
          },
          {
            id: "email-1",
            kind: "formField",
            role: "textbox",
            name: "Email address",
            selector: "#email",
            _nativeHtmlControl: "input",
            _inputType: "email",
          },
          {
            id: "custom-1",
            kind: "formField",
            role: "textbox",
            name: "Custom field",
            selector: "#custom",
          },
          {
            id: "combo-1",
            kind: "formField",
            role: "combobox",
            name: "Assignee",
            selector: "#assignee",
            _nativeHtmlControl: "input",
            _inputType: "text",
          },
          {
            id: "spin-1",
            kind: "formField",
            role: "spinbutton",
            name: "Seats",
            selector: "#seats",
          },
          {
            id: "select-1",
            kind: "formField",
            role: "combobox",
            name: "Plan",
            selector: "#plan",
            _nativeHtmlControl: "select",
          },
          {
            id: "frame-text-1",
            kind: "formField",
            role: "textbox",
            name: "Card number",
            selector: "#card",
            _nativeHtmlControl: "input",
            _inputType: "text",
            _frame: { url: "https://example.test/frame", source: "ariaSnapshot" },
          },
          {
            id: "toggle-1",
            kind: "button",
            role: "button",
            name: "Mute alerts",
            selector: "#mute",
            _attributeValues: { "aria-pressed": "false" },
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
      targetCount: 5,
      findingCount: 0,
      edgeCount: 0,
    },
  };
}
