import type { Command } from "commander";
import {
  runSuggestRemediations,
  SuggestRemediationsError,
} from "../../pipeline/suggest-remediations.js";

export function registerSuggestRemediations(program: Command): void {
  program
    .command("suggest-remediations")
    .description("Extract top remediation suggestions from an analysis result")
    .argument("<file>", "Path to analysis JSON file")
    .option(
      "-n, --max-suggestions <n>",
      "Maximum suggestions to show",
      "10",
    )
    // Legacy alias; parity plan renames this `maxSuggestions` everywhere.
    .option("--max <n>", "(deprecated - use --max-suggestions)")
    .action(
      async (file: string, opts: { maxSuggestions?: string; max?: string }) => {
        const fs = await import("fs/promises");
        try {
          const data = JSON.parse(await fs.readFile(file, "utf-8"));
          const max = parseInt(opts.maxSuggestions ?? opts.max ?? "10", 10);
          const suggestions = runSuggestRemediations({
            analysis: data,
            maxSuggestions: max,
          });

          console.log("");
          if (suggestions.length === 0) {
            console.log("  No fix suggestions found.");
            console.log("");
            return;
          }
          for (const s of suggestions) {
            console.log(`  ${s.score}/100  ${s.targetId}`);
            console.log(`  \x1b[2m-> ${s.fix}\x1b[0m`);
            console.log("");
          }
        } catch (err) {
          if (err instanceof SuggestRemediationsError) {
            console.error(err.message);
          } else {
            console.error(`Error: ${err}`);
          }
          process.exit(1);
        }
      },
    );
}
