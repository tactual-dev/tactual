import type { Command } from "commander";
import { listPresets } from "../../core/presets.js";

export function registerPresets(program: Command): void {
  program
    .command("presets")
    .description("List available scoring presets")
    .action(() => {
      const presets = listPresets();
      console.log("Available presets:");
      console.log("");
      for (const p of presets) {
        console.log(`  ${p.id}`);
        console.log(`    ${p.description}`);
        if (p.config.focus) console.log(`    Focus: ${p.config.focus.join(", ")}`);
        const critical = Object.entries(p.config.priority ?? {})
          .filter(([, v]) => v === "critical")
          .map(([k]) => k);
        if (critical.length > 0) console.log(`    Critical targets: ${critical.join(", ")}`);
        console.log("");
      }
      console.log("Usage: npx tactual analyze-url <url> --preset <name>");
    });
}
