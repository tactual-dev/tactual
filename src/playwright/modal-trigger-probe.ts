import type { Locator, Page } from "playwright";
import type { Target } from "../core/types.js";

export interface ModalTriggerProbeResults {
  opensDialog: boolean;
  focusMovedInside: boolean;
  tabStaysInside: boolean;
  escapeCloses: boolean;
  focusReturnedToTrigger: boolean;
  probeSucceeded: boolean;
  dialogHasNoFocusables?: boolean;
  sampledFromExemplar?: boolean;
}

export interface ModalTriggerProbeOptions {
  scopeSelector?: string[];
  targetIds?: Set<string>;
}

interface ModalTriggerCandidate {
  accname: string;
  role: string;
  nameIndex: number;
  sig: string;
  controls?: string;
}

const MAX_MODAL_TRIGGERS = 10;
const STEP_TIMEOUT_MS = 500;
const SAMPLE_THRESHOLD = 3;
const SAMPLE_COUNT = 2;

export async function probeModalTriggers(
  page: Page,
  targets: Target[],
  maxTriggersOrOptions: number | ModalTriggerProbeOptions = MAX_MODAL_TRIGGERS,
  maybeOptions: ModalTriggerProbeOptions = {},
): Promise<Target[]> {
  const maxTriggers =
    typeof maxTriggersOrOptions === "number" ? maxTriggersOrOptions : MAX_MODAL_TRIGGERS;
  const options = typeof maxTriggersOrOptions === "number" ? maybeOptions : maxTriggersOrOptions;

  let triggers: ModalTriggerCandidate[];
  try {
    triggers = await page.evaluate((scopeSelectors) => {
      const scopes =
        scopeSelectors.length > 0
          ? scopeSelectors.flatMap((selector) => Array.from(document.querySelectorAll(selector)))
          : [];
      const seenByName = new Map<string, number>();
      const candidates: ModalTriggerCandidate[] = [];
      const elements = Array.from(
        document.querySelectorAll('button, [role="button"], a[href], [role="link"]'),
      );

      for (const el of elements) {
        if (candidates.length >= 40) break;
        if (!isVisible(el)) continue;
        if (
          scopes.length > 0 &&
          !scopes.some((scope) => scope === el || scope.contains(el) || el.contains(scope))
        ) {
          continue;
        }

        const controls = el.getAttribute("aria-controls") ?? undefined;
        const popup = el.getAttribute("aria-haspopup")?.toLowerCase();
        const controlsDialog = controls
          ? ["dialog", "alertdialog"].includes(
              document.getElementById(controls)?.getAttribute("role")?.toLowerCase() ?? "",
            )
          : false;
        if (popup !== "dialog" && !controlsDialog) continue;

        const accname = accessibleName(el);
        if (!accname) continue;
        const nameIndex = seenByName.get(accname) ?? 0;
        seenByName.set(accname, nameIndex + 1);
        const role = (
          el.getAttribute("role") ?? (el.tagName === "A" ? "link" : "button")
        ).toLowerCase();
        const parent = el.parentElement;
        const parentSig = `${parent?.tagName ?? ""}|${Array.from(parent?.classList ?? [])
          .sort()
          .slice(0, 3)
          .join(".")}`;
        const classSig = Array.from((el as HTMLElement).classList)
          .sort()
          .slice(0, 3)
          .join(".");
        candidates.push({
          accname,
          role,
          nameIndex,
          controls,
          sig: `${parentSig}|${role}|${classSig}|${popup ?? ""}|${controls ? "controls" : "no-controls"}`,
        });
      }
      return candidates;

      function isVisible(el: Element): boolean {
        const rect = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        return (
          rect.width > 0 &&
          rect.height > 0 &&
          style.display !== "none" &&
          style.visibility !== "hidden" &&
          !el.hasAttribute("hidden")
        );
      }

      function accessibleName(el: Element): string {
        const label = el.getAttribute("aria-label")?.trim();
        if (label) return normalize(label);
        const labelledBy = el.getAttribute("aria-labelledby");
        if (labelledBy) {
          const text = labelledBy
            .split(/\s+/)
            .map((id) => document.getElementById(id)?.textContent ?? "")
            .join(" ");
          if (text.trim()) return normalize(text);
        }
        return normalize(el.textContent ?? "");
      }

      function normalize(value: string): string {
        return value.replace(/\s+/g, " ").trim();
      }
    }, options.scopeSelector ?? []);
  } catch {
    return targets;
  }
  if (triggers.length === 0) return targets;

  const targetByCandidate = new Map<number, Target>();
  for (let i = 0; i < triggers.length; i++) {
    const matched = matchTarget(targets, triggers[i], options.targetIds);
    if (matched) targetByCandidate.set(i, matched);
  }
  if (options.targetIds) {
    triggers = triggers.filter((_, idx) => targetByCandidate.has(idx));
  }
  if (triggers.length === 0) return targets;

  const directProbe = sampleCandidates(triggers).slice(0, maxTriggers);
  const resultBySig = new Map<string, ModalTriggerProbeResults>();
  const resultsByTargetId = new Map<string, ModalTriggerProbeResults>();
  const syntheticTargets: Target[] = [];
  let syntheticIdx = 0;

  for (const candidate of directProbe) {
    const result = await probeOne(page, locateCandidate(page, candidate), candidate.controls);
    if (!result.probeSucceeded) continue;
    if (!resultBySig.has(candidate.sig)) resultBySig.set(candidate.sig, result);
    attachResult(candidate, result, false);
  }

  const probedKeys = new Set(directProbe.map(candidateKey));
  for (const candidate of triggers) {
    if (probedKeys.has(candidateKey(candidate))) continue;
    const sampled = resultBySig.get(candidate.sig);
    if (!sampled) continue;
    attachResult(candidate, sampled, true);
  }

  if (resultsByTargetId.size === 0 && syntheticTargets.length === 0) return targets;

  const enriched = targets.map((target) => {
    const probe = resultsByTargetId.get(target.id);
    if (!probe) return target;
    return { ...target, _modalTriggerProbe: probe } as Target;
  });
  return [...enriched, ...syntheticTargets];

  function attachResult(
    candidate: ModalTriggerCandidate,
    result: ModalTriggerProbeResults,
    sampled: boolean,
  ): void {
    const matchedTarget = matchTarget(targets, candidate, options.targetIds);
    const stored = sampled ? { ...result, sampledFromExemplar: true } : result;
    if (matchedTarget) {
      resultsByTargetId.set(matchedTarget.id, stored);
    } else if (!options.targetIds) {
      syntheticTargets.push({
        id: `modal-trigger-synthetic:${slugify(candidate.accname)}-${syntheticIdx++}`,
        kind: candidate.role === "link" ? "link" : "button",
        role: candidate.role,
        name: candidate.accname,
        requiresBranchOpen: false,
        _modalTriggerProbe: stored,
        _synthetic: "modal-trigger-probe",
      });
    }
  }
}

