/**
 * Color utilities for visibility detection: WCAG 2.1 relative luminance,
 * contrast ratio, CSS color parsing, and system-color identification.
 *
 * Used by the visibility probe and finding-builder to compute icon
 * contrast against ancestor backgrounds in different visual modes.
 */

export interface RGB {
  r: number;
  g: number;
  b: number;
  a: number;
}

/**
 * CSS system color keywords (CSS Color Module 4). When forced-colors is
 * active, the user agent substitutes these with the user's HCM theme. An
 * author who writes `fill: ButtonText` opts into HCM-safe rendering.
 */
const SYSTEM_COLOR_NAMES: ReadonlySet<string> = new Set([
  "activetext",
  "buttonborder",
  "buttonface",
  "buttontext",
  "canvas",
  "canvastext",
  "field",
  "fieldtext",
  "graytext",
  "highlight",
  "highlighttext",
  "linktext",
  "mark",
  "marktext",
  "selecteditem",
  "selecteditemtext",
  "visitedtext",
]);

/** Common CSS named colors. Computed styles always serialize to rgb()/rgba(),
 *  so this only matters for raw author values like `fill="red"`. */
const NAMED_COLORS: Record<string, [number, number, number]> = {
  black: [0, 0, 0],
  silver: [192, 192, 192],
  gray: [128, 128, 128],
  grey: [128, 128, 128],
  white: [255, 255, 255],
  maroon: [128, 0, 0],
  red: [255, 0, 0],
  purple: [128, 0, 128],
  fuchsia: [255, 0, 255],
  green: [0, 128, 0],
  lime: [0, 255, 0],
  olive: [128, 128, 0],
  yellow: [255, 255, 0],
  navy: [0, 0, 128],
  blue: [0, 0, 255],
  teal: [0, 128, 128],
  aqua: [0, 255, 255],
  orange: [255, 165, 0],
};

/** Parse a CSS color string into RGB, or null if unparseable / transparent / "none". */
export function parseColor(value: string | null | undefined): RGB | null {
  if (!value) return null;
  const v = value.trim();
  if (!v || v === "none" || v === "transparent" || v === "currentColor") return null;

  const rgbMatch = v.match(/^rgba?\(\s*(\d+(?:\.\d+)?)\s*[, ]\s*(\d+(?:\.\d+)?)\s*[, ]\s*(\d+(?:\.\d+)?)\s*(?:[, /]\s*([\d.]+%?)\s*)?\)$/i);
  if (rgbMatch) {
    const r = clampByte(parseFloat(rgbMatch[1]));
    const g = clampByte(parseFloat(rgbMatch[2]));
    const b = clampByte(parseFloat(rgbMatch[3]));
    let a = 1;
    if (rgbMatch[4] !== undefined) {
      a = rgbMatch[4].endsWith("%")
        ? parseFloat(rgbMatch[4]) / 100
        : parseFloat(rgbMatch[4]);
    }
    return { r, g, b, a };
  }

  const hexMatch = v.match(/^#([0-9a-f]{3,8})$/i);
  if (hexMatch) {
    let h = hexMatch[1];
    if (h.length === 3 || h.length === 4) {
      h = h.split("").map((c) => c + c).join("");
    }
    if (h.length !== 6 && h.length !== 8) return null;
    const r = parseInt(h.slice(0, 2), 16);
    const g = parseInt(h.slice(2, 4), 16);
    const b = parseInt(h.slice(4, 6), 16);
    const a = h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1;
    return { r, g, b, a };
  }

  const lower = v.toLowerCase();
  const named = NAMED_COLORS[lower];
  if (named) {
    return { r: named[0], g: named[1], b: named[2], a: 1 };
  }

  return null;
}

/** True if the value is a CSS system color keyword. */
export function isSystemColor(value: string | null | undefined): boolean {
  if (!value) return false;
  return SYSTEM_COLOR_NAMES.has(value.trim().toLowerCase());
}

/** True if the value asks the renderer to inherit (currentColor). */
export function isCurrentColor(value: string | null | undefined): boolean {
  return !!value && value.trim().toLowerCase() === "currentcolor";
}

/** WCAG 2.1 relative luminance (sRGB, linear-space). */
export function luminance(rgb: RGB): number {
  const channel = (c: number): number => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * channel(rgb.r) + 0.7152 * channel(rgb.g) + 0.0722 * channel(rgb.b);
}

/** WCAG 2.1 contrast ratio between two colors (1.0–21.0). */
export function contrastRatio(a: RGB, b: RGB): number {
  const la = luminance(a);
  const lb = luminance(b);
  const lighter = Math.max(la, lb);
  const darker = Math.min(la, lb);
  return (lighter + 0.05) / (darker + 0.05);
}

/**
 * Composite a (possibly translucent) foreground over an opaque background.
 * Returns the perceived color a viewer sees.
 */
export function compositeOver(fg: RGB, bg: RGB): RGB {
  const a = Math.max(0, Math.min(1, fg.a));
  return {
    r: Math.round(fg.r * a + bg.r * (1 - a)),
    g: Math.round(fg.g * a + bg.g * (1 - a)),
    b: Math.round(fg.b * a + bg.b * (1 - a)),
    a: 1,
  };
}

function clampByte(n: number): number {
  if (Number.isNaN(n)) return 0;
  return Math.max(0, Math.min(255, Math.round(n)));
}
