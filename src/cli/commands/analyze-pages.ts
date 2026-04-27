import type { Command } from "commander";
import { listProfiles } from "../../profiles/index.js";
import {
  runAnalyzePages,
  AnalyzePagesError,
  type AnalyzePagesResult,
} from "../../pipeline/analyze-pages.js";

export function registerAnalyzePages(program: Command): void {
  program
    .command("analyze-pages")
    .description("Analyze multiple pages with site-level aggregation")
    .argument("<urls...>", "URLs to analyze (space-separated)")
    .option("-p, --profile <id>", "AT profile to use")
    .option("-f, --format <format>", "Output format: json, console", "console")
    .option("--wait-for-selector <selector>", "CSS selector to wait for on each page")
    .option("--wait-time <ms>", "Additional wait per page in ms")
    .option("--storage-state <path>", "Playwright storageState JSON for authenticated pages")
    .option("--timeout <ms>", "Page load timeout per URL", "30000")
    .action(async (urls: string[], opts: Record<string, unknown>) => {
      try {
        const result = await runAnalyzePages({
          urls,
          profileId: opts.profile as string | undefined,
          waitForSelector: opts.waitForSelector as string | undefined,
          waitTime: opts.waitTime ? parseInt(opts.waitTime as string, 10) : undefined,
          timeout: parseInt((opts.timeout as string) ?? "30000", 10),
          storageState: opts.storageState as string | undefined,
        });

        if (opts.format === "json") {
          console.log(JSON.stringify(result, null, 2));
        } else {
          printConsole(result, opts.profile as string | undefined, urls.length);
        }
      } catch (err) {
        if (err instanceof AnalyzePagesError) {
          console.error(err.message);
          if (err.code === "unknown-profile") {
            console.error(`Available: ${listProfiles().join(", ")}`);
          }
          process.exit(1);
        }
        if (
          err instanceof Error &&
          (err.message.includes("Cannot find module") ||
            err.message.includes("Cannot find package"))
        ) {
          console.error("Playwright is required. Install it: npm install playwright");
          process.exit(1);
        }
        throw err;
      }
    });
}

function printConsole(
  result: AnalyzePagesResult,
  profileId: string | undefined,
  urlCount: number,
): void {
  const c = process.stdout.isTTY === true && !process.env.NO_COLOR;
  const bold = c ? "\x1b[1m" : "";
  const dim = c ? "\x1b[2m" : "";
  const green = c ? "\x1b[32m" : "";
  const yellow = c ? "\x1b[33m" : "";
  const red = c ? "\x1b[31m" : "";
  const reset = c ? "\x1b[0m" : "";

  const pid = profileId ?? "generic-mobile-web-sr-v0";
  console.log("");
  console.log(
    `  ${bold}Tactual Site Analysis${reset}  ${dim}${urlCount} pages | ${pid}${reset}`,
  );
  console.log(
    `  ${dim}P10${reset} ${result.site.p10}  ${dim}Median${reset} ${result.site.median}  ${dim}Avg${reset} ${result.site.average}  ${dim}Targets${reset} ${result.site.totalTargets}`,
  );
  const sevParts: string[] = [];
  for (const [sev, count] of Object.entries(result.site.severityCounts)) {
    if (count > 0) {
      const color =
        sev === "severe" || sev === "high"
          ? red
          : sev === "moderate"
            ? yellow
            : green;
      sevParts.push(`${color}${count} ${sev}${reset}`);
    }
  }
  if (sevParts.length > 0) {
    console.log(`  ${sevParts.join(`${dim}  |  ${reset}`)}`);
  }
  if (result.site.repeatedNavigation && result.site.repeatedNavigation.repeatedTargets > 0) {
    const repeated = result.site.repeatedNavigation;
    console.log(
      `  ${dim}Repeated nav${reset} ${repeated.repeatedTargets} target groups | ${repeated.totalLinearSteps} repeated linear steps`,
    );
  }
  console.log("");

  for (const r of result.pages) {
    const scoreColor = r.p10 >= 75 ? green : r.p10 >= 60 ? yellow : red;
    console.log(
      `  ${scoreColor}P10:${r.p10}${reset}  ${dim}Med:${r.median} Avg:${r.average}${reset}  ${r.url}`,
    );
    if (r.topIssue) console.log(`  ${dim}       -> ${r.topIssue}${reset}`);
    if (r.diagnostics.length > 0) {
      console.log(`  ${dim}       diagnostics: ${r.diagnostics.join(", ")}${reset}`);
    }
  }
  const repeated = result.site.repeatedNavigation?.worstGroups ?? [];
  if (repeated.length > 0) {
    console.log("");
    console.log(`  ${bold}Repeated Navigation Cost${reset}`);
    for (const g of repeated.slice(0, 5)) {
      console.log(
        `  ${yellow}${g.totalLinearSteps} steps${reset}  ${g.label} (${g.role}) ${dim}${g.pageCount} pages | avg score ${g.averageScore}${reset}`,
      );
      if (g.topPenalties[0]) {
        console.log(`  ${dim}       -> ${g.topPenalties[0]}${reset}`);
      }
    }
  }
  console.log("");
}