async function probeOne(
  page: Page,
  trigger: Locator,
  controls?: string,
): Promise<ModalTriggerProbeResults> {
  const results: ModalTriggerProbeResults = {
    opensDialog: false,
    focusMovedInside: false,
    tabStaysInside: false,
    escapeCloses: false,
    focusReturnedToTrigger: false,
    probeSucceeded: false,
  };

  try {
    await page.keyboard.press("Escape").catch(() => {});
    await trigger.focus({ timeout: 1000 }).catch(async () => {
      await trigger.click({ timeout: 1000 });
    });

    const beforeVisibleKeys = await visibleDialogKeys(page);
    await page.keyboard.press("Enter");
    const dialog = await waitForDialog(page, beforeVisibleKeys, controls);
    if (!dialog) {
      results.probeSucceeded = true;
      return results;
    }

    results.opensDialog = true;
    await page.waitForTimeout(100);
    results.focusMovedInside = await dialog
      .evaluate((el: Element) => el.contains(document.activeElement))
      .catch(() => false);

    const focusableCount = await focusFirstAndReturnCount(dialog);
    if (focusableCount === 0) {
      results.dialogHasNoFocusables = true;
      results.probeSucceeded = true;
      await page.keyboard.press("Escape").catch(() => {});
      return results;
    }

    await focusLast(dialog);
    await page.keyboard.press("Tab");
    await page.waitForTimeout(100);
    results.tabStaysInside = await dialog
      .evaluate((el: Element) => el.contains(document.activeElement))
      .catch(() => false);

    await focusFirstAndReturnCount(dialog);
    await page.keyboard.press("Escape");
    await page.waitForTimeout(100);
    results.escapeCloses = !(await dialog.isVisible().catch(() => false));
    results.focusReturnedToTrigger = await trigger
      .evaluate((el: Element) => document.activeElement === el)
      .catch(() => false);

    if (!results.escapeCloses) await page.keyboard.press("Escape").catch(() => {});
    results.probeSucceeded = true;
    return results;
  } catch {
    return results;
  }
}

async function waitForDialog(
  page: Page,
  beforeVisibleKeys: Set<string>,
  controls?: string,
): Promise<Locator | null> {
  const deadline = Date.now() + STEP_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const dialog = await findVisibleDialog(page, beforeVisibleKeys, controls);
    if (dialog) return dialog;
    await page.waitForTimeout(25);
  }
  return await findVisibleDialog(page, beforeVisibleKeys, controls);
}

