import { describe, it, expect } from "vitest";
import {
  isLandmarkDemoted,
  buildAnnouncement,
  buildMultiATAnnouncement,
  detectInteropDivergence,
  buildTranscript,
  buildNavigationTranscript,
  type NestingContext,
} from "./sr-simulator.js";
import type { Target } from "../core/types.js";

const target = (overrides: Partial<Target> & { kind: Target["kind"]; role: string }): Target =>
  ({
    id: "t1",
    name: "",
    requiresBranchOpen: false,
    ...overrides,
  } as Target);

const ctx = (overrides: Partial<NestingContext>): NestingContext => ({
  role: "banner",
  nestedInSectioning: false,
  hasExplicitRole: false,
  hasLabel: false,
  ...overrides,
});

describe("isLandmarkDemoted", () => {
  it("explicit role= attribute always wins, even when nested", () => {
    expect(isLandmarkDemoted(ctx({
      role: "banner", nestedInSectioning: true, hasExplicitRole: true,
    }))).toBe(false);
  });

  it("<header> inside <section> loses implicit banner role", () => {
    expect(isLandmarkDemoted(ctx({
      role: "banner", nestedInSectioning: true,
    }))).toBe(true);
  });

  it("<header> at top level keeps banner role", () => {
    expect(isLandmarkDemoted(ctx({
      role: "banner", nestedInSectioning: false,
    }))).toBe(false);
  });

  it("<footer> inside <section> loses contentinfo role", () => {
    expect(isLandmarkDemoted(ctx({
      role: "contentinfo", nestedInSectioning: true,
    }))).toBe(true);
  });

  it("unlabeled <form> is not a landmark", () => {
    expect(isLandmarkDemoted(ctx({
      role: "form", hasLabel: false,
    }))).toBe(true);
  });

  it("labeled <form> IS a landmark", () => {
    expect(isLandmarkDemoted(ctx({
      role: "form", hasLabel: true,
    }))).toBe(false);
  });

  it("unlabeled <section> (region) is not a landmark", () => {
    expect(isLandmarkDemoted(ctx({
      role: "region", hasLabel: false,
    }))).toBe(true);
  });

  it("labeled <section> IS a landmark", () => {
    expect(isLandmarkDemoted(ctx({
      role: "region", hasLabel: true,
    }))).toBe(false);
  });

  it("<main> is never demoted regardless of nesting", () => {
    expect(isLandmarkDemoted(ctx({
      role: "main", nestedInSectioning: true,
    }))).toBe(false);
  });

  it("<nav> is not subject to header/footer demotion rules", () => {
    expect(isLandmarkDemoted(ctx({
      role: "navigation", nestedInSectioning: true,
    }))).toBe(false);
  });
});

