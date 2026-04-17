/**
 * Scoring presets — named config bundles for common use cases.
 *
 * Each preset is a partial TactualConfig that sets focus filters,
 * priority mappings, and optionally a profile. CLI flags and
 * tactual.json settings override preset values.
 */

import type { TactualConfig } from "./config.js";

export interface Preset {
  id: string;
  name: string;
  description: string;
  config: TactualConfig;
}

const presets: Preset[] = [
  {
    id: "ecommerce-checkout",
    name: "E-commerce Checkout",
    description: "Focus on main content and checkout flow. Marks cart, checkout, and payment targets as critical.",
    config: {
      focus: ["main"],
      priority: {
        "*checkout*": "critical",
        "*cart*": "critical",
        "*payment*": "critical",
        "*order*": "critical",
        "*buy*": "critical",
        "*add to cart*": "critical",
        "*quantity*": "critical",
        "*shipping*": "normal",
        "*promo*": "low",
        "*newsletter*": "ignore",
        "*cookie*": "ignore",
      },
      minSeverity: "moderate",
    },
  },
  {
    id: "docs-site",
    name: "Documentation Site",
    description: "Focus on navigation and content discovery. Prioritizes search, nav, and heading structure.",
    config: {
      focus: ["main", "navigation"],
      priority: {
        "*search*": "critical",
        "*nav*": "critical",
        "*sidebar*": "normal",
        "*breadcrumb*": "normal",
        "*table of contents*": "normal",
        "*toc*": "normal",
        "*edit*": "low",
        "*theme*": "low",
        "*cookie*": "ignore",
        "*analytics*": "ignore",
      },
      minSeverity: "moderate",
    },
  },
  {
    id: "dashboard",
    name: "Dashboard / Web App",
    description: "Focus on main workspace and navigation. Marks primary actions and data views as critical.",
    config: {
      focus: ["main", "navigation"],
      priority: {
        "*save*": "critical",
        "*submit*": "critical",
        "*create*": "critical",
        "*delete*": "critical",
        "*search*": "critical",
        "*filter*": "normal",
        "*sort*": "normal",
        "*settings*": "normal",
        "*notification*": "low",
        "*avatar*": "low",
        "*cookie*": "ignore",
      },
    },
  },
  {
    id: "form-heavy",
    name: "Form-Heavy Page",
    description: "Focus on form interactions. Marks all form controls and submission as critical.",
    config: {
      focus: ["main"],
      explore: true,
      priority: {
        "*submit*": "critical",
        "*save*": "critical",
        "*next*": "critical",
        "*continue*": "critical",
        "*required*": "critical",
        "*error*": "critical",
        "*cancel*": "normal",
        "*reset*": "normal",
        "*help*": "low",
        "*cookie*": "ignore",
      },
    },
  },
];

const presetMap = new Map(presets.map((p) => [p.id, p]));

/** Get a preset by ID, or null if not found. */
export function getPreset(id: string): Preset | null {
  return presetMap.get(id) ?? null;
}

/** List all available preset IDs with descriptions. */
export function listPresets(): Preset[] {
  return [...presets];
}
