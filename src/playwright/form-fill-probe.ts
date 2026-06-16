/**
 * Form-input simulation (Black Widow data-flow v2).
 *
 * Standalone utility for the Tactual user who wants to know which
 * buttons UNLOCK after filling a form. Tactual's default safety
 * policy doesn't auto-fill forms (risk of accidental submission /
 * data-write), so this lives behind explicit invocation: caller
 * imports `probeFormEnablement` from `tactual/playwright` and runs
 * it after capture.
 *
 * What it does:
 *   1. Find <form> elements (capped).
 *   2. Snapshot button disabled/enabled state.
 *   3. Fill type-appropriate SAFE values into input/textarea/select
 *      fields (test@example.com, +1-555-0100, etc.). Skips file /
 *      hidden / submit / reset / button input types.
 *   4. Wait briefly for framework reactivity (React fiber commits,
 *      Vue reactivity ticks).
 *   5. Snapshot button enabled state again.
 *   6. Diff: report any button that flipped disabled → enabled.
 *   7. Restore: clear the filled fields so subsequent analysis sees
 *      a clean form.
 *
 * Does NOT click submit / does NOT submit forms.
 *
 * Limitations:
 *   - Pattern-validating fields (regex, etc.) may reject the canned
 *     values; the diff still works but might not show "would be
 *     enabled if values were valid."
 *   - <select> filling is skipped (would require enumerating options
 *     and picking a non-default).
 *   - Forms with custom JavaScript validation that fires only on blur
 *     may not enable until each field is also blurred — we attempt
 *     blur via Tab between fills.
 */

import type { Page } from "playwright";

export interface FormEnablement {
  /** Button text content / value at activation time. */
  buttonName: string;
  /** Form's accessible name or "form #N" fallback. */
  formName: string;
}

export interface FormFillResult {
  formsProbed: number;
  enablementsFound: FormEnablement[];
  /** Reasons forms were skipped (e.g. all-hidden, no fillable fields). */
  formsSkipped: number;
}

export interface FormFillOptions {
  /** Maximum number of forms to probe per page. Default 5. */
  maxForms?: number;
  /** ms to wait between filling and snapshotting post-state. Default 400. */
  postFillDelayMs?: number;
}

const FILL_VALUES: Record<string, string> = {
  email: "test@example.com",
  tel: "+15550100",
  url: "https://example.com",
  password: "Tactual_probe_8x!",
  number: "1",
  date: "2024-01-01",
  time: "12:00",
  month: "2024-01",
  week: "2024-W01",
  search: "Tactual",
  text: "Tactual",
};

const SKIP_INPUT_TYPES = new Set(["hidden", "submit", "reset", "button", "file", "image"]);

export async function probeFormEnablement(
  page: Page,
  options: FormFillOptions = {},
): Promise<FormFillResult> {
  const maxForms = options.maxForms ?? 5;
  const postFillDelay = options.postFillDelayMs ?? 400;

  const formCount = await page.locator("form").count().catch(() => 0);
  if (formCount === 0) {
    return { formsProbed: 0, enablementsFound: [], formsSkipped: 0 };
  }

  const result: FormFillResult = {
    formsProbed: 0,
    enablementsFound: [],
    formsSkipped: 0,
  };

  for (let i = 0; i < Math.min(formCount, maxForms); i++) {
    const form = page.locator("form").nth(i);
    const enablements = await probeOneForm(page, form, postFillDelay).catch(() => null);
    if (!enablements) {
      result.formsSkipped++;
      continue;
    }
    result.formsProbed++;
    result.enablementsFound.push(...enablements);
  }
  return result;
}