describe("buildAnnouncement", () => {
  it("labeled button: 'Sign Up, button'", () => {
    expect(buildAnnouncement(target({ kind: "button", role: "button", name: "Sign Up" })))
      .toBe("Sign Up, button");
  });

  it("unlabeled button: 'button'", () => {
    expect(buildAnnouncement(target({ kind: "button", role: "button", name: "" })))
      .toBe("button");
  });

  it("link: 'Home, link'", () => {
    expect(buildAnnouncement(target({ kind: "link", role: "link", name: "Home" })))
      .toBe("Home, link");
  });

  it("heading with level: 'Title, heading, level 2'", () => {
    expect(buildAnnouncement(target({
      kind: "heading", role: "heading", name: "Title", headingLevel: 2,
    }))).toBe("Title, heading, level 2");
  });

  it("checked checkbox: 'Subscribe, check box, checked'", () => {
    expect(buildAnnouncement(target({
      kind: "formField", role: "checkbox", name: "Subscribe",
      _attributeValues: { "aria-checked": "true" },
    } as Partial<Target> & { kind: Target["kind"]; role: string }))).toBe("Subscribe, check box, checked");
  });

  it("unchecked checkbox: 'Subscribe, check box, not checked'", () => {
    expect(buildAnnouncement(target({
      kind: "formField", role: "checkbox", name: "Subscribe",
      _attributeValues: { "aria-checked": "false" },
    } as Partial<Target> & { kind: Target["kind"]; role: string }))).toBe("Subscribe, check box, not checked");
  });

  it("mixed checkbox: 'partially checked'", () => {
    expect(buildAnnouncement(target({
      kind: "formField", role: "checkbox", name: "All",
      _attributeValues: { "aria-checked": "mixed" },
    } as Partial<Target> & { kind: Target["kind"]; role: string }))).toBe("All, check box, partially checked");
  });

  it("collapsed combobox: 'Country, combo box, collapsed'", () => {
    expect(buildAnnouncement(target({
      kind: "formField", role: "combobox", name: "Country",
      _attributeValues: { "aria-expanded": "false" },
    } as Partial<Target> & { kind: Target["kind"]; role: string }))).toBe("Country, combo box, collapsed");
  });

  it("expanded menu trigger: 'File, button, expanded'", () => {
    expect(buildAnnouncement(target({
      kind: "button", role: "button", name: "File",
      _attributeValues: { "aria-expanded": "true" },
    } as Partial<Target> & { kind: Target["kind"]; role: string }))).toBe("File, button, expanded");
  });

  it("selected tab: 'Settings, tab, selected'", () => {
    expect(buildAnnouncement(target({
      kind: "tab", role: "tab", name: "Settings",
      _attributeValues: { "aria-selected": "true" },
    } as Partial<Target> & { kind: Target["kind"]; role: string }))).toBe("Settings, tab, selected");
  });

  it("modal dialog: 'Confirm, dialog, modal'", () => {
    expect(buildAnnouncement(target({
      kind: "dialog", role: "dialog", name: "Confirm",
      _attributeValues: { "aria-modal": "true" },
    } as Partial<Target> & { kind: Target["kind"]; role: string }))).toBe("Confirm, dialog, modal");
  });

  it("required + invalid textbox", () => {
    expect(buildAnnouncement(target({
      kind: "formField", role: "textbox", name: "Email",
      _attributeValues: { "aria-required": "true", "aria-invalid": "true" },
    } as Partial<Target> & { kind: Target["kind"]; role: string }))).toBe("Email, edit, invalid entry, required");
  });

  it("disabled button: 'Save, button, unavailable'", () => {
    expect(buildAnnouncement(target({
      kind: "button", role: "button", name: "Save",
      _attributeValues: { "aria-disabled": "true" },
    } as Partial<Target> & { kind: Target["kind"]; role: string }))).toBe("Save, button, unavailable");
  });

  it("readonly textbox", () => {
    expect(buildAnnouncement(target({
      kind: "formField", role: "textbox", name: "ID",
      _attributeValues: { "aria-readonly": "true" },
    } as Partial<Target> & { kind: Target["kind"]; role: string }))).toBe("ID, edit, read only");
  });

  it("slider with value: 'Volume, slider, 75'", () => {
    expect(buildAnnouncement(target({
      kind: "formField", role: "slider", name: "Volume",
      _value: "75",
    } as Partial<Target> & { kind: Target["kind"]; role: string }))).toBe("Volume, slider, 75");
  });

  it("landmark: 'Main, main landmark'", () => {
    expect(buildAnnouncement(target({ kind: "landmark", role: "main", name: "Main" })))
      .toBe("Main, main landmark");
  });

  it("unmapped role falls back to raw role", () => {
    expect(buildAnnouncement(target({ kind: "button", role: "treeitem", name: "Folder" })))
      .toBe("Folder, treeitem");
  });

  it("appends aria-describedby resolved text", () => {
    expect(buildAnnouncement(target({
      kind: "formField", role: "textbox", name: "Email",
      _description: "you must use a work address",
    } as Partial<Target> & { kind: Target["kind"]; role: string }))).toBe(
      "Email, edit, you must use a work address",
    );
  });
});

