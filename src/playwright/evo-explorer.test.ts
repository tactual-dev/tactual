import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { chromium, type Browser, type BrowserContext } from "playwright";
import { captureState } from "./capture.js";
import { evoExplore } from "./evo-explorer.js";

async function mock(context: BrowserContext, body: string): Promise<void> {
  await context.route("http://tactual.test/", (route) =>
    route.fulfill({ contentType: "text/html", body }),
  );
}

describe("evoExplore", () => {
  let browser: Browser;
  beforeAll(async () => {
    browser = await chromium.launch();
  });
  afterAll(async () => {
    await browser.close();
  });

  it("explores interaction sequences and finds states beyond the initial", async () => {
    // Three buttons. Clicking them changes a status div, which alters
    // ariaSnapshot and produces distinct states.
    const HTML = `<!DOCTYPE html><html lang="en"><head><title>Evo</title></head>
      <body><main>
        <h1>Evo</h1>
        <button id="a">Open A</button>
        <button id="b">Open B</button>
        <button id="c">Open C</button>
        <div id="status" role="status" aria-live="polite"></div>
        <script>
          document.getElementById('a').addEventListener('click', () =>
            document.getElementById('status').textContent = 'A is open');
          document.getElementById('b').addEventListener('click', () =>
            document.getElementById('status').textContent = 'B is open');
          document.getElementById('c').addEventListener('click', () =>
            document.getElementById('status').textContent = 'C is open');
        </script>
      </main></body></html>`;

    const context = await browser.newContext();
    await mock(context, HTML);
    const page = await context.newPage();
    await page.goto("http://tactual.test/", { waitUntil: "load" });
    const initialState = await captureState(page, { provenance: "scripted" });

    // Tiny population/generations to bound test time. Even with 3 sequences
    // of length 2, the algorithm should reach at least one more state.
    const result = await evoExplore(page, initialState, {
      populationSize: 3,
      generations: 2,
      sequenceLength: 2,
      randomSeed: 42,
    });
    await context.close();

    expect(result.totalSequencesEvaluated).toBe(6); // 3 × 2
    expect(result.bestFitness).toBeGreaterThan(0);
    expect(result.bestSequence.length).toBeGreaterThan(0);
    // At minimum we should visit the initial state — usually more.
    expect(result.bestSequenceStates.length).toBeGreaterThan(0);
  }, 60000);

  it("returns immediately with no candidates when initialState has no safe interactive targets", async () => {
    const HTML = `<!DOCTYPE html><html lang="en"><head><title>Empty</title></head>
      <body><main><h1>Just text</h1><p>No buttons.</p></main></body></html>`;

    const context = await browser.newContext();
    await mock(context, HTML);
    const page = await context.newPage();
    await page.goto("http://tactual.test/", { waitUntil: "load" });
    const initialState = await captureState(page, { provenance: "scripted", minTargets: 1 });

    const result = await evoExplore(page, initialState, {
      populationSize: 4,
      generations: 2,
      sequenceLength: 3,
    });
    await context.close();

    expect(result.totalSequencesEvaluated).toBe(0);
    expect(result.generationsRun).toBe(0);
    expect(result.bestSequence).toEqual([]);
  }, 30000);
});
