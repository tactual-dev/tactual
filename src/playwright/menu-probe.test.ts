import { describe, it, expect } from "vitest";
import { chromium } from "playwright";
import { probeMenuPatterns, type MenuProbeResults } from "./menu-probe.js";
import type { Target } from "../core/types.js";

const FIXTURE = `
<!DOCTYPE html>
<html lang="en">
<body>
<button id="good" aria-haspopup="menu" aria-expanded="false" aria-controls="good-menu">Actions</button>
<div id="good-menu" role="menu" hidden>
  <button role="menuitem" tabindex="-1">Edit</button>
  <button role="menuitem" tabindex="-1">Delete</button>
</div>

<button id="bad-escape" aria-haspopup="menu" aria-expanded="false" aria-controls="bad-escape-menu">More</button>
<div id="bad-escape-menu" role="menu" hidden>
  <button role="menuitem" tabindex="-1">Share</button>
  <button role="menuitem" tabindex="-1">Report</button>
</div>

<button id="bad-arrow" aria-haspopup="menu" aria-expanded="false" aria-controls="bad-arrow-menu">Options</button>
<div id="bad-arrow-menu" role="menu" hidden>
  <button role="menuitem" tabindex="-1">Option 1</button>
  <button role="menuitem" tabindex="-1">Option 2</button>
</div>

<button id="plain">Plain Button</button>

<script>
function mkMenu(triggerId, menuId, opts) {
  const trigger = document.getElementById(triggerId);
  const menu = document.getElementById(menuId);
  const items = [...menu.querySelectorAll('[role="menuitem"]')];
  let openedBy = null;

  function open() {
    menu.hidden = false;
    trigger.setAttribute("aria-expanded", "true");
    openedBy = trigger;
    items[0].focus();
  }
  function close() {
    menu.hidden = true;
    trigger.setAttribute("aria-expanded", "false");
    if (opts.restoreFocus && openedBy) openedBy.focus();
    openedBy = null;
  }

  trigger.addEventListener("click", () => (menu.hidden ? open() : close()));
  trigger.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(); }
  });
  menu.addEventListener("keydown", (e) => {
    const idx = items.indexOf(document.activeElement);
    if (opts.arrowKeys && e.key === "ArrowDown") {
      e.preventDefault();
      items[(idx + 1) % items.length].focus();
    }
    if (e.key === "Escape") { e.preventDefault(); close(); }
  });
  if (opts.outsideClick) {
    document.addEventListener("click", (e) => {
      if (!menu.hidden && !menu.contains(e.target) && e.target !== trigger) close();
    });
  }
}

mkMenu("good", "good-menu", { restoreFocus: true, arrowKeys: true, outsideClick: true });
mkMenu("bad-escape", "bad-escape-menu", { restoreFocus: false, arrowKeys: true, outsideClick: true });
mkMenu("bad-arrow", "bad-arrow-menu", { restoreFocus: true, arrowKeys: false, outsideClick: true });
</script>
</body>
</html>
`;

function t(id: string, name: string, role = "button", hp: string = "menu"): Target {
  return {
    id,
    kind: "button" as Target["kind"],
    role,
    name,
    requiresBranchOpen: false,
    _attributeValues: { "aria-haspopup": hp },
  } as unknown as Target;
}

