import { describe, it, expect } from "vitest";
import { parseAriaSnapshot } from "./capture.js";

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
});
