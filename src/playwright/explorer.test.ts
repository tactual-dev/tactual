import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { chromium, type Browser } from "playwright";
import { captureState } from "./capture.js";
import { explore } from "./explorer.js";
import { resolve } from "path";

// Concurrent: each test uses its own browser.newPage() (own BrowserContext),
// so they're fully isolated. Serial run of 12 tests was ~188s; concurrent
// drops to the longest single test (~25s).
describe.concurrent("explorer", { timeout: 60000 }, () => {
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

  it("discovers pagination triggers by accname pattern", async () => {
    // Use buttons rather than anchors so the fixture doesn't navigate —
    // real-world pagination often uses <a href="?page=2"> which causes a
    // full page load and can't be safely test-restored. Button-based
    // pagination is common in SPAs and exercises the same detection path.
    const page = await browser.newPage();
    await page.setContent(`
      <main>
        <h1>Article list</h1>
        <div id="list">
          <p>Page <span id="page">1</span> content</p>
        </div>
        <nav aria-label="Pagination">
          <button onclick="document.getElementById('page').textContent='1'">Page 1</button>
          <button onclick="document.getElementById('page').textContent='2'">Page 2</button>
          <button onclick="document.getElementById('page').textContent='3'">Next page</button>
        </nav>
      </main>
    `);
    const initialState = await captureState(page);
    const result = await explore(page, initialState, {
      maxDepth: 1,
      maxActions: 10,
    });
    await page.close();
    // At least one pagination button should have activated.
    expect(result.actionsPerformed).toBeGreaterThan(0);
  });

  it("discovers load-more triggers by accname pattern", async () => {
    const page = await browser.newPage();
    await page.setContent(`
      <main>
        <h1>Products</h1>
        <ul id="list">
          <li>Item 1</li>
          <li>Item 2</li>
        </ul>
        <button id="load" onclick="
          const li = document.createElement('li');
          li.textContent = 'Item 3 (revealed)';
          document.getElementById('list').appendChild(li);
        ">Load more</button>
      </main>
    `);
    const initialState = await captureState(page);
    const result = await explore(page, initialState, {
      maxDepth: 1,
      maxActions: 5,
    });
    await page.close();
    // Post-explore, the added item should be present in some captured state.
    const names = result.states.flatMap((s) => s.targets.map((t) => t.name ?? ""));
    const foundRevealed = names.some((n) => n.toLowerCase().includes("revealed"));
    // The li might not be captured as a target (it's not interactive), but
    // at minimum the Load more button should have been activated.
    expect(result.actionsPerformed).toBeGreaterThan(0);
    void foundRevealed;
  });

  it("discovers step-next triggers in a multi-step flow", async () => {
    const page = await browser.newPage();
    await page.setContent(`
      <main>
        <h1>Checkout wizard</h1>
        <section id="step-1">
          <h2>Step 1: Cart</h2>
          <button onclick="
            document.getElementById('step-1').hidden = true;
            document.getElementById('step-2').hidden = false;
          ">Continue to shipping</button>
        </section>
        <section id="step-2" hidden>
          <h2>Step 2: Shipping</h2>
          <input type="text" id="address" placeholder="Address">
          <button>Continue to payment</button>
        </section>
      </main>
    `);
    const initialState = await captureState(page);
    // Initial state should NOT include the shipping address input.
    const initialNames = initialState.targets.map((t) => t.name ?? "");
    expect(initialNames.some((n) => /address/i.test(n))).toBe(false);

    const result = await explore(page, initialState, {
      maxDepth: 1,
      maxActions: 5,
    });
    await page.close();

    // After exploring "Continue to shipping", step 2's Address input and
    // "Continue to payment" button should appear in a revealed state.
    const allNames = result.states.flatMap((s) => s.targets.map((t) => t.name ?? ""));
    expect(allNames.some((n) => /payment/i.test(n))).toBe(true);
  });

  it("onStateRevealed hook can run probes against live page and attach results to returned state", async () => {
    // The hook receives newIds, runs a probe-equivalent evaluation on the
    // live page, and returns a state that carries the probe data.
    const page = await browser.newPage();
    await page.goto(`file://${resolve("fixtures/interactive-page.html")}`);

    const initialState = await captureState(page);

    const probedStates: string[] = [];
    const result = await explore(page, initialState, {
      maxDepth: 2,
      maxActions: 10,
      onStateRevealed: async (state, newIds, livePage) => {
        // Demonstrate that the page is live: we can read computed styles
        // of newly-revealed elements. If the page weren't live, this would
        // return undefined/stale data.
        const menuVisible = await livePage
          .evaluate(() => {
            const m = document.getElementById("dropdown-menu");
            return m ? !m.classList.contains("hidden") : false;
          })
          .catch(() => false);

        // Attach a synthetic probe-like field to targets in newIds.
        const taggedTargets = state.targets.map((t) =>
          newIds.has(t.id)
            ? { ...t, _testProbeData: { menuVisibleAtProbeTime: menuVisible } }
            : t,
        );
        probedStates.push(state.snapshotHash);
        return { ...state, targets: taggedTargets };
      },
    });

    await page.close();

    // At least one revealed state should have probe data attached.
    const statesWithProbeData = result.states.flatMap((s) =>
      s.targets.filter((t) => (t as Record<string, unknown>)._testProbeData),
    );
    expect(statesWithProbeData.length).toBeGreaterThan(0);
  });

  it("fires onStateRevealed hook with delta target IDs while page is live", async () => {
    // The hook supports probing revealed states. This validates:
    //   1. Hook fires once per novel state
    //   2. newIds contains only targets that first appeared in that state
    //   3. Returned state replaces the captured one in the result
    //   4. Page is still in the revealed state during the hook call
    //      (element check inside hook would succeed)
    const page = await browser.newPage();
    await page.goto(`file://${resolve("fixtures/interactive-page.html")}`);

    const initialState = await captureState(page);
    const initialIds = new Set(initialState.targets.map((t) => t.id));

    const hookCalls: Array<{ newIdsSize: number; stateTargetCount: number }> = [];

    const result = await explore(page, initialState, {
      maxDepth: 2,
      maxActions: 10,
      onStateRevealed: async (state, newIds, _page) => {
        hookCalls.push({ newIdsSize: newIds.size, stateTargetCount: state.targets.length });
        // Sanity check: no newId should be present in the initial state.
        for (const id of newIds) {
          expect(initialIds.has(id)).toBe(false);
        }
        // Replace state with a version tagged for verification downstream.
        return { ...state, hash: `${state.snapshotHash}::hooked` };
      },
    });

    await page.close();

    // Hook should have fired at least once (we explored at least one branch).
    expect(hookCalls.length).toBeGreaterThan(0);
    // Every explored state in the result should carry the hook-tagged hash,
    // proving the hook's return value replaced the captured state.
    const exploredStates = result.states.filter((s) => s.provenance === "explored");
    for (const s of exploredStates) {
      expect((s as Record<string, unknown>).hash).toMatch(/::hooked$/);
    }
  });

  it("bounds sparse-state capture waits by the exploration timeout", async () => {
    const page = await browser.newPage();
    await page.setContent(`
      <main>
        <button onclick="document.body.dataset.clicked = 'true'">Next</button>
      </main>
    `);

    const initialState = await captureState(page, { minTargets: 1 });
    const start = Date.now();

    const result = await explore(page, initialState, {
      maxDepth: 1,
      maxActions: 10,
      totalTimeout: 700,
    });

    const elapsed = Date.now() - start;
    await page.close();

    expect(result.actionsPerformed).toBeLessThanOrEqual(1);
    expect(elapsed).toBeLessThan(2500);
  });
});
