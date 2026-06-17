import { describe, expect, it } from "vitest";
import { resolve } from "path";
import { pathToFileURL } from "url";
import { runAnalyzeUrl } from "./pipeline/analyze-url.js";

const fixtureUrl = (path: string): string => pathToFileURL(resolve(path)).href;

describe("calibration fixture coverage", { timeout: 180_000 }, () => {
  it("captures and scores dialog calibration targets", async () => {
    const { result } = await runAnalyzeUrl({
      url: fixtureUrl("fixtures/calibration-dialog-lab.html"),
      profileId: "nvda-desktop-v0",
      checkVisibility: false,
      probe: true,
      probeMode: "deep",
    });

    const targets = result.states.flatMap((state) => state.targets);
    expect(targets).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ role: "dialog", kind: "dialog", name: "Edit shipping address" }),
        expect.objectContaining({ role: "textbox", kind: "formField", name: "Street address" }),
        expect.objectContaining({ role: "combobox", kind: "formField", name: "Delivery window" }),
        expect.objectContaining({ role: "button", kind: "button", name: "Save address" }),
      ]),
    );
    expect(result.findings.some((finding) => finding.targetId.includes("edit-shipping-address"))).toBe(true);
  });

  it("captures SPA route calibration targets and route events", async () => {
    const { result } = await runAnalyzeUrl({
      url: fixtureUrl("fixtures/calibration-spa-route-lab.html"),
      profileId: "nvda-desktop-v0",
      checkVisibility: false,
      detectRoutes: true,
      probe: true,
      probeMode: "standard",
    });

    const targets = result.states.flatMap((state) => state.targets);
    expect(targets).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ role: "heading", name: "SPA Route Calibration Lab" }),
        expect.objectContaining({ role: "button", name: "Open orders route" }),
        expect.objectContaining({ role: "searchbox", name: "Global search" }),
        expect.objectContaining({ role: "status", _value: expect.stringContaining("route") }),
      ]),
    );
    const routeButtons = targets.filter((target) => target.role === "button") as Array<Record<string, unknown>>;
    expect(
      routeButtons.some((target) =>
        typeof (target._probe as { liveAnnouncement?: string } | undefined)?.liveAnnouncement === "string" &&
        ((target._probe as { liveAnnouncement?: string }).liveAnnouncement ?? "").includes("Orders route loaded"),
      ),
    ).toBe(true);
  });

  it("keeps structured table, grid, tree, and treegrid roles visible to scoring", async () => {
    const { result } = await runAnalyzeUrl({
      url: fixtureUrl("fixtures/calibration-structured-lab.html"),
      profileId: "nvda-desktop-v0",
      checkVisibility: false,
    });

    const targets = result.states.flatMap((state) => state.targets);
    expect(targets).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ role: "table", kind: "other", name: "Open invoices by account" }),
        expect.objectContaining({ role: "grid", kind: "other", name: "Account review grid" }),
        expect.objectContaining({ role: "tree", kind: "other", name: "Repository folders" }),
        expect.objectContaining({ role: "treegrid", kind: "other", name: "Expandable accounts" }),
        expect.objectContaining({ role: "button", name: "Open Northwind" }),
      ]),
    );

    const penalties = result.findings.flatMap((finding) => finding.penalties);
    expect(penalties).toEqual(
      expect.arrayContaining([
        expect.stringContaining("grid: Grid navigation"),
        expect.stringContaining("treegrid: Treegrid combines tree + grid problems"),
      ]),
    );
  });
});
