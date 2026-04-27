import type { Page, Locator } from "playwright";
import type { Target } from "../core/types.js";

/**
 * Runtime menu-pattern probe.
 *
 * Drives the four APG menu-pattern invariants against every menu trigger
 * on the page:
 *
 *   1. Enter on a focused menu trigger opens the menu — aria-expanded flips
 *      to "true", the [role="menu"] element becomes visible, and focus lands
 *      on a [role="menuitem"].
 *   2. ArrowDown within an open menu advances focus to another menuitem.
 *   3. Escape closes the menu AND returns focus to the trigger
 *      (aria-expanded="false" AND document.activeElement === trigger).
 *   4. Clicking outside the menu closes it.
 *
 * Results attach to the trigger target as passthrough `_menuProbe`. The
 * finding builder reads this to emit menu-pattern-specific penalties with
 * remediation guidance anchored to the APG menu pattern.
 *
 * Neither axe-core nor Lighthouse can test this class of behavior — they
 * run static rule checks and can't drive keyboard interactions against
 * live elements. This is a runtime-probed invariant, the same category
 * as the existing `probeTarget` keyboard checks in probes.ts.
 *
 * Reference: https://www.w3.org/WAI/ARIA/apg/patterns/menu/
 */

export interface MenuProbeResults {
  /** Compound: all three of expandedFlipped + menuDisplayed + focusMovedIntoMenu. */
  opens: boolean;
  /** aria-expanded on the trigger flipped from "false" to "true". */
  expandedFlipped: boolean;
  /** The controlled menu (via aria-controls) is visible, or no aria-controls
   *  so we can't disprove visibility. */
  menuDisplayed: boolean;
  /** Focus moved into a menuitem (APG menu-pattern requirement — keyboard
   *  users need the first item focused, otherwise arrow-key navigation
   *  doesn't work until they Tab into the menu). */
  focusMovedIntoMenu: boolean;
  /** ArrowDown within the open menu moved focus to a different menuitem. */
  arrowDownAdvances: boolean;
  /** Escape closed the menu AND returned focus to the trigger. */
  escapeRestoresFocus: boolean;
  /** Clicking outside the menu closed it. */
  outsideClickCloses: boolean;
  /** Probe completed without exceptions (element found, page stable). */
  probeSucceeded: boolean;
  /** True when the result was inferred from a same-sig exemplar rather
   *  than directly measured. Set on members of an oversized sig group
   *  that were skipped to save probe time — the first 2 exemplars in
   *  the group were probed directly; the rest carry this result via
   *  broadcast. */
  sampledFromExemplar?: boolean;
}

export interface MenuProbeOptions {
  scopeSelector?: string[];
  targetIds?: Set<string>;
}

/** Keep total probe time bounded on menu-heavy pages. 1.5s per trigger × cap. */
const MAX_MENU_TRIGGERS = 20;

/** Maximum wait for an expected state change (aria-expanded flip, menu
 *  hide/show, focus move). Event-driven — returns as soon as the condition
 *  is met, so fast pages stay fast. Timeout applies only when the expected
 *  change never arrives. */
const STEP_TIMEOUT_MS = 400;

/**
 * Turn an accessible name into a kebab-case slug usable in a target ID.
 * Caps at ~40 chars so long dropdown names don't bloat IDs. Used to make
 * synthetic target IDs readable ("menu-trigger-synthetic:language-selector"
 * vs "menu-trigger-synthetic-3").
 */
function slugifyAccname(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}

/**
 * Wait until `predicate` returns true on the trigger element, or timeout.
 * Uses a MutationObserver inside the page to resolve immediately when the
 * DOM condition is met, avoiding fixed-sleep overhead on fast pages and
 * still covering slower ones.
 */
