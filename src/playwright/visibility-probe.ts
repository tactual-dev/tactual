/// <reference lib="dom" />
import type { Page } from "playwright";
import type { PageState, Target } from "../core/types.js";
import type { VisualMode } from "../profiles/types.js";

export type { VisualMode };

/**
 * Per-icon visibility data captured under specific (colorScheme, forcedColors)
 * emulation modes. Used by the finding builder to flag icons that render
 * invisible or low-contrast against their ancestor background.
 *
 * The data is collected once per (target, mode) and attached as a passthrough
 * field `_visibility` on the target. Reporters and scoring read from it
 * generically — no schema change to Target.
 */

export interface VisibilityRecord {
  mode: VisualMode;
  iconKind: "svg" | "img";
  /** Computed CSS `fill` (resolved color, e.g., "rgb(0, 0, 0)"). */
  fill: string;
  /** Computed CSS `color` — useful for currentColor-tracking detection. */
  color: string;
  /** Raw `fill` attribute value (SVG only). Tells us if author wrote "currentColor" / system color literal. */
  fillAttr: string | null;
  /** Computed background-color of nearest non-transparent ancestor. */
  bgColor: string;
  /** Computed forced-color-adjust (default for SVG is "preserve-parent-color"). */
  forcedColorAdjust: string;
  /** Computed opacity (parsed). */
  opacity: number;
  /** True if the icon is effectively non-rendering (display:none, visibility:hidden, 0-area, opacity≈0). */
  hidden: boolean;
  /** True if the owner element has visible non-icon text content. */
  hasTextLabel: boolean;
  /** Bounding rect dimensions in px. */
  rect: { width: number; height: number };
}

/**
 * Roles whose icon descendants we sample. Restricted to interactive controls
 * so each icon is counted under its nearest interactive ancestor exactly once
 * (otherwise the same chevron under a button would also be attributed to the
 * enclosing landmark/heading).
 */
const PROBE_ROLES: ReadonlySet<string> = new Set([
  "button", "link", "menuitem", "menuitemcheckbox", "menuitemradio",
  "tab", "switch", "checkbox", "radio", "combobox", "listbox",
  "slider", "spinbutton", "treeitem", "option",
]);

const ICON_SELECTOR = 'svg, img[role="img"]';
const TAG_ATTR = "data-tactual-target-id";

/**
 * Walk every probeable target, tag each matching DOM element with a
 * temporary data attribute, then for each visual mode do ONE page-wide
 * icon traversal that attributes each icon to its closest tagged ancestor.
 *
 * This handles two patterns that descendant-only search does not cover:
 *
 *   1. Multi-match locators — `getByRole('button', { name: 'post /pet' })`
 *      can match several DOM elements; `locator.first()` is unreliable.
 *      Tagging via `elementHandles()` gives every match an owner attribute.
 *
 *   2. Icons inside one captured target whose siblings are also captured
 *      targets (e.g., Swagger UI rows with separate chevron/lock/copy
 *      buttons). Each icon resolves to its true owner via `closest()`,
 *      so attribution is always unambiguous.
 *
 * Restores the original media emulation and removes the tagging attributes
 * before returning so this probe doesn't perturb subsequent probes.
 */
export async function collectVisibility(
  page: Page,
  state: PageState,
  modes: VisualMode[],
): Promise<PageState> {
  if (state.targets.length === 0 || modes.length === 0) {
    return state;
  }

  const probeable = state.targets.filter(
    (t) => t.role && PROBE_ROLES.has(t.role.toLowerCase()),
  );
  if (probeable.length === 0) {
    return state;
  }

  const recordsByTargetId = new Map<string, VisibilityRecord[]>();

  try {
    await tagTargetElements(page, probeable);

    for (const mode of modes) {
      await page.emulateMedia({
        colorScheme: mode.colorScheme,
        forcedColors: mode.forcedColors,
      });

      const grouped = await sampleAllTaggedIcons(page, mode);
      for (const [tid, records] of Object.entries(grouped)) {
        const existing = recordsByTargetId.get(tid) ?? [];
        existing.push(...records);
        recordsByTargetId.set(tid, existing);
      }
    }
  } finally {
    await page
      .evaluate((attr: string) => {
        document.querySelectorAll(`[${attr}]`).forEach((el) => el.removeAttribute(attr));
      }, TAG_ATTR)
      .catch(() => {});
    await page.emulateMedia({ colorScheme: null, forcedColors: null }).catch(() => {});
  }

  return {
    ...state,
    targets: state.targets.map((t) => {
      const records = recordsByTargetId.get(t.id);
      if (!records || records.length === 0) return t;
      return { ...t, _visibility: records } as Target;
    }),
  };
}

