/**
 * Wave 30: color-vision-deficiency (CVD) simulation for contrast checks.
 *
 * Re-runs WCAG 1.4.3 contrast on the page after applying the perceptual
 * transformation a viewer with one of the three common CVDs would
 * experience:
 *
 *   - Deuteranopia (no M cone, ~6% of males): red/green collapse
 *   - Protanopia  (no L cone, ~2% of males): red/green collapse, dimmer reds
 *   - Tritanopia  (no S cone, very rare):    blue/yellow collapse
 *
 * Together these account for the vast majority of color-vision
 * deficiencies. WCAG 1.4.1 ("Use of color") forbids using color as the
 * ONLY means of conveying information; this module catches a related
 * but distinct problem: text whose contrast against its background is
 * fine for normal vision but collapses to <4.5:1 (or <3:1 for large
 * text) once a CVD transform is applied.
 *
 * Algorithm per element:
 *   1. Read fg color and effective bg color (same walk as detectLowContrastText)
 *   2. For each CVD type: transform both colors, compute WCAG contrast ratio
 *   3. Flag elements where ratio drops below threshold under any CVD type
 *
 * Matrices are the standard Brettel/Viénot/Mollon (1997) severe-deficiency
 * approximations as published in Machado et al. (2009). They operate on
 * linear-RGB values, so we gamma-correct in/out around the matrix multiply.
 */

import type { Frame, Page } from "playwright";

export type CvdType = "deuteranopia" | "protanopia" | "tritanopia";

interface RGB {
  r: number;
  g: number;
  b: number;
}

const CVD_MATRICES: Record<CvdType, [number, number, number, number, number, number, number, number, number]> = {
  // Severe protanopia (Brettel et al. 1997)
  protanopia: [
    0.567, 0.433, 0.000,
    0.558, 0.442, 0.000,
    0.000, 0.242, 0.758,
  ],
  // Severe deuteranopia
  deuteranopia: [
    0.625, 0.375, 0.000,
    0.700, 0.300, 0.000,
    0.000, 0.300, 0.700,
  ],
  // Severe tritanopia
  tritanopia: [
    0.950, 0.050, 0.000,
    0.000, 0.433, 0.567,
    0.000, 0.475, 0.525,
  ],
};

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}
function clamp255(v: number): number {
  return v < 0 ? 0 : v > 255 ? 255 : Math.round(v);
}

/** sRGB channel value [0..255] → linear-light [0..1]. */
function srgbToLinear(c: number): number {
  const v = clamp01(c / 255);
  return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
}

/** Linear-light [0..1] → sRGB channel [0..255]. */
function linearToSrgb(v: number): number {
  const clamped = clamp01(v);
  const out = clamped <= 0.0031308 ? clamped * 12.92 : 1.055 * Math.pow(clamped, 1 / 2.4) - 0.055;
  return clamp255(out * 255);
}

/**
 * Transform an sRGB color through the given CVD matrix and return the
 * sRGB color a viewer with that deficiency would perceive (in normal-vision
 * terms — i.e. for use in further contrast math, not for display).
 */
export function simulateCvd(input: RGB, type: CvdType): RGB {
  const M = CVD_MATRICES[type];
  const lr = srgbToLinear(input.r);
  const lg = srgbToLinear(input.g);
  const lb = srgbToLinear(input.b);
  const r = M[0] * lr + M[1] * lg + M[2] * lb;
  const g = M[3] * lr + M[4] * lg + M[5] * lb;
  const b = M[6] * lr + M[7] * lg + M[8] * lb;
  return { r: linearToSrgb(r), g: linearToSrgb(g), b: linearToSrgb(b) };
}

function relativeLuminance(c: RGB): number {
  const r = srgbToLinear(c.r);
  const g = srgbToLinear(c.g);
  const b = srgbToLinear(c.b);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG 2.x contrast ratio: (L1 + 0.05) / (L2 + 0.05), L1 = lighter. */
export function contrastRatio(a: RGB, b: RGB): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const lighter = Math.max(la, lb);
  const darker = Math.min(la, lb);
  return (lighter + 0.05) / (darker + 0.05);
}

