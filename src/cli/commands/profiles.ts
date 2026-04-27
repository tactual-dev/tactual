import type { Command } from "commander";
import { getProfile, listProfiles } from "../../profiles/index.js";

export function registerProfiles(program: Command): void {
  program
    .command("profiles")
    .description("List available AT profiles")
    .action(() => {
      const profiles = listProfiles();
      const idWidth = Math.max(...profiles.map((id) => id.length));
      console.log("Available profiles:");
      console.log("");
      for (const id of profiles) {
        const p = getProfile(id);
        const platform = (p?.platform ?? "").padEnd(7);
        console.log(`  ${id.padEnd(idWidth)}  ${platform}  ${p?.description ?? ""}`);
      }
      console.log("");
      console.log("Usage: npx tactual analyze-url <url> --profile <id>");
    });
}