async function tagTargetElements(page: Page, targets: Target[]): Promise<void> {
  // Group targets by (role, name) so we can pair them to DOM matches by ordinal.
  // Tactual assigns unique target IDs to same-named elements (`-2`, `-3`, …),
  // and a single getByRole(...).elementHandles() call returns all matches in
  // DOM order. Without grouping we'd overwrite the data attribute on every
  // shared-name iteration and only the last target ID would survive.
  const groups = new Map<string, Target[]>();
  for (const t of targets) {
    if (!t.role) continue;
    const key = `${t.role}|${t.name ?? ""}`;
    const list = groups.get(key) ?? [];
    list.push(t);
    groups.set(key, list);
  }

  for (const group of groups.values()) {
    const first = group[0];
    if (!first.role) continue;
    try {
      const locator = first.name
        ? page.getByRole(first.role as Parameters<Page["getByRole"]>[0], { name: first.name, exact: true })
        : page.locator(`[role="${first.role}"]`);
      const handles = await locator.elementHandles();
      for (let i = 0; i < handles.length; i++) {
        // Pair handle[i] with target[i]; if DOM has more matches than Tactual
        // captured (rare — usually 1:1), the overflow handles share the last
        // target's id so they're still attributable.
        const target = group[i] ?? group[group.length - 1];
        try {
          await handles[i].evaluate(
            (el: Element, args: { attr: string; id: string }) =>
              el.setAttribute(args.attr, args.id),
            { attr: TAG_ATTR, id: target.id },
          );
        } catch {
          // element detached; skip
        } finally {
          await handles[i].dispose().catch(() => {});
        }
      }
    } catch {
      // locator failed (invalid role string, etc.) — skip silently
    }
  }
}

async function sampleAllTaggedIcons(
  page: Page,
  mode: VisualMode,
): Promise<Record<string, VisibilityRecord[]>> {
  return await page.evaluate(
    (args: { modeArg: VisualMode; iconSel: string; tagAttr: string }) => {
      function findBgColor(start: Element): string {
        let cur: Element | null = start.parentElement;
        while (cur) {
          const bg = getComputedStyle(cur).backgroundColor;
          if (bg && bg !== "rgba(0, 0, 0, 0)" && bg !== "transparent") {
            return bg;
          }
          cur = cur.parentElement;
        }
        return getComputedStyle(document.body).backgroundColor || "rgb(255, 255, 255)";
      }

      function visibleNonIconText(el: Element): boolean {
        const clone = el.cloneNode(true) as Element;
        clone.querySelectorAll('svg, img[role="img"]').forEach((n) => n.remove());
        const text = (clone.textContent || "").trim();
        return text.length > 0;
      }

      function describeIcon(
        icon: Element,
        ownerEl: Element,
        kind: "svg" | "img",
      ): VisibilityRecord {
        const cs = getComputedStyle(icon);
        const rect = icon.getBoundingClientRect();
        const opacity = parseFloat(cs.opacity || "1");
        const hidden =
          cs.display === "none" ||
          cs.visibility === "hidden" ||
          opacity < 0.01 ||
          rect.width === 0 ||
          rect.height === 0;
        return {
          mode: args.modeArg,
          iconKind: kind,
          fill: cs.fill || "",
          color: cs.color || "",
          fillAttr: kind === "svg" ? icon.getAttribute("fill") : null,
          bgColor: findBgColor(icon),
          forcedColorAdjust: cs.forcedColorAdjust || "auto",
          opacity,
          hidden,
          hasTextLabel: visibleNonIconText(ownerEl),
          rect: { width: rect.width, height: rect.height },
        };
      }

      const grouped: Record<string, VisibilityRecord[]> = {};
      const icons = document.querySelectorAll(args.iconSel);
      icons.forEach((icon) => {
        const owner = icon.closest(`[${args.tagAttr}]`);
        if (!owner) return;
        const id = owner.getAttribute(args.tagAttr);
        if (!id) return;
        const kind: "svg" | "img" = icon.tagName.toLowerCase() === "svg" ? "svg" : "img";
        const record = describeIcon(icon, owner, kind);
        if (!grouped[id]) grouped[id] = [];
        grouped[id].push(record);
      });
      return grouped;
    },
    { modeArg: mode, iconSel: ICON_SELECTOR, tagAttr: TAG_ATTR },
  );
}

export { ICON_SELECTOR };
