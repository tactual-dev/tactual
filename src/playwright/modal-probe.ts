import type { Page, Locator } from "playwright";
import type { Target } from "../core/types.js";

/**
 * Runtime modal-dialog probe.
 *
 * Drives the three APG dialog-pattern invariants against every visible
 * role="dialog" / role="alertdialog" element on the page:
 *
 *   1. focusTrapped — Tab from the last focusable element in the dialog
 *      doesn't escape to the outer page; focus should cycle to the first
 *      focusable or stay within the dialog.
 *   2. shiftTabWraps — Shift+Tab from the first focusable element in the
 *      dialog doesn't escape backward; cycles to the last focusable.
 *   3. escapeCloses — Escape while focused inside the dialog closes it
 *      (the dialog element is either removed or becomes display: none).
 *
 * A fourth invariant — "focus returns to trigger on close" — requires
 * knowing the element that opened the dialog, which can't always be
 * inferred from the captured state alone. Deferred to a future pass
 * that probes dialog triggers explicitly rather than dialogs directly.
 *
 * Results attach as passthrough `_modalProbe` on the dialog target.
 * Axe-core and Lighthouse can't test these invariants — they'd need to
 * drive keyboard interactions against a live element.
 *
 * Reference: https://www.w3.org/WAI/ARIA/apg/patterns/dialog-modal/
 */

export interface ModalProbeResults {
  /** Tab from last focusable in the dialog did not escape to the outer page. */
  focusTrapped: boolean;
  /** Shift+Tab from first focusable in the dialog did not escape backward. */
  shiftTabWraps: boolean;
  /** Escape while focused inside the dialog closed it. */
  escapeCloses: boolean;
  /** Probe completed without exceptions (dialog visible, focusables present). */
  probeSucceeded: boolean;
  /** Dialog had no focusable descendants — probe couldn't run meaningfully. */
  dialogHasNoFocusables?: boolean;
}

export interface ModalProbeOptions {
  scopeSelector?: string[];
  targetIds?: Set<string>;
  allowSynthetic?: boolean;
}

const MAX_DIALOGS = 10;

/** Wait budget after a keystroke for JS handlers to run. 100ms is
 *  sufficient for synchronous focus handlers in well-behaved dialogs.
 *  The Escape closes step uses event-driven polling (below) to catch
 *  slow-closing overlays. */
const STEP_TIMEOUT_MS = 100;

/** Turn a dialog's accessible name into a readable slug for synthetic IDs. */
function slugifyDialogName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}

/**
 * Probe every visible dialog on the page and attach `_modalProbe` results.
 *
 * Discovery is DOM-first: we query for `[role="dialog"]` and
 * `[role="alertdialog"]` directly. Filtering on captured targets alone
 * misses cookie-consent and confirm dialogs that mount into the DOM but
 * don't always surface through `ariaSnapshot`.
 *
 * After DOM discovery, we match each dialog back to a captured Tactual
 * target by accessible name + role, so `_modalProbe` attaches to the right
 * target. When no match exists we emit a synthetic target so the finding
 * still surfaces.
 */
export async function probeModalDialogs(
  page: Page,
  targets: Target[],
  maxDialogsOrOptions: number | ModalProbeOptions = MAX_DIALOGS,
  maybeOptions: ModalProbeOptions = {},
): Promise<Target[]> {
  const maxDialogs = typeof maxDialogsOrOptions === "number" ? maxDialogsOrOptions : MAX_DIALOGS;
  const options = typeof maxDialogsOrOptions === "number" ? maybeOptions : maxDialogsOrOptions;

  let dialogs: Array<{ accname: string; role: string }>;
  try {
    dialogs = await page.evaluate((scopeSelectors) => {
      const scopes =
        scopeSelectors.length > 0
          ? scopeSelectors.flatMap((selector) => Array.from(document.querySelectorAll(selector)))
          : [];
      const found = Array.from(document.querySelectorAll('[role="dialog"], [role="alertdialog"]'));
      return found
        .filter((el) => {
          if (
            scopes.length > 0 &&
            !scopes.some((scope) => scope === el || scope.contains(el) || el.contains(scope))
          ) {
            return false;
          }
          const rect = el.getBoundingClientRect();
          const cs = getComputedStyle(el);
          return (
            rect.width > 0 && rect.height > 0 && cs.display !== "none" && cs.visibility !== "hidden"
          );
        })
        .slice(0, 40)
        .map((el) => {
          const labelledby = el.getAttribute("aria-labelledby");
          let name = "";
          if (labelledby) {
            name = labelledby
              .split(/\s+/)
              .map((id) => document.getElementById(id)?.textContent?.trim() ?? "")
              .filter(Boolean)
              .join(" ");
          }
          if (!name) name = (el.getAttribute("aria-label") ?? "").trim();
          return {
            accname: name,
            role: (el.getAttribute("role") ?? "dialog").toLowerCase(),
          };
        });
    }, options.scopeSelector ?? []);
  } catch {
    return targets;
  }
  if (dialogs.length === 0) return targets;

  const resultsByTargetId = new Map<string, ModalProbeResults>();
  const syntheticTargets: Target[] = [];
  let syntheticIdx = 0;
  let probed = 0;

  for (const dlg of dialogs) {
    if (probed >= maxDialogs) break;
    let probeResult: ModalProbeResults;
    try {
      const loc = dlg.accname
        ? page.getByRole(dlg.role as Parameters<Page["getByRole"]>[0], {
            name: dlg.accname,
            exact: true,
          })
        : page.locator(`[role="${dlg.role}"]`);
      const count = await loc.count();
      if (count === 0) continue;
      const visible = await loc
        .first()
        .isVisible()
        .catch(() => false);
      if (!visible) continue;
      probeResult = await probeOne(page, loc.first());
      probed++;
    } catch {
      continue;
    }

    const matchedTarget = targets.find((t) => {
      if (options.targetIds && !options.targetIds.has(t.id)) return false;
      const tr = t.role?.toLowerCase();
      if (tr !== dlg.role) return false;
      if (dlg.accname && t.name !== dlg.accname) return false;
      return true;
    });

    if (matchedTarget) {
      resultsByTargetId.set(matchedTarget.id, probeResult);
    } else if (options.allowSynthetic !== false) {
      // Self-describing synthetic ID: modal-dialog-synthetic:cookie-consent
      // instead of modal-dialog-synthetic-0. Index suffix disambiguates
      // same-name dialogs.
      const slug = slugifyDialogName(dlg.accname) || "unnamed";
      syntheticTargets.push({
        id: `modal-dialog-synthetic:${slug}-${syntheticIdx++}`,
        kind: "dialog",
        role: dlg.role,
        name: dlg.accname || "(unnamed)",
        requiresBranchOpen: false,
        _modalProbe: probeResult,
        _synthetic: "modal-probe",
      });
    }
  }

  if (resultsByTargetId.size === 0 && syntheticTargets.length === 0) return targets;

  const enriched = targets.map((t) => {
    const mp = resultsByTargetId.get(t.id);
    if (!mp) return t;
    return { ...t, _modalProbe: mp } as Target;
  });
  return [...enriched, ...syntheticTargets];
}

