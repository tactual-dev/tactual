import { describe, it, expect } from "vitest";
import {
  parseColor,
  isSystemColor,
  isCurrentColor,
  luminance,
  contrastRatio,
  compositeOver,
} from "./contrast.js";

describe("parseColor", () => {
  it("parses rgb()", () => {
    expect(parseColor("rgb(0, 0, 0)")).toEqual({ r: 0, g: 0, b: 0, a: 1 });
    expect(parseColor("rgb(255, 128, 0)")).toEqual({ r: 255, g: 128, b: 0, a: 1 });
  });

  it("parses rgba() with comma and slash separators", () => {
    expect(parseColor("rgba(0, 0, 0, 0.5)")).toEqual({ r: 0, g: 0, b: 0, a: 0.5 });
    expect(parseColor("rgb(0 0 0 / 0.25)")).toEqual({ r: 0, g: 0, b: 0, a: 0.25 });
  });

  it("parses hex (3, 6, 8 chars)", () => {
    expect(parseColor("#fff")).toEqual({ r: 255, g: 255, b: 255, a: 1 });
    expect(parseColor("#000000")).toEqual({ r: 0, g: 0, b: 0, a: 1 });
    expect(parseColor("#ff8000")).toEqual({ r: 255, g: 128, b: 0, a: 1 });
    expect(parseColor("#000000ff")).toEqual({ r: 0, g: 0, b: 0, a: 1 });
    const half = parseColor("#00000080");
    expect(half).not.toBeNull();
    expect(half!.a).toBeCloseTo(0.5, 1);
  });

  it("parses common named colors", () => {
    expect(parseColor("white")).toEqual({ r: 255, g: 255, b: 255, a: 1 });
    expect(parseColor("RED")).toEqual({ r: 255, g: 0, b: 0, a: 1 });
  });

  it("returns null for transparent / none / currentColor / empty / nonsense", () => {
    expect(parseColor(null)).toBeNull();
    expect(parseColor(undefined)).toBeNull();
    expect(parseColor("")).toBeNull();
    expect(parseColor("none")).toBeNull();
    expect(parseColor("transparent")).toBeNull();
    expect(parseColor("currentColor")).toBeNull();
    expect(parseColor("blarg")).toBeNull();
  });
});

describe("isSystemColor", () => {
  it("matches CSS system color keywords case-insensitively", () => {
    expect(isSystemColor("ButtonText")).toBe(true);
    expect(isSystemColor("CANVASTEXT")).toBe(true);
    expect(isSystemColor("linktext")).toBe(true);
    expect(isSystemColor(" Mark ")).toBe(true);
  });

  it("rejects regular colors", () => {
    expect(isSystemColor("red")).toBe(false);
    expect(isSystemColor("#fff")).toBe(false);
    expect(isSystemColor("rgb(0,0,0)")).toBe(false);
    expect(isSystemColor(null)).toBe(false);
    expect(isSystemColor("")).toBe(false);
  });
});

describe("isCurrentColor", () => {
  it("matches currentColor case-insensitively", () => {
    expect(isCurrentColor("currentColor")).toBe(true);
    expect(isCurrentColor("CURRENTCOLOR")).toBe(true);
    expect(isCurrentColor("currentcolor")).toBe(true);
  });

  it("rejects others", () => {
    expect(isCurrentColor("color")).toBe(false);
    expect(isCurrentColor("inherit")).toBe(false);
    expect(isCurrentColor(null)).toBe(false);
  });
});

describe("luminance", () => {
  it("computes 0 for black and 1 for white", () => {
    expect(luminance({ r: 0, g: 0, b: 0, a: 1 })).toBeCloseTo(0, 4);
    expect(luminance({ r: 255, g: 255, b: 255, a: 1 })).toBeCloseTo(1, 4);
  });

  it("weighs green channel highest", () => {
    const r = luminance({ r: 255, g: 0, b: 0, a: 1 });
    const g = luminance({ r: 0, g: 255, b: 0, a: 1 });
    const b = luminance({ r: 0, g: 0, b: 255, a: 1 });
    expect(g).toBeGreaterThan(r);
    expect(r).toBeGreaterThan(b);
  });
});

describe("contrastRatio", () => {
  it("returns 21:1 for white-on-black", () => {
    const ratio = contrastRatio(
      { r: 255, g: 255, b: 255, a: 1 },
      { r: 0, g: 0, b: 0, a: 1 },
    );
    expect(ratio).toBeCloseTo(21, 1);
  });

  it("returns 1:1 for identical colors", () => {
    const c = { r: 100, g: 100, b: 100, a: 1 };
    expect(contrastRatio(c, c)).toBeCloseTo(1, 4);
  });

  it("is symmetric", () => {
    const a = { r: 30, g: 60, b: 90, a: 1 };
    const b = { r: 200, g: 220, b: 240, a: 1 };
    expect(contrastRatio(a, b)).toBeCloseTo(contrastRatio(b, a), 4);
  });
});

describe("compositeOver", () => {
  it("returns fg unchanged when fg is fully opaque", () => {
    const fg = { r: 255, g: 0, b: 0, a: 1 };
    const bg = { r: 0, g: 0, b: 255, a: 1 };
    expect(compositeOver(fg, bg)).toEqual({ r: 255, g: 0, b: 0, a: 1 });
  });

  it("returns bg when fg is fully transparent", () => {
    const fg = { r: 255, g: 0, b: 0, a: 0 };
    const bg = { r: 0, g: 0, b: 255, a: 1 };
    expect(compositeOver(fg, bg)).toEqual({ r: 0, g: 0, b: 255, a: 1 });
  });

  it("blends 50/50 alpha", () => {
    const fg = { r: 255, g: 0, b: 0, a: 0.5 };
    const bg = { r: 0, g: 0, b: 255, a: 1 };
    const result = compositeOver(fg, bg);
    expect(result.r).toBeCloseTo(128, 0);
    expect(result.g).toBe(0);
    expect(result.b).toBeCloseTo(128, 0);
  });
});
