import type { Command } from "commander";
import { validateUrl } from "../../core/url-validation.js";

export function registerTranscript(program: Command): void {
  program
    .command("transcript <url>")
    .description("Print a screen-reader navigation transcript for a URL - what an SR user hears as they Tab through interactive elements")
    .option("--at <name>", "Screen reader to simulate: nvda | jaws | voiceover", "nvda")
    .option("--timeout <ms>", "Page load timeout", "30000")
    .option("--wait-for-selector <selector>", "CSS selector to wait for (SPAs)")
    .option("--storage-state <path>", "Playwright storageState JSON for authenticated pages")
    .option("--format <format>", "Output format: text | json", "text")
    .action(
      async (
        url: string,
        opts: {
          at?: string;
          timeout?: string;
          waitForSelector?: string;
          storageState?: string;
          format?: string;
        },
      ) => {
        const at = (opts.at ?? "nvda") as "nvda" | "jaws" | "voiceover";
        if (!["nvda", "jaws", "voiceover"].includes(at)) {
          console.error(`Unknown --at value: ${opts.at}. Use: nvda | jaws | voiceover`);
          process.exit(1);
        }

        const urlCheck = validateUrl(url);
        if (!urlCheck.valid) {
          console.error(`Invalid URL: ${urlCheck.error}`);
          process.exit(1);
        }

        let browser;
        try {
          const pw = await import("playwright");
          const { captureState } = await import("../../playwright/capture.js");
          const { buildTranscript } = await import("../../playwright/sr-simulator.js");

          browser = await pw.chromium.launch();
          const contextOpts: Record<string, unknown> = {};
          if (opts.storageState) contextOpts.storageState = opts.storageState;
          const context = await browser.newContext(contextOpts);
          const page = await context.newPage();
          await page.goto(urlCheck.url!, {
            timeout: parseInt(opts.timeout ?? "30000", 10),
          });
          if (opts.waitForSelector) {
            await page.waitForSelector(opts.waitForSelector);
          }

          const state = await captureState(page);
          const transcript = buildTranscript(state.targets, at);

          if (opts.format === "json") {
            console.log(JSON.stringify({ url: urlCheck.url, at, transcript }, null, 2));
          } else {
            console.log(`Transcript (${at.toUpperCase()}, ${transcript.length} steps): ${urlCheck.url}`);
            console.log("");
            for (const step of transcript) {
              const kindLabel = step.kind.padEnd(13);
              console.log(`  ${String(step.step).padStart(3)}. [${kindLabel}] ${step.announcement}`);
            }
          }
        } catch (err) {
          if (
            err instanceof Error &&
            (err.message.includes("Cannot find module") || err.message.includes("Cannot find package"))
          ) {
            console.error("Playwright is required for transcript. Install it: npm install playwright");
            process.exit(1);
          }
          throw err;
        } finally {
          await browser?.close().catch(() => {});
        }
      },
    );
}
