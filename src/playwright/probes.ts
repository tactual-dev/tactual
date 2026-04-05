import type { Page } from "playwright";
import type { Target } from "../core/types.js";

/**
 * Runtime keyboard probe results stored on Target via passthrough fields.
 *
 * Each probe is a lightweight Playwright interaction (~100ms) that tests
 * actual keyboard behavior rather than inferring from ARIA role.
 */
export interface ProbeResults {
  /** Element received focus via Tab or click */
  focusable: boolean;
  /** Element responded to Enter/Space activation */
  activatable: boolean;
  /** After activation, Escape returned focus to the trigger or a logical position */
  escapeRestoresFocus: boolean;
  /** After activation, focus was not trapped (Tab moves focus forward) */
  focusNotTrapped: boolean;
  /** After activation, aria-expanded or similar state changed */
  stateChanged: boolean;
  /** Element is reachable via Tab key (not tabindex="-1") */
  tabbable: boolean;
  /** Element has positive tabindex (anti-pattern: forces non-standard Tab order) */
  hasPositiveTabindex: boolean;
  /** Probe completed successfully (false = element was stale/detached) */
  probeSucceeded: boolean;
}

/** Maximum targets to probe per page (keeps total time under ~3s) */
const MAX_PROBE_TARGETS = 20;

/** Timeout per individual probe action in ms */
const PROBE_ACTION_TIMEOUT = 2000;

/** Roles worth probing — non-interactive roles don't need keyboard testing */
const PROBEABLE_ROLES = new Set([
  // Links excluded: clicking navigates away from the page.
  // Links are well-supported across all AT — operability is inherently 100.
  "button", "menuitem", "menuitemcheckbox", "menuitemradio",
  "tab", "switch", "checkbox", "radio", "combobox", "listbox",
  "slider", "spinbutton", "treeitem", "option",
  "menu", "dialog", "alertdialog",
]);

/**
 * Run lightweight keyboard probes on interactive targets.
 *
 * For each probeable target (up to MAX_PROBE_TARGETS):
 * 1. Click to focus the element
 * 2. Check if it received focus
 * 3. Press Enter to activate
 * 4. Check if state changed (aria-expanded, dialog opened, etc.)
 * 5. Press Escape to dismiss
 * 6. Check if focus returned to the trigger
 * 7. Press Tab to verify focus isn't trapped
 *
 * Results are stored as extra fields on the Target object via the
 * passthrough Zod schema. The finding builder reads these to replace
 * role-based operability/recovery guesses with runtime observations.
 *
 * Each probe restores page state (Escape + focus return) so probes
 * don't interfere with subsequent analysis.
 */
export async function probeTargets(
  page: Page,
  targets: Target[],
): Promise<Target[]> {
  const probeable = targets.filter(
    (t) => PROBEABLE_ROLES.has(t.role?.toLowerCase() ?? ""),
  );

  // Prioritize targets most likely to have operability issues:
  // stateful/focus-managing roles first, then by DOM order
  const prioritized = [...probeable].sort((a, b) => {
    const aWeight = probeWeight(a.role);
    const bWeight = probeWeight(b.role);
    return bWeight - aWeight;
  });

  const toProbe = prioritized.slice(0, MAX_PROBE_TARGETS);
  const probed = new Map<string, ProbeResults>();

  for (const target of toProbe) {
    // Record URL before probe to detect navigation-triggering buttons
    const urlBefore = page.url();

    const result = await probeTarget(page, target);

    // If the probe navigated away (submit button, link-like button),
    // restore the page and mark this probe as failed
    const urlAfter = page.url();
    if (urlAfter !== urlBefore) {
      await page.goBack({ waitUntil: "domcontentloaded" }).catch(() => {});
      await page.waitForTimeout(500);
      probed.set(target.id, { ...result, probeSucceeded: false });
      continue;
    }

    // Retry once only if the probe failed (element stale/detached)
    if (!result.probeSucceeded) {
      const retry = await probeTarget(page, target);
      probed.set(target.id, retry);
    } else {
      probed.set(target.id, result);
    }
  }

  // Annotate targets with probe results
  return targets.map((t) => {
    const probe = probed.get(t.id);
    if (!probe) return t;
    return { ...t, _probe: probe } as Target;
  });
}