async function waitForTriggerCondition(
  trigger: Locator,
  predicate: (el: Element) => boolean,
  timeoutMs: number,
): Promise<void> {
  await trigger
    .evaluate(
      (el, [fn, timeout]: [string, number]) => {
        const check = new Function("el", `return (${fn})(el);`) as (e: Element) => boolean;
        if (check(el)) return;
        return new Promise<void>((resolve) => {
          const observer = new MutationObserver(() => {
            if (check(el)) {
              observer.disconnect();
              clearTimeout(timer);
              resolve();
            }
          });
          observer.observe(el, {
            attributes: true,
            subtree: true,
            childList: true,
          });
          const timer = setTimeout(() => {
            observer.disconnect();
            resolve();
          }, timeout);
        });
      },
      [predicate.toString(), timeoutMs] as [string, number],
    )
    .catch(() => {});
}

/**
 * Wait for a document-level condition (e.g., focus moved) or timeout.
 * Falls back to polling via animation frames so it's cheap even when no
 * DOM mutation triggers (pure focus changes don't fire MutationObserver).
 */
async function waitForDocumentCondition(
  page: Page,
  predicate: () => boolean,
  timeoutMs: number,
): Promise<void> {
  await page
    .evaluate(
      ([fn, timeout]: [string, number]) => {
        const check = new Function(`return (${fn})();`) as () => boolean;
        if (check()) return;
        return new Promise<void>((resolve) => {
          const deadline = performance.now() + timeout;
          const tick = () => {
            if (check()) {
              resolve();
              return;
            }
            if (performance.now() >= deadline) {
              resolve();
              return;
            }
            requestAnimationFrame(tick);
          };
          requestAnimationFrame(tick);
        });
      },
      [predicate.toString(), timeoutMs] as [string, number],
    )
    .catch(() => {});
}

/**
 * Probe every menu trigger on the page and attach results as `_menuProbe`.
 *
 * Discovery is DOM-first: we query the page for `[aria-haspopup="menu"]` and
 * `[aria-haspopup="true"]` elements directly. Filtering on Tactual targets'
 * `_attributeValues` alone isn't reliable because Playwright's `ariaSnapshot`
 * doesn't always surface `aria-haspopup` as an ARIA token. Chromium's a11y
 * tree can expose the popup relationship via role metadata rather than a
 * distinct attribute token, so captureState's parser can miss otherwise
 * valid DOM menu triggers.
 *
 * After DOM discovery, we match each trigger back to its Tactual target by
 * accessible name + role, so the `_menuProbe` results attach to the right
 * target in the captured set.
 */
