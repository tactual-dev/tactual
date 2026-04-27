import type { Command } from "commander";
import {
  runValidateUrl,
  ValidateUrlError,
  type ValidateUrlResult,
} from "../../pipeline/validate-url.js";

/**
 * Registers the `validate-url` command (with a `validate` alias for
 * compatibility with pre-0.4 users). Parameter name aligns with the MCP
 * tool (`validate_url`).
 */
export function registerValidate(program: Command): void {
  program
    .command("validate-url")
    .alias("validate")
    .description(
      "Validate Tactual's predicted paths against a virtual screen reader. " +
      "For each worst finding, runs @guidepup/virtual-screen-reader over the " +
      "captured DOM to see whether the target is reachable to the virtual SR " +
      "and how many announcements it takes to reach it. Requires jsdom and " +
      "@guidepup/virtual-screen-reader (both optional deps).",
    )
    .argument("<url>", "URL to analyze and validate")
    .option("-p, --profile <id>", "AT profile to use")
    .option("--max-targets <n>", "Maximum findings to validate (worst first)", "10")
    .option("--strategy <name>", "Navigation strategy: linear | semantic", "semantic")
    .option("--timeout <ms>", "Page load timeout", "30000")
    .option("--wait-time <ms>", "Additional wait after load")
    .option("--channel <name>", "Browser channel: chrome, chrome-beta, msedge")
    .option("--stealth", "Apply anti-bot-detection defaults")
    .option("--no-headless", "Run browser in headed mode")
    .option("--storage-state <path>", "Playwright storageState JSON file for authenticated pages")
    .option("-f, --format <format>", "Output format: json | console", "console")
    .option("-o, --output <path>", "Write output to file instead of stdout")
    .action(async (url: string, opts: Record<string, unknown>) => {
      try {
        const result = await runValidateUrl({
          url,
          profileId: opts.profile as string | undefined,
          maxTargets: parseInt((opts.maxTargets as string) ?? "10", 10),
          strategy: (opts.strategy as "linear" | "semantic") ?? "semantic",
          timeout: parseInt((opts.timeout as string) ?? "30000", 10),
          waitTime: opts.waitTime ? parseInt(opts.waitTime as string, 10) : undefined,
          channel: opts.channel as string | undefined,
          stealth: opts.stealth === true,
          headless: opts.headless !== false,
          storageState: opts.storageState as string | undefined,
        });

        const output =
          opts.format === "json"
            ? JSON.stringify(result, null, 2)
            : formatValidateConsole(result);

        if (opts.output) {
          const fs = await import("node:fs/promises");
          await fs.writeFile(opts.output as string, output, "utf-8");
          console.error(`Wrote ${opts.output}`);
        } else {
          console.log(output);
        }
      } catch (err) {
        if (err instanceof ValidateUrlError) {
          console.error(err.message);
        } else {
          console.error(err instanceof Error ? err.message : String(err));
        }
        process.exit(1);
      }
    });
}

function formatValidateConsole(p: ValidateUrlResult): string {
  const lines: string[] = [];
  lines.push(`Validation results for ${p.url}`);
  lines.push(`Profile: ${p.profile}   Strategy: ${p.strategy}`);
  lines.push("");
  lines.push(`Validated ${p.totalValidated} findings`);
  lines.push(`  Reachable by virtual SR: ${p.reachable}`);
  lines.push(`  Unreachable: ${p.unreachable}`);
  if (p.meanAccuracy !== null) {
    lines.push(
      `  Mean predicted/actual step ratio: ${p.meanAccuracy.toFixed(2)} (1.0 = perfect)`,
    );
  }
  lines.push("");
  lines.push("Per-target:");
  for (const r of p.results) {
    const marker = r.reachable ? "  OK " : " MISS";
    lines.push(
      `${marker}  ${r.targetName.slice(0, 40).padEnd(40)}  ` +
      `predicted=${r.predictedCost}  actual=${r.actualSteps}  ratio=${r.accuracy.toFixed(2)}`,
    );
  }
  return lines.join("\n");
}