async function probeOneForm(
  page: Page,
  form: ReturnType<Page["locator"]>,
  postFillDelay: number,
): Promise<FormEnablement[] | null> {
  // Snapshot pre-state of buttons inside the form
  const preButtons = await snapshotButtons(form);
  if (preButtons.length === 0) return [];

  // Find fillable fields
  const fillableCount = await form
    .locator("input, textarea")
    .count()
    .catch(() => 0);
  if (fillableCount === 0) return [];

  const filledFieldHandles: Array<{ index: number; tag: string; type: string | null }> = [];
  for (let i = 0; i < fillableCount; i++) {
    const field = form.locator("input, textarea").nth(i);
    const meta = await field
      .evaluate((el: Element) => {
        const tag = el.tagName.toLowerCase();
        const type = el instanceof HTMLInputElement ? el.type.toLowerCase() : null;
        const disabled = (el as HTMLInputElement).disabled;
        const readOnly = (el as HTMLInputElement).readOnly;
        return { tag, type, disabled, readOnly };
      })
      .catch(() => null);
    if (!meta) continue;
    if (meta.disabled || meta.readOnly) continue;
    if (meta.type && SKIP_INPUT_TYPES.has(meta.type)) continue;

    const value = pickSafeValue(meta.tag, meta.type);
    if (value === null) continue;

    await field.fill(value, { timeout: 1000 }).catch(() => {});
    // Blur to trigger any onBlur validation
    await field.blur({ timeout: 500 }).catch(() => {});
    filledFieldHandles.push({ index: i, tag: meta.tag, type: meta.type });
  }

  if (filledFieldHandles.length === 0) return [];

  await page.waitForTimeout(postFillDelay);

  // Snapshot post-state
  const postButtons = await snapshotButtons(form);

  // Build form-name fallback once
  const formName = await form
    .evaluate((el: Element) => {
      const aria = el.getAttribute("aria-label") ?? "";
      const labelledBy = el.getAttribute("aria-labelledby");
      if (aria.trim()) return aria.trim();
      if (labelledBy) {
        const ref = document.getElementById(labelledBy.split(/\s+/)[0]);
        if (ref?.textContent) return ref.textContent.trim();
      }
      return "";
    })
    .catch(() => "");

  // Diff: which buttons went from disabled to enabled
  const enablements: FormEnablement[] = [];
  for (const post of postButtons) {
    const pre = preButtons.find((p) => p.identity === post.identity);
    if (pre && pre.disabled && !post.disabled) {
      enablements.push({
        buttonName: post.name || "(unnamed button)",
        formName: formName || "(unnamed form)",
      });
    }
  }

  // Restore: clear filled fields so subsequent analysis is unaffected
  for (const { index } of filledFieldHandles) {
    const field = form.locator("input, textarea").nth(index);
    await field.fill("", { timeout: 500 }).catch(() => {});
  }

  return enablements;
}

interface ButtonSnapshot {
  identity: string;
  name: string;
  disabled: boolean;
}

async function snapshotButtons(form: ReturnType<Page["locator"]>): Promise<ButtonSnapshot[]> {
  return form
    .evaluate((el: Element) => {
      const buttons = el.querySelectorAll(
        "button, input[type='submit'], input[type='button'], [role='button']",
      );
      const out: ButtonSnapshot[] = [];
      for (let i = 0; i < buttons.length; i++) {
        const b = buttons[i];
        const name =
          (b.getAttribute("aria-label") ?? "").trim() ||
          ((b as HTMLButtonElement).textContent ?? "").trim() ||
          ((b as HTMLInputElement).value ?? "");
        const disabled =
          (b as HTMLButtonElement).disabled ||
          b.getAttribute("aria-disabled") === "true";
        out.push({
          identity: b.id ? `#${b.id}` : `${b.tagName.toLowerCase()}@${i}`,
          name: name.slice(0, 60),
          disabled,
        });
      }
      return out;
    })
    .catch(() => [] as ButtonSnapshot[]);
}

function pickSafeValue(tag: string, type: string | null): string | null {
  if (tag === "textarea") return "Tactual test content";
  if (tag === "input") {
    const t = type ?? "text";
    if (t in FILL_VALUES) return FILL_VALUES[t];
    if (t === "checkbox" || t === "radio" || t === "color" || t === "range") return null;
    return FILL_VALUES.text;
  }
  return null;
}