export async function probeMenuPatterns(
  page: Page,
  targets: Target[],
  maxTriggersOrOptions: number | MenuProbeOptions = MAX_MENU_TRIGGERS,
  maybeOptions: MenuProbeOptions = {},
): Promise<Target[]> {
  const maxTriggers =
    typeof maxTriggersOrOptions === "number" ? maxTriggersOrOptions : MAX_MENU_TRIGGERS;
  const options = typeof maxTriggersOrOptions === "number" ? maybeOptions : maxTriggersOrOptions;
  // DOM-first discovery. Returns accname + role + sig per visible trigger.
  // `sig` is a structural fingerprint (parent tag + class list + role +
  // haspopup value) used to detect near-identical menu triggers that share
  // the same component implementation — e.g., 20 menu buttons in a data
  // grid row, each rendered from the same React component. When N>3 share
  // a sig, we probe 2 exemplars and emit the result for the whole class.
  let triggers: Array<{ accname: string; role: string; sig: string }>;
  try {
    triggers = await page.evaluate((scopeSelectors) => {
      const scopes =
        scopeSelectors.length > 0
          ? scopeSelectors.flatMap((selector) => Array.from(document.querySelectorAll(selector)))
          : [];
      const sel =
        '[aria-haspopup="menu"]:not([aria-expanded="true"][hidden]), ' +
        '[aria-haspopup="true"]:not([aria-expanded="true"][hidden])';
      const found = Array.from(document.querySelectorAll(sel));
      return found
        .filter((el) => {
          if (
            scopes.length > 0 &&
            !scopes.some((scope) => scope === el || scope.contains(el) || el.contains(scope))
          ) {
            return false;
          }
          const rect = el.getBoundingClientRect();
          return rect.width > 0 && rect.height > 0;
        })
        .slice(0, 40)
        .map((el) => {
          const parent = el.parentElement;
          const parentTag = parent?.tagName ?? "";
          // Sort classes so sibling jitter (e.g., "btn primary" vs "primary
          // btn" in some frameworks) doesn't produce different sigs.
          const parentClasses = parent ? Array.from(parent.classList).sort().join(" ") : "";
          const role = (el.getAttribute("role") ?? el.tagName).toLowerCase();
          const haspopup = el.getAttribute("aria-haspopup") ?? "";
          const sig = `${parentTag}|${parentClasses}|${role}|${haspopup}`;
          return {
            accname: (el.getAttribute("aria-label") ?? el.textContent ?? "").trim(),
            role,
            sig,
          };
        });
    }, options.scopeSelector ?? []);
  } catch {
    return targets;
  }
  if (triggers.length === 0) return targets;

  // Group by sig. For groups with > SAMPLE_THRESHOLD members, probe only
  // the first SAMPLE_COUNT and broadcast the result to the rest. Saves
  // ~1.5s per extra trigger on nav-heavy or grid sites.
  const SAMPLE_THRESHOLD = 3;
  const SAMPLE_COUNT = 2;
  const sigGroups = new Map<
    string,
    Array<{ accname: string; role: string; sig: string; idx: number }>
  >();
  triggers.forEach((t, idx) => {
    if (!t.accname) return;
    const list = sigGroups.get(t.sig) ?? [];
    list.push({ ...t, idx });
    sigGroups.set(t.sig, list);
  });
  // Build a filtered list: from each oversized group, keep only the first
  // SAMPLE_COUNT. The remaining group members are recorded separately so
  // we can broadcast the probe result without re-running probeOne on them.
  const toProbe: Array<{ accname: string; role: string; sig: string; idx: number }> = [];
  const broadcastTargets = new Map<
    string,
    Array<{ accname: string; role: string; sig: string; idx: number }>
  >();
  for (const [sig, group] of sigGroups) {
    if (group.length > SAMPLE_THRESHOLD) {
      toProbe.push(...group.slice(0, SAMPLE_COUNT));
      broadcastTargets.set(sig, group.slice(SAMPLE_COUNT));
    } else {
      toProbe.push(...group);
    }
  }
  // Preserve original DOM order so the first group exemplar is probed
  // early (usually the most visible / canonical one).
  toProbe.sort((a, b) => a.idx - b.idx);
  // Re-use the filtered list under the existing `triggers` name so the
  // existing probe loop below doesn't need restructuring.
  triggers = toProbe;

  const resultsByTargetId = new Map<string, MenuProbeResults>();
  const syntheticTargets: Target[] = [];
  let syntheticIdx = 0;
  let probed = 0;
  // Track probe result per sig so we can broadcast to skipped group members.
  const resultBySig = new Map<string, MenuProbeResults>();
  const matchTarget = (accname: string, role: string): Target | undefined =>
    targets.find((t) => {
      if (options.targetIds && !options.targetIds.has(t.id)) return false;
      if (!t.name || t.name !== accname) return false;
      const tr = t.role?.toLowerCase();
      return (
        tr === role ||
        (tr === "button" && role === "button") ||
        (tr === "menuitem" && role === "menuitem")
      );
    });
  const attachResult = (
    trig: { accname: string; role: string },
    probeResult: MenuProbeResults,
    sampled: boolean,
  ): void => {
    const matchedTarget = matchTarget(trig.accname, trig.role);
    // Mark inferred (via sampling) results so downstream consumers can
    // distinguish a directly-probed finding from a broadcast one.
    const result = sampled
      ? ({ ...probeResult, sampledFromExemplar: true } as MenuProbeResults & {
          sampledFromExemplar: boolean;
        })
      : probeResult;
    if (matchedTarget) {
      resultsByTargetId.set(matchedTarget.id, result);
    } else if (!options.targetIds) {
      // Use the accname in the ID for readability. "menu-trigger-synthetic-3"
      // tells the user nothing; "menu-trigger-synthetic:user-menu" is self-
      // describing. syntheticIdx still suffixes to disambiguate same-name
      // triggers (rare but possible — two "Options" menus on a crowded page).
      const slug = slugifyAccname(trig.accname) || "unnamed";
      syntheticTargets.push({
        id: `menu-trigger-synthetic:${slug}-${syntheticIdx++}`,
        kind: "menuTrigger",
        role: trig.role === "menuitem" ? "menuitem" : "button",
        name: trig.accname,
        requiresBranchOpen: false,
        _menuProbe: result,
        _synthetic: "menu-probe",
      });
    }
  };

  // Every trigger in `triggers` is either a singleton or an exemplar of
  // its sig group — we probe each one directly. Sig-cache is consulted
  // only for the post-loop broadcast to skipped group members.
  for (const trig of triggers) {
    if (probed >= maxTriggers) break;
    if (!trig.accname) continue;

    let probeResult: MenuProbeResults;
    try {
      const loc = page.getByRole(trig.role as Parameters<Page["getByRole"]>[0], {
        name: trig.accname,
        exact: true,
      });
      const count = await loc.count();
      if (count === 0) continue;
      probeResult = await probeOne(page, loc.first());
      probed++;
    } catch {
      continue;
    }
    // Store the FIRST result per sig — broadcast members use the first
    // exemplar's result as representative. We probe up to SAMPLE_COUNT
    // exemplars directly but only the first seeds the broadcast cache.
    if (!resultBySig.has(trig.sig)) resultBySig.set(trig.sig, probeResult);
    attachResult(trig, probeResult, false);
  }

  // Broadcast sampled probes to group members that weren't in the `triggers`
  // list (skipped during the sampling filter). If the exemplar for a sig
  // produced no result (locator missed, trigger re-rendered), the group
  // silently falls through — no broadcast.
  for (const [sig, members] of broadcastTargets) {
    const sampleResult = resultBySig.get(sig);
    if (!sampleResult) continue;
    for (const m of members) {
      if (!m.accname) continue;
      attachResult(m, sampleResult, true);
    }
  }

  if (resultsByTargetId.size === 0 && syntheticTargets.length === 0) return targets;

  const enriched = targets.map((t) => {
    const mp = resultsByTargetId.get(t.id);
    if (!mp) return t;
    return { ...t, _menuProbe: mp } as Target;
  });
  // Append synthetic targets for DOM triggers that had no matching captured
  // target. Captures the finding even when ariaSnapshot missed the trigger.
  return [...enriched, ...syntheticTargets];
}

