import type { Locator, Page } from "playwright";
import type { Target } from "../core/types.js";

export interface ComboboxProbeResults {
  probeSucceeded: boolean;
  opensWithArrowDown: boolean;
  exposesActiveOption: boolean;
  escapeCloses: boolean;
}

export interface ListboxProbeResults {
  probeSucceeded: boolean;
  arrowDownMovesOption: boolean;
  exposesSelectedOption: boolean;
}

export interface CompositeWidgetProbeOptions {
  scopeSelector?: string[];
  targetIds?: Set<string>;
}

const MAX_COMPOSITE_TARGETS = 20;
const STEP_TIMEOUT_MS = 150;
const ACTION_TIMEOUT_MS = 750;

export async function probeComboListboxContracts(
  page: Page,
  targets: Target[],
  maxTargetsOrOptions: number | CompositeWidgetProbeOptions = MAX_COMPOSITE_TARGETS,
  maybeOptions: CompositeWidgetProbeOptions = {},
): Promise<Target[]> {
  const maxTargets =
    typeof maxTargetsOrOptions === "number" ? maxTargetsOrOptions : MAX_COMPOSITE_TARGETS;
  const options = typeof maxTargetsOrOptions === "number" ? maybeOptions : maxTargetsOrOptions;
  const targetFilter = (target: Target) => !options.targetIds || options.targetIds.has(target.id);
  const candidates = targets
    .filter(
      (t) =>
        targetFilter(t) &&
        (t.role === "combobox" || t.role === "listbox") &&
        (t as Record<string, unknown>)._nativeHtmlControl !== "select",
    )
    .slice(0, maxTargets);
  if (candidates.length === 0) return targets;

  const comboResults = new Map<string, ComboboxProbeResults>();
  const listboxResults = new Map<string, ListboxProbeResults>();

  for (const target of candidates) {
    if (target.role === "combobox") {
      const result = await probeCombobox(page, target);
      if (result) comboResults.set(target.id, result);
    } else {
      const result = await probeListbox(page, target);
      if (result) listboxResults.set(target.id, result);
    }
  }

  return targets.map((t) => {
    const combo = comboResults.get(t.id);
    if (combo) return { ...t, _comboboxProbe: combo } as Target;
    const listbox = listboxResults.get(t.id);
    if (listbox) return { ...t, _listboxProbe: listbox } as Target;
    return t;
  });
}