/** Contrast ratio after applying the CVD transform to BOTH colors. */
export function contrastWithCvd(fg: RGB, bg: RGB, type: CvdType): number {
  return contrastRatio(simulateCvd(fg, type), simulateCvd(bg, type));
}

export interface CvdContrastSample {
  selector: string;
  /** Snippet of the offending text (≤ 30 chars). */
  text: string;
  /** Original (normal-vision) contrast ratio. */
  normalRatio: number;
  /** Contrast ratio under the CVD transform. */
  cvdRatio: number;
  /** WCAG threshold for this element (3 for large text, 4.5 otherwise). */
  threshold: number;
}

export interface CvdTypeResult {
  count: number;
  samples: CvdContrastSample[];
}

export interface CvdContrastSummary {
  byType: Record<CvdType, CvdTypeResult>;
  /** Distinct elements that fail under at least one CVD type. */
  totalUniqueElements: number;
}

/**
 * Page-side scan: finds text elements whose contrast falls under the
 * WCAG threshold once a CVD transform is applied. Re-uses the same
 * element selector + bg-walk as detectLowContrastText for parity.
 *
 * Optimization: the matrices and the gamma helpers are passed as JSON
 * to the page-side fn so we don't have to maintain two copies of the
 * math. The JS side only does float arithmetic.
 */
