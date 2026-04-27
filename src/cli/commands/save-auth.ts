import type { Command } from "commander";
import {
  runSaveAuth,
  SaveAuthError,
  stepsFromCliFlags,
} from "../../pipeline/save-auth.js";

export function registerSaveAuth(program: Command): void {
  program
    .command("save-auth")
    .description("Authenticate with a web app and save session state for later analysis")
    .argument("<url>", "Login page URL")
    .option("-o, --output <path>", "Output file for storageState JSON", "tactual-auth.json")
    .option("--click <text>", "Click a button/link with this text")
    .option("--fill <pairs...>", "Fill form fields: selector=value (e.g., '#email=user@test.com')")
    .option("--wait-for-url <pattern>", "Wait until URL contains this string")
    .option("--timeout <ms>", "Timeout per step in ms", "30000")
    .action(async (url: string, opts: Record<string, unknown>) => {
      try {
        const steps = stepsFromCliFlags({
          fill: opts.fill as string[] | undefined,
          click: opts.click as string | undefined,
          waitForUrl: opts.waitForUrl as string | undefined,
        });
        const result = await runSaveAuth({
          url,
          steps,
          outputPath: (opts.output as string) ?? "tactual-auth.json",
          timeout: parseInt((opts.timeout as string) ?? "30000", 10),
          restrictOutputToCwd: false,
        });
        console.log(`Auth state saved to ${result.saved}`);
        console.log(
          `Use with: tactual analyze-url <url> --storage-state ${result.saved}`,
        );
      } catch (err) {
        if (err instanceof SaveAuthError) {
          console.error(err.message);
        } else {
          console.error(
            `Auth failed: ${err instanceof Error ? err.message : err}`,
          );
        }
        process.exit(1);
      }
    });
}
