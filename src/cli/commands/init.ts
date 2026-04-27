import type { Command } from "commander";

export function registerInit(program: Command): void {
  program
    .command("init")
    .description("Create a tactual.json config file in the current directory")
    .action(async () => {
      const fs = await import("fs/promises");
      const { existsSync } = await import("fs");
      if (existsSync("tactual.json")) {
        console.error("tactual.json already exists.");
        process.exit(1);
      }
      const template = {
        profile: "nvda-desktop-v0",
        exclude: [],
        focus: [],
        suppress: [],
        threshold: 70,
      };
      await fs.writeFile("tactual.json", JSON.stringify(template, null, 2) + "\n", "utf-8");
      console.log("Created tactual.json");
    });
}
