import type { Page, Locator } from "playwright";
import type { PageState } from "../core/types.js";
import { captureState, type CaptureOptions } from "./capture.js";
import { checkActionSafety } from "./safety.js";

// ---------------------------------------------------------------------------
// Explorer configuration
// ---------------------------------------------------------------------------

export interface ExploreOptions extends CaptureOptions {
  /** Maximum exploration depth (default: 3) */
  maxDepth?: number;
  /** Maximum total actions across all branches (default: 50) */
  maxActions?: number;
  /** Maximum branches to explore per state (default: 10) */
  maxBranchesPerState?: number;
  /** Stop exploring a branch when no new targets appear (default: true) */
  stopOnNoNovelty?: boolean;
  /** Timeout per action in ms (default: 5000) */
  actionTimeout?: number;
  /** Total exploration timeout in ms (default: 120000) */
  totalTimeout?: number;
  /** Maximum accumulated targets before stopping (default: 2000) */
  maxTotalTargets?: number;
  /** Whether to explore external links (default: false) */
  followExternalLinks?: boolean;
  /** Patterns that override safety policy — matching "unsafe" elements become explorable */
  allowActionPatterns?: RegExp[];
  /** Callback fired after each exploration step */
  onStep?: (step: ExplorationStep) => void;
}

export interface ExplorationStep {
  action: string;
  targetName: string;
  depth: number;
  newTargetsFound: number;
  totalStates: number;
}

export interface ExploreResult {
  /** All captured states (initial + explored) */
  states: PageState[];
  /** Number of branches explored */
  branchesExplored: number;
  /** Number of actions taken */
  actionsPerformed: number;
  /** Branches skipped due to safety policy */
  skippedUnsafe: number;
  /** Elements skipped by the safety policy (role:name + reason). Use --allow-action to override. */
  skippedElements: Array<{ id: string; reason: string }>;
  /** Branches skipped due to budget limits */
  skippedBudget: number;
}

// ---------------------------------------------------------------------------
// Explorable element detection
// ---------------------------------------------------------------------------

interface ExplorableElement {
  locator: Locator;
  role: string;
  name: string;
  type: ExploreType;
  expanded?: boolean;
  hasPopup?: boolean;
}

type ExploreType =
  | "menu-trigger"
  | "disclosure"
  | "tab"
  | "dialog-trigger"
  | "accordion"
  | "expandable"
  | "interactive";

/**
 * Explore bounded interactive branches from the current page state.
 *
 * Starting from the page's current state, the explorer:
 * 1. Identifies explorable triggers (menus, tabs, disclosures, dialogs)
 * 2. Activates each safely, capturing the resulting state
 * 3. Marks newly discovered targets as requiring branch open
 * 4. Restores the page to its previous state (dismiss/back)
 * 5. Respects depth, action, and novelty budgets
 */
export async function explore(
  page: Page,
  initialState: PageState,
  options: ExploreOptions = {},
): Promise<ExploreResult> {
  const maxDepth = options.maxDepth ?? 3;
  const maxActions = options.maxActions ?? 50;
  const maxBranches = options.maxBranchesPerState ?? 10;
  const stopOnNoNovelty = options.stopOnNoNovelty ?? true;
  const actionTimeout = options.actionTimeout ?? 5000;
  const totalTimeout = options.totalTimeout ?? 120000;
  const maxTotalTargets = options.maxTotalTargets ?? 2000;
  const explorationStart = Date.now();

  const states: PageState[] = [initialState];
  const seenHashes = new Set<string>([initialState.snapshotHash]);
  const knownTargetIds = new Set(initialState.targets.map((t) => t.id));

  let actionsPerformed = 0;
  let branchesExplored = 0;
  let skippedUnsafe = 0;
  const skippedElements: Array<{ id: string; reason: string }> = [];
  let skippedBudget = 0;

  async function exploreAt(depth: number): Promise<void> {
    const totalTargets = states.reduce((sum, s) => sum + s.targets.length, 0);
    const elapsed = Date.now() - explorationStart;
    if (depth >= maxDepth || actionsPerformed >= maxActions || totalTargets >= maxTotalTargets || elapsed >= totalTimeout) return;

    // Wait for the page to settle before discovering candidates.
    // SPAs may still be rendering after navigation/activation.
    await page.waitForLoadState("domcontentloaded").catch(() => {});
    await page.waitForTimeout(300);

    let explorables = await findExplorableElements(page);

    // Retry once if no candidates found — catches SPA timing gaps
    if (explorables.length === 0 && depth === 0) {
      await page.waitForTimeout(1000);
      explorables = await findExplorableElements(page);
    }

    let branchCount = 0;

    for (const el of explorables) {
      if (branchCount >= maxBranches) {
        skippedBudget += explorables.length - branchCount;
        break;
      }
      if (actionsPerformed >= maxActions) {
        skippedBudget++;
        break;
      }

      // Safety check (allow patterns override unsafe → caution)
      const safety = checkActionSafety({
        role: el.role,
        name: el.name,
        expanded: el.expanded,
        hasPopup: el.hasPopup,
      }, options.allowActionPatterns);

      if (safety.safety === "unsafe") {
        skippedUnsafe++;
        const elId = `${el.role}:${el.name || "(unnamed)"}`;
        if (!skippedElements.some((s) => s.id === elId)) {
          skippedElements.push({ id: elId, reason: safety.reason });
        }
        continue;
      }

      // Activate the element
      try {
        await activateElement(page, el, actionTimeout);
        actionsPerformed++;
        branchCount++;
        branchesExplored++;

        // Wait for animations / SPA state transitions
        await page.waitForTimeout(500);

        // Capture the new state
        const newState = await captureState(page, {
          ...options,
          provenance: "explored",
        });

        // Check novelty
        const isNovel = !seenHashes.has(newState.snapshotHash);
        const newTargets = newState.targets.filter((t) => !knownTargetIds.has(t.id));

        if (isNovel) {
          // Determine trigger quality for branch penalty scaling
          const triggerQuality: "well-labeled" | "labeled" | "unlabeled" =
            el.hasPopup && el.name.length > 0 ? "well-labeled" :
            el.name.length > 0 ? "labeled" : "unlabeled";

          // Mark targets in explored states as requiring branch open,
          // and annotate with the trigger quality for scoring
          const markedState: PageState = {
            ...newState,
            targets: newState.targets.map((t) => ({
              ...t,
              requiresBranchOpen: !knownTargetIds.has(t.id),
              // Pass trigger quality through as a passthrough field
              ...(!knownTargetIds.has(t.id) ? { _branchTriggerQuality: triggerQuality } : {}),
            })),
          };

          states.push(markedState);
          seenHashes.add(newState.snapshotHash);

          for (const t of newState.targets) {
            knownTargetIds.add(t.id);
          }

          options.onStep?.({
            action: el.type,
            targetName: el.name,
            depth,
            newTargetsFound: newTargets.length,
            totalStates: states.length,
          });

          // Recurse into the new state if there are novel targets
          if (newTargets.length > 0 || !stopOnNoNovelty) {
            await exploreAt(depth + 1);
          }
        }

        // Try to restore previous state
        await restoreState(page, el);
        await page.waitForTimeout(100);
      } catch {
        // Element may have become stale or action failed — continue
        try {
          await restoreState(page, el);
        } catch {
          // Best effort restoration
        }
      }
    }
  }

  await exploreAt(0);

  return {
    states,
    branchesExplored,
    actionsPerformed,
    skippedUnsafe,
    skippedElements,
    skippedBudget,
  };
}

