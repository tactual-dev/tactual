import type { Command } from "commander";
import { listProfiles } from "../../profiles/index.js";
import {
  runTracePath,
  TracePathError,
  type TracePathResult,
  type TraceEntry,
} from "../../pipeline/trace-path.js";

export function registerTracePath(program: Command): void {
  program
    .command("trace-path")
    .description("Trace the step-by-step screen-reader navigation path to a specific target")
    .argument("<url>", "URL of the page")
    .argument("<target>", "Target ID or glob pattern (e.g., '*search*', 'combobox:search')")
    .option("-p, --profile <id>", "AT profile to use")
    .option("-d, --device <name>", "Device to emulate")
    .option("-e, --explore", "Explore hidden branches before tracing")
    .option("--wait-for-selector <selector>", "CSS selector to wait for (SPAs)")
    .option("--storage-state <path>", "Playwright storageState JSON file for authenticated pages")
    .option("--timeout <ms>", "Page load timeout", "30000")
    .action(async (url: string, targetPattern: string, opts: Record<string, unknown>) => {
      const startTime = Date.now();
      const isTTY = process.stderr.isTTY;
      let dots = 0;
      const progress = isTTY
        ? setInterval(() => {
            dots = (dots + 1) % 4;
            const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
            process.stderr.write(
              `\r  Tracing path to "${targetPattern}"${".".repeat(dots)}${" ".repeat(3 - dots)} (${elapsed}s)`,
            );
          }, 500)
        : null;
      const stopProgress = () => {
        if (progress) {
          clearInterval(progress);
          process.stderr.write("\r" + " ".repeat(80) + "\r");
        }
      };

      try {
        const result = await runTracePath({
          url,
          targetPattern,
          profileId: opts.profile as string | undefined,
          device: opts.device as string | undefined,
          explore: opts.explore as boolean | undefined,
          waitForSelector: opts.waitForSelector as string | undefined,
          timeout: parseInt((opts.timeout as string) ?? "30000", 10),
          storageState: opts.storageState as string | undefined,
        });

        stopProgress();
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
        if (isTTY) console.error(`  \x1b[90mCompleted in ${elapsed}s\x1b[0m`);

        for (const warn of result.warnings) {
          process.stderr.write(`  Warning: ${warn}\n`);
        }

        printTracesConsole(result);
      } catch (err) {
        stopProgress();
        if (err instanceof TracePathError) {
          if (err.code === "unknown-profile") {
            console.error(err.message);
            console.error(`Available: ${listProfiles().join(", ")}`);
          } else if (err.code === "no-matches" && err.availableTargets) {
            const formatted = err.availableTargets
              .slice(0, 15)
              .map((t) => `  ${t}`)
              .join("\n");
            console.error(`${err.message}\n\nAvailable targets:\n${formatted}`);
          } else {
            console.error(err.message);
          }
          process.exit(1);
        }
        if (
          err instanceof Error &&
          (err.message.includes("Cannot find module") ||
            err.message.includes("Cannot find package"))
        ) {
          console.error(
            "Playwright is required. Install it: npm install playwright",
          );
          process.exit(1);
        }
        throw err;
      }
    });
}

function printTracesConsole(result: TracePathResult): void {
  for (const match of result.traces) {
    console.log("");
    console.log(`  \x1b[1mTrace: ${match.targetId}\x1b[0m`);
    console.log(`  \x1b[2m${match.targetRole} "${match.targetName}"\x1b[0m`);
    if (match.selector) console.log(`  \x1b[2m${match.selector}\x1b[0m`);

    if (!match.reachable) {
      console.log(`  \x1b[31mNo path found from any entry point.\x1b[0m`);
      continue;
    }

    console.log(
      `  \x1b[2mTotal cost: ${match.totalCost.toFixed(1)} | Steps: ${match.stepCount}\x1b[0m`,
    );
    console.log("");

    printSteps(match);
    console.log("");
  }
}

function printSteps(match: TraceEntry): void {
  for (let i = 0; i < match.steps.length; i++) {
    const s = match.steps[i];
    const isLast = i === match.steps.length - 1;
    const arrow = isLast ? "\x1b[32m->\x1b[0m" : "\x1b[2m->\x1b[0m";
    const nameColor = isLast ? "\x1b[1m" : "";
    console.log(
      `  ${arrow}  \x1b[33m${s.action}\x1b[0m  ${nameColor}${s.to.name}\x1b[0m`,
    );
    console.log(
      `     \x1b[2m${s.modeledAnnouncement}  (cost +${s.cost}, total ${s.cumulativeCost.toFixed(1)})\x1b[0m`,
    );
  }
}