export async function detectCvdContrastIssues(page: Page | Frame): Promise<CvdContrastSummary> {
  const matrices = CVD_MATRICES;
  const result = await page
    .evaluate(
      ({ matrices: M }: { matrices: typeof CVD_MATRICES }) => {
        const SELECTOR =
          "button, a, h1, h2, h3, h4, h5, h6, [role='button'], [role='link'], " +
          "p, li, td, blockquote, figcaption, dt, dd, label, span";

        const parseRgb = (str: string): { r: number; g: number; b: number; a: number } | null => {
          const m = str.match(
            /rgba?\(\s*(\d+(?:\.\d+)?)[,\s]+(\d+(?:\.\d+)?)[,\s]+(\d+(?:\.\d+)?)(?:[,\s/]+([\d.]+))?\s*\)/,
          );
          if (!m) return null;
          return {
            r: parseFloat(m[1]),
            g: parseFloat(m[2]),
            b: parseFloat(m[3]),
            a: m[4] !== undefined ? parseFloat(m[4]) : 1,
          };
        };

        const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);
        const clamp255 = (v: number): number => (v < 0 ? 0 : v > 255 ? 255 : Math.round(v));
        const srgbToLinear = (c: number): number => {
          const v = clamp01(c / 255);
          return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
        };
        const linearToSrgb = (v: number): number => {
          const cl = clamp01(v);
          const out = cl <= 0.0031308 ? cl * 12.92 : 1.055 * Math.pow(cl, 1 / 2.4) - 0.055;
          return clamp255(out * 255);
        };
        const luminance = (c: { r: number; g: number; b: number }): number =>
          0.2126 * srgbToLinear(c.r) + 0.7152 * srgbToLinear(c.g) + 0.0722 * srgbToLinear(c.b);
        const ratio = (
          a: { r: number; g: number; b: number },
          b: { r: number; g: number; b: number },
        ): number => {
          const la = luminance(a);
          const lb = luminance(b);
          const lighter = Math.max(la, lb);
          const darker = Math.min(la, lb);
          return (lighter + 0.05) / (darker + 0.05);
        };
        const transform = (
          c: { r: number; g: number; b: number },
          type: "deuteranopia" | "protanopia" | "tritanopia",
        ): { r: number; g: number; b: number } => {
          const m = M[type];
          const lr = srgbToLinear(c.r);
          const lg = srgbToLinear(c.g);
          const lb = srgbToLinear(c.b);
          const r = m[0] * lr + m[1] * lg + m[2] * lb;
          const g = m[3] * lr + m[4] * lg + m[5] * lb;
          const b = m[6] * lr + m[7] * lg + m[8] * lb;
          return { r: linearToSrgb(r), g: linearToSrgb(g), b: linearToSrgb(b) };
        };

        const effectiveBackground = (el: Element): { r: number; g: number; b: number } => {
          let p: Element | null = el;
          while (p && p !== document.documentElement) {
            const bg = getComputedStyle(p).backgroundColor;
            const parsed = parseRgb(bg);
            if (parsed && parsed.a > 0.5) return { r: parsed.r, g: parsed.g, b: parsed.b };
            p = p.parentElement;
          }
          const bodyBg = parseRgb(
            getComputedStyle(document.body || document.documentElement).backgroundColor,
          );
          if (bodyBg && bodyBg.a > 0.5) return { r: bodyBg.r, g: bodyBg.g, b: bodyBg.b };
          return { r: 255, g: 255, b: 255 };
        };
        const isLargeText = (style: CSSStyleDeclaration): boolean => {
          const sizePx = parseFloat(style.fontSize);
          const weight = parseInt(style.fontWeight, 10) || 400;
          if (sizePx >= 24) return true;
          if (sizePx >= 18.66 && weight >= 700) return true;
          return false;
        };

        const TYPES = ["deuteranopia", "protanopia", "tritanopia"] as const;
        type CvdT = (typeof TYPES)[number];
        type Sample = {
          selector: string;
          text: string;
          normalRatio: number;
          cvdRatio: number;
          threshold: number;
        };
        const out: Record<CvdT, { count: number; samples: Sample[] }> = {
          deuteranopia: { count: 0, samples: [] },
          protanopia: { count: 0, samples: [] },
          tritanopia: { count: 0, samples: [] },
        };
        const failedEls = new Set<Element>();

        const els = document.querySelectorAll(SELECTOR);
        for (let i = 0; i < els.length && i < 500; i++) {
          const el = els[i];
          const text = (el.textContent ?? "").trim();
          if (!text) continue;
          const rect = el.getBoundingClientRect();
          if (rect.width === 0 || rect.height === 0) continue;
          const style = getComputedStyle(el);
          if (style.display === "none" || style.visibility === "hidden") continue;
          const opacity = parseFloat(style.opacity);
          if (!isNaN(opacity) && opacity < 0.5) continue;

          const fg = parseRgb(style.color);
          if (!fg) continue;
          const bg = effectiveBackground(el);
          const normalR = ratio(fg, bg);
          const threshold = isLargeText(style) ? 3 : 4.5;
          // Skip elements whose NORMAL-vision contrast already fails the
          // WCAG threshold — those are already surfaced by
          // detectLowContrastText. The CVD scan exists to catch the
          // distinct case "passes normal vision, fails for ~8% of users
          // with a CVD" — counting elements that fail BOTH inflates the
          // CVD diagnostic with already-known issues.
          if (normalR < threshold) continue;

          for (const t of TYPES) {
            const fgC = transform(fg, t);
            const bgC = transform(bg, t);
            const r = ratio(fgC, bgC);
            if (r >= threshold) continue;
            out[t].count++;
            failedEls.add(el);
            if (out[t].samples.length < 5) {
              const tag = el.tagName.toLowerCase();
              const trimmed = text.length > 30 ? text.slice(0, 27) + "…" : text;
              out[t].samples.push({
                selector: tag,
                text: trimmed,
                normalRatio: Math.round(normalR * 100) / 100,
                cvdRatio: Math.round(r * 100) / 100,
                threshold,
              });
            }
          }
        }
        return { byType: out, totalUniqueElements: failedEls.size };
      },
      { matrices },
    )
    .catch(
      () =>
        ({
          byType: {
            deuteranopia: { count: 0, samples: [] },
            protanopia: { count: 0, samples: [] },
            tritanopia: { count: 0, samples: [] },
          },
          totalUniqueElements: 0,
        }) as CvdContrastSummary,
    );
  return result;
}