async function probeCombobox(page: Page, target: Target): Promise<ComboboxProbeResults | null> {
  const combo = locateTarget(page, target);
  const visible = await combo.isVisible({ timeout: ACTION_TIMEOUT_MS }).catch(() => false);
  if (!visible) return null;

  try {
    await combo.focus({ timeout: ACTION_TIMEOUT_MS }).catch(async () => {
      await combo.click({ timeout: ACTION_TIMEOUT_MS });
    });
    await pressKeyWithTimeout(page, "ArrowDown", ACTION_TIMEOUT_MS);
    await page.waitForTimeout(STEP_TIMEOUT_MS);

    const opened = await combo.evaluate((el: Element) => {
      const expanded = el.getAttribute("aria-expanded") === "true";
      const controls = el.getAttribute("aria-controls");
      const active = el.getAttribute("aria-activedescendant");
      const popupVisible = controls ? isVisible(document.getElementById(controls)) : hasVisiblePopup();
      const activeOption =
        (active ? document.getElementById(active)?.getAttribute("role") === "option" : false) ||
        document.activeElement?.getAttribute("role") === "option" ||
        !!document.querySelector('[role="option"][aria-selected="true"]');
      return { expanded, popupVisible, activeOption };

      function hasVisiblePopup(): boolean {
        return Array.from(document.querySelectorAll('[role="listbox"], [role="tree"], [role="grid"]'))
          .some((node) => isVisible(node as HTMLElement));
      }
      function isVisible(node: Element | null): boolean {
        if (!node) return false;
        const style = getComputedStyle(node);
        const rect = node.getBoundingClientRect();
        return !node.hasAttribute("hidden") &&
          style.display !== "none" &&
          style.visibility !== "hidden" &&
          rect.width > 0 &&
          rect.height > 0;
      }
    }, undefined, { timeout: ACTION_TIMEOUT_MS });

    await pressKeyWithTimeout(page, "Escape", ACTION_TIMEOUT_MS);
    await page.waitForTimeout(STEP_TIMEOUT_MS);
    const closed = await combo.evaluate((el: Element) => {
      const expanded = el.getAttribute("aria-expanded");
      const controls = el.getAttribute("aria-controls");
      const popupVisible = controls ? isVisible(document.getElementById(controls)) : hasVisiblePopup();
      return expanded === "false" || !popupVisible;

      function hasVisiblePopup(): boolean {
        return Array.from(document.querySelectorAll('[role="listbox"], [role="tree"], [role="grid"]'))
          .some((node) => isVisible(node as HTMLElement));
      }
      function isVisible(node: Element | null): boolean {
        if (!node) return false;
        const style = getComputedStyle(node);
        const rect = node.getBoundingClientRect();
        return !node.hasAttribute("hidden") &&
          style.display !== "none" &&
          style.visibility !== "hidden" &&
          rect.width > 0 &&
          rect.height > 0;
      }
    }, undefined, { timeout: ACTION_TIMEOUT_MS });

    return {
      probeSucceeded: true,
      opensWithArrowDown: opened.expanded || opened.popupVisible,
      exposesActiveOption: opened.activeOption,
      escapeCloses: closed,
    };
  } catch {
    return {
      probeSucceeded: false,
      opensWithArrowDown: false,
      exposesActiveOption: false,
      escapeCloses: false,
    };
  } finally {
    await pressKeyWithTimeout(page, "Escape", ACTION_TIMEOUT_MS).catch(() => false);
  }
}

async function probeListbox(page: Page, target: Target): Promise<ListboxProbeResults | null> {
  const listbox = locateTarget(page, target);
  const visible = await listbox.isVisible({ timeout: ACTION_TIMEOUT_MS }).catch(() => false);
  if (!visible) return null;

  try {
    await listbox.focus({ timeout: ACTION_TIMEOUT_MS }).catch(async () => {
      await listbox.click({ timeout: ACTION_TIMEOUT_MS });
    });
    const before = await listbox.evaluate((el: Element) => {
      const activeDescendant = el.getAttribute("aria-activedescendant");
      const selected = el.querySelector('[role="option"][aria-selected="true"]');
      return {
        activeDescendant,
        selectedText: selected?.textContent?.trim() || null,
        activeElementIsOption: document.activeElement?.getAttribute("role") === "option",
      };
    }, undefined, { timeout: ACTION_TIMEOUT_MS });
    await pressKeyWithTimeout(page, "ArrowDown", ACTION_TIMEOUT_MS);
    await page.waitForTimeout(STEP_TIMEOUT_MS);
    const after = await listbox.evaluate((el: Element) => {
      const activeDescendant = el.getAttribute("aria-activedescendant");
      const selected = el.querySelector('[role="option"][aria-selected="true"]');
      return {
        activeDescendant,
        selectedText: selected?.textContent?.trim() || null,
        activeElementIsOption: document.activeElement?.getAttribute("role") === "option",
      };
    }, undefined, { timeout: ACTION_TIMEOUT_MS });

    return {
      probeSucceeded: true,
      arrowDownMovesOption:
        before.activeDescendant !== after.activeDescendant ||
        before.selectedText !== after.selectedText ||
        after.activeElementIsOption,
      exposesSelectedOption:
        !!after.activeDescendant ||
        !!after.selectedText ||
        after.activeElementIsOption,
    };
  } catch {
    return {
      probeSucceeded: false,
      arrowDownMovesOption: false,
      exposesSelectedOption: false,
    };
  }
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