// ---------------------------------------------------------------------------
// Element discovery
// ---------------------------------------------------------------------------

async function findExplorableElements(page: Page): Promise<ExplorableElement[]> {
  const explorables: ExplorableElement[] = [];

  // Menu triggers: buttons with aria-haspopup or aria-expanded
  const expandButtons = page.locator(
    'button[aria-expanded], button[aria-haspopup], [role="button"][aria-expanded], [role="button"][aria-haspopup]',
  );
  const expandCount = await expandButtons.count();
  for (let i = 0; i < expandCount; i++) {
    const el = expandButtons.nth(i);
    const name = (await el.getAttribute("aria-label")) ?? (await el.textContent()) ?? "";
    const expanded = (await el.getAttribute("aria-expanded")) === "true";
    const hasPopup = (await el.getAttribute("aria-haspopup")) !== null;

    // Skip already-expanded elements
    if (expanded) continue;

    explorables.push({
      locator: el,
      role: "button",
      name: name.trim(),
      type: hasPopup ? "menu-trigger" : "disclosure",
      expanded,
      hasPopup,
    });
  }

  // Tabs: elements with role="tab" that are not selected
  const tabs = page.locator('[role="tab"][aria-selected="false"]');
  const tabCount = await tabs.count();
  for (let i = 0; i < tabCount; i++) {
    const el = tabs.nth(i);
    const name = (await el.getAttribute("aria-label")) ?? (await el.textContent()) ?? "";
    explorables.push({
      locator: el,
      role: "tab",
      name: name.trim(),
      type: "tab",
    });
  }

  // Details/summary (native HTML disclosure)
  const details = page.locator("details:not([open]) > summary");
  const detailsCount = await details.count();
  for (let i = 0; i < detailsCount; i++) {
    const el = details.nth(i);
    const name = (await el.textContent()) ?? "";
    explorables.push({
      locator: el,
      role: "disclosure",
      name: name.trim(),
      type: "accordion",
    });
  }

  // Sort by stable key (role + name) to make exploration deterministic
  // across page loads where DOM order may vary due to React rendering.
  explorables.sort((a, b) => {
    const keyA = `${a.role}:${a.name}`;
    const keyB = `${b.role}:${b.name}`;
    return keyA.localeCompare(keyB);
  });

  return explorables;
}

// ---------------------------------------------------------------------------
// Element activation and state restoration
// ---------------------------------------------------------------------------

async function activateElement(
  page: Page,
  el: ExplorableElement,
  timeout: number,
): Promise<void> {
  await el.locator.click({ timeout });

  // For menu triggers, wait for the menu to appear
  if (el.type === "menu-trigger" || el.hasPopup) {
    await page
      .locator('[role="menu"], [role="listbox"], [role="dialog"]')
      .first()
      .waitFor({ state: "visible", timeout: 1000 })
      .catch(() => {});
  }
}

async function restoreState(page: Page, el: ExplorableElement): Promise<void> {
  switch (el.type) {
    case "menu-trigger": {
      // Press Escape to close menu
      await page.keyboard.press("Escape");
      await page.waitForTimeout(100);
      break;
    }
    case "disclosure":
    case "accordion":
    case "expandable": {
      // Click again to collapse, or press Escape
      try {
        await el.locator.click({ timeout: 2000 });
      } catch {
        await page.keyboard.press("Escape");
      }
      await page.waitForTimeout(100);
      break;
    }
    case "tab": {
      // Tabs don't need restoration — the state change is the new tab
      break;
    }
    case "dialog-trigger": {
      await page.keyboard.press("Escape");
      await page.waitForTimeout(100);
      break;
    }
    default: {
      // Best effort: press Escape
      await page.keyboard.press("Escape");
      await page.waitForTimeout(100);
    }
  }
}
