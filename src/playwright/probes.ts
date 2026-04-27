import type { Locator, Page } from "playwright";
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
  /** After activation, Escape returned focus to the trigger or a logical position */
  escapeRestoresFocus: boolean;
  /** After activation, focus was not trapped (Tab moves focus forward) */
  focusNotTrapped: boolean;
  /** After activation, an ARIA state attribute (expanded/checked/pressed/selected) changed */
  stateChanged: boolean;
  /** Element is reachable via Tab key (not tabindex="-1") */
  tabbable: boolean;
  /** Element has positive tabindex (anti-pattern: forces non-standard Tab order) */
  hasPositiveTabindex: boolean;
  /** Element contains a nested focusable child, creating duplicate tab stops */
  nestedFocusable: boolean;
  /** Focus indicator is suppressed (outline: none / 0px with no visible replacement) */
  focusIndicatorSuppressed: boolean;
  /** Probe completed successfully (false = element was stale/detached) */
  probeSucceeded: boolean;
  /** ARIA state attributes captured before the activation key was pressed */
  ariaStateBeforeEnter?: Record<string, string>;
  /** ARIA state attributes captured after the activation key was pressed.
   *  Compared against simulateAction's prediction to detect pattern deviations. */
  ariaStateAfterEnter?: Record<string, string>;
  /**
   * Where focus landed after the user pressed Enter on the trigger:
   *
   *   - `stayed`        — document.activeElement === the trigger itself
   *                       (expected for toggle buttons, disclosure buttons,
   *                       plain actions that don't reveal new content)
   *   - `moved-inside`  — focus is now within the trigger element
   *                       (unusual; happens with wrapping patterns)
   *   - `moved-away`    — focus is somewhere else on the page
   *                       (expected for buttons that open modals / panels:
   *                       focus should move into the newly-revealed content)
   *   - `moved-to-body` — focus is on document.body (focus was LOST — this
   *                       is the buggy case, user is now at page start)
   *
   * A penalty fires only on `moved-to-body`. The `moved-away` case is
   * ambiguous without knowing the intended destination — could be correct
   * (focus moved into new content) or incorrect (focus went somewhere
   * unrelated). We capture it but don't penalize without more context.
   */
  focusAfterActivation?: "stayed" | "moved-inside" | "moved-away" | "moved-to-body";
  /** Whether the trigger element is still attached to the DOM after activation.
   *  False when the click handler re-renders or unmounts the element (common
   *  in React-style component trees). When false, `ariaStateAfterEnter` may
   *  read from a detached node (all attrs empty) and pattern-deviation
   *  comparisons against the prediction should be skipped. */
  elementStillConnected?: boolean;
  /** Internal retry hint for probe orchestration. */
  failureReason?: "not-visible" | "error";
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
  maxTargets: number = MAX_PROBE_TARGETS,
): Promise<Target[]> {
  const probeable = targets.filter(
    (t) =>
      PROBEABLE_ROLES.has(t.role?.toLowerCase() ?? "") &&
      !isConsentManagementTarget(t),
  );

  // Prioritize targets most likely to have operability issues. Uses the
  // richer ranking signals (requiresBranchOpen, aria-haspopup/controls/
  // expanded presence, plus role weight) so budget flows to risky targets
  // first. Critical when maxTargets is smaller than probeable.length —
  // e.g., `--probe-mode fast` (budget 5) on a 50-target page.
  const prioritized = prioritizeTargetsForProbing(probeable);

  const toProbe = prioritized.slice(0, maxTargets);
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

    // Retry once only for transient probe errors. Targets that simply are not
    // visible in the current state should not burn the probe budget twice.
    if (!result.probeSucceeded && result.failureReason === "error") {
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

function isConsentManagementTarget(target: Target): boolean {
  const name = target.name.toLowerCase().replace(/\s+/g, " ").trim();
  return [
    "cookie settings",
    "cookies settings",
    "cookie preferences",
    "manage cookies",
    "allow all cookies",
    "accept all cookies",
    "reject all cookies",
    "privacy preferences",
    "customize choices",
    "consent choices",
    "consent preferences",
    "privacy settings",
    "manage consent",
    "cookies verwalten",
    "alle cookies akzeptieren",
    "cookies ablehnen",
    "parametres des cookies",
    "accepter les cookies",
    "refuser les cookies",
    "preferencias de cookies",
    "aceptar cookies",
    "rechazar cookies",
    "preferenze cookie",
    "accetta cookie",
    "rifiuta cookie",
  ].some((phrase) => name.includes(phrase));
}

/**
 * Score a target's likelihood of surfacing a useful probe finding.
 * Higher score = probe sooner. Used to prioritize when budget is
 * smaller than the candidate set, so we spend probe time where new
 * information is most likely. Informed by which signals empirically
 * correlate with real bugs from the 30-site corpus:
 *
 *   - requiresBranchOpen    +5   (revealed states see less prior testing)
 *   - has aria-haspopup     +4   (menu triggers often break APG)
 *   - has aria-controls     +3   (overlay triggers are stateful)
 *   - has aria-expanded     +3   (stateful toggles / disclosures)
 *   - role weight          +N   (per probeWeight above — combobox/dialog high)
 *
 * Stable secondary ordering: DOM order (targets are already in DOM order
 * at capture time, so the sort preserves input order for equal scores).
 */
export function prioritizeTargetsForProbing<T extends Target>(targets: T[]): T[] {
  const score = (t: T): number => {
    const attrs = (t as unknown as { _attributeValues?: Record<string, string> })
      ._attributeValues ?? {};
    let s = probeWeight(t.role ?? "");
    if (t.requiresBranchOpen) s += 5;
    if (attrs["aria-haspopup"]) s += 4;
    if (attrs["aria-controls"]) s += 3;
    if (attrs["aria-expanded"]) s += 3;
    return s;
  };
  // Stable sort: attach original index, sort by (score DESC, index ASC).
  return targets
    .map((t, i) => ({ t, i, s: score(t) }))
    .sort((a, b) => b.s - a.s || a.i - b.i)
    .map((x) => x.t);
}

/**
 * Probe a single target element.
 */
async function probeTarget(page: Page, target: Target): Promise<ProbeResults> {
  try {
    // Build one concrete locator from role + name. Exact matching avoids
    // strict-mode work on repeated app controls; fallback keeps older fuzzy
    // name matches working when accessible-name normalization differs.
    const locator = await locatorForTarget(page, target);

    // Bail if not visible/attached
    const isVisible = await locator
      .isVisible({ timeout: PROBE_ACTION_TIMEOUT })
      .catch(() => false);
    if (!isVisible) return failProbe("not-visible");

    const tabIndexInfo = await readTabIndexInfo(locator);
    const tabbable = tabIndexInfo.tabIndex >= 0 || tabIndexInfo.isRovingTabindex;
    const hasPositiveTabindex =
      tabIndexInfo.explicit !== null &&
      parseInt(tabIndexInfo.explicit, 10) > 0 &&
      tabIndexInfo.positiveTabindexCount < 5;
    const nestedFocusable = await hasNestedFocusable(locator);

    // Record initial focus state
    const initialActiveId = await page.evaluate(() =>
      document.activeElement?.id || document.activeElement?.tagName || "none",
    ).catch(() => "none");

    // 1. Focus the element the way a keyboard user would. Mouse clicks can
    //    fail for reasons unrelated to keyboard focusability, so focus() is
    //    the right instrument for a keyboard-accessibility probe.
    const hasFocus = await focusTarget(page, locator);
    const focusIndicatorSuppressed = hasFocus
      ? await hasSuppressedFocusIndicator(page)
      : false;

    // 3. Check pre-activation state
    const preStateMap = await getElementStateMap(locator);
    const preState = stateMapToString(preStateMap);

    // 4. Press Enter to activate
    await page.keyboard.press("Enter");

    // 5. Check post-activation state. Stateful controls in React/Vue/etc.
    // may commit aria-* updates on a later microtask/frame, so poll briefly
    // before declaring "no state change". This avoids reading the state in
    // the narrow window after the key event but before the framework commit.
    let postStateMap: Record<string, string>;
    if (preState === "none") {
      await page.waitForTimeout(100);
      postStateMap = await getElementStateMap(locator);
    } else {
      postStateMap = await waitForStateChange(locator, preState, 300);
    }
    const postState = stateMapToString(postStateMap);
    const stateChanged = preState !== postState;

    let focusAfterActivation: ProbeResults["focusAfterActivation"];
    if (hasFocus) {
      focusAfterActivation = await classifyFocusAfterActivation(locator);
      if (focusAfterActivation === "moved-to-body") {
        await page.waitForTimeout(300);
        focusAfterActivation = await classifyFocusAfterActivation(locator);
      }
    }

    // Separately capture whether the element is still in the DOM — used by
    // finding-builder to suppress pattern-deviation findings when the
    // trigger was re-rendered (and thus `ariaStateAfterEnter` reflects a
    // detached/stale node rather than a real attribute-toggle miss).
    const elementStillConnected = await readElementStillConnected(locator);

    if (stateChanged && preState !== "none" && elementStillConnected) {
      await page.keyboard.press("Enter").catch(() => {});
      await waitForStateChange(locator, postState, 300).catch(() => ({}));
    }

    const overlayRecovery = await probeOverlayRecovery(page, locator, initialActiveId);

    // Restore: Escape any remaining state, then click body to defocus
    await restoreAfterProbe(page);

    return {
      focusable: hasFocus,
      escapeRestoresFocus: overlayRecovery.escapeRestoresFocus,
      focusNotTrapped: overlayRecovery.focusNotTrapped,
      stateChanged,
      tabbable,
      hasPositiveTabindex,
      nestedFocusable,
      focusIndicatorSuppressed,
      focusAfterActivation,
      elementStillConnected,
      probeSucceeded: true,
      ariaStateBeforeEnter: preStateMap,
      ariaStateAfterEnter: postStateMap,
    };
  } catch {
    return failProbe("error");
  }
}

function failProbe(failureReason: ProbeResults["failureReason"]): ProbeResults {
  return {
    focusable: false,
    escapeRestoresFocus: false,
    focusNotTrapped: false,
    stateChanged: false,
    tabbable: false,
    hasPositiveTabindex: false,
    nestedFocusable: false,
    focusIndicatorSuppressed: false,
    probeSucceeded: false,
    failureReason,
  };
}

async function readTabIndexInfo(locator: Locator): Promise<{
  tabIndex: number;
  explicit: string | null;
  isRovingTabindex: boolean;
  positiveTabindexCount: number;
}> {
  return await locator
    .evaluate(
      (el: Element) => {
        const tabIndex = (el as HTMLElement).tabIndex;
        const explicit = el.getAttribute("tabindex");
        const role = el.getAttribute("role") ?? "";

        let isRovingTabindex = false;
        if (explicit === "-1" && el.parentElement) {
          const siblings = Array.from(el.parentElement.querySelectorAll(`[role="${role}"]`));
          isRovingTabindex = siblings.some(
            (sibling) => sibling !== el && sibling.getAttribute("tabindex") === "0",
          );
        }

        const positiveTabindexCount =
          explicit && parseInt(explicit, 10) > 0
            ? document.querySelectorAll("[tabindex]").length
            : 0;

        return { tabIndex, explicit, isRovingTabindex, positiveTabindexCount };
      },
      undefined,
      { timeout: PROBE_ACTION_TIMEOUT },
    )
    .catch(() => ({
      tabIndex: 0,
      explicit: null,
      isRovingTabindex: false,
      positiveTabindexCount: 0,
    }));
}

async function hasNestedFocusable(locator: Locator): Promise<boolean> {
  return await locator
    .evaluate(
      (el: Element) => {
        const focusable = el.querySelectorAll(
          'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]',
        );
        return Array.from(focusable).some((child) => {
          const tabIndex = (child as HTMLElement).tabIndex;
          return tabIndex >= 0 && child !== el;
        });
      },
      undefined,
      { timeout: PROBE_ACTION_TIMEOUT },
    )
    .catch(() => false);
}

async function focusTarget(page: Page, locator: Locator): Promise<boolean> {
  await locator.focus({ timeout: PROBE_ACTION_TIMEOUT }).catch(() => {});
  await page.waitForTimeout(50);
  const focusLanded = await locator
    .evaluate(
      (el: Element) => {
        const active = document.activeElement;
        if (!active) return "nothing";
        if (active === el) return "trigger";
        if (el.contains(active)) return "inside";
        if (active === document.body) return "body";
        return "other";
      },
      undefined,
      { timeout: PROBE_ACTION_TIMEOUT },
    )
    .catch(() => "error");
  return focusLanded === "trigger" || focusLanded === "inside";
}

async function hasSuppressedFocusIndicator(page: Page): Promise<boolean> {
  return await page
    .evaluate(() => {
      const el = document.activeElement;
      if (!el) return false;
      const style = getComputedStyle(el);
      const noOutline =
        style.outline === "none" ||
        style.outlineWidth === "0px" ||
        style.outlineStyle === "none";
      const hasBoxShadow = style.boxShadow !== "none" && style.boxShadow !== "";
      const hasBorder = style.borderStyle !== "none" && style.borderWidth !== "0px";
      return noOutline && !hasBoxShadow && !hasBorder;
    })
    .catch(() => false);
}

async function classifyFocusAfterActivation(
  locator: Locator,
): Promise<ProbeResults["focusAfterActivation"]> {
  return (await locator
    .evaluate(
      (el: Element) => {
        const active = document.activeElement;
        if (!(el as Node).isConnected) return "moved-away";
        if (!active) return "moved-to-body";
        if (active === document.body) return "moved-to-body";
        if (active === el) return "stayed";
        if (el.contains(active)) return "moved-inside";
        return "moved-away";
      },
      undefined,
      { timeout: PROBE_ACTION_TIMEOUT },
    )
    .catch(() => undefined)) as ProbeResults["focusAfterActivation"];
}

async function readElementStillConnected(locator: Locator): Promise<boolean> {
  return await locator
    .evaluate((el: Element) => (el as Node).isConnected, undefined, {
      timeout: PROBE_ACTION_TIMEOUT,
    })
    .catch(() => true);
}

async function readOverlayInfo(locator: Locator): Promise<{
  isMenuOrDialog: boolean;
  triggersOverlay: boolean;
}> {
  return await locator
    .evaluate(
      (el: Element) => {
        const hasPopup = el.hasAttribute("aria-haspopup");
        const hasControls = el.hasAttribute("aria-controls");
        const role = el.getAttribute("role") ?? "";
        const isMenuOrDialog =
          ["menu", "dialog", "alertdialog"].includes(role) ||
          el.getAttribute("aria-haspopup") === "menu" ||
          el.getAttribute("aria-haspopup") === "true";
        const isOtherOverlay = role === "combobox" || (hasPopup && !isMenuOrDialog);
        const expandsOverlay = el.hasAttribute("aria-expanded") && (hasPopup || hasControls);
        return {
          isMenuOrDialog,
          triggersOverlay: hasPopup || expandsOverlay || isOtherOverlay || isMenuOrDialog,
        };
      },
      undefined,
      { timeout: PROBE_ACTION_TIMEOUT },
    )
    .catch(() => ({ isMenuOrDialog: false, triggersOverlay: false }));
}

async function probeOverlayRecovery(
  page: Page,
  locator: Locator,
  initialActiveId: string,
): Promise<{ escapeRestoresFocus: boolean; focusNotTrapped: boolean }> {
  const overlayInfo = await readOverlayInfo(locator);
  if (!overlayInfo.triggersOverlay || overlayInfo.isMenuOrDialog) {
    return { escapeRestoresFocus: true, focusNotTrapped: true };
  }

  const focusBeforeEscape = await activeElementToken(page);
  await page.keyboard.press("Escape");
  await page.waitForTimeout(100);
  const focusAfterEscape = await activeElementToken(page);

  const leftOverlay = focusAfterEscape !== focusBeforeEscape;
  const landedOnTrigger = focusAfterEscape === initialActiveId;
  const landedSomewhere = focusAfterEscape !== "unknown" && focusAfterEscape !== "BODY";
  const escapeRestoresFocus = leftOverlay && (landedOnTrigger || landedSomewhere);

  await page.keyboard.press("Tab");
  await page.waitForTimeout(50);
  const focusAfterTab = await activeElementToken(page);

  return {
    escapeRestoresFocus,
    focusNotTrapped: focusAfterTab !== focusAfterEscape,
  };
}

async function activeElementToken(page: Page): Promise<string> {
  return await page
    .evaluate(() => document.activeElement?.id || document.activeElement?.getAttribute("role") || "unknown")
    .catch(() => "unknown");
}

async function restoreAfterProbe(page: Page): Promise<void> {
  await page.keyboard.press("Escape").catch(() => {});
  await page.evaluate(() => (document.activeElement as HTMLElement)?.blur?.()).catch(() => {});
}

async function locatorForTarget(page: Page, target: Target): Promise<Locator> {
  const role = target.role as Parameters<Page["getByRole"]>[0];
  if (target.name) {
    const exact = page.getByRole(role, { name: target.name, exact: true }).first();
    const exactCount = await exact.count().catch(() => 0);
    if (exactCount > 0) return exact;
    return page.getByRole(role, { name: target.name }).first();
  }

  return page.locator(`[role="${escapeAttributeValue(target.role)}"]`).first();
}

function escapeAttributeValue(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/**
 * Get the current interaction state of an element as a key→value map.
 * Used both for stateChanged detection and for pattern-deviation analysis.
 */
async function getElementStateMap(
  locator: Locator,
): Promise<Record<string, string>> {
  try {
    return await locator.evaluate((el: Element) => {
      const out: Record<string, string> = {};
      const attrs = ["aria-expanded", "aria-checked", "aria-pressed", "aria-selected", "aria-hidden", "aria-disabled"];
      for (const a of attrs) {
        const v = el.getAttribute(a);
        if (v !== null) out[a] = v;
      }
      return out;
    }, undefined, { timeout: PROBE_ACTION_TIMEOUT });
  } catch {
    return {};
  }
}

async function waitForStateChange(
  locator: Locator,
  before: string,
  timeoutMs: number,
): Promise<Record<string, string>> {
  const deadline = Date.now() + timeoutMs;
  let latest = await getElementStateMap(locator);
  while (Date.now() < deadline) {
    if (stateMapToString(latest) !== before) return latest;
    await locator.page().waitForTimeout(25);
    latest = await getElementStateMap(locator);
  }
  return latest;
}

/** String form for cheap equality comparison. */
function stateMapToString(m: Record<string, string>): string {
  const keys = Object.keys(m).sort();
  if (keys.length === 0) return "none";
  return keys.map((k) => `${k}=${m[k]}`).join(",");
}
