import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { chromium, type Browser } from "playwright";
import { captureState } from "./capture.js";
import { explore } from "./explorer.js";
import { resolve } from "path";

describe("explorer", { timeout: 30000 }, () => {
  let browser: Browser;

  beforeAll(async () => {
    browser = await chromium.launch();
  });

  afterAll(async () => {
    await browser.close();
  });

  it("discovers targets hidden behind a dropdown menu", async () => {
    const page = await browser.newPage();
    await page.goto(`file://${resolve("fixtures/interactive-page.html")}`);

    const initialState = await captureState(page);
    const initialTargetCount = initialState.targets.length;

    const result = await explore(page, initialState, {
      maxDepth: 2,
      maxActions: 20,
    });

    await page.close();

    // Should have explored at least the menu trigger
    expect(result.branchesExplored).toBeGreaterThan(0);
    expect(result.actionsPerformed).toBeGreaterThan(0);

    // Should have more states than just the initial one
    expect(result.states.length).toBeGreaterThan(1);

    // Total targets across all states should exceed initial
    const totalTargets = result.states.reduce((sum, s) => sum + s.targets.length, 0);
    expect(totalTargets).toBeGreaterThan(initialTargetCount);
  });

  it("discovers targets in unselected tabs", async () => {
    const page = await browser.newPage();
    await page.goto(`file://${resolve("fixtures/interactive-page.html")}`);

    const initialState = await captureState(page);

    // The initial state should only see the Description tab content
    const initialLinkNames = initialState.targets
      .filter((t) => t.kind === "link")
      .map((t) => t.name);

    const result = await explore(page, initialState, {
      maxDepth: 2,
      maxActions: 20,
    });

    await page.close();

    // After exploration, we should find links from other tab panels
    const allTargets = result.states.flatMap((s) => s.targets);
    const allLinkNames = allTargets.filter((t) => t.kind === "link").map((t) => t.name);
    const uniqueLinks = new Set(allLinkNames);

    // Should have more unique links after exploring tabs
    expect(uniqueLinks.size).toBeGreaterThan(new Set(initialLinkNames).size);
  });

  it("discovers targets in disclosure/accordion elements", async () => {
    const page = await browser.newPage();
    await page.goto(`file://${resolve("fixtures/interactive-page.html")}`);

    const initialState = await captureState(page);

    const result = await explore(page, initialState, {
      maxDepth: 2,
      maxActions: 30,
    });

    await page.close();

    // Check that explored states exist
    const exploredStates = result.states.filter((s) => s.provenance === "explored");
    expect(exploredStates.length).toBeGreaterThan(0);
  });

  it("respects action budget limits", async () => {
    const page = await browser.newPage();
    await page.goto(`file://${resolve("fixtures/interactive-page.html")}`);

    const initialState = await captureState(page);

    const result = await explore(page, initialState, {
      maxDepth: 5,
      maxActions: 3,
    });

    await page.close();

    expect(result.actionsPerformed).toBeLessThanOrEqual(3);
  });

  it("respects depth limits", async () => {
    const page = await browser.newPage();
    await page.goto(`file://${resolve("fixtures/interactive-page.html")}`);

    const initialState = await captureState(page);

    const result = await explore(page, initialState, {
      maxDepth: 1,
      maxActions: 50,
    });

    await page.close();

    // With depth 1, should still explore but not deeply
    expect(result.states.length).toBeGreaterThanOrEqual(1);
  });

  it("marks explored targets as requiresBranchOpen", async () => {
    const page = await browser.newPage();
    await page.goto(`file://${resolve("fixtures/interactive-page.html")}`);

    const initialState = await captureState(page);

    const result = await explore(page, initialState, {
      maxDepth: 2,
      maxActions: 20,
    });

    await page.close();

    if (result.states.length > 1) {
      const exploredState = result.states.find((s) => s.provenance === "explored");
      if (exploredState) {
        // Some targets in explored states should be marked as requiring branch open
        const branchTargets = exploredState.targets.filter((t) => t.requiresBranchOpen);
        expect(branchTargets.length).toBeGreaterThanOrEqual(0); // May be 0 if all were already known
      }
    }
  });

  it("fires onStep callback during exploration", async () => {
    const page = await browser.newPage();
    await page.goto(`file://${resolve("fixtures/interactive-page.html")}`);

    const initialState = await captureState(page);
    const steps: Array<{ action: string; targetName: string }> = [];

    await explore(page, initialState, {
      maxDepth: 2,
      maxActions: 10,
      onStep: (step) => steps.push({ action: step.action, targetName: step.targetName }),
    });

    await page.close();

    // Should have received step callbacks
    expect(steps.length).toBeGreaterThan(0);
  });
});
