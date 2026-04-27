import type { Locator, Page } from "playwright";
import type { Target } from "../core/types.js";

export interface TabProbeResults {
  probeSucceeded: boolean;
  singleTab?: boolean;
  arrowRightMovesFocus: boolean;
  activationSelectsTab: boolean;
  selectedTabHasPanel: boolean;
}

export interface DisclosureProbeResults {
  probeSucceeded: boolean;
  expandedFlipped: boolean;
  controlledRegionDisplayed: boolean;
  focusLostToBody: boolean;
  sampledFromExemplar?: boolean;
}

interface DisclosureCandidate {
  accname: string;
  nameIndex: number;
  signature: string;
  target?: Target;
}

export interface WidgetProbeOptions {
  scopeSelector?: string[];
  targetIds?: Set<string>;
}

const MAX_WIDGET_TARGETS = 20;
const STEP_TIMEOUT_MS = 120;
const ACTION_TIMEOUT_MS = 750;

export async function probeTabAndDisclosurePatterns(
  page: Page,
  targets: Target[],
  maxTargetsOrOptions: number | WidgetProbeOptions = MAX_WIDGET_TARGETS,
  maybeOptions: WidgetProbeOptions = {},
): Promise<Target[]> {
  const maxTargets =
    typeof maxTargetsOrOptions === "number" ? maxTargetsOrOptions : MAX_WIDGET_TARGETS;
  const options = typeof maxTargetsOrOptions === "number" ? maybeOptions : maxTargetsOrOptions;
  const targetFilter = (target: Target) => !options.targetIds || options.targetIds.has(target.id);
  const tabCandidates = targets
    .filter((target) => targetFilter(target) && isTabTarget(target))
    .slice(0, maxTargets);
  const disclosureCandidates = await discoverDisclosureCandidates(
    page,
    targets,
    maxTargets,
    options,
  );
  if (tabCandidates.length === 0 && disclosureCandidates.length === 0) return targets;

  const tabResults = new Map<string, TabProbeResults>();
  const disclosureResults = new Map<string, DisclosureProbeResults>();
  const syntheticTargets: Target[] = [];

  for (const target of tabCandidates) {
    const result = await probeTab(page, target);
    if (result) tabResults.set(target.id, result);
  }

  let syntheticIdx = 0;
  const groups = groupDisclosureCandidates(disclosureCandidates);
  for (const group of groups) {
    const sampled = group.length > 3;
    const toProbe = sampled ? group.slice(0, 2) : group;
    let exemplar: DisclosureProbeResults | null = null;

    for (const candidate of toProbe) {
      const disclosure = page
        .getByRole("button", { name: candidate.accname, exact: true })
        .nth(candidate.nameIndex);
      const result = await probeDisclosureLocator(page, disclosure);
      if (!result) continue;
      exemplar ??= result;
      attachDisclosureResult(candidate, result);
    }

    if (sampled && exemplar) {
      for (const candidate of group.slice(2)) {
        attachDisclosureResult(candidate, {
          ...exemplar,
          sampledFromExemplar: true,
        });
      }
    }
  }

  const enriched = targets.map((t) => {
    const tabProbe = tabResults.get(t.id);
    if (tabProbe) return { ...t, _tabProbe: tabProbe } as Target;
    const disclosureProbe = disclosureResults.get(t.id);
    if (disclosureProbe) return { ...t, _disclosureProbe: disclosureProbe } as Target;
    return t;
  });
  return [...enriched, ...syntheticTargets];

  function attachDisclosureResult(
    candidate: DisclosureCandidate,
    result: DisclosureProbeResults,
  ): void {
    if (candidate.target) {
      disclosureResults.set(candidate.target.id, result);
    } else {
      syntheticTargets.push({
        id: `disclosure-synthetic:${slugifyAccname(candidate.accname)}-${syntheticIdx++}`,
        kind: "button",
        role: "button",
        name: candidate.accname,
        requiresBranchOpen: false,
        _disclosureProbe: result,
        _synthetic: "disclosure-probe",
      });
    }
  }
}