async function probeOne(page: Page, trigger: Locator): Promise<MenuProbeResults> {
  const results: MenuProbeResults = {
    opens: false,
    expandedFlipped: false,
    menuDisplayed: false,
    focusMovedIntoMenu: false,
    arrowDownAdvances: false,
    escapeRestoresFocus: false,
    outsideClickCloses: false,
    probeSucceeded: false,
  };

  try {
    // Reset focus. Use keyboard.press("Escape") to close any lingering
    // overlays from prior probes. No fixed delay — trigger.focus() below
    // awaits the focus event naturally.
    await page.keyboard.press("Escape").catch(() => {});
    await trigger.focus();

    // 1. Enter opens. Wait for aria-expanded to flip OR timeout. Event-
    //    driven so fast pages don't pay a fixed delay.
    await page.keyboard.press("Enter");
    await waitForTriggerCondition(
      trigger,
      (el) => el.getAttribute("aria-expanded") === "true",
      STEP_TIMEOUT_MS,
    );
    const opensInfo = await trigger
      .evaluate((el: Element) => {
        const controls = el.getAttribute("aria-controls");
        const menu = controls ? document.getElementById(controls) : null;
        const focused = document.activeElement;
        return {
          expanded: el.getAttribute("aria-expanded"),
          menuDisplay: menu ? getComputedStyle(menu).display : null,
          focusedRole: focused?.getAttribute("role") ?? null,
        };
      })
      .catch(() => ({ expanded: null, menuDisplay: null, focusedRole: null }));

    const menuVisible = opensInfo.menuDisplay === null || opensInfo.menuDisplay !== "none";
    results.expandedFlipped = opensInfo.expanded === "true";
    results.menuDisplayed = menuVisible;
    results.focusMovedIntoMenu = opensInfo.focusedRole === "menuitem";
    results.opens = results.expandedFlipped && results.menuDisplayed && results.focusMovedIntoMenu;

    // Proceed with subsequent steps only if the menu is at least visibly
    // open (expanded + displayed). APG focus-into-menu is reported
    // separately — if focus didn't move but the menu is otherwise usable
    // via click, we still want to test Escape + outside-click behavior.
    const menuIsUsable = results.expandedFlipped && results.menuDisplayed;
    if (!menuIsUsable) {
      // Restore page state, mark probe as succeeded (we got a measurement).
      await page.keyboard.press("Escape").catch(() => {});
      results.probeSucceeded = true;
      return results;
    }

    // 2. ArrowDown advances focus within the menu. Wait for activeElement
    //    text to change, or timeout if the menu doesn't respond to arrows.
    const before = await page.evaluate(() => document.activeElement?.textContent?.trim() ?? "");
    await page.evaluate((value) => {
      (window as unknown as { __menuProbeBefore?: string }).__menuProbeBefore = value;
    }, before);
    await page.keyboard.press("ArrowDown");
    await waitForDocumentCondition(
      page,
      () => {
        const active = document.activeElement;
        const txt = active?.textContent?.trim() ?? "";
        return (
          txt.length > 0 &&
          txt !== (window as unknown as { __menuProbeBefore?: string }).__menuProbeBefore
        );
      },
      STEP_TIMEOUT_MS,
    );
    const after = await page.evaluate(() => document.activeElement?.textContent?.trim() ?? "");
    await page.evaluate(() => {
      delete (window as unknown as { __menuProbeBefore?: string }).__menuProbeBefore;
    });
    results.arrowDownAdvances = before !== after && after.length > 0 && before.length > 0;

    // 3. Escape closes + restores focus to trigger. Wait for aria-expanded
    //    to flip back to "false" (or timeout if it never does).
    await page.keyboard.press("Escape");
    await waitForTriggerCondition(
      trigger,
      (el) => el.getAttribute("aria-expanded") === "false",
      STEP_TIMEOUT_MS,
    );
    const escInfo = await trigger
      .evaluate((el: Element) => ({
        expanded: el.getAttribute("aria-expanded"),
        focusedIsTrigger: document.activeElement === el,
      }))
      .catch(() => ({ expanded: null, focusedIsTrigger: false }));
    results.escapeRestoresFocus = escInfo.expanded === "false" && escInfo.focusedIsTrigger;

    // 4. Outside-click closes — reopen then click outside the menu. Click
    //    body at (1, 1) which is almost certainly outside the menu popover.
    await page.keyboard.press("Enter");
    await waitForTriggerCondition(
      trigger,
      (el) => el.getAttribute("aria-expanded") === "true",
      STEP_TIMEOUT_MS,
    );
    await page.mouse.click(1, 1);
    await waitForTriggerCondition(
      trigger,
      (el) => el.getAttribute("aria-expanded") === "false",
      STEP_TIMEOUT_MS,
    );
    const outside = await trigger
      .evaluate((el: Element) => el.getAttribute("aria-expanded"))
      .catch(() => null);
    results.outsideClickCloses = outside === "false";

    // Final cleanup — if menu is still open somehow, close it
    if (outside !== "false") {
      await page.keyboard.press("Escape").catch(() => {});
    }

    results.probeSucceeded = true;
    return results;
  } catch {
    // Something unrecoverable — return whatever we measured so far
    return results;
  }
}
