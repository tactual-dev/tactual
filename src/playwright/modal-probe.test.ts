import { describe, it, expect } from "vitest";
import { chromium } from "playwright";
import { probeModalDialogs, type ModalProbeResults } from "./modal-probe.js";
import type { Target } from "../core/types.js";

const FIXTURE = `
<!DOCTYPE html>
<html lang="en">
<body>
<div id="good" role="dialog" aria-labelledby="good-title" aria-modal="true"
     style="display:block;position:fixed;inset:0;background:#fff;padding:20px">
  <h2 id="good-title">Good dialog</h2>
  <button id="g1">Confirm</button>
  <button id="g2">Cancel</button>
  <button id="g-close">Close</button>
</div>

<div id="bad-trap" role="dialog" aria-labelledby="bad-trap-title"
     style="display:none;position:fixed;inset:0;background:#fff;padding:20px">
  <h2 id="bad-trap-title">Bad trap dialog</h2>
  <button id="bt1">Button A</button>
  <button id="bt2">Button B</button>
</div>

<div id="bad-esc" role="dialog" aria-labelledby="bad-esc-title"
     style="display:none;position:fixed;inset:0;background:#fff;padding:20px">
  <h2 id="bad-esc-title">Bad escape dialog</h2>
  <button id="be1">Inside 1</button>
  <button id="be2">Inside 2</button>
</div>

<button id="outside">Outside dialog</button>

<script>
// Good dialog: Tab cycles within, Escape closes, focus trap works.
(function () {
  const d = document.getElementById("good");
  const focusables = () => [...d.querySelectorAll("button")];
  d.addEventListener("keydown", (e) => {
    if (e.key === "Escape") { e.preventDefault(); d.style.display = "none"; return; }
    if (e.key === "Tab") {
      const fs = focusables();
      const first = fs[0], last = fs[fs.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault(); last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault(); first.focus();
      }
    }
  });
})();
// Bad trap: no trap handling at all; Tab escapes the dialog.
// Bad escape: Escape doesn't close it.
(function () {
  const d = document.getElementById("bad-esc");
  const focusables = () => [...d.querySelectorAll("button")];
  d.addEventListener("keydown", (e) => {
    if (e.key === "Tab") {
      const fs = focusables();
      const first = fs[0], last = fs[fs.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault(); last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault(); first.focus();
      }
    }
    // BUG: no Escape handler
  });
})();
</script>
</body>
</html>
`;

function t(id: string, role = "dialog", name?: string): Target {
  return {
    id,
    kind: "dialog" as Target["kind"],
    role,
    name: name ?? "Dialog",
    requiresBranchOpen: false,
  } as unknown as Target;
}

async function showDialog(page: import("playwright").Page, domId: string) {
  await page.evaluate((id) => {
    const el = document.getElementById(id);
    if (el) el.style.display = "block";
  }, domId);
}

describe("probeModalDialogs", () => {
  it("reports 3/3 pass on a well-formed APG dialog with focus trap + Escape", async () => {
    const browser = await chromium.launch();
    const page = await browser.newPage();
    await page.setContent(FIXTURE);
    // Good dialog is already visible
    const targets = [t("good", "dialog", "Good dialog")];
    const result = await probeModalDialogs(page, targets);
    await browser.close();
    const probe = (result.find((x) => x.id === "good") as Record<string, unknown>)
      ._modalProbe as ModalProbeResults;
    expect(probe).toBeDefined();
    expect(probe.probeSucceeded).toBe(true);
    expect(probe.focusTrapped).toBe(true);
    expect(probe.shiftTabWraps).toBe(true);
    expect(probe.escapeCloses).toBe(true);
  }, 30000);

  it("flags focusTrapped=false on a dialog without a trap handler", async () => {
    const browser = await chromium.launch();
    const page = await browser.newPage();
    await page.setContent(FIXTURE);
    await showDialog(page, "bad-trap");
    const targets = [t("bad-trap", "dialog", "Bad trap dialog")];
    const result = await probeModalDialogs(page, targets);
    await browser.close();
    const probe = (result.find((x) => x.id === "bad-trap") as Record<string, unknown>)
      ._modalProbe as ModalProbeResults;
    expect(probe.probeSucceeded).toBe(true);
    // Without a trap, Tab from last focusable moves to #outside (outside dialog)
    expect(probe.focusTrapped).toBe(false);
  }, 30000);

  it("flags escapeCloses=false on a dialog that ignores Escape", async () => {
    const browser = await chromium.launch();
    const page = await browser.newPage();
    await page.setContent(FIXTURE);
    await showDialog(page, "bad-esc");
    const targets = [t("bad-esc", "dialog", "Bad escape dialog")];
    const result = await probeModalDialogs(page, targets);
    await browser.close();
    const probe = (result.find((x) => x.id === "bad-esc") as Record<string, unknown>)
      ._modalProbe as ModalProbeResults;
    expect(probe.probeSucceeded).toBe(true);
    expect(probe.escapeCloses).toBe(false);
  }, 30000);

  it("marks dialogs with no focusable children as skipped-meaningfully", async () => {
    const browser = await chromium.launch();
    const page = await browser.newPage();
    await page.setContent(`
      <div id="empty" role="dialog" aria-labelledby="t"
           style="display:block;position:fixed;inset:0;background:#fff;padding:20px">
        <h2 id="t">Empty</h2>
        <p>No buttons, no inputs. Can't trap anything.</p>
      </div>
    `);
    const result = await probeModalDialogs(page, [t("empty", "dialog", "Empty")]);
    await browser.close();
    const probe = (result.find((x) => x.id === "empty") as Record<string, unknown>)
      ._modalProbe as ModalProbeResults;
    expect(probe.probeSucceeded).toBe(true);
    expect(probe.dialogHasNoFocusables).toBe(true);
  }, 30000);

  it("skips hidden dialogs", async () => {
    const browser = await chromium.launch();
    const page = await browser.newPage();
    await page.setContent(FIXTURE);
    // bad-trap starts with display:none
    const result = await probeModalDialogs(page, [t("bad-trap", "dialog", "Bad trap dialog")]);
    await browser.close();
    const probe = (result.find((x) => x.id === "bad-trap") as Record<string, unknown>)
      ._modalProbe;
    expect(probe).toBeUndefined();
  }, 30000);

  it("non-dialog targets pass through unchanged; synthetic dialogs may be appended", async () => {
    // With DOM-first discovery, dialogs present in the DOM but missing from
    // the captured target set will be probed and emitted as synthetic targets.
    // The non-dialog targets in the input are returned unmodified.
    const browser = await chromium.launch();
    const page = await browser.newPage();
    await page.setContent(FIXTURE);
    const targets: Target[] = [
      { id: "btn", kind: "button", role: "button", name: "Outside dialog", requiresBranchOpen: false },
    ];
    const result = await probeModalDialogs(page, targets);
    await browser.close();
    const btn = result.find((x) => x.id === "btn");
    expect(btn).toBeDefined();
    expect((btn as Record<string, unknown>)._modalProbe).toBeUndefined();
  }, 30000);
});
