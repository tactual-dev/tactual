#!/usr/bin/env node

/**
 * NVDA VM sequence planner, launcher, and speech-log aligner.
 *
 * This is deliberately black-box around NVDA. Tactual supplies a navigation
 * plan from its captured targets, the host sends real VM keyboard scancodes,
 * and this script turns NVDA's input/output log back into observed
 * announcement records. Unmatched speech is preserved because it is often the
 * most useful clue that NVDA reached content Tactual did not model.
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const defaultCaptureRoot = process.env.TACTUAL_NVDA_CAPTURE_ROOT ?? "C:\\TactualNvdaCapture";
const defaultSource = "nvda-vm";
const defaultAtVersion = "NVDA";
const defaultBrowser = "Microsoft Edge";
const browseModePreludeScancodes = ["01", "81", "1d", "e0", "47", "e0", "c7", "9d"];

export const navigationModes = {
  tab: {
    keyName: "Tab",
    scancodes: ["0f", "8f"],
    description: "Sequential keyboard Tab traversal through focusable controls.",
  },
  heading: {
    keyName: "h",
    preludeScancodes: browseModePreludeScancodes,
    scancodes: ["23", "a3"],
    description: "NVDA browse-mode next-heading quick navigation.",
  },
  button: {
    keyName: "b",
    preludeScancodes: browseModePreludeScancodes,
    scancodes: ["30", "b0"],
    description: "NVDA browse-mode next-button quick navigation.",
  },
  link: {
    keyName: "k",
    preludeScancodes: browseModePreludeScancodes,
    scancodes: ["25", "a5"],
    description: "NVDA browse-mode next-link quick navigation.",
  },
  "form-field": {
    keyName: "f",
    preludeScancodes: browseModePreludeScancodes,
    scancodes: ["21", "a1"],
    description: "NVDA browse-mode next-form-field quick navigation.",
  },
  landmark: {
    keyName: "d",
    preludeScancodes: browseModePreludeScancodes,
    scancodes: ["20", "a0"],
    description: "NVDA browse-mode next-landmark quick navigation.",
  },
};

const helpText = `NVDA VM sequence planner and speech aligner

Usage:
  node scripts/nvda-vm-sequence.mjs plan --analysis analysis.full.json --mode tab --out plan.json
  node scripts/nvda-vm-sequence.mjs prepare --plan plan.json --out C:\\TactualNvdaCapture\\sequence-run-state.json
  node scripts/nvda-vm-sequence.mjs extract --plan plan.json --log nvda-io.log --offset 123 --jsonl-out speech.jsonl

Commands:
  plan      Build a keyboard navigation plan from a full Tactual AnalysisResult.
  prepare   Start Edge in the VM and record the NVDA log offset before key input.
  extract   Parse NVDA speech log output and align it to the plan.

Plan options:
  --analysis <path>       Full Tactual AnalysisResult JSON with states/targets
  --mode <mode>           tab | heading | button | link | form-field | landmark (default: tab)
  --max-steps <n>         Max planned navigation steps (default: 20)
  --state <id|all>        State to plan from (default: first)
  --url <url>             Override URL to open during prepare
  --out <path>            Plan output path

Prepare options:
  --plan <path>           Plan JSON
  --capture-root <path>   Guest capture root (default: C:\\TactualNvdaCapture)
  --log <path>            NVDA log path (default: <capture-root>\\nvda-io.log)
  --out <path>            Run-state output path
  --browser-path <path>   Edge/Chrome executable path
  --keep-profile          Reuse the existing guest browser profile

Extract options:
  --plan <path>           Plan JSON
  --log <path>            NVDA input/output log copied from the guest
  --offset <bytes>        Start parsing at this byte offset
  --jsonl-out <path>      Calibration speech JSONL output
  --alignment-out <path>  Detailed alignment JSON output
  --unmatched-out <path>  Unmatched NVDA speech JSON output
  --source <source>       Observation source (default: nvda-vm)
  --at-version <version>  NVDA version metadata
  --browser <version>     Browser version metadata
  --lookahead <n>         Speech blocks to scan for each expected target (default: 24)
  --max-window-blocks <n> Adjacent speech blocks that may describe one target (default: 3)
  --require-input         Match only speech emitted after an NVDA input gesture
  --require-navigation-input
                          Match only speech emitted after the plan's navigation key
`;

if (isMainModule()) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}

async function main() {
  const { command, opts } = parseArgs(process.argv.slice(2));
  if (!command || opts.help) {
    console.log(helpText);
    return;
  }

  switch (command) {
    case "plan":
      await runPlanCommand(opts);
      return;
    case "prepare":
      await runPrepareCommand(opts);
      return;
    case "extract":
      await runExtractCommand(opts);
      return;
    default:
      throw new Error(`Unknown command: ${command}. Use --help for usage.`);
  }
}

function parseArgs(argv) {
  const command = argv[0] && !argv[0].startsWith("--") ? argv[0] : undefined;
  const start = command ? 1 : 0;
  const opts = {};

  for (let i = start; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      opts.help = true;
      continue;
    }
    if (arg === "--keep-profile") {
      opts.keepProfile = true;
      continue;
    }
    if (arg === "--require-input") {
      opts.requireInput = true;
      continue;
    }
    if (arg === "--require-navigation-input") {
      opts.requireNavigationInput = true;
      continue;
    }
    if (!arg.startsWith("--")) {
      throw new Error(`Unexpected positional argument: ${arg}`);
    }
    const value = argv[i + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`Missing value for ${arg}.`);
    }
    i += 1;
    opts[toCamel(arg)] = value;
  }

  return { command, opts };
}

function toCamel(flag) {
  return flag.replace(/^--/, "").replace(/-([a-z])/g, (_, char) => char.toUpperCase());
}

async function runPlanCommand(opts) {
  if (!opts.analysis) throw new Error("plan requires --analysis <path>.");
  const plan = await buildSequencePlan({
    analysisPath: resolve(opts.analysis),
    mode: opts.mode ?? "tab",
    maxSteps: parseInteger(opts.maxSteps, 20, "--max-steps"),
    state: opts.state ?? "first",
    urlOverride: opts.url,
  });
  const out = resolve(opts.out ?? defaultOutPath("sequence-plan.json"));
  await writeJson(out, plan);
  console.log(out);
}

async function runPrepareCommand(opts) {
  if (!opts.plan) throw new Error("prepare requires --plan <path>.");
  const plan = await readJson(resolve(opts.plan));
  const captureRoot = opts.captureRoot ?? defaultCaptureRoot;
  const logPath = opts.log ?? join(captureRoot, "nvda-io.log");
  const out = resolve(opts.out ?? join(captureRoot, "sequence-run-state.json"));
  const profileDir = join(captureRoot, "edge-sequence-profile");
  const browserExecutable = opts.browserPath ?? findBrowserExecutable();
  if (!browserExecutable) {
    throw new Error("Could not find Edge or Chrome. Pass --browser-path <path>.");
  }

  await mkdir(dirname(out), { recursive: true });
  if (!opts.keepProfile) {
    await rm(profileDir, { recursive: true, force: true }).catch(() => {});
  }
  await mkdir(profileDir, { recursive: true });

  const logOffset = await fileSize(logPath);
  const url = coerceLaunchUrl(plan.url);
  const args = [
    `--user-data-dir=${profileDir}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-features=msEdgeFirstRunExperience",
    "--force-renderer-accessibility",
    `--app=${url}`,
  ];
  const child = spawn(browserExecutable, args, {
    detached: true,
    stdio: "ignore",
    windowsHide: false,
  });
  child.unref();

  const state = {
    schema: "tactual-nvda-vm-sequence-run@1",
    preparedAt: new Date().toISOString(),
    planPath: resolve(opts.plan),
    mode: plan.mode,
    url,
    logPath,
    logOffset,
    browserExecutable,
    profileDir,
    expectedStepCount: plan.targets.length,
  };
  await writeJson(out, state);
  console.log(out);
}

async function runExtractCommand(opts) {
  if (!opts.plan) throw new Error("extract requires --plan <path>.");
  if (!opts.log) throw new Error("extract requires --log <path>.");
  const plan = await readJson(resolve(opts.plan));
  const offset = parseInteger(opts.offset, 0, "--offset");
  const logText = await readLogDelta(resolve(opts.log), offset);
  const blocks = parseNvdaSpeechBlocks(logText);
  const alignment = alignSpeechToPlan(plan, blocks, {
    lookahead: parseInteger(opts.lookahead, 24, "--lookahead"),
    maxWindowBlocks: parseInteger(opts.maxWindowBlocks, 3, "--max-window-blocks"),
    requireInput: opts.requireInput || opts.requireNavigationInput,
    navigationGesture: opts.requireNavigationInput ? plan.navigation?.keyName : undefined,
  });
  const records = alignment.matches.map((match) =>
    observationRecordFromMatch(match, {
      source: opts.source ?? defaultSource,
      atVersion: opts.atVersion ?? defaultAtVersion,
      browser: opts.browser ?? defaultBrowser,
    }),
  );

  if (opts.jsonlOut) {
    await writeJsonl(resolve(opts.jsonlOut), records);
  }
  if (opts.alignmentOut) {
    await writeJson(resolve(opts.alignmentOut), {
      schema: "tactual-nvda-vm-sequence-alignment@1",
      generatedAt: new Date().toISOString(),
      plan: {
        mode: plan.mode,
        url: plan.url,
        targetCount: plan.targets.length,
      },
      parsedSpeechBlockCount: blocks.length,
      inputEventCount: countInputEvents(blocks),
      ...alignment,
      records,
    });
  }
  if (opts.unmatchedOut) {
    await writeJson(resolve(opts.unmatchedOut), alignment.unmatchedBlocks);
  }

  console.log(
    `Matched ${alignment.matches.length}/${plan.targets.length} planned target${
      plan.targets.length === 1 ? "" : "s"
    }; ${alignment.unmatchedBlocks.length} unmatched speech block${
      alignment.unmatchedBlocks.length === 1 ? "" : "s"
    }.`,
  );
}

export async function buildSequencePlan({
  analysisPath,
  mode = "tab",
  maxSteps = 20,
  state = "first",
  urlOverride,
}) {
  const modeInfo = navigationModes[mode];
  if (!modeInfo) {
    throw new Error(`Unknown --mode value: ${mode}. Use: ${Object.keys(navigationModes).join(", ")}.`);
  }

  const parsed = await readJson(analysisPath);
  const result = parsed.result ?? parsed;
  if (!Array.isArray(result.states)) {
    throw new Error(
      "Sequence planning requires a full AnalysisResult with states[]. " +
        "Run analyze-url with --full-json, not the compact JSON reporter output.",
    );
  }

  const states = selectStates(result.states, state);
  const targets = [];
  const seen = new Set();
  for (const selectedState of states) {
    for (const target of selectedState.targets ?? []) {
      const key = `${selectedState.id}:${target.id}`;
      if (seen.has(key) || !targetMatchesMode(target, mode)) continue;
      seen.add(key);
      const modeled = modelNvdaAnnouncement(target);
      targets.push({
        index: targets.length + 1,
        mode,
        stateId: selectedState.id,
        id: target.id,
        kind: target.kind,
        role: target.role,
        name: target.name ?? "",
        selector: target.selector,
        expectedAnnouncement: modeled.announcement,
        expectedTokens: modeled.parts.map((part) => normalizeSpeechToken(part)).filter(Boolean),
      });
    }
  }

  const limitedTargets = targets.slice(0, maxSteps);
  return {
    schema: "tactual-nvda-vm-sequence-plan@1",
    createdAt: new Date().toISOString(),
    analysisPath,
    url: urlOverride ?? result.flow?.name ?? result.states[0]?.url ?? "",
    profile: result.metadata?.profile ?? "nvda-desktop-v0",
    mode,
    navigation: modeInfo,
    state,
    maxSteps,
    targetCount: limitedTargets.length,
    targets: limitedTargets,
    notes: [
      "Observed speech is version-, browser-, mode-, verbosity-, and page-state-specific.",
      "Unmatched speech can indicate browser chrome chatter, contextual landmark output, timing noise, or content NVDA reached that Tactual did not model.",
    ],
  };
}

function selectStates(states, state) {
  if (state === "all") return states;
  if (state === "first") return states.slice(0, 1);
  const selected = states.find((candidate) => candidate.id === state);
  if (!selected) throw new Error(`No state matched --state ${state}.`);
  return [selected];
}

function targetMatchesMode(target, mode) {
  const kind = target.kind ?? "";
  const role = target.role ?? "";
  switch (mode) {
    case "tab":
      return new Set([
        "button",
        "link",
        "formField",
        "menuTrigger",
        "menuItem",
        "tab",
        "search",
        "pagination",
        "disclosure",
      ]).has(kind);
    case "heading":
      return kind === "heading" || role === "heading";
    case "button":
      return kind === "button" || kind === "menuTrigger" || kind === "disclosure" || role === "button";
    case "link":
      return kind === "link" || role === "link";
    case "form-field":
      return isLikelyNvdaFormFieldQuickNavTarget(target);
    case "landmark":
      return (
        kind === "landmark" ||
        kind === "search" ||
        new Set([
          "banner",
          "navigation",
          "main",
          "contentinfo",
          "complementary",
          "region",
          "form",
          "search",
        ]).has(role)
      );
    default:
      return false;
  }
}

function isLikelyNvdaFormFieldQuickNavTarget(target) {
  // Keep this in sync with src/core/at-navigation.ts. VM calibration on
  // 2026-06-12 showed NVDA/Edge browse-mode `F` reaching buttons, native
  // text/search fields, combobox/listbox widgets, checkboxes, radios, and
  // spinbuttons. It skipped a generic custom role=textbox and a native range
  // slider, even though browse traversal announced both.
  if (new Set(["button", "disclosure", "menuTrigger"]).has(target.kind) || target.role === "button") {
    return true;
  }
  if (target.kind !== "formField") return false;
  const role = String(target.role ?? "").toLowerCase();
  if (new Set(["checkbox", "combobox", "listbox", "radio", "spinbutton"]).has(role)) {
    return true;
  }
  if (!new Set(["searchbox", "textbox"]).has(role)) return false;
  return target._nativeHtmlControl === "input" || target._nativeHtmlControl === "textarea";
}

const nvdaRoleMap = {
  banner: "banner landmark",
  navigation: "navigation landmark",
  main: "main landmark",
  contentinfo: "content information landmark",
  complementary: "complementary landmark",
  region: "region",
  search: "search landmark",
  form: "form landmark",
  heading: "heading",
  link: "link",
  button: "button",
  checkbox: "check box",
  radio: "radio button",
  textbox: "edit",
  searchbox: "edit",
  combobox: "combo box",
  listbox: "list",
  slider: "slider",
  spinbutton: "spin button",
  switch: "switch",
  tab: "tab",
  dialog: "dialog",
  alertdialog: "alert dialog",
  menuitem: "menu item",
  table: "table",
  grid: "grid",
  tree: "tree",
  treegrid: "tree grid",
  row: "row",
  columnheader: "column header",
  rowheader: "row header",
  gridcell: "grid cell",
  cell: "cell",
  treeitem: "tree item",
};

function modelNvdaAnnouncement(target) {
  const attrs = target._attributeValues ?? {};
  const parts = [];
  if (target.name) parts.push(target.name);
  let roleText = nvdaRoleMap[target.role] ?? target.role;
  if (target.role === "button" && (attrs["aria-haspopup"] === "menu" || attrs["aria-haspopup"] === "true")) {
    roleText = "menu button";
  } else if (target.role === "button" && attrs["aria-pressed"] !== undefined) {
    roleText = "toggle button";
  }
  if (roleText) parts.push(roleText);
  if (target.kind === "heading" && target.headingLevel) parts.push(`level ${target.headingLevel}`);
  if (attrs["aria-expanded"] === "true") parts.push("expanded");
  if (attrs["aria-expanded"] === "false") parts.push("collapsed");
  if (attrs["aria-selected"] === "true") parts.push("selected");
  if (attrs["aria-disabled"] === "true") parts.push("unavailable");
  if (attrs["aria-required"] === "true") parts.push("required");
  if (attrs["aria-readonly"] === "true") parts.push("read only");
  if (attrs["aria-invalid"] === "true") parts.push("invalid entry");
  if (attrs["aria-pressed"] === "true") parts.push("pressed");
  if (attrs["aria-pressed"] === "false") parts.push("not pressed");
  if (attrs["aria-checked"] === "true") parts.push("checked");
  if (attrs["aria-checked"] === "false") parts.push("not checked");
  if (attrs["aria-checked"] === "mixed") parts.push("partially checked");
  if (target._value && new Set(["slider", "spinbutton", "progressbar"]).has(target.role)) {
    parts.push(String(target._value));
  }
  if (target._description) parts.push(String(target._description));
  return { announcement: parts.join(", "), parts };
}

export function parseNvdaSpeechBlocks(text) {
  const lines = text.split(/\r?\n/);
  const blocks = [];
  let pending = null;
  let pendingInput = null;
  let inputCount = 0;
  let lastInput = null;

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (/\bIO - inputCore\.InputManager\.executeGesture\b/.test(line)) {
      pendingInput = {
        timestamp: extractTimestamp(line),
        line: i + 1,
      };
      continue;
    }
    const input = parseInputGestureLine(line, pendingInput, i + 1);
    if (input) {
      inputCount += 1;
      lastInput = {
        ...input,
        ordinal: inputCount,
      };
      pendingInput = null;
      continue;
    }
    if (/\bIO - speech\.speech\.speak\b/.test(line)) {
      pending = {
        timestamp: extractTimestamp(line),
        startLine: i + 1,
      };
      continue;
    }
    if (!/\bSpeaking\s+\[/.test(line)) continue;

    const { text: speakingText, endIndex } = collectSpeakingText(lines, i);
    i = endIndex;
    const tokens = parseSpeakingTokens(speakingText);
    if (tokens.length === 0) continue;
    blocks.push({
      index: blocks.length,
      line: (pending?.startLine ?? i) + 1,
      timestamp: pending?.timestamp,
      raw: speakingText,
      tokens,
      announcement: tokens.join(", "),
      inputCount,
      lastInput,
    });
  }

  return blocks;
}

function parseInputGestureLine(line, pendingInput, lineNumber) {
  const match = line.match(/\bInput:\s*(?<raw>.+?)\s*$/);
  if (!match?.groups?.raw) return null;
  const raw = match.groups.raw.trim();
  return {
    line: pendingInput?.line ?? lineNumber,
    inputLine: lineNumber,
    timestamp: pendingInput?.timestamp ?? extractTimestamp(line),
    raw,
    gesture: stripKeyboardInputPrefix(raw),
    normalizedGesture: normalizeInputGesture(raw),
  };
}

function stripKeyboardInputPrefix(value) {
  return String(value ?? "").replace(/^kb\([^)]*\):/i, "").trim();
}

function normalizeInputGesture(value) {
  return stripKeyboardInputPrefix(value)
    .toLowerCase()
    .replace(/\s+/g, "");
}

function extractTimestamp(line) {
  const match = line.match(/\((\d{2}:\d{2}:\d{2}\.\d{3})\)/);
  return match?.[1];
}

function collectSpeakingText(lines, startIndex) {
  let text = lines[startIndex];
  let balance = bracketBalanceFromSpeaking(text);
  let endIndex = startIndex;
  while (balance > 0 && endIndex + 1 < lines.length) {
    endIndex += 1;
    text += `\n${lines[endIndex]}`;
    balance += bracketBalance(lines[endIndex]);
  }
  return { text, endIndex };
}

function bracketBalanceFromSpeaking(text) {
  const idx = text.indexOf("[");
  return idx === -1 ? 0 : bracketBalance(text.slice(idx));
}

function bracketBalance(text) {
  let balance = 0;
  let inString = false;
  let quote = "";
  let escaped = false;
  for (const char of text) {
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === quote) inString = false;
      continue;
    }
    if (char === "'" || char === '"') {
      inString = true;
      quote = char;
    } else if (char === "[") {
      balance += 1;
    } else if (char === "]") {
      balance -= 1;
    }
  }
  return balance;
}

export function parseSpeakingTokens(speakingText) {
  const start = speakingText.indexOf("[");
  if (start === -1) return [];

  const tokens = [];
  let bracketDepth = 0;
  let parenDepth = 0;
  let inString = false;
  let quote = "";
  let escaped = false;
  let capture = false;
  let current = "";

  for (let i = start; i < speakingText.length; i += 1) {
    const char = speakingText[i];
    if (inString) {
      if (escaped) {
        if (capture) current += char;
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === quote) {
        if (capture) {
          const token = current.trim();
          if (token) tokens.push(token);
        }
        inString = false;
        capture = false;
        current = "";
      } else if (capture) {
        current += char;
      }
      continue;
    }

    if (char === "'" || char === '"') {
      inString = true;
      quote = char;
      capture = bracketDepth === 1 && parenDepth === 0;
      current = "";
    } else if (char === "[") {
      bracketDepth += 1;
    } else if (char === "]") {
      bracketDepth -= 1;
      if (bracketDepth <= 0) break;
    } else if (char === "(") {
      parenDepth += 1;
    } else if (char === ")") {
      parenDepth = Math.max(0, parenDepth - 1);
    }
  }

  return tokens;
}

export function alignSpeechToPlan(plan, speechBlocks, options = {}) {
  const lookahead = options.lookahead ?? 6;
  const maxWindowBlocks = options.maxWindowBlocks ?? 3;
  const navigationGesture = normalizeInputGesture(options.navigationGesture ?? "");
  const candidateBlocks = speechBlocks.filter((block) =>
    shouldConsiderSpeechBlock(block, {
      requireInput: options.requireInput === true,
      navigationGesture,
    }),
  );
  const matches = [];
  const missingTargets = [];
  const usedBlocks = new Set();
  let cursor = 0;

  for (const target of plan.targets ?? []) {
    const expectedTokens = (target.expectedTokens ?? [])
      .map(normalizeSpeechToken)
      .filter(Boolean);
    const requiredMatches = Math.min(2, Math.max(1, expectedTokens.length));
    let best = null;
    const end = Math.min(candidateBlocks.length, cursor + lookahead);

    for (let blockIndex = cursor; blockIndex < end; blockIndex += 1) {
      if (usedBlocks.has(candidateBlocks[blockIndex].index)) continue;
      for (
        let windowEnd = blockIndex;
        windowEnd < Math.min(end, blockIndex + maxWindowBlocks);
        windowEnd += 1
      ) {
        const indexes = range(blockIndex, windowEnd);
        if (indexes.some((index) => usedBlocks.has(candidateBlocks[index].index))) break;
        const blocks = indexes.map((index) => candidateBlocks[index]);
        if (blocks.some(isNegativeQuickNavBlock)) break;
        const block = combineSpeechBlocks(blocks);
        const score = scoreSpeechBlock(block, expectedTokens);
        if (!best || isBetterSpeechMatch({ blockIndex, windowEnd, score }, best)) {
          best = { blockIndex, windowEnd, block, score };
        }
        if (score.matchedCount === expectedTokens.length) break;
      }
    }

    if (best && best.score.matchedCount >= requiredMatches) {
      for (let index = best.blockIndex; index <= best.windowEnd; index += 1) {
        usedBlocks.add(candidateBlocks[index].index);
      }
      cursor = best.windowEnd + 1;
      matches.push({
        target,
        block: best.block,
        matchedTokens: best.score.matchedTokens,
        missingTokens: best.score.missingTokens,
        score: best.score.matchedCount,
      });
    } else {
      missingTargets.push({
        target,
        expectedTokens,
      });
    }
  }

  const unmatchedBlocks = candidateBlocks.filter((block) => {
    if (usedBlocks.has(block.index)) return false;
    return block.tokens.some((token) => normalizeSpeechToken(token));
  });
  const ignoredBlocks = speechBlocks.filter((block) => {
    if (candidateBlocks.includes(block)) return false;
    return block.tokens.some((token) => normalizeSpeechToken(token));
  });

  return {
    matches,
    missingTargets,
    unmatchedBlocks,
    ignoredBlocks,
    summary: {
      plannedTargets: plan.targets?.length ?? 0,
      parsedSpeechBlocks: speechBlocks.length,
      consideredSpeechBlocks: candidateBlocks.length,
      ignoredSpeechBlocks: ignoredBlocks.length,
      inputEventCount: countInputEvents(speechBlocks),
      navigationInputGesture: navigationGesture || null,
      matchedTargets: matches.length,
      missingTargets: missingTargets.length,
      unmatchedSpeechBlocks: unmatchedBlocks.length,
    },
  };
}

function shouldConsiderSpeechBlock(block, options) {
  if (!options.requireInput) return true;
  if (!block.lastInput) return false;
  if (!options.navigationGesture) return block.inputCount > 0;
  return block.lastInput.normalizedGesture === options.navigationGesture;
}

function isBetterSpeechMatch(candidate, best) {
  if (candidate.score.matchedCount !== best.score.matchedCount) {
    return candidate.score.matchedCount > best.score.matchedCount;
  }
  const candidateMissing = candidate.score.missingTokens.length;
  const bestMissing = best.score.missingTokens.length;
  if (candidateMissing !== bestMissing) return candidateMissing < bestMissing;
  const candidateWindow = candidate.windowEnd - candidate.blockIndex;
  const bestWindow = best.windowEnd - best.blockIndex;
  return candidateWindow < bestWindow;
}

function combineSpeechBlocks(blocks) {
  if (blocks.length === 1) return blocks[0];
  const first = blocks[0];
  const last = blocks[blocks.length - 1];
  const tokens = blocks.flatMap((block) => block.tokens);
  return {
    index: first.index,
    line: first.line,
    lineEnd: last.line,
    timestamp: first.timestamp,
    raw: blocks.map((block) => block.raw).join("\n"),
    tokens,
    announcement: tokens.join(", "),
    inputCount: first.inputCount,
    lastInput: first.lastInput,
    combinedBlockCount: blocks.length,
    blockIndexes: blocks.map((block) => block.index),
  };
}

function countInputEvents(blocks) {
  return blocks.reduce((max, block) => Math.max(max, block.inputCount ?? 0), 0);
}

function range(start, endInclusive) {
  return Array.from({ length: endInclusive - start + 1 }, (_, offset) => start + offset);
}

function isNegativeQuickNavBlock(block) {
  return /^no (next|previous) /.test(normalizeSpeechToken(block.announcement));
}

function scoreSpeechBlock(block, expectedTokens) {
  const observed = normalizeSpeechToken(block.announcement);
  if (/^no (next|previous) /.test(observed)) {
    return {
      matchedCount: 0,
      matchedTokens: [],
      missingTokens: expectedTokens,
    };
  }
  const matchedTokens = [];
  const missingTokens = [];

  for (const token of expectedTokens) {
    if (!token) continue;
    if (tokenMatchesObserved(observed, token)) matchedTokens.push(token);
    else missingTokens.push(token);
  }

  return {
    matchedCount: matchedTokens.length,
    matchedTokens,
    missingTokens,
  };
}

function tokenMatchesObserved(observed, token) {
  return tokenAlternatives(token).some((alternative) => observed.includes(alternative));
}

function tokenAlternatives(token) {
  const normalized = normalizeSpeechToken(token);
  const alternatives = new Set([normalized]);
  const landmarkRole = normalized.match(/^(.+) landmark$/)?.[1];
  if (landmarkRole) {
    alternatives.add(landmarkRole);
  }
  if (normalized === "content information landmark") {
    alternatives.add("content information");
    alternatives.add("content info landmark");
    alternatives.add("content info");
  }
  return [...alternatives].filter(Boolean);
}

function observationRecordFromMatch(match, opts) {
  const target = match.target;
  const speechLine = match.block.lineEnd && match.block.lineEnd !== match.block.line
    ? `${match.block.line}-${match.block.lineEnd}`
    : String(match.block.line);
  const notes = [
    `nvda-vm ${target.index} ${target.id}`,
    `mode=${target.mode ?? "sequence"}`,
    `speechLine=${speechLine}`,
    `matched=${match.matchedTokens.join("|") || "none"}`,
  ];
  if (match.block.lastInput) {
    notes.push(`input=${match.block.lastInput.gesture}@${match.block.lastInput.inputLine}`);
  }
  if (match.missingTokens.length > 0) {
    notes.push(`missingExpected=${match.missingTokens.join("|")}`);
  }

  return {
    target: target.stateId ? `${target.stateId}:${target.id}` : target.id,
    targetName: target.name || target.id,
    ...(target.selector ? { targetSelector: target.selector } : {}),
    observedAnnouncement: match.block.announcement,
    announcementSource: opts.source,
    atVersion: opts.atVersion,
    browser: opts.browser,
    announcementNotes: notes.join("; "),
  };
}

export function normalizeSpeechToken(token) {
  return String(token ?? "")
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^\p{Letter}\p{Number}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

async function readLogDelta(path, offset) {
  const buffer = await readFile(path);
  return buffer.subarray(Math.max(0, Math.min(offset, buffer.length))).toString("utf-8");
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf-8"));
}

async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf-8");
}

async function writeJsonl(path, records) {
  await mkdir(dirname(path), { recursive: true });
  const lines = records.map((record) => JSON.stringify(record));
  await writeFile(path, `${lines.join("\n")}${lines.length ? "\n" : ""}`, "utf-8");
}

function parseInteger(value, fallback, label) {
  if (value === undefined || value === null || value === "") return fallback;
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`${label} must be a non-negative integer.`);
  }
  return parsed;
}

function defaultOutPath(fileName) {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return resolve(root, "build", "nvda-vm-sequence", stamp, fileName);
}

function findBrowserExecutable() {
  return firstExisting([
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  ]);
}

function firstExisting(paths) {
  return paths.find((path) => existsSync(path));
}

function coerceLaunchUrl(value) {
  if (!value) throw new Error("Plan does not include a URL to open.");
  if (/^[a-z][a-z0-9+.-]*:/i.test(value)) return value;
  return pathToFileURL(resolve(value)).href;
}

async function fileSize(path) {
  try {
    return (await stat(path)).size;
  } catch {
    return 0;
  }
}

function isMainModule() {
  if (!process.argv[1]) return false;
  return import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
}