describe("multi-AT announcements", () => {
  it("VoiceOver says 'text field' where NVDA/JAWS say 'edit'", () => {
    const t = target({ kind: "formField", role: "textbox", name: "Email" });
    expect(buildAnnouncement(t, "nvda")).toBe("Email, edit");
    expect(buildAnnouncement(t, "jaws")).toBe("Email, edit");
    expect(buildAnnouncement(t, "voiceover")).toBe("Email, text field");
  });

  it("VoiceOver says 'dimmed' where NVDA/JAWS say 'unavailable'", () => {
    const t = target({
      kind: "button", role: "button", name: "Save",
      _attributeValues: { "aria-disabled": "true" },
    } as Partial<Target> & { kind: Target["kind"]; role: string });
    expect(buildAnnouncement(t, "nvda")).toBe("Save, button, unavailable");
    expect(buildAnnouncement(t, "voiceover")).toBe("Save, button, dimmed");
  });

  it("VoiceOver omits expanded/collapsed for combobox (uses 'popup button')", () => {
    const t = target({
      kind: "formField", role: "combobox", name: "Country",
      _attributeValues: { "aria-expanded": "false" },
    } as Partial<Target> & { kind: Target["kind"]; role: string });
    expect(buildAnnouncement(t, "nvda")).toBe("Country, combo box, collapsed");
    expect(buildAnnouncement(t, "voiceover")).toBe("Country, popup button");
  });

  it("buildMultiATAnnouncement returns all three variants", () => {
    const t = target({ kind: "formField", role: "textbox", name: "Email" });
    const a = buildMultiATAnnouncement(t);
    expect(a.nvda).toBe("Email, edit");
    expect(a.jaws).toBe("Email, edit");
    expect(a.voiceover).toBe("Email, text field");
  });
});

describe("detectInteropDivergence", () => {
  it("flags combobox with aria-expanded (VoiceOver omits state)", () => {
    const t = target({
      kind: "formField", role: "combobox", name: "Country",
      _attributeValues: { "aria-expanded": "false" },
    } as Partial<Target> & { kind: Target["kind"]; role: string });
    const result = detectInteropDivergence(t);
    expect(result).not.toBeNull();
    expect(result?.description).toContain("popup button");
  });

  it("flags disabled state (NVDA/JAWS 'unavailable' vs VO 'dimmed')", () => {
    const t = target({
      kind: "button", role: "button", name: "Save",
      _attributeValues: { "aria-disabled": "true" },
    } as Partial<Target> & { kind: Target["kind"]; role: string });
    const result = detectInteropDivergence(t);
    expect(result).not.toBeNull();
    expect(result?.description).toContain("dimmed");
  });

  it("flags textbox role-name divergence", () => {
    const t = target({ kind: "formField", role: "textbox", name: "Email" });
    const result = detectInteropDivergence(t);
    expect(result).not.toBeNull();
    expect(result?.description).toContain("text field");
  });

  it("returns null when announcements are identical", () => {
    const t = target({ kind: "button", role: "button", name: "Submit" });
    const result = detectInteropDivergence(t);
    expect(result).toBeNull();
  });
});

describe("buildTranscript", () => {
  const targets: Target[] = [
    target({ id: "t1", kind: "landmark", role: "main", name: "Main" }),
    target({ id: "t2", kind: "heading", role: "heading", name: "Welcome", headingLevel: 1 }),
    target({ id: "t3", kind: "link", role: "link", name: "Sign in" }),
    target({ id: "t4", kind: "button", role: "button", name: "Search" }),
  ];

  it("produces one step per target in order", () => {
    const transcript = buildTranscript(targets);
    expect(transcript).toHaveLength(4);
    expect(transcript[0].step).toBe(1);
    expect(transcript[3].step).toBe(4);
    expect(transcript[0].targetId).toBe("t1");
    expect(transcript[3].targetId).toBe("t4");
  });

  it("uses NVDA announcements by default", () => {
    const transcript = buildTranscript(targets);
    expect(transcript[1].announcement).toBe("Welcome, heading, level 1");
    expect(transcript[2].announcement).toBe("Sign in, link");
  });

  it("respects --at parameter", () => {
    const t = [target({ id: "t1", kind: "formField", role: "textbox", name: "Email" })];
    expect(buildTranscript(t, "nvda")[0].announcement).toBe("Email, edit");
    expect(buildTranscript(t, "voiceover")[0].announcement).toBe("Email, text field");
  });

  it("preserves target kind for filtering downstream", () => {
    const transcript = buildTranscript(targets);
    expect(transcript.map((s) => s.kind)).toEqual(["landmark", "heading", "link", "button"]);
  });
});