async function findVisibleDialog(
  page: Page,
  beforeVisibleKeys: Set<string>,
  controls?: string,
): Promise<Locator | null> {
  const selector = '[role="dialog"], [role="alertdialog"]';
  if (controls) {
    const controlled = page.locator(`[id="${cssAttrValue(controls)}"]`).first();
    const isVisible = await controlled.isVisible().catch(() => false);
    if (isVisible) return controlled;
  }

  const dialogs = page.locator(selector);
  const count = await dialogs.count().catch(() => 0);
  for (let i = 0; i < count; i++) {
    const dialog = dialogs.nth(i);
    const visible = await dialog.isVisible().catch(() => false);
    if (!visible) continue;
    const key = await dialogKey(dialog);
    if (!beforeVisibleKeys.has(key)) return dialog;
  }
  if (count === 1) {
    const first = dialogs.first();
    if (await first.isVisible().catch(() => false)) return first;
  }
  return null;
}

async function visibleDialogKeys(page: Page): Promise<Set<string>> {
  const keys = await page
    .evaluate(() => {
      return Array.from(document.querySelectorAll('[role="dialog"], [role="alertdialog"]'))
        .filter((el) => {
          const rect = el.getBoundingClientRect();
          const style = getComputedStyle(el);
          return (
            rect.width > 0 &&
            rect.height > 0 &&
            style.display !== "none" &&
            style.visibility !== "hidden"
          );
        })
        .map(
          (el, idx) =>
            `${el.id || idx}:${el.getAttribute("aria-label") ?? ""}:${el.textContent?.trim().slice(0, 80) ?? ""}`,
        );
    })
    .catch(() => []);
  return new Set(keys);
}

async function dialogKey(dialog: Locator): Promise<string> {
  return await dialog
    .evaluate(
      (el: Element, idx) =>
        `${el.id || idx}:${el.getAttribute("aria-label") ?? ""}:${el.textContent?.trim().slice(0, 80) ?? ""}`,
      0,
    )
    .catch(() => "unknown");
}

async function focusFirstAndReturnCount(dialog: Locator): Promise<number> {
  return await dialog
    .evaluate((el: Element) => {
      const focusables = (root: Element): HTMLElement[] => {
        const selector =
          "a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), " +
          'textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
        return Array.from(root.querySelectorAll<HTMLElement>(selector)).filter((node) => {
          const style = getComputedStyle(node);
          return (
            node.offsetParent !== null || style.position === "fixed" || style.display !== "none"
          );
        });
      };
      const nodes = focusables(el);
      nodes[0]?.focus();
      return nodes.length;
    })
    .catch(() => 0);
}

async function focusLast(dialog: Locator): Promise<void> {
  await dialog
    .evaluate((el: Element) => {
      const focusables = (root: Element): HTMLElement[] => {
        const selector =
          "a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), " +
          'textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
        return Array.from(root.querySelectorAll<HTMLElement>(selector)).filter((node) => {
          const style = getComputedStyle(node);
          return (
            node.offsetParent !== null || style.position === "fixed" || style.display !== "none"
          );
        });
      };
      const nodes = focusables(el);
      nodes[nodes.length - 1]?.focus();
    })
    .catch(() => {});
}

function locateCandidate(page: Page, candidate: ModalTriggerCandidate): Locator {
  return page
    .getByRole(candidate.role as Parameters<Page["getByRole"]>[0], {
      name: candidate.accname,
      exact: true,
    })
    .nth(candidate.nameIndex);
}

function matchTarget(
  targets: Target[],
  candidate: ModalTriggerCandidate,
  targetIds?: Set<string>,
): Target | undefined {
  return targets.find((target) => {
    if (targetIds && !targetIds.has(target.id)) return false;
    if (target.name !== candidate.accname) return false;
    const role = target.role?.toLowerCase();
    return (
      role === candidate.role ||
      (candidate.role === "button" && role === "button") ||
      (candidate.role === "link" && role === "link")
    );
  });
}

function sampleCandidates(candidates: ModalTriggerCandidate[]): ModalTriggerCandidate[] {
  const groups = new Map<string, ModalTriggerCandidate[]>();
  for (const candidate of candidates) {
    const list = groups.get(candidate.sig) ?? [];
    list.push(candidate);
    groups.set(candidate.sig, list);
  }

  const sampled: ModalTriggerCandidate[] = [];
  for (const group of groups.values()) {
    sampled.push(...(group.length > SAMPLE_THRESHOLD ? group.slice(0, SAMPLE_COUNT) : group));
  }
  return sampled.sort((a, b) => candidateKey(a).localeCompare(candidateKey(b)));
}

function candidateKey(candidate: ModalTriggerCandidate): string {
  return `${candidate.accname}:${candidate.nameIndex}`;
}

function slugify(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "unnamed"
  );
}

function cssAttrValue(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}
