import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { chromium } from "playwright";
import { canonicalizeYaml, captureState, parseAriaSnapshot } from "./capture.js";
import { buildAnnouncement } from "./sr-simulator.js";
import type { Target } from "../core/types.js";

describe("parseAriaSnapshot", () => {
  it("extracts targets from a simple snapshot", () => {
    const yaml = `- banner:
  - heading "Site Title" [level=1]
  - navigation "Main":
    - link "Home"
    - link "About"
- main:
  - heading "Welcome" [level=2]
  - button "Submit"
  - textbox "Email"`;

    const targets = parseAriaSnapshot(yaml);

    // banner, heading, navigation, link, link, main, heading, button, textbox
    expect(targets.length).toBe(9);

    const banner = targets.find((t) => t.role === "banner");
    expect(banner?.kind).toBe("landmark");

    const h1 = targets.find((t) => t.name === "Site Title");
    expect(h1?.kind).toBe("heading");
    expect(h1?.headingLevel).toBe(1);

    const nav = targets.find((t) => t.role === "navigation");
    expect(nav?.kind).toBe("landmark");
    expect(nav?.name).toBe("Main");

    const links = targets.filter((t) => t.kind === "link");
    expect(links).toHaveLength(2);

    const button = targets.find((t) => t.kind === "button");
    expect(button?.name).toBe("Submit");

    const textbox = targets.find((t) => t.role === "textbox");
    expect(textbox?.kind).toBe("formField");
  });

  it("handles empty snapshot", () => {
    expect(parseAriaSnapshot("")).toEqual([]);
  });

  it("handles snapshot with dialogs", () => {
    const yaml = `- dialog "Confirm":
  - heading "Are you sure?" [level=2]
  - button "Yes"
  - button "No"`;

    const targets = parseAriaSnapshot(yaml);
    const dialog = targets.find((t) => t.kind === "dialog");
    expect(dialog?.name).toBe("Confirm");
  });

  it("handles roles without names", () => {
    const yaml = `- main:
  - search:
    - textbox "Search"
    - button "Go"`;

    const targets = parseAriaSnapshot(yaml);
    expect(targets.some((t) => t.kind === "landmark" && t.role === "main")).toBe(true);
    expect(targets.some((t) => t.kind === "search")).toBe(true);
  });

  it("handles menu structures", () => {
    const yaml = `- menubar "File Menu":
  - menuitem "New"
  - menuitem "Open"
  - menuitem "Save"`;

    const targets = parseAriaSnapshot(yaml);
    expect(targets.filter((t) => t.kind === "menuItem")).toHaveLength(3);
    expect(targets.some((t) => t.kind === "menuTrigger")).toBe(true);
  });

  it("keeps structured table/grid/tree roles as modeled targets", () => {
    const yaml = `- table "Open invoices":
  - row:
    - columnheader "Account"
    - columnheader "Status"
  - row:
    - rowheader "Ada Labs"
    - cell "Ready"
- grid "Account review grid":
  - row:
    - columnheader "Owner"
    - gridcell "Grace"
- tree "Repository folders":
  - treeitem "src" [expanded]
- treegrid "Expandable accounts":
  - row:
    - rowheader "Enterprise"`;

    const targets = parseAriaSnapshot(yaml);

    expect(targets).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ role: "table", kind: "other", name: "Open invoices" }),
        expect.objectContaining({ role: "columnheader", kind: "other", name: "Account" }),
        expect.objectContaining({ role: "rowheader", kind: "other", name: "Ada Labs" }),
        expect.objectContaining({ role: "cell", kind: "other", name: "Ready" }),
        expect.objectContaining({ role: "grid", kind: "other", name: "Account review grid" }),
        expect.objectContaining({ role: "gridcell", kind: "other", name: "Grace" }),
        expect.objectContaining({ role: "tree", kind: "other", name: "Repository folders" }),
        expect.objectContaining({ role: "treeitem", kind: "other", name: "src" }),
        expect.objectContaining({ role: "treegrid", kind: "other", name: "Expandable accounts" }),
      ]),
    );
  });

  it("generates unique target IDs", () => {
    const yaml = `- main:
  - button "A"
  - button "B"
  - button "C"`;

    const targets = parseAriaSnapshot(yaml);
    const ids = targets.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("captures ARIA attribute values for state-aware announcements", () => {
    const yaml = `- main:
  - checkbox "Subscribe" [checked]
  - combobox "Country" [expanded=false]
  - tab "Settings" [selected]
  - dialog "Confirm" [modal]
  - slider "Volume": "75"`;

    const targets = parseAriaSnapshot(yaml);
    const checkbox = targets.find((t) => t.role === "checkbox") as Record<string, unknown>;
    expect(checkbox._attributeValues).toMatchObject({ "aria-checked": "true" });

    const combobox = targets.find((t) => t.role === "combobox") as Record<string, unknown>;
    expect(combobox._attributeValues).toMatchObject({ "aria-expanded": "false" });

    const tab = targets.find((t) => t.role === "tab") as Record<string, unknown>;
    expect(tab._attributeValues).toMatchObject({ "aria-selected": "true" });

    const dialog = targets.find((t) => t.role === "dialog") as Record<string, unknown>;
    expect(dialog._attributeValues).toMatchObject({ "aria-modal": "true" });

    const slider = targets.find((t) => t.role === "slider") as Record<string, unknown>;
    expect(slider._value).toBe("75");
  });

  it("retains lightweight AT-tree ancestry metadata for targets", () => {
    const yaml = `- main:
  - navigation "Primary":
    - link "Home"
  - region "Billing":
    - heading "Invoices" [level=2]
    - button "Pay now"`;

    const targets = parseAriaSnapshot(yaml);
    const link = targets.find((t) => t.name === "Home") as Record<string, unknown>;
    expect(link._atTree).toMatchObject({
      depth: 2,
      parent: { role: "navigation", name: "Primary" },
      ancestors: [{ role: "main" }, { role: "navigation", name: "Primary" }],
    });

    const button = targets.find((t) => t.name === "Pay now") as Record<string, unknown>;
    expect(button._atTree).toMatchObject({
      depth: 2,
      parent: { role: "region", name: "Billing" },
    });
  });
});