describe("buildNavigationTranscript", () => {
  const targets: Target[] = [
    target({ id: "before", kind: "link", role: "link", name: "Before main" }),
    target({ id: "main", kind: "landmark", role: "main", name: "" }),
    target({ id: "h1", kind: "heading", role: "heading", name: "Welcome", headingLevel: 1 }),
    target({ id: "btn", kind: "button", role: "button", name: "Sign Up" }),
    target({ id: "h2", kind: "heading", role: "heading", name: "Features", headingLevel: 2 }),
    target({ id: "after", kind: "link", role: "link", name: "After main" }),
  ];

  it("linear mode produces all steps from start to end", () => {
    const transcript = buildNavigationTranscript(targets);
    expect(transcript).toHaveLength(6);
    expect(transcript[0].targetId).toBe("before");
    expect(transcript[5].targetId).toBe("after");
    expect(transcript.every((s) => s.action === "next-item")).toBe(true);
  });

  it("from/to constrains the range (inclusive)", () => {
    const transcript = buildNavigationTranscript(targets, { from: "main", to: "btn" });
    expect(transcript).toHaveLength(3);
    expect(transcript.map((s) => s.targetId)).toEqual(["main", "h1", "btn"]);
  });

  it("by-heading mode emits only headings", () => {
    const transcript = buildNavigationTranscript(targets, { mode: "by-heading" });
    expect(transcript).toHaveLength(2);
    expect(transcript.map((s) => s.targetId)).toEqual(["h1", "h2"]);
    expect(transcript[0].announcement).toBe("Welcome, heading, level 1");
    expect(transcript.every((s) => s.action === "next-heading")).toBe(true);
  });

  it("by-landmark mode emits only landmarks", () => {
    const transcript = buildNavigationTranscript(targets, { mode: "by-landmark" });
    expect(transcript).toHaveLength(1);
    expect(transcript[0].targetId).toBe("main");
    expect(transcript[0].action).toBe("next-landmark");
  });

  it("by-form-control mode emits buttons, links, form fields", () => {
    const transcript = buildNavigationTranscript(targets, { mode: "by-form-control" });
    expect(transcript.map((s) => s.targetId)).toEqual(["before", "btn", "after"]);
  });

  it("respects --at parameter for announcements", () => {
    const t = [target({ id: "t1", kind: "formField", role: "textbox", name: "Email" })];
    const nvda = buildNavigationTranscript(t, { at: "nvda" });
    const vo = buildNavigationTranscript(t, { at: "voiceover" });
    expect(nvda[0].announcement).toBe("Email, edit");
    expect(vo[0].announcement).toBe("Email, text field");
  });

  it("supports navigating from a target into a landmark (ARIA-AT scenario)", () => {
    // ARIA-AT "Navigate forwards into a main landmark" pattern
    const transcript = buildNavigationTranscript(targets, {
      from: "before", to: "h1", mode: "linear",
    });
    expect(transcript.map((s) => s.targetId)).toEqual(["before", "main", "h1"]);
    // The main landmark and the h1 inside it both get announced
    expect(transcript[1].announcement).toContain("main landmark");
    expect(transcript[2].announcement).toContain("Welcome");
    expect(transcript[2].announcement).toContain("heading");
  });

  it("returns empty when from/to don't exist", () => {
    expect(buildNavigationTranscript(targets, { from: "nonexistent" })).toEqual([]);
  });
});