describe("probeMenuPatterns", () => {
  it("reports 4/4 pass on a well-formed APG menu", async () => {
    const browser = await chromium.launch();
    const page = await browser.newPage();
    await page.setContent(FIXTURE);
    const targets = [t("good", "Actions"), t("plain", "Plain Button", "button", "")];
    const result = await probeMenuPatterns(page, targets);
    await browser.close();
    const good = result.find((x) => x.id === "good") as Record<string, unknown>;
    const probe = good._menuProbe as MenuProbeResults;
    expect(probe).toBeDefined();
    expect(probe.probeSucceeded).toBe(true);
    expect(probe.opens).toBe(true);
    expect(probe.arrowDownAdvances).toBe(true);
    expect(probe.escapeRestoresFocus).toBe(true);
    expect(probe.outsideClickCloses).toBe(true);
  }, 30000);

  it("flags escapeRestoresFocus=false on a menu that doesn't restore focus after Escape", async () => {
    const browser = await chromium.launch();
    const page = await browser.newPage();
    await page.setContent(FIXTURE);
    const targets = [t("bad-escape", "More")];
    const result = await probeMenuPatterns(page, targets);
    await browser.close();
    const bad = result.find((x) => x.id === "bad-escape") as Record<string, unknown>;
    const probe = bad._menuProbe as MenuProbeResults;
    expect(probe.opens).toBe(true);
    expect(probe.arrowDownAdvances).toBe(true);
    expect(probe.escapeRestoresFocus).toBe(false); // bug caught
    // outsideClickCloses may pass — that invariant is correct for this fixture
  }, 30000);

  it("flags arrowDownAdvances=false on a menu without arrow-key nav", async () => {
    const browser = await chromium.launch();
    const page = await browser.newPage();
    await page.setContent(FIXTURE);
    const targets = [t("bad-arrow", "Options")];
    const result = await probeMenuPatterns(page, targets);
    await browser.close();
    const bad = result.find((x) => x.id === "bad-arrow") as Record<string, unknown>;
    const probe = bad._menuProbe as MenuProbeResults;
    expect(probe.opens).toBe(true);
    expect(probe.arrowDownAdvances).toBe(false); // bug caught
    expect(probe.escapeRestoresFocus).toBe(true);
  }, 30000);

  it("skips targets without aria-haspopup (plain buttons pass through unchanged)", async () => {
    const browser = await chromium.launch();
    const page = await browser.newPage();
    await page.setContent(FIXTURE);
    const targets = [t("plain", "Plain Button", "button", "")];
    const result = await probeMenuPatterns(page, targets);
    await browser.close();
    const plain = result.find((x) => x.id === "plain") as Record<string, unknown>;
    expect(plain._menuProbe).toBeUndefined();
  }, 30000);

  it("returns the original targets array unchanged when no menu triggers exist", async () => {
    const browser = await chromium.launch();
    const page = await browser.newPage();
    await page.setContent("<button>No menu here</button>");
    const targets: Target[] = [
      { id: "nope", kind: "button", role: "button", name: "No menu here", requiresBranchOpen: false },
    ];
    const result = await probeMenuPatterns(page, targets);
    await browser.close();
    expect(result).toBe(targets); // same array reference
  }, 30000);

  it("respects the maxTriggers budget", async () => {
    const browser = await chromium.launch();
    const page = await browser.newPage();
    await page.setContent(FIXTURE);
    const targets = [
      t("good", "Actions"),
      t("bad-escape", "More"),
      t("bad-arrow", "Options"),
    ];
    const result = await probeMenuPatterns(page, targets, 1);
    await browser.close();
    const probed = result.filter(
      (x) => (x as Record<string, unknown>)._menuProbe !== undefined,
    );
    expect(probed.length).toBe(1);
  }, 30000);

  it("samples oversized sig groups and broadcasts the exemplar result", async () => {
    // 6 menu triggers, identical sig (same parent/role/haspopup). Expect
    // 2 directly probed (exemplars) + 4 broadcast (sampledFromExemplar).
    const browser = await chromium.launch();
    const page = await browser.newPage();
    await page.setContent(`
      <!DOCTYPE html>
      <div class="grid">
        <button aria-haspopup="menu" aria-expanded="false" aria-controls="m1">Row 1 menu</button>
        <div id="m1" role="menu" hidden><button role="menuitem">A</button></div>
        <button aria-haspopup="menu" aria-expanded="false" aria-controls="m2">Row 2 menu</button>
        <div id="m2" role="menu" hidden><button role="menuitem">A</button></div>
        <button aria-haspopup="menu" aria-expanded="false" aria-controls="m3">Row 3 menu</button>
        <div id="m3" role="menu" hidden><button role="menuitem">A</button></div>
        <button aria-haspopup="menu" aria-expanded="false" aria-controls="m4">Row 4 menu</button>
        <div id="m4" role="menu" hidden><button role="menuitem">A</button></div>
        <button aria-haspopup="menu" aria-expanded="false" aria-controls="m5">Row 5 menu</button>
        <div id="m5" role="menu" hidden><button role="menuitem">A</button></div>
        <button aria-haspopup="menu" aria-expanded="false" aria-controls="m6">Row 6 menu</button>
        <div id="m6" role="menu" hidden><button role="menuitem">A</button></div>
      </div>
    `);
    const targets: Target[] = [];
    for (let i = 1; i <= 6; i++) {
      targets.push({
        id: `row${i}`, kind: "button", role: "button",
        name: `Row ${i} menu`, requiresBranchOpen: false,
      });
    }
    const result = await probeMenuPatterns(page, targets);
    await browser.close();
    const probed = result.filter(
      (x) => (x as Record<string, unknown>)._menuProbe !== undefined,
    );
    const sampled = probed.filter((x) => {
      const p = (x as Record<string, unknown>)._menuProbe as Record<string, unknown> | undefined;
      return p?.sampledFromExemplar === true;
    });
    // All 6 should have a probe result, but only 2 should be direct (not sampled)
    expect(probed.length).toBe(6);
    expect(sampled.length).toBe(4);
  }, 30000);

  it("generates readable synthetic IDs that include the accname slug", async () => {
    // Pass an empty target list so every DOM-discovered trigger becomes
    // synthetic — this exercises the ID-naming path.
    const browser = await chromium.launch();
    const page = await browser.newPage();
    await page.setContent(`
      <button aria-haspopup="menu" aria-expanded="false" aria-controls="m">User Menu</button>
      <div id="m" role="menu" hidden><button role="menuitem">Profile</button></div>
    `);
    const result = await probeMenuPatterns(page, []);
    await browser.close();
    const synthetic = result.find((t) => t.id.startsWith("menu-trigger-synthetic:"));
    expect(synthetic).toBeDefined();
    // Slug should derive from the accname "User Menu" → "user-menu".
    expect(synthetic!.id).toMatch(/^menu-trigger-synthetic:user-menu-\d+$/);
  }, 30000);
});