function isTabTarget(target: Target): boolean {
  return target.role?.toLowerCase() === "tab";
}

function isDisclosureTarget(target: Target): boolean {
  const attrs = (target as Record<string, unknown>)._attributeValues as
    | Record<string, string>
    | undefined;
  const hasPopup = attrs?.["aria-haspopup"] !== undefined;
  return (
    target.role?.toLowerCase() === "button" && attrs?.["aria-expanded"] !== undefined && !hasPopup
  );
}

async function discoverDisclosureCandidates(
  page: Page,
  targets: Target[],
  maxTargets: number,
  options: WidgetProbeOptions,
): Promise<DisclosureCandidate[]> {
  let domCandidates: Array<{ accname: string; nameIndex: number; signature: string }>;
  try {
    domCandidates = await page.evaluate(
      ({ limit, scopeSelectors }) => {
        const scopes =
          scopeSelectors.length > 0
            ? scopeSelectors.flatMap((selector) => Array.from(document.querySelectorAll(selector)))
            : [];
        const seenByName = new Map<string, number>();
        const candidates: Array<{ accname: string; nameIndex: number; signature: string }> = [];
        const elements = Array.from(
          document.querySelectorAll("[aria-expanded]:not([aria-haspopup])"),
        );

        for (const el of elements) {
          if (candidates.length >= limit) break;
          if (!isButtonLike(el) || !isVisible(el)) continue;
          if (
            scopes.length > 0 &&
            !scopes.some((scope) => scope === el || scope.contains(el) || el.contains(scope))
          ) {
            continue;
          }

          const accname = accessibleName(el);
          if (!accname) continue;
          const nameIndex = seenByName.get(accname) ?? 0;
          seenByName.set(accname, nameIndex + 1);
          candidates.push({ accname, nameIndex, signature: structuralSignature(el) });
        }

        return candidates;

        function isButtonLike(el: Element): boolean {
          const explicitRole = el.getAttribute("role")?.toLowerCase();
          if (explicitRole === "button") return true;
          if (el.tagName === "BUTTON") return true;
          if (el instanceof HTMLInputElement) {
            return ["button", "submit", "reset"].includes(el.type.toLowerCase());
          }
          return false;
        }

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

          if (el instanceof HTMLInputElement && el.value.trim()) {
            return normalize(el.value);
          }
          return normalize(el.textContent ?? "");
        }

        function normalize(value: string): string {
          return value.replace(/\s+/g, " ").trim();
        }
        function structuralSignature(el: Element): string {
          const role = el.getAttribute("role") ?? el.tagName.toLowerCase();
          const classNames = Array.from((el as HTMLElement).classList)
            .sort()
            .slice(0, 3)
            .join(".");
          const controls = el.hasAttribute("aria-controls") ? "controls" : "no-controls";
          const parentRole =
            el.parentElement?.getAttribute("role") ?? el.parentElement?.tagName.toLowerCase() ?? "";
          return `${parentRole}|${role}|${classNames}|${controls}`;
        }
      },
      { limit: maxTargets, scopeSelectors: options.scopeSelector ?? [] },
    );
  } catch {
    domCandidates = [];
  }

  const matched = new Set<string>();
  const candidates = domCandidates
    .map((candidate) => {
      const target = matchDisclosureTarget(targets, candidate.accname, matched, options.targetIds);
      if (target) matched.add(target.id);
      return { ...candidate, target };
    })
    .filter((candidate) => !options.targetIds || candidate.target);

  if (candidates.length > 0) return candidates;

  // Fallback for environments where DOM scanning is unavailable but the
  // accessibility snapshot did surface aria-expanded.
  return targets
    .filter(
      (target) =>
        isDisclosureTarget(target) && (!options.targetIds || options.targetIds.has(target.id)),
    )
    .slice(0, maxTargets)
    .map((target, idx) => ({
      accname: target.name,
      nameIndex: idx,
      signature: `${target.role}:${target.name}`,
      target,
    }));
}