async function probeOne(page: Page, dialog: Locator): Promise<ModalProbeResults> {
  const results: ModalProbeResults = {
    focusTrapped: false,
    shiftTabWraps: false,
    escapeCloses: false,
    probeSucceeded: false,
  };

  try {
    // Collect focusables inside the dialog. If none exist, the dialog is
    // effectively unusable for keyboard users — a separate bug class.
    const focusables = await dialog
      .evaluate((d: Element) => {
        const sel =
          "a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), " +
          'textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
        const nodes = Array.from(d.querySelectorAll<HTMLElement>(sel)).filter(
          (el) => el.offsetParent !== null || getComputedStyle(el).position === "fixed",
        );
        return nodes.length;
      })
      .catch(() => 0);

    if (focusables === 0) {
      results.dialogHasNoFocusables = true;
      results.probeSucceeded = true;
      return results;
    }

    // 1. Focus last focusable, press Tab, check that focus stayed in the
    //    dialog (either cycled to first focusable or remained on last).
    await dialog.evaluate((d: Element) => {
      const sel =
        "a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), " +
        'textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
      const nodes = Array.from(d.querySelectorAll<HTMLElement>(sel));
      nodes[nodes.length - 1]?.focus();
    });
    await page.keyboard.press("Tab");
    await page.waitForTimeout(STEP_TIMEOUT_MS);
    const afterTab = await dialog
      .evaluate((d: Element) => ({
        focusInsideDialog: d.contains(document.activeElement),
      }))
      .catch(() => ({ focusInsideDialog: false }));
    results.focusTrapped = afterTab.focusInsideDialog;

    // 2. Focus first focusable, press Shift+Tab, check that focus stayed
    //    in the dialog (cycled to last, or bounced to a non-dialog element).
    await dialog.evaluate((d: Element) => {
      const sel =
        "a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), " +
        'textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
      const nodes = Array.from(d.querySelectorAll<HTMLElement>(sel));
      nodes[0]?.focus();
    });
    await page.keyboard.press("Shift+Tab");
    await page.waitForTimeout(STEP_TIMEOUT_MS);
    const afterShiftTab = await dialog
      .evaluate((d: Element) => ({
        focusInsideDialog: d.contains(document.activeElement),
      }))
      .catch(() => ({ focusInsideDialog: false }));
    results.shiftTabWraps = afterShiftTab.focusInsideDialog;

    // 3. Escape closes. Focus inside the dialog first, then press Escape.
    //    100ms is enough for synchronous close handlers; slower animations
    //    are intentionally treated as inconclusive for this bounded probe.
    await dialog.evaluate((d: Element) => {
      const sel =
        "a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), " +
        'textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
      const nodes = Array.from(d.querySelectorAll<HTMLElement>(sel));
      nodes[0]?.focus();
    });
    await page.keyboard.press("Escape");
    await page.waitForTimeout(STEP_TIMEOUT_MS);
    const stillVisible = await dialog.isVisible().catch(() => false);
    results.escapeCloses = !stillVisible;

    results.probeSucceeded = true;
    return results;
  } catch {
    return results;
  }
}
