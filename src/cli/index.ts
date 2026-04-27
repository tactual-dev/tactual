#!/usr/bin/env node

import { Command } from "commander";
import { VERSION } from "../version.js";
import { registerAnalyzeUrl } from "./commands/analyze-url.js";
import { registerAnalyzePages } from "./commands/analyze-pages.js";
import { registerTracePath } from "./commands/trace-path.js";
import { registerSaveAuth } from "./commands/save-auth.js";
import { registerSuggestRemediations } from "./commands/suggest-remediations.js";
import { registerDiff } from "./commands/diff.js";
import { registerProfiles } from "./commands/profiles.js";
import { registerPresets } from "./commands/presets.js";
import { registerTranscript } from "./commands/transcript.js";
import { registerInit } from "./commands/init.js";
import { registerBenchmark } from "./commands/benchmark.js";
import { registerValidate } from "./commands/validate.js";

const program = new Command();

program
  .name("tactual")
  .description(
    "Screen-reader navigation cost analyzer. " +
      "Measures how hard it is for AT users to discover, reach, and operate web content.",
  )
  .version(VERSION, "-v, --version");

// Register all commands. Each module owns its option definitions and
// action handler. Adding a command is 1 file + 1 import + 1 register call.
registerAnalyzeUrl(program);
registerTracePath(program);
registerSaveAuth(program);
registerAnalyzePages(program);
registerSuggestRemediations(program);
registerDiff(program);
registerProfiles(program);
registerPresets(program);
registerTranscript(program);
registerInit(program);
registerBenchmark(program);
registerValidate(program);

program.parse();