function matchDisclosureTarget(
  targets: Target[],
  accname: string,
  matched: Set<string>,
  targetIds?: Set<string>,
): Target | undefined {
  return targets.find(
    (target) =>
      !matched.has(target.id) &&
      (!targetIds || targetIds.has(target.id)) &&
      target.role?.toLowerCase() === "button" &&
      target.name === accname,
  );
}

function groupDisclosureCandidates(candidates: DisclosureCandidate[]): DisclosureCandidate[][] {
  const groups = new Map<string, DisclosureCandidate[]>();
  for (const candidate of candidates) {
    const list = groups.get(candidate.signature) ?? [];
    list.push(candidate);
    groups.set(candidate.signature, list);
  }
  return [...groups.values()];
}

function slugifyAccname(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "unnamed"
  );
}

async function probeTab(page: Page, target: Target): Promise<TabProbeResults | null> {
  const tab = locateTarget(page, target);
  const visible = await tab.isVisible({ timeout: ACTION_TIMEOUT_MS }).catch(() => false);
  if (!visible) return null;

  const selectedBefore = await selectedTabName(page);
  const tabCount = await page
    .locator('[role="tab"]')
    .count()
    .catch(() => 0);
  if (tabCount <= 1) {
    return {
      probeSucceeded: true,
      singleTab: true,
      arrowRightMovesFocus: true,
      activationSelectsTab: true,
      selectedTabHasPanel: true,
    };
  }

  try {
    await tab.focus({ timeout: ACTION_TIMEOUT_MS }).catch(async () => {
      await tab.click({ timeout: ACTION_TIMEOUT_MS });
    });
    await page.keyboard.press("ArrowRight");
    await page.waitForTimeout(STEP_TIMEOUT_MS);

    const afterArrow = await page.evaluate(() => {
      const active = document.activeElement;
      return {
        activeIsTab: active?.getAttribute("role") === "tab",
        selected: active?.getAttribute("aria-selected") === "true",
        hasVisiblePanel: active ? activeTabHasVisiblePanel(active) : false,
      };

      function activeTabHasVisiblePanel(active: Element): boolean {
        const controls = active.getAttribute("aria-controls");
        if (!controls) return false;
        const panel = document.getElementById(controls);
        if (!panel) return false;
        const style = getComputedStyle(panel);
        const rect = panel.getBoundingClientRect();
        return (
          !panel.hasAttribute("hidden") &&
          style.display !== "none" &&
          style.visibility !== "hidden" &&
          rect.width > 0 &&
          rect.height > 0
        );
      }
    });

    await page.keyboard.press("Enter");
    await page.waitForTimeout(STEP_TIMEOUT_MS);
    const afterActivation = await page.evaluate(() => {
      const active = document.activeElement;
      return {
        selected: active?.getAttribute("aria-selected") === "true",
        hasVisiblePanel: active ? activeTabHasVisiblePanel(active) : false,
      };

      function activeTabHasVisiblePanel(active: Element): boolean {
        const controls = active.getAttribute("aria-controls");
        if (!controls) return false;
        const panel = document.getElementById(controls);
        if (!panel) return false;
        const style = getComputedStyle(panel);
        const rect = panel.getBoundingClientRect();
        return (
          !panel.hasAttribute("hidden") &&
          style.display !== "none" &&
          style.visibility !== "hidden" &&
          rect.width > 0 &&
          rect.height > 0
        );
      }
    });

    return {
      probeSucceeded: true,
      arrowRightMovesFocus: afterArrow.activeIsTab,
      activationSelectsTab: afterActivation.selected || afterArrow.selected,
      selectedTabHasPanel: afterActivation.hasVisiblePanel || afterArrow.hasVisiblePanel,
    };
  } catch {
    return {
      probeSucceeded: false,
      arrowRightMovesFocus: false,
      activationSelectsTab: false,
      selectedTabHasPanel: false,
    };
  } finally {
    if (selectedBefore) {
      await page
        .getByRole("tab", { name: selectedBefore, exact: true })
        .click({ timeout: ACTION_TIMEOUT_MS })
        .catch(() => {});
    }
  }
}