/** Higher weight = more important to probe (complex interaction patterns) */
function probeWeight(role: string): number {
  const weights: Record<string, number> = {
    combobox: 10, menu: 9, dialog: 9, alertdialog: 9, treeitem: 8,
    listbox: 7, tab: 7, slider: 6, spinbutton: 6,
    menuitem: 5, menuitemcheckbox: 5, menuitemradio: 5,
    switch: 4, checkbox: 3, radio: 3,
    button: 2, link: 1, option: 1,
  };
  return weights[role?.toLowerCase()] ?? 0;
}

/**
 * Probe a single target element.
 */
async function probeTarget(page: Page, target: Target): Promise<ProbeResults> {
  const fail: ProbeResults = {
    focusable: false, activatable: false, escapeRestoresFocus: false,
    focusNotTrapped: false, stateChanged: false, tabbable: false,
    hasPositiveTabindex: false, probeSucceeded: false,
  };

  try {
    // Build a locator from role + name
    const locator = target.name
      ? page.getByRole(target.role as Parameters<Page["getByRole"]>[0], { name: target.name })
      : page.locator(`[role="${target.role}"]`).first();

    // Bail if not visible/attached
    const isVisible = await locator.isVisible().catch(() => false);
    if (!isVisible) return fail;

    // Check tab reachability and tabindex patterns.
    // Context-aware: roving tabindex (tabindex="-1" with a sibling at "0")
    // is the correct ARIA APG pattern for tabs/grids, not a bug.
    const tabIndexInfo = await locator.evaluate((el: Element) => {
      const ti = (el as HTMLElement).tabIndex;
      const explicit = el.getAttribute("tabindex");
      const role = el.getAttribute("role") ?? "";

      // Check for roving tabindex pattern: sibling elements with
      // the same role where at least one has tabindex="0"
      let isRovingTabindex = false;
      if (explicit === "-1" && el.parentElement) {
        const siblings = Array.from(el.parentElement.querySelectorAll(`[role="${role}"]`));
        for (let si = 0; si < siblings.length; si++) {
          if (siblings[si] !== el && siblings[si].getAttribute("tabindex") === "0") {
            isRovingTabindex = true;
            break;
          }
        }
      }

      // Check if positive tabindex is used broadly (framework pattern)
      // vs isolated (likely a mistake)
      let positiveTabindexCount = 0;
      if (explicit && parseInt(explicit, 10) > 0) {
        positiveTabindexCount = document.querySelectorAll("[tabindex]").length;
      }

      return { tabIndex: ti, explicit, isRovingTabindex, positiveTabindexCount };
    }).catch(() => ({ tabIndex: 0, explicit: null, isRovingTabindex: false, positiveTabindexCount: 0 }));

    // tabindex="-1" in a roving tabindex pattern is correct — don't penalize
    const tabbable = tabIndexInfo.tabIndex >= 0 || tabIndexInfo.isRovingTabindex;
    // Positive tabindex: only flag if it's isolated usage (< 5 elements).
    // If many elements use it (Blazor/framework pattern), it's a framework
    // convention, not a per-element mistake.
    const hasPositiveTabindex = tabIndexInfo.explicit !== null
      && parseInt(tabIndexInfo.explicit, 10) > 0
      && tabIndexInfo.positiveTabindexCount < 5;

    // Record initial focus state
    const initialActiveId = await page.evaluate(() =>
      document.activeElement?.id || document.activeElement?.tagName || "none",
    ).catch(() => "none");

    // 1. Click to focus
    await locator.click({ timeout: PROBE_ACTION_TIMEOUT }).catch(() => {});
    await page.waitForTimeout(50);

    // 2. Check focus
    const focusedAfterClick = await page.evaluate((role) => {
      const el = document.activeElement;
      if (!el) return false;
      return el.getAttribute("role") === role || el.tagName.toLowerCase() === role;
    }, target.role).catch(() => false);

    // Also accept focus on a child (e.g., clicking a menu focuses a menuitem)
    const hasFocus = focusedAfterClick || await page.evaluate(() =>
      document.activeElement !== document.body,
    ).catch(() => false);

    // 3. Check pre-activation state
    const preState = await getElementState(page, locator);

    // 4. Press Enter to activate
    await page.keyboard.press("Enter");
    await page.waitForTimeout(100);

    // 5. Check post-activation state
    const postState = await getElementState(page, locator);
    const stateChanged = preState !== postState;

    // Determine if this element triggers an overlay (menu, dialog, popover).
    // Only run Escape/recovery probes on overlay-triggering elements.
    // Simple toggles (dark mode, aria-pressed) don't open overlays.
    // aria-expanded alone isn't enough — a toggle can have aria-expanded
    // without being an overlay trigger. Must also have haspopup or controls.
    const triggersOverlay = await locator.evaluate((el: Element) => {
      const hasPopup = el.hasAttribute("aria-haspopup");
      const hasControls = el.hasAttribute("aria-controls");
      const isOverlayRole = ["menu", "combobox", "dialog", "alertdialog"].includes(
        el.getAttribute("role") ?? "",
      );
      // aria-expanded is only an overlay signal WITH haspopup or controls
      const expandsOverlay = el.hasAttribute("aria-expanded") && (hasPopup || hasControls);
      return hasPopup || expandsOverlay || isOverlayRole;
    }).catch(() => false);

    let escapeRestoresFocus = true;
    let focusNotTrapped = true;

    if (triggersOverlay) {
      // 6. Record focus position before Escape
      const focusBeforeEscape = await page.evaluate(() =>
        document.activeElement?.id || document.activeElement?.getAttribute("role") || "unknown",
      ).catch(() => "unknown");

      // 7. Press Escape to dismiss
      await page.keyboard.press("Escape");
      await page.waitForTimeout(100);

      // 8. Check if focus returned to trigger or a logical position
      const focusAfterEscape = await page.evaluate(() =>
        document.activeElement?.id || document.activeElement?.getAttribute("role") || "unknown",
      ).catch(() => "unknown");

      escapeRestoresFocus =
        focusAfterEscape !== focusBeforeEscape || focusAfterEscape === initialActiveId;

      // 9. Tab to check for focus traps
      await page.keyboard.press("Tab");
      await page.waitForTimeout(50);
      const focusAfterTab = await page.evaluate(() =>
        document.activeElement?.id || document.activeElement?.getAttribute("role") || "unknown",
      ).catch(() => "unknown");

      focusNotTrapped = focusAfterTab !== focusAfterEscape;
    }

    // Restore: Escape any remaining state, then click body to defocus
    await page.keyboard.press("Escape").catch(() => {});
    await page.evaluate(() => (document.activeElement as HTMLElement)?.blur?.()).catch(() => {});

    return {
      focusable: hasFocus,
      activatable: stateChanged || hasFocus,
      escapeRestoresFocus,
      focusNotTrapped,
      stateChanged,
      tabbable,
      hasPositiveTabindex,
      probeSucceeded: true,
    };
  } catch {
    return fail;
  }
}

/**
 * Get the current interaction state of an element (expanded, checked, pressed, selected).
 */
async function getElementState(_page: Page, locator: import("playwright").Locator): Promise<string> {
  try {
    const state = await locator.evaluate((el: Element) => {
      return [
        el.getAttribute("aria-expanded"),
        el.getAttribute("aria-checked"),
        el.getAttribute("aria-pressed"),
        el.getAttribute("aria-selected"),
        el.getAttribute("aria-hidden"),
      ].filter(Boolean).join(",");
    });
    return state || "none";
  } catch {
    return "unknown";
  }
}

