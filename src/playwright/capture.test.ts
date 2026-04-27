import { describe, it, expect } from "vitest";
import { chromium } from "playwright";
import { captureState, parseAriaSnapshot } from "./capture.js";

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
});

describe("captureState", () => {
  it("limits capture to scoped subtrees when scopeSelectors are provided", async () => {
    const browser = await chromium.launch();
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
    await browser.close();

    expect(state.targets.some((target) => target.name === "Run check")).toBe(true);
    expect(state.targets.some((target) => target.name === "Docs")).toBe(false);
  }, 20000);

  it("ignores invalid excluded selectors while applying valid exclusions", async () => {
    const browser = await chromium.launch();
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
    await browser.close();

    expect(state.targets.some((target) => target.name === "Keep me")).toBe(true);
    expect(state.targets.some((target) => target.name === "Exclude me")).toBe(false);
  }, 20000);

  it("marks native selects so APG combobox checks do not treat them as custom widgets", async () => {
    const browser = await chromium.launch();
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
    await browser.close();

    const select = state.targets.find((target) => target.role === "combobox") as
      | Record<string, unknown>
      | undefined;
    expect(select?._htmlTag).toBe("select");
    expect(select?._nativeHtmlControl).toBe("select");
  }, 20000);

  it("waits for likely app-shell hydration even when the initial tree is non-empty", async () => {
    const browser = await chromium.launch();
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
    await browser.close();

    expect(
      state.targets.filter((target) => target.role === "button").length,
    ).toBeGreaterThanOrEqual(35);
  }, 20000);
});
