import { describe, expect, it } from "vitest";
import { chromium } from "playwright";
import { probeModalTriggers, type ModalTriggerProbeResults } from "./modal-trigger-probe.js";
import type { Target } from "../core/types.js";

const FIXTURE = `
<!DOCTYPE html>
<html lang="en">
<body>
<button id="good-open" aria-haspopup="dialog" aria-controls="good-dialog">Open good dialog</button>
<div id="good-dialog" role="dialog" aria-labelledby="good-title"
     style="display:none;position:fixed;inset:0;background:white;padding:20px">
  <h2 id="good-title">Good dialog</h2>
  <button id="good-first">First</button>
  <button id="good-last">Last</button>
</div>

<button id="bad-focus-open" aria-haspopup="dialog" aria-controls="bad-focus-dialog">Open unfocused dialog</button>
<div id="bad-focus-dialog" role="dialog" aria-labelledby="bad-focus-title"
     style="display:none;position:fixed;inset:0;background:white;padding:20px">
  <h2 id="bad-focus-title">Bad focus dialog</h2>
  <button id="bad-focus-first">First</button>
  <button id="bad-focus-last">Last</button>
</div>

<button id="bad-return-open" aria-haspopup="dialog" aria-controls="bad-return-dialog">Open bad return dialog</button>
<div id="bad-return-dialog" role="dialog" aria-labelledby="bad-return-title"
     style="display:none;position:fixed;inset:0;background:white;padding:20px">
  <h2 id="bad-return-title">Bad return dialog</h2>
  <button id="bad-return-first">First</button>
  <button id="bad-return-last">Last</button>
</div>
<button id="after">After dialogs</button>

<script>
function wireDialog(openId, dialogId, firstId, lastId, options = {}) {
  const open = document.getElementById(openId);
  const dialog = document.getElementById(dialogId);
  const first = document.getElementById(firstId);
  const last = document.getElementById(lastId);
  open.addEventListener("keydown", event => {
    if (event.key !== "Enter") return;
    dialog.style.display = "block";
    if (!options.skipInitialFocus) first.focus();
  });
  dialog.addEventListener("keydown", event => {
    if (event.key === "Tab" && document.activeElement === last && !event.shiftKey) {
      event.preventDefault();
      first.focus();
    }
    if (event.key === "Escape") {
      dialog.style.display = "none";
      if (options.badReturn) document.getElementById("after").focus();
      else open.focus();
    }
  });
}
wireDialog("good-open", "good-dialog", "good-first", "good-last");
wireDialog("bad-focus-open", "bad-focus-dialog", "bad-focus-first", "bad-focus-last", { skipInitialFocus: true });
wireDialog("bad-return-open", "bad-return-dialog", "bad-return-first", "bad-return-last", { badReturn: true });
</script>
</body>
</html>
`;

function target(id: string, name: string): Target {
  return {
    id,
    kind: "button",
    role: "button",
    name,
    requiresBranchOpen: false,
  } as Target;
}

function getProbe(result: Target[], id: string): ModalTriggerProbeResults {
  return (result.find((t) => t.id === id) as Record<string, unknown>)
    ._modalTriggerProbe as ModalTriggerProbeResults;
}

describe("probeModalTriggers", () => {
  it("measures the full trigger-to-dialog flow", async () => {
    const browser = await chromium.launch();
    const page = await browser.newPage();
    await page.setContent(FIXTURE);
    const result = await probeModalTriggers(page, [target("good", "Open good dialog")]);
    await browser.close();

    const probe = getProbe(result, "good");
    expect(probe.probeSucceeded).toBe(true);
    expect(probe.opensDialog).toBe(true);
    expect(probe.focusMovedInside).toBe(true);
    expect(probe.tabStaysInside).toBe(true);
    expect(probe.escapeCloses).toBe(true);
    expect(probe.focusReturnedToTrigger).toBe(true);
  }, 30000);

  it("flags missing initial focus movement into an opened dialog", async () => {
    const browser = await chromium.launch();
    const page = await browser.newPage();
    await page.setContent(FIXTURE);
    const result = await probeModalTriggers(page, [target("bad-focus", "Open unfocused dialog")]);
    await browser.close();

    const probe = getProbe(result, "bad-focus");
    expect(probe.probeSucceeded).toBe(true);
    expect(probe.opensDialog).toBe(true);
    expect(probe.focusMovedInside).toBe(false);
  }, 30000);

  it("flags dialogs that close without returning focus to the opener", async () => {
    const browser = await chromium.launch();
    const page = await browser.newPage();
    await page.setContent(FIXTURE);
    const result = await probeModalTriggers(page, [target("bad-return", "Open bad return dialog")]);
    await browser.close();

    const probe = getProbe(result, "bad-return");
    expect(probe.probeSucceeded).toBe(true);
    expect(probe.escapeCloses).toBe(true);
    expect(probe.focusReturnedToTrigger).toBe(false);
  }, 30000);
});