async function probeDisclosureLocator(
  page: Page,
  disclosure: Locator,
): Promise<DisclosureProbeResults | null> {
  const visible = await disclosure.isVisible({ timeout: ACTION_TIMEOUT_MS }).catch(() => false);
  if (!visible) return null;

  const contract = await disclosure
    .evaluate((el: Element) => ({
      beforeExpanded: el.getAttribute("aria-expanded"),
      hasPopup: el.hasAttribute("aria-haspopup"),
    }), undefined, { timeout: ACTION_TIMEOUT_MS })
    .catch(() => null);
  if (!contract || contract.beforeExpanded === null || contract.hasPopup) return null;

  const beforeExpanded = contract.beforeExpanded;
  try {
    await disclosure.focus({ timeout: ACTION_TIMEOUT_MS }).catch(async () => {
      await disclosure.click({ timeout: ACTION_TIMEOUT_MS });
    });
    const activated = await pressKeyWithTimeout(page, "Enter", ACTION_TIMEOUT_MS);
    if (!activated) {
      return {
        probeSucceeded: false,
        expandedFlipped: false,
        controlledRegionDisplayed: false,
        focusLostToBody: false,
      };
    }
    await page.waitForTimeout(STEP_TIMEOUT_MS);

    const result = await disclosure.evaluate((el: Element) => {
      const expanded = el.getAttribute("aria-expanded");
      const controls = el.getAttribute("aria-controls");
      let controlledRegionDisplayed = true;
      if (controls) {
        const region = document.getElementById(controls);
        if (!region) {
          controlledRegionDisplayed = false;
        } else {
          const style = getComputedStyle(region);
          const rect = region.getBoundingClientRect();
          controlledRegionDisplayed =
            !region.hasAttribute("hidden") &&
            style.display !== "none" &&
            style.visibility !== "hidden" &&
            rect.width > 0 &&
            rect.height > 0;
        }
      }
      return {
        expanded,
        controlledRegionDisplayed,
        focusLostToBody: document.activeElement === document.body,
      };
    }, undefined, { timeout: ACTION_TIMEOUT_MS });

    const expandedFlipped =
      beforeExpanded !== null && result.expanded !== null && result.expanded !== beforeExpanded;

    return {
      probeSucceeded: true,
      expandedFlipped,
      controlledRegionDisplayed:
        result.expanded === "true" ? result.controlledRegionDisplayed : true,
      focusLostToBody: result.focusLostToBody,
    };
  } catch {
    return {
      probeSucceeded: false,
      expandedFlipped: false,
      controlledRegionDisplayed: false,
      focusLostToBody: false,
    };
  } finally {
    const afterExpanded = await disclosure
      .getAttribute("aria-expanded", { timeout: ACTION_TIMEOUT_MS })
      .catch(() => null);
    if (beforeExpanded !== null && afterExpanded !== null && beforeExpanded !== afterExpanded) {
      await disclosure.focus({ timeout: ACTION_TIMEOUT_MS }).catch(() => {});
      await pressKeyWithTimeout(page, "Enter", ACTION_TIMEOUT_MS).catch(() => false);
      await page.waitForTimeout(STEP_TIMEOUT_MS).catch(() => {});
    }
  }
}

async function selectedTabName(page: Page): Promise<string | null> {
  return page
    .evaluate(() => {
      const selected = document.querySelector('[role="tab"][aria-selected="true"]');
      return (selected?.getAttribute("aria-label") ?? selected?.textContent ?? "").trim() || null;
    })
    .catch(() => null);
}

function locateTarget(page: Page, target: Target): Locator {
  const role = target.role as Parameters<Page["getByRole"]>[0];
  return target.name
    ? page.getByRole(role, { name: target.name, exact: true }).first()
    : page.locator(`[role="${target.role}"]`).first();
}

async function pressKeyWithTimeout(
  page: Page,
  key: string,
  timeoutMs: number,
): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), timeoutMs);
  });
  try {
    const pressed = page.keyboard.press(key).then(
      () => true,
      () => false,
    );
    return await Promise.race([pressed, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
