import type { Command } from "commander";

export function registerBenchmark(program: Command): void {
  program
    .command("benchmark")
    .description("Run benchmark suite against local validation fixtures")
    .option(
      "-s, --suite <name>",
      "Benchmark suite to run: public-fixtures | stress-fixtures | multi-profile | all",
      "public-fixtures",
    )
    .action(async (opts: { suite: string }) => {
      try {
        const pw = await import("playwright");
        const { publicFixturesSuite } = await import("../../benchmark/suites/public-fixtures.js");
        const { stressFixturesSuite } = await import("../../benchmark/suites/stress-fixtures.js");
        const { multiProfileSuite } = await import("../../benchmark/suites/multi-profile.js");
        const { runBenchmarkSuite, formatBenchmarkResults } = await import("../../benchmark/runner.js");

        const suites = {
          "public-fixtures": publicFixturesSuite,
          "stress-fixtures": stressFixturesSuite,
          "multi-profile": multiProfileSuite,
        };
        const selectedSuites = opts.suite === "all"
          ? Object.values(suites)
          : [suites[opts.suite as keyof typeof suites]].filter(Boolean);
        if (selectedSuites.length === 0) {
          console.error(`Unknown suite: ${opts.suite}. Available: public-fixtures, stress-fixtures, multi-profile, all`);
          process.exit(1);
        }

        const browser = await pw.chromium.launch();
        let failed = 0;
        try {
          for (const suite of selectedSuites) {
            console.error(`Running benchmark suite: ${suite.name}...`);
            const result = await runBenchmarkSuite(suite, browser, (msg) => {
              console.error(`  ${msg}`);
            });
            console.log(formatBenchmarkResults(result));
            failed += result.totalFailed;
          }
        } finally {
          await browser.close();
        }

        if (failed > 0) process.exit(1);
      } catch (err) {
        if (err instanceof Error && (err.message.includes("Cannot find module") || err.message.includes("Cannot find package"))) {
          console.error("Playwright is required for benchmarks. Install it: npm install playwright");
          process.exit(1);
        }
        throw err;
      }
    });
}
