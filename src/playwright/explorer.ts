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
  /**
   * Hook called immediately after each new state is captured, while the
   * page is still live in that state. Lets callers run probes (keyboard,
   * menu, modal) against newly-revealed targets without restructuring
   * the exploration flow. The returned state replaces the captured one
   * in the result. Used by the CLI / MCP to probe targets that only
   * exist inside revealed branches (menu items, dialog content, tab
   * panel contents).
   *
   * The hook receives the captured state plus the set of target IDs
   * that are NEW to this state (not seen in prior states) — probes
   * typically only need to run against the new delta, since initial-state
   * targets were already probed before explore started.
   */
  onStateRevealed?: (
    state: PageState,
    newTargetIds: Set<string>,
    page: Page,
    budget: { remainingMs: () => number },
  ) => Promise<PageState>;
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
  | "interactive"
  | "pagination"
  | "load-more"
  | "step-next";

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

  const remainingMs = (): number =>
    Math.max(0, totalTimeout - (Date.now() - explorationStart));

  const hasBudget = (): boolean => remainingMs() > 0;

  const boundedTimeout = (requested: number): number =>
    Math.max(1, Math.min(requested, remainingMs()));

  const waitWithinBudget = async (ms: number): Promise<void> => {
    if (!hasBudget()) return;
    await page.waitForTimeout(boundedTimeout(ms));
  };

  async function exploreAt(depth: number): Promise<void> {
    const totalTargets = states.reduce((sum, s) => sum + s.targets.length, 0);
    if (depth >= maxDepth || actionsPerformed >= maxActions || totalTargets >= maxTotalTargets || !hasBudget()) return;

    // Wait for page to settle before discovering candidates.
    // 300ms is the minimum observed for framework hydration to attach
    // click handlers — dropping this causes flake on React/Vue fixtures
    // where the event listener isn't wired when we query.
    await page
      .waitForLoadState("domcontentloaded", { timeout: boundedTimeout(1000) })
      .catch(() => {});
    await waitWithinBudget(300);
    if (!hasBudget()) {
      skippedBudget++;
      return;
    }

    let explorables = await findExplorableElements(page);

    // Retry once at depth 0 if no candidates — catches SPA hydration
    // windows longer than the 300ms baseline. 1s is the empirically-
    // observed upper bound for mainstream SPAs to hydrate visibly.
    if (explorables.length === 0 && depth === 0 && hasBudget()) {
      await waitWithinBudget(1000);
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
      if (!hasBudget()) {
        skippedBudget += explorables.length - branchCount;
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
        await activateElement(page, el, boundedTimeout(actionTimeout));
        actionsPerformed++;
        branchCount++;
        branchesExplored++;

        // Wait for animations / SPA state transitions. 300ms (reduced
        // from 500ms) because captureState's own convergence polling
        // catches slower renders anyway — this is just the initial
        // debounce to avoid sampling mid-animation.
        await waitWithinBudget(300);
        if (!hasBudget()) {
          skippedBudget++;
          break;
        }

        // Capture the new state
        const captureSpaWaitTimeout = Math.min(options.spaWaitTimeout ?? 5000, remainingMs());
        const newState = await captureState(page, {
          ...options,
          provenance: "explored",
          spaWaitTimeout: captureSpaWaitTimeout,
        });

        // Check novelty
        const isNovel = !seenHashes.has(newState.snapshotHash);
        const newTargets = newState.targets.filter((t) => !knownTargetIds.has(t.id));

        if (isNovel) {
          // Determine trigger quality for branch penalty scaling
          const triggerQuality: "well-labeled" | "labeled" | "unlabeled" =
            el.hasPopup && el.name.length > 0 ? "well-labeled" :
            el.name.length > 0 ? "labeled" : "unlabeled";

          // Capture the set of IDs that are new to this revealed state.
          // Must be computed BEFORE knownTargetIds is updated below.
          const newIds = new Set(
            newState.targets.filter((t) => !knownTargetIds.has(t.id)).map((t) => t.id),
          );

          // Mark targets in explored states as requiring branch open,
          // and annotate with the trigger quality for scoring
          let markedState: PageState = {
            ...newState,
            targets: newState.targets.map((t) => ({
              ...t,
              requiresBranchOpen: !knownTargetIds.has(t.id),
              // Pass trigger quality through as a passthrough field
              ...(!knownTargetIds.has(t.id) ? { _branchTriggerQuality: triggerQuality } : {}),
            })),
          };

          // Give the caller a chance to probe the new state while the
          // page is still live. Keeps probe data attached to the correct
          // state without requiring state replay. Typically used to run
          // keyboard / menu / modal probes against targets that only
          // exist inside this revealed branch (menu items, dialog body).
          if (options.onStateRevealed && hasBudget()) {
            try {
              markedState = await options.onStateRevealed(
                markedState,
                newIds,
                page,
                { remainingMs },
              );
            } catch {
              // Hook errors must not break exploration — the unprobed
              // state is still useful data.
            }
          }

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
          if (hasBudget() && (newTargets.length > 0 || !stopOnNoNovelty)) {
            await exploreAt(depth + 1);
          }
        }

        // Try to restore previous state
        await restoreState(page, el, boundedTimeout(actionTimeout));
        await waitWithinBudget(100);
      } catch {
        // Element may have become stale or action failed — continue
        try {
          await restoreState(page, el, boundedTimeout(actionTimeout));
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

  // Pagination / load-more / step-next triggers. Detected via a combination
  // of accessible-name patterns AND structural hints. These reveal new
  // content without opening an overlay — instead they update the page's
  // main content region with the next page / additional items / the next
  // step of a multi-step flow. Safe to activate because:
  //   - they're non-destructive (no "Submit", "Delete", etc. — see safety.ts)
  //   - they typically don't leave the current URL
  //   - restoration: we can click again to go back, or accept the new state
  //     as a valid revealed state in the exploration tree
  //
  // Detection uses a "flow pattern" classifier that matches accname against
  // well-known English patterns. Future: i18n via profile-specific patterns.
  const flowPatterns = await discoverFlowTriggers(page);
  for (const trig of flowPatterns) {
    // Dedup: skip if we already added this locator as a menu-trigger or similar.
    const alreadyQueued = explorables.some((e) =>
      e.name === trig.name && e.role === trig.role,
    );
    if (alreadyQueued) continue;
    explorables.push(trig);
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

/**
 * Discover pagination / load-more / step-next triggers.
 *
 * These UI patterns don't use standard ARIA roles — they're typically
 * `<button>` or `<a>` whose only signal is their accessible name. A
 * checkout's "Continue to payment" button is role=button just like a
 * destructive "Delete account" button, and we can't tell them apart by
 * role alone. Detection uses a pattern list matched against accname.
 *
 * Kept conservative: we only match phrases that appear on a narrow set of
 * navigation patterns. Adjacent-to-destructive phrases ("Submit order",
 * "Confirm purchase") are excluded so we don't auto-click them during
 * exploration.
 */
async function discoverFlowTriggers(page: Page): Promise<ExplorableElement[]> {
  // Patterns are grouped by the kind of flow they implement. Grouping
  // lets us attach the right ExploreType to each match, so finding-builder
  // can reason about what kind of state change happened.
  const PAGINATION_PATTERNS = [
    /^next(\s+page)?$/i,
    /^prev(ious)?(\s+page)?$/i,
    /^page\s+\d+$/i,
    /^go\s+to\s+page\s+\d+$/i,
  ];
  const LOAD_MORE_PATTERNS = [
    /^load\s+more/i,
    /^show\s+more/i,
    /^view\s+more/i,
    /^see\s+more/i,
    /^more\s+results/i,
  ];
  const STEP_PATTERNS = [
    /^continue(\s+to\s+\w+)?$/i,
    /^next(\s+step)?$/i,
    /^proceed(\s+to\s+\w+)?$/i,
    // "Step N" or "Go to step N"
    /^step\s+\d+/i,
  ];

  const classify = (name: string): ExploreType | null => {
    if (PAGINATION_PATTERNS.some((p) => p.test(name))) return "pagination";
    if (LOAD_MORE_PATTERNS.some((p) => p.test(name))) return "load-more";
    if (STEP_PATTERNS.some((p) => p.test(name))) return "step-next";
    return null;
  };

  const results: ExplorableElement[] = [];
  // Scope to button-like elements. role=link also counts because pagination
  // is often anchors (`<a href="?page=2">`).
  const candidates = page.locator(
    'button, [role="button"], a[href], [role="link"]',
  );
  const count = Math.min(await candidates.count(), 200); // cap discovery work
  for (let i = 0; i < count; i++) {
    const el = candidates.nth(i);
    const accname = (
      (await el.getAttribute("aria-label")) ??
      (await el.textContent()) ??
      ""
    ).trim();
    if (!accname || accname.length > 50) continue; // skip unreadable/generic
    const type = classify(accname);
    if (!type) continue;
    // Skip disabled / aria-disabled — they won't activate anyway.
    const disabled = await el.isDisabled().catch(() => false);
    if (disabled) continue;
    const ariaDisabled =
      (await el.getAttribute("aria-disabled")) === "true";
    if (ariaDisabled) continue;
    results.push({
      locator: el,
      role: (await el.getAttribute("role")) === "link" ? "link" : "button",
      name: accname,
      type,
    });
  }
  return results;
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

async function restoreState(
  page: Page,
  el: ExplorableElement,
  timeout: number = 2000,
): Promise<void> {
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
        await el.locator.click({ timeout });
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
    case "pagination":
    case "load-more":
    case "step-next": {
      // These reveal new content without opening an overlay. Restoration
      // approach depends on the pattern:
      //  - pagination: a "Previous" link typically exists; easiest is to
      //    accept the new state (we've captured it) and let subsequent
      //    exploration queries the fresh DOM.
      //  - load-more: appends items to the list; the previous state is
      //    a prefix of the current, so no restoration needed.
      //  - step-next: reaches the next step of a flow; the previous step
      //    may or may not be reachable (some flows are one-way). We don't
      //    try to go back — downstream exploration works with the new step.
      // Net: all three are "fire-and-keep" — no explicit restore. The
      // explorer's novelty check ensures we don't re-activate the same
      // trigger if it's still present after.
      break;
    }
    default: {
      // Best effort: press Escape
      await page.keyboard.press("Escape");
      await page.waitForTimeout(100);
    }
  }
}