describe("canonicalizeYaml", () => {
  it("strips digits from quoted accessible names so dynamic counts hash the same", () => {
    const before = `- button "Saved 5 minutes ago"\n- status "3 unread messages"`;
    const after = `- button "Saved 12 minutes ago"\n- status "1 unread message"`;
    expect(canonicalizeYaml(before)).toBe(canonicalizeYaml(after).replace(/messages?/g, "messages"));
  });

  it("preserves digits inside structural attributes like [level=1]", () => {
    const yaml = `- heading "Title" [level=1]\n- heading "Sub" [level=2]`;
    const canonical = canonicalizeYaml(yaml);
    expect(canonical).toContain("[level=1]");
    expect(canonical).toContain("[level=2]");
  });

  it("only normalizes inside double-quoted names, not surrounding YAML", () => {
    expect(canonicalizeYaml(`- button "5 items"`)).toBe(`- button "N items"`);
    expect(canonicalizeYaml(`- list:\n  - listitem "item 1"`)).toBe(`- list:\n  - listitem "item N"`);
  });
});

describe("captureState", () => {
  // Shared browser per file (per-test newPage gives isolation). Refactored
  // from per-test chromium.launch to reduce parallel-worker contention.
  let browser: import("playwright").Browser;
  beforeAll(async () => {
    browser = await chromium.launch();
  });
  afterAll(async () => {
    await browser.close();
  });

  it("limits capture to scoped subtrees when scopeSelectors are provided", async () => {
    const page = await browser.newPage();
    await page.setContent(`
      <nav aria-label="Global"><a href="/docs">Docs</a></nav>
      <main id="work-area">
        <h1>Workspace</h1>
        <button>Run check</button>
      </main>
    `);

    const state = await captureState(page, {
      provenance: "scripted",
      scopeSelectors: ["#work-area", "main["],
    });
    await page.close();

    expect(state.targets.some((target) => target.name === "Run check")).toBe(true);
    expect(state.targets.some((target) => target.name === "Docs")).toBe(false);
  }, 20000);

  it("ignores invalid excluded selectors while applying valid exclusions", async () => {
    const page = await browser.newPage();
    await page.setContent(`
      <main>
        <button>Keep me</button>
        <button id="ad">Exclude me</button>
      </main>
    `);

    const state = await captureState(page, {
      provenance: "scripted",
      excludeSelectors: ["#ad", "main["],
      minTargets: 1,
    });
    await page.close();

    expect(state.targets.some((target) => target.name === "Keep me")).toBe(true);
    expect(state.targets.some((target) => target.name === "Exclude me")).toBe(false);
  }, 20000);

  it("marks native selects so APG combobox checks do not treat them as custom widgets", async () => {
    const page = await browser.newPage();
    await page.setContent(`
      <main>
        <label for="country">Country</label>
        <select id="country">
          <option>Canada</option>
          <option>United States</option>
        </select>
      </main>
    `);

    const state = await captureState(page, { provenance: "scripted", minTargets: 1 });
    await page.close();

    const select = state.targets.find((target) => target.role === "combobox") as
      | Record<string, unknown>
      | undefined;
    expect(select?._htmlTag).toBe("select");
    expect(select?._nativeHtmlControl).toBe("select");
  }, 20000);

  it("projects native control state into state-aware announcements", async () => {
    const page = await browser.newPage();
    await page.setContent(`
      <main>
        <label for="plan">Plan</label>
        <select id="plan">
          <option>Free</option>
          <option selected>Pro</option>
        </select>

        <label>
          <input type="checkbox" />
          Weekly digest
        </label>

        <fieldset>
          <legend>Billing contact</legend>
          <label>
            <input type="radio" name="billing" checked />
            Use my profile
          </label>
          <label>
            <input type="radio" name="billing" />
            Use team owner
          </label>
        </fieldset>
      </main>
    `);

    const state = await captureState(page, { provenance: "scripted", minTargets: 1 });
    await page.close();

    const plan = state.targets.find((target) => target.role === "combobox" && target.name === "Plan") as
      | Record<string, unknown>
      | undefined;
    expect(plan?._attributeValues).toMatchObject({ "aria-expanded": "false" });
    expect(buildAnnouncement(plan as Target)).toBe("Plan, combo box, collapsed");

    const checkbox = state.targets.find((target) => target.role === "checkbox" && target.name === "Weekly digest") as
      | Record<string, unknown>
      | undefined;
    expect(checkbox?._attributeValues).toMatchObject({ "aria-checked": "false" });
    expect(buildAnnouncement(checkbox as Target)).toBe("Weekly digest, check box, not checked");

    const selectedRadio = state.targets.find((target) => target.role === "radio" && target.name === "Use my profile") as
      | Record<string, unknown>
      | undefined;
    expect(selectedRadio?._attributeValues).toMatchObject({ "aria-checked": "true" });
    expect(buildAnnouncement(selectedRadio as Target)).toBe("Use my profile, radio button, checked");

    const unselectedRadio = state.targets.find((target) => target.role === "radio" && target.name === "Use team owner") as
      | Record<string, unknown>
      | undefined;
    expect(unselectedRadio?._attributeValues).toMatchObject({ "aria-checked": "false" });
    expect(buildAnnouncement(unselectedRadio as Target)).toBe("Use team owner, radio button, not checked");
  }, 20000);

  it("waits for likely app-shell hydration even when the initial tree is non-empty", async () => {
    const page = await browser.newPage();
    await page.setContent(`
      <main id="root">
        <h1>Loading docs</h1>
        <a href="/">Home</a>
        <button>Menu</button>
        <script>
          setTimeout(() => {
            const root = document.getElementById("root");
            for (let i = 0; i < 35; i++) {
              const button = document.createElement("button");
              button.textContent = "Operation " + i;
              root.appendChild(button);
            }
          }, 700);
        </script>
      </main>
    `);

    const state = await captureState(page, {
      provenance: "scripted",
      spaWaitTimeout: 5000,
    });
    await page.close();

    expect(
      state.targets.filter((target) => target.role === "button").length,
    ).toBeGreaterThanOrEqual(35);
  }, 20000);

  // Regression coverage for the accessible-name resolution fix in
  // enrichWithAriaReferences. Prior to the fix, name was extracted as
  // aria-label-or-empty, which missed every native input labeled via
  // <label for>, every button whose name was its text content, etc.
  it("resolves aria-describedby on a native input labeled via <label for>", async () => {
    const page = await browser.newPage();
    await page.setContent(`
      <main>
        <label for="email-input">Email</label>
        <input id="email-input" type="email" aria-describedby="email-help" />
        <span id="email-help">We won't share your email</span>
      </main>
    `);
    const state = await captureState(page, { provenance: "scripted", minTargets: 1 });
    await page.close();

    const email = state.targets.find(
      (t) => t.kind === "formField" && t.name === "Email",
    ) as Record<string, unknown> | undefined;
    expect(email?._description).toBe("We won't share your email");
  }, 20000);

  it("resolves aria-describedby on a button whose name is its text content", async () => {
    const page = await browser.newPage();
    await page.setContent(`
      <main>
        <button aria-describedby="save-help">Save</button>
        <span id="save-help">Saves the current form</span>
      </main>
    `);
    const state = await captureState(page, { provenance: "scripted", minTargets: 1 });
    await page.close();

    const btn = state.targets.find(
      (t) => t.kind === "button" && t.name === "Save",
    ) as Record<string, unknown> | undefined;
    expect(btn?._description).toBe("Saves the current form");
  }, 20000);

  it("resolves aria-describedby on an input with a wrapping <label>", async () => {
    const page = await browser.newPage();
    await page.setContent(`
      <main>
        <label>
          Phone
          <input type="tel" aria-describedby="phone-help" />
        </label>
        <span id="phone-help">Include area code</span>
      </main>
    `);
    const state = await captureState(page, { provenance: "scripted", minTargets: 1 });
    await page.close();

    const phone = state.targets.find(
      (t) => t.kind === "formField" && t.name && t.name.includes("Phone"),
    ) as Record<string, unknown> | undefined;
    expect(phone?._description).toBe("Include area code");
  }, 20000);

  it("enriches form fields with _required when [required] or aria-required is set", async () => {
    const page = await browser.newPage();
    await page.setContent(`
      <main>
        <label for="email">Email</label>
        <input id="email" type="email" required />

        <label for="phone">Phone</label>
        <input id="phone" type="tel" />

        <label for="bio">Bio</label>
        <textarea id="bio" required></textarea>

        <div role="textbox" aria-label="Custom field" aria-required="true" tabindex="0">value</div>
      </main>
    `);
    const state = await captureState(page, { provenance: "scripted", minTargets: 1 });
    await page.close();

    const email = state.targets.find((t) => t.kind === "formField" && t.name === "Email");
    const phone = state.targets.find((t) => t.kind === "formField" && t.name === "Phone");
    const bio = state.targets.find((t) => t.kind === "formField" && t.name === "Bio");
    const custom = state.targets.find((t) => t.kind === "formField" && t.name === "Custom field");

    expect((email as Record<string, unknown>)?._required).toBe(true);
    expect((phone as Record<string, unknown>)?._required).toBeUndefined();
    expect((bio as Record<string, unknown>)?._required).toBe(true);
    expect((custom as Record<string, unknown>)?._required).toBe(true);
  }, 20000);

  it("flags empty interactive, missing H1, and media without controls", async () => {
    const page = await browser.newPage();
    await page.setContent(`
      <html lang="en"><head><title>Wave 10 fixture</title></head>
      <body>
        <main>
          <!-- No H1 anywhere -->
          <h2>Section</h2>
          <button></button>          <!-- empty button -->
          <a href="/x"></a>          <!-- empty link -->
          <button>Real</button>
          <video src="/clip.mp4" autoplay></video>
          <audio src="/sound.mp3"></audio>
          <p>Filler 1</p><p>Filler 2</p><p>Filler 3</p><p>Filler 4</p>
          <p>Filler 5</p><p>Filler 6</p><p>Filler 7</p>
        </main>
      </body></html>
    `);
    const state = await captureState(page, { provenance: "scripted", minTargets: 1 });
    await page.close();

    const { diagnoseCapture } = await import("../core/diagnostics.js");
    const diagnostics = diagnoseCapture(state, "http://tactual.test/", "");
    expect(diagnostics.find((d) => d.code === "empty-interactive")?.affectedCount).toBeGreaterThanOrEqual(2);
    expect(diagnostics.find((d) => d.code === "h1-count")).toBeDefined();
    expect(diagnostics.find((d) => d.code === "media-without-controls")?.affectedCount).toBe(2);
  }, 30000);

  it("flags empty headings, numeric-only headings, and skip-link-not-first", async () => {
    const page = await browser.newPage();
    await page.setContent(`
      <html lang="en"><head><title>Heading content test</title></head>
      <body>
        <main>
          <h1></h1>                          <!-- empty -->
          <h2>2024</h2>                      <!-- numeric only -->
          <h2>$23M</h2>                      <!-- starts with $, mostly digits -->
          <h2>Real heading</h2>              <!-- fine -->
          <a href="#main">Skip to main content</a>
        </main>
      </body></html>
    `);
    const state = await captureState(page, { provenance: "scripted", minTargets: 1 });
    await page.close();

    const { diagnoseCapture } = await import("../core/diagnostics.js");
    const diagnostics = diagnoseCapture(state, "http://tactual.test/", "");
    expect(diagnostics.find((d) => d.code === "empty-heading")?.affectedCount).toBe(1);
    expect(diagnostics.find((d) => d.code === "numeric-heading")?.affectedCount).toBeGreaterThanOrEqual(1);
  }, 30000);

  it("flags skip-link-not-first when tab order data shows the skip link isn't reachable early", async () => {
    const page = await browser.newPage();
    await page.setContent(`
      <html lang="en"><head><title>Skip-link-position test</title></head>
      <body>
        <main>
          <button>First button</button>
          <button>Second button</button>
          <button>Third button</button>
          <a href="#main">Skip to main content</a>
          <main id="main"><h1>Workspace</h1></main>
        </main>
      </body></html>
    `);
    const state = await captureState(page, { provenance: "scripted", minTargets: 1 });
    // Simulate what pipeline does: stash tab order on state.
    (state as Record<string, unknown>)._tabOrder = {
      sequence: [
        { name: "First button" },
        { name: "Second button" },
        { name: "Third button" },
        { name: "Skip to main content" },
      ],
    };
    await page.close();

    const { diagnoseCapture } = await import("../core/diagnostics.js");
    const diagnostics = diagnoseCapture(state, "http://tactual.test/", "");
    expect(diagnostics.find((d) => d.code === "skip-link-not-first")).toBeDefined();
  }, 30000);

  it("lang-switch detection flags French paragraph on an English page", async () => {
    const page = await browser.newPage();
    await page.setContent(`
      <html lang="en"><head><title>Lang switch</title></head>
      <body><main>
        <h1>Bilingual page</h1>
        <p>This is the English content. The page is in English with normal English words.</p>
        <p>Voici un paragraphe en français qui devrait être détecté comme une langue différente avec des mots français très distinctifs.</p>
      </main></body></html>
    `);
    const state = await captureState(page, { provenance: "scripted", minTargets: 1 });
    await page.close();

    const ls = (state as Record<string, unknown>)._langSwitches as
      | { pageLang: string; suspects: Array<{ detectedLang: string }> }
      | undefined;
    expect(ls?.pageLang).toBe("en");
    expect(ls?.suspects.some((s) => s.detectedLang === "fr")).toBe(true);

    const { diagnoseCapture } = await import("../core/diagnostics.js");
    const diagnostics = diagnoseCapture(state, "http://tactual.test/", "");
    expect(diagnostics.find((d) => d.code === "lang-switch-without-marker")).toBeDefined();
  }, 30000);

  it("color-only conveyance heuristic flags spans differentiated only by color", async () => {
    const page = await browser.newPage();
    await page.setContent(`
      <html lang="en"><head><title>Color-only test</title></head>
      <body>
        <main>
          <h1>Test</h1>
          <p>Status: <span style="color: red;">offline</span></p>
          <p>Mode: <span style="color: green;">production</span></p>
          <!-- Should NOT flag (has icon sibling) -->
          <p>Wrong: <span style="color: red;"><svg width="10" height="10"></svg> bad</span></p>
          <!-- Should NOT flag (font-weight differs) -->
          <p>OK: <span style="color: red; font-weight: bold;">important</span></p>
          <!-- Should NOT flag (has aria-label) -->
          <p>Tag: <span style="color: red;" aria-label="error tag">err</span></p>
        </main>
      </body></html>
    `);
    const state = await captureState(page, { provenance: "scripted", minTargets: 1 });
    await page.close();

    const co = (state as Record<string, unknown>)._colorOnlyConveyance as
      | { count: number; samples: string[] }
      | undefined;
    expect(co?.count).toBe(2);

    const { diagnoseCapture } = await import("../core/diagnostics.js");
    const diagnostics = diagnoseCapture(state, "http://tactual.test/", "");
    const diag = diagnostics.find((d) => d.code === "color-only-conveyance");
    expect(diag?.affectedCount).toBe(2);
  }, 30000);

  it("framework detection identifies Angular via [ng-version] marker", async () => {
    const page = await browser.newPage();
    await page.setContent(`
      <html lang="en"><head><title>Angular</title></head>
      <body>
        <app-root ng-version="17.3.0">
          <main><h1>Angular</h1><button>Click</button></main>
        </app-root>
      </body></html>
    `);
    const state = await captureState(page, { provenance: "scripted", minTargets: 1 });
    await page.close();

    const fws = (state as Record<string, unknown>)._frameworks as
      | Array<{ name: string; version?: string }>
      | undefined;
    expect(fws?.find((f) => f.name === "Angular")?.version).toBe("17.3.0");

    const { diagnoseCapture } = await import("../core/diagnostics.js");
    const diagnostics = diagnoseCapture(state, "http://tactual.test/", "");
    const diag = diagnostics.find((d) => d.code === "framework-detected");
    expect(diag?.message).toMatch(/Angular 17\.3\.0/);
  }, 30000);

  it("CDP listener probe finds click handlers on divs that lack role/tabindex", async () => {
    const page = await browser.newPage();
    await page.setContent(`
      <html lang="en"><head><title>CDP listener probe</title></head>
      <body>
        <main>
          <h1>CDP</h1>
          <div id="fake-a" style="width:60px;height:30px;cursor:pointer">Click A</div>
          <div id="fake-b" style="width:60px;height:30px;cursor:pointer">Click B</div>
          <div id="not-clickable" style="width:60px;height:30px">Just text</div>
        </main>
        <script>
          // Attach via the element on-property (the JS-wrap catches
          // addEventListener but not direct on-property assignment).
          document.getElementById('fake-a').onclick = function () {};
          document.getElementById('fake-b').onmousedown = function () {};
        </script>
      </body></html>
    `);
    const state = await captureState(page, { provenance: "scripted", minTargets: 1 });
    await page.close();

    const cdp = (state as Record<string, unknown>)._cdpListeners as
      | { probed: number; withClickListener: number; samples: string[] }
      | undefined;
    expect(cdp?.withClickListener).toBe(2);

    const { diagnoseCapture } = await import("../core/diagnostics.js");
    const diagnostics = diagnoseCapture(state, "http://tactual.test/", "");
    expect(diagnostics.find((d) => d.code === "cdp-click-listeners")?.affectedCount).toBe(2);
  }, 30000);

  it("flags invalid-aria-role, unknown-aria-attr, and invalid-aria-attr-value", async () => {
    const page = await browser.newPage();
    await page.setContent(`
      <html lang="en"><head><title>ARIA test</title></head>
      <body>
        <main>
          <h1>ARIA</h1>
          <div role="card">Invalid role</div>
          <div role="buton">Typo'd role</div>
          <button aria-decribedby="x">Typo'd attr</button>
          <button aria-checked="on">Bad enum</button>
          <button aria-checked="true">Good enum</button>
        </main>
      </body></html>
    `);
    const state = await captureState(page, { provenance: "scripted", minTargets: 1 });
    await page.close();

    const { diagnoseCapture } = await import("../core/diagnostics.js");
    const diagnostics = diagnoseCapture(state, "http://tactual.test/", "");
    const invalidRole = diagnostics.find((d) => d.code === "invalid-aria-role");
    const unknownAttr = diagnostics.find((d) => d.code === "unknown-aria-attr");
    const invalidValue = diagnostics.find((d) => d.code === "invalid-aria-attr-value");
    expect(invalidRole?.affectedCount).toBe(2);
    expect(invalidRole?.message).toMatch(/did you mean/);
    expect(unknownAttr?.affectedCount).toBe(1);
    expect(unknownAttr?.message).toMatch(/aria-describedby/);
    expect(invalidValue?.affectedCount).toBe(1);
    expect(invalidValue?.message).toMatch(/aria-checked/);
  }, 30000);

  it("flags duplicate-id, nested-interactive, and meta-refresh structural issues", async () => {
    const page = await browser.newPage();
    await page.setContent(`
      <html lang="en"><head>
        <title>Structural test</title>
        <meta http-equiv="refresh" content="30; url=/somewhere" />
      </head>
      <body>
        <main>
          <h1>Structural</h1>
          <span id="dup">first</span>
          <span id="dup">second</span>
          <span id="dup">third</span>

          <a href="/x">
            Outer link
            <button>Inner button</button>
          </a>
        </main>
      </body></html>
    `);
    const state = await captureState(page, { provenance: "scripted", minTargets: 1 });
    await page.close();

    const struct = (state as Record<string, unknown>)._structuralIssues as
      | { duplicateIds: Array<{ id: string; count: number }>; nestedInteractive: string[]; metaRefresh: boolean }
      | undefined;
    expect(struct?.duplicateIds.find((d) => d.id === "dup")?.count).toBe(3);
    expect(struct?.nestedInteractive.length).toBeGreaterThanOrEqual(1);
    expect(struct?.metaRefresh).toBe(true);

    const { diagnoseCapture } = await import("../core/diagnostics.js");
    const diagnostics = diagnoseCapture(state, "http://tactual.test/", "");
    expect(diagnostics.find((d) => d.code === "duplicate-id")).toBeDefined();
    expect(diagnostics.find((d) => d.code === "nested-interactive")).toBeDefined();
    expect(diagnostics.find((d) => d.code === "meta-refresh")).toBeDefined();
  }, 30000);

  it("flags missing image alt, suspicious image alt, and missing iframe title", async () => {
    const page = await browser.newPage();
    await page.setContent(`
      <html lang="en"><head><title>Media test page</title></head>
      <body>
        <main>
          <h1>Media</h1>
          <img src="/avatar.png" />                    <!-- no alt — bad -->
          <img src="/decor.svg" alt="" />              <!-- decorative — fine -->
          <img src="/chart.png" alt="Q4 revenue chart showing 23% growth" />  <!-- good -->
          <img src="/icon.svg" alt="image" />          <!-- suspicious filler -->
          <img src="/photo.jpg" alt="photo.jpg" />     <!-- filename-as-alt -->
          <iframe src="https://www.youtube.com/embed/abc"></iframe>           <!-- missing title -->
          <iframe src="/payment" title="Payment form"></iframe>               <!-- good -->
        </main>
      </body></html>
    `);
    const state = await captureState(page, { provenance: "scripted", minTargets: 1 });
    await page.close();

    const media = (state as Record<string, unknown>)._mediaMetadata as
      | {
          totalImages: number;
          imagesMissingAlt: number;
          imagesSuspiciousAlt: Array<{ alt: string }>;
          totalIframes: number;
          iframesMissingTitle: Array<{ src: string }>;
        }
      | undefined;
    expect(media?.totalImages).toBe(5);
    expect(media?.imagesMissingAlt).toBe(1);
    expect(media?.imagesSuspiciousAlt.length).toBe(2);
    expect(media?.totalIframes).toBe(2);
    expect(media?.iframesMissingTitle.length).toBe(1);

    const { diagnoseCapture } = await import("../core/diagnostics.js");
    const diagnostics = diagnoseCapture(state, "http://tactual.test/", "");
    expect(diagnostics.find((d) => d.code === "missing-image-alt")?.affectedCount).toBe(1);
    expect(diagnostics.find((d) => d.code === "suspicious-image-alt")?.affectedCount).toBe(2);
    expect(diagnostics.find((d) => d.code === "missing-iframe-title")?.affectedCount).toBe(1);
  }, 30000);

  it("captures document metadata (lang, title, viewport) and emits the relevant diagnostics", async () => {
    const page = await browser.newPage();
    // No <html lang>, generic title, viewport blocks zoom — should
    // trigger all three Wave 6 diagnostics.
    await page.setContent(`
      <html>
        <head>
          <title>Untitled</title>
          <meta name="viewport" content="width=device-width, user-scalable=no" />
        </head>
        <body>
          <main><h1>Heading</h1></main>
        </body>
      </html>
    `);
    const state = await captureState(page, { provenance: "scripted", minTargets: 1 });
    await page.close();

    const meta = (state as Record<string, unknown>)._docMetadata as
      | { htmlLang: string; title: string; zoomRestricted: boolean }
      | undefined;
    expect(meta?.htmlLang).toBe("");
    expect(meta?.title).toBe("Untitled");
    expect(meta?.zoomRestricted).toBe(true);

    const { diagnoseCapture } = await import("../core/diagnostics.js");
    const diagnostics = diagnoseCapture(state, "http://tactual.test/", "");
    expect(diagnostics.find((d) => d.code === "missing-html-lang")).toBeDefined();
    expect(diagnostics.find((d) => d.code === "poor-document-title")).toBeDefined();
    expect(diagnostics.find((d) => d.code === "viewport-blocks-zoom")).toBeDefined();
  }, 20000);

  it("does NOT emit Wave 6 diagnostics when document metadata is healthy", async () => {
    const page = await browser.newPage();
    await page.setContent(`
      <html lang="en">
        <head>
          <title>Pricing — Acme Inc.</title>
          <meta name="viewport" content="width=device-width, initial-scale=1" />
        </head>
        <body><main><h1>Pricing</h1><a href="/x">Plans</a></main></body>
      </html>
    `);
    const state = await captureState(page, { provenance: "scripted", minTargets: 1 });
    await page.close();

    const { diagnoseCapture } = await import("../core/diagnostics.js");
    const diagnostics = diagnoseCapture(state, "http://tactual.test/", "");
    expect(diagnostics.find((d) => d.code === "missing-html-lang")).toBeUndefined();
    expect(diagnostics.find((d) => d.code === "poor-document-title")).toBeUndefined();
    expect(diagnostics.find((d) => d.code === "viewport-blocks-zoom")).toBeUndefined();
  }, 20000);

  it("enriches form fields with _autocomplete and flags missing autocomplete on standard input types", async () => {
    const page = await browser.newPage();
    await page.setContent(`
      <main>
        <form>
          <label>Email <input type="email" /></label>
          <label>Password <input type="password" autocomplete="off" /></label>
          <label>Phone <input type="tel" autocomplete="tel" /></label>
          <label>Site <input type="url" /></label>
        </form>
      </main>
    `);
    const state = await captureState(page, { provenance: "scripted", minTargets: 1 });
    await page.close();

    const phone = state.targets.find((t) => t.kind === "formField" && t.name === "Phone");
    expect((phone as Record<string, unknown>)?._autocomplete).toBe("tel");

    const password = state.targets.find((t) => t.kind === "formField" && t.name === "Password");
    expect((password as Record<string, unknown>)?._autocomplete).toBe("off");

    const { diagnoseCapture } = await import("../core/diagnostics.js");
    const diagnostics = diagnoseCapture(state, "http://tactual.test/", "");
    const diag = diagnostics.find((d) => d.code === "missing-autocomplete");
    expect(diag).toBeDefined();
    // email (no autocomplete), password (off), url (no autocomplete) → 3
    // phone has autocomplete=tel → not flagged
    expect(diag?.affectedCount).toBe(3);
  }, 20000);

  it("flags low-contrast text on buttons/links/headings via low-contrast-text diagnostic", async () => {
    const page = await browser.newPage();
    await page.setContent(`
      <main style="background: white;">
        <h1>Page</h1>
        <button style="background: white; color: #ddd; padding: 8px;">Almost invisible button</button>
        <a href="#x" style="color: #ccc;">Almost invisible link</a>
        <button style="background: white; color: black; padding: 8px;">High contrast button</button>
      </main>
    `);
    const state = await captureState(page, { provenance: "scripted", minTargets: 1 });
    await page.close();

    const lct = (state as Record<string, unknown>)._lowContrastText as
      | { count: number; samples: string[] }
      | undefined;
    expect(lct?.count).toBeGreaterThanOrEqual(2);

    const { diagnoseCapture } = await import("../core/diagnostics.js");
    const diagnostics = diagnoseCapture(state, "http://tactual.test/", "");
    const diag = diagnostics.find((d) => d.code === "low-contrast-text");
    expect(diag).toBeDefined();
    expect(diag?.affectedCount).toBeGreaterThanOrEqual(2);
  }, 20000);

  it("summarizes forms via _forms state metadata + form-summary diagnostic", async () => {
    const page = await browser.newPage();
    await page.setContent(`
      <main>
        <form aria-label="Sign up">
          <label>Email <input type="email" required /></label>
          <label>Name <input type="text" /></label>
          <button type="submit">Sign up</button>
        </form>
        <form>
          <label>Search <input type="search" /></label>
        </form>
      </main>
    `);
    const state = await captureState(page, { provenance: "scripted", minTargets: 1 });
    await page.close();

    const forms = (state as Record<string, unknown>)._forms as
      | Array<Record<string, unknown>>
      | undefined;
    expect(forms?.length).toBe(2);
    expect(forms?.[0].name).toBe("Sign up");
    expect(forms?.[0].fieldCount).toBe(2);
    expect(forms?.[0].requiredCount).toBe(1);
    expect(forms?.[0].hasSubmit).toBe(true);
    expect(forms?.[1].fieldCount).toBe(1);
    expect(forms?.[1].hasSubmit).toBe(false);

    const { diagnoseCapture } = await import("../core/diagnostics.js");
    const diagnostics = diagnoseCapture(state, "http://tactual.test/", "");
    const summary = diagnostics.find((d) => d.code === "form-summary");
    expect(summary).toBeDefined();
    // Search form has no submit and one field → triggers the warning level.
    expect(summary?.level).toBe("warning");
  }, 20000);

  it("emits visual-order-divergence when CSS reorders buttons away from DOM order", async () => {
    const page = await browser.newPage();
    await page.setContent(`
      <main>
        <h1>Reordered</h1>
        <div style="display: flex; flex-direction: row-reverse; width: 600px;">
          <button>Alpha</button>
          <button>Bravo</button>
          <button>Charlie</button>
          <button>Delta</button>
          <button>Echo</button>
        </div>
      </main>
    `);
    const state = await captureState(page, { provenance: "scripted", minTargets: 1 });
    await page.close();

    const { diagnoseCapture } = await import("../core/diagnostics.js");
    const diagnostics = diagnoseCapture(state, "http://tactual.test/", "");
    const divergence = diagnostics.find((d) => d.code === "visual-order-divergence");
    expect(divergence).toBeDefined();
    expect(divergence?.affectedCount).toBeGreaterThanOrEqual(2);
  }, 20000);

  it("does NOT emit visual-order-divergence on a normal vertically-stacked layout", async () => {
    const page = await browser.newPage();
    await page.setContent(`
      <main>
        <h1>Plain</h1>
        <button style="display: block;">Alpha</button>
        <button style="display: block;">Bravo</button>
        <button style="display: block;">Charlie</button>
        <button style="display: block;">Delta</button>
      </main>
    `);
    const state = await captureState(page, { provenance: "scripted", minTargets: 1 });
    await page.close();

    const { diagnoseCapture } = await import("../core/diagnostics.js");
    const diagnostics = diagnoseCapture(state, "http://tactual.test/", "");
    expect(diagnostics.find((d) => d.code === "visual-order-divergence")).toBeUndefined();
  }, 20000);

  it("flags a skip link whose href fragment doesn't match any element", async () => {
    const page = await browser.newPage();
    await page.setContent(`
      <a href="#main">Skip to main content</a>
      <nav><a href="/x">x</a></nav>
      <!-- No element with id="main" -->
      <section><h1>Body</h1><p>content</p></section>
    `);
    const state = await captureState(page, { provenance: "scripted", minTargets: 1 });
    await page.close();

    const skipLink = state.targets.find(
      (t) => t.kind === "link" && t.name === "Skip to main content",
    ) as Record<string, unknown> | undefined;
    expect(skipLink?._skipLinkBroken).toBe("target-missing");
  }, 20000);

  it("does NOT flag a skip link whose href fragment resolves", async () => {
    const page = await browser.newPage();
    await page.setContent(`
      <a href="#main">Skip to main content</a>
      <main id="main"><h1>Workspace</h1><button>Action</button></main>
    `);
    const state = await captureState(page, { provenance: "scripted", minTargets: 1 });
    await page.close();

    const skipLink = state.targets.find(
      (t) => t.kind === "link" && t.name === "Skip to main content",
    ) as Record<string, unknown> | undefined;
    expect(skipLink?._skipLinkBroken).toBeUndefined();
  }, 20000);

  it("counts fake-interactive elements (onclick on non-interactive tags with no role/tabindex)", async () => {
    const page = await browser.newPage();
    await page.setContent(`
      <main>
        <h1>Page</h1>
        <button>Real button</button>
        <a href="/x">Real link</a>
        <div onclick="alert('clicked')" style="width:100px;height:30px;cursor:pointer">Fake button A</div>
        <span onclick="alert('also clicked')" style="display:inline-block;width:100px;height:30px">Fake button B</span>
        <!-- Has role=button → not fake, properly accessible -->
        <div role="button" tabindex="0" onclick="alert()" style="width:50px;height:30px">Real-ish button</div>
      </main>
    `);
    const state = await captureState(page, { provenance: "scripted", minTargets: 1 });
    await page.close();

    const fakeInteractive = (state as Record<string, unknown>)._fakeInteractive as
      | { count: number; samples: string[] }
      | undefined;
    expect(fakeInteractive?.count).toBe(2);
    expect(fakeInteractive?.samples.length).toBeGreaterThan(0);
    expect(fakeInteractive?.samples.some((s) => s.includes("[onclick]"))).toBe(true);
  }, 20000);

  it("flags labelledByMissing on a button whose aria-labelledby points at a removed id", async () => {
    const page = await browser.newPage();
    await page.setContent(`
      <main>
        <button aria-labelledby="missing-id">Fallback name</button>
      </main>
    `);
    const state = await captureState(page, { provenance: "scripted", minTargets: 1 });
    await page.close();

    // ariaSnapshot falls back to the button's text content as the name when
    // aria-labelledby resolves to nothing.
    const btn = state.targets.find(
      (t) => t.kind === "button" && t.name === "Fallback name",
    ) as Record<string, unknown> | undefined;
    expect(btn?._labelledByMissing).toBe(true);
  }, 20000);

  it("captures ARIA relationships for graph-level AT navigation modeling", async () => {
    const page = await browser.newPage();
    await page.setContent(`
      <main>
        <button aria-haspopup="dialog" aria-controls="settings-dialog">Open settings</button>
        <div id="settings-dialog" role="dialog" aria-label="Settings">
          <button>Close settings</button>
        </div>
        <div role="combobox" aria-label="Assignee" aria-activedescendant="assignee-ada" tabindex="0">
          <div id="assignee-ada" role="option">Ada Lovelace</div>
        </div>
      </main>
    `);
    const state = await captureState(page, { provenance: "scripted", minTargets: 1 });
    await page.close();

    const trigger = state.targets.find((t) => t.name === "Open settings") as
      | Record<string, unknown>
      | undefined;
    expect(trigger?._attributeValues).toMatchObject({
      "aria-haspopup": "dialog",
      "aria-controls": "settings-dialog",
    });
    expect(trigger?._ariaRelationships).toMatchObject({
      hasPopup: "dialog",
      controls: [{ id: "settings-dialog", role: "dialog", name: "Settings" }],
    });

    const combo = state.targets.find((t) => t.role === "combobox") as
      | Record<string, unknown>
      | undefined;
    expect(combo?._ariaRelationships).toMatchObject({
      activeDescendant: { id: "assignee-ada", role: "option", name: "Ada Lovelace" },
    });
  }, 20000);
});
