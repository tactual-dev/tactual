/**
 * Interop risk data derived from a11ysupport.io and ARIA-AT project.
 *
 * This is a static snapshot mapping ARIA roles, attributes, and patterns
 * to known cross-AT/browser support gaps. The data is informative, not
 * normative — it represents a point-in-time assessment of support levels.
 *
 * Sources:
 * - https://a11ysupport.io (community-driven, updated regularly)
 * - https://aria-at.w3.org (W3C ARIA-AT interoperability reports)
 *
 * Risk levels:
 * - 0: Well-supported across major AT/browser combos
 * - 1-5: Minor gaps or inconsistencies
 * - 6-10: Moderate gaps likely to affect some users
 * - 11-15: Significant gaps across multiple combos
 * - 16-20: Major interop problems
 *
 * @version 2025-Q1 — snapshot taken from a11ysupport.io circa January 2025
 */

/** Interop data version. Exposed in analysis metadata for consumers to detect staleness. */
export const INTEROP_DATA_VERSION = "2025-Q1";

export interface InteropEntry {
  /** Risk penalty (0-20) */
  risk: number;
  /** Human-readable description of the support gap */
  issue: string;
  /** Which AT/browser combos are known to have problems */
  affectedCombos?: string[];
}

/**
 * Known interop risks by ARIA role.
 */
export const roleInteropRisk: Record<string, InteropEntry> = {
  // Well-supported roles (risk 0-2)
  button: { risk: 0, issue: "Well-supported across all major AT" },
  link: { risk: 0, issue: "Well-supported across all major AT" },
  heading: { risk: 0, issue: "Well-supported across all major AT" },
  textbox: { risk: 0, issue: "Well-supported across all major AT" },
  checkbox: { risk: 0, issue: "Well-supported across all major AT" },
  radio: { risk: 0, issue: "Well-supported across all major AT" },
  main: { risk: 0, issue: "Well-supported across all major AT" },
  navigation: { risk: 0, issue: "Well-supported across all major AT" },
  banner: { risk: 1, issue: "Minor: some AT don't announce banner landmark by default" },
  contentinfo: { risk: 1, issue: "Minor: some AT don't announce contentinfo landmark by default" },

  // Moderate risk roles (3-8)
  dialog: {
    risk: 5,
    issue: "Focus management and announcement varies significantly across AT",
    affectedCombos: ["NVDA+Firefox", "TalkBack+Chrome"],
  },
  alertdialog: {
    risk: 6,
    issue: "Alert dialog behavior inconsistent — some AT don't force focus or announce urgency",
    affectedCombos: ["TalkBack+Chrome", "VoiceOver+Safari"],
  },
  menu: {
    risk: 4,
    issue: "Menu navigation model varies — some AT expect arrow keys, others don't enter menu mode",
    affectedCombos: ["TalkBack+Chrome"],
  },
  menuitem: {
    risk: 4,
    issue: "Menuitem announcement and navigation within menus varies by AT",
    affectedCombos: ["TalkBack+Chrome"],
  },
  tab: {
    risk: 3,
    issue: "Tab widget interaction model (arrow keys vs tab key) not consistently expected",
    affectedCombos: ["VoiceOver+Safari mobile"],
  },
  tabpanel: {
    risk: 3,
    issue: "Tab panel association with tab not always announced",
    affectedCombos: ["NVDA+Chrome"],
  },
  combobox: {
    risk: 8,
    issue: "Combobox is the most interop-problematic ARIA pattern — behavior varies widely",
    affectedCombos: ["NVDA+Firefox", "JAWS+Chrome", "TalkBack+Chrome", "VoiceOver+Safari"],
  },
  listbox: {
    risk: 5,
    issue: "Listbox selection announcement inconsistent across AT",
    affectedCombos: ["TalkBack+Chrome", "NVDA+Firefox"],
  },
  switch: {
    risk: 4,
    issue: "Switch role not consistently distinguished from checkbox by some AT",
    affectedCombos: ["NVDA+Firefox", "TalkBack+Chrome"],
  },
  slider: {
    risk: 5,
    issue: "Slider value change announcements and interaction model vary",
    affectedCombos: ["TalkBack+Chrome", "VoiceOver+Safari mobile"],
  },
  spinbutton: {
    risk: 5,
    issue: "Spinbutton increment/decrement behavior inconsistent",
    affectedCombos: ["TalkBack+Chrome"],
  },

  // Higher risk roles (9+)
  tree: {
    risk: 10,
    issue: "Tree widget navigation model poorly supported outside of JAWS",
    affectedCombos: ["NVDA+Chrome", "TalkBack+Chrome", "VoiceOver+Safari"],
  },
  treeitem: {
    risk: 10,
    issue: "Tree item expand/collapse and level announcement varies widely",
    affectedCombos: ["NVDA+Chrome", "TalkBack+Chrome"],
  },
  grid: {
    risk: 9,
    issue: "Grid navigation (arrow keys for cells) not consistently supported",
    affectedCombos: ["TalkBack+Chrome", "VoiceOver+Safari mobile"],
  },
  treegrid: {
    risk: 12,
    issue: "Treegrid combines tree + grid problems — very low cross-AT support",
    affectedCombos: ["Most AT/browser combos"],
  },
  feed: {
    risk: 8,
    issue: "Feed role and article navigation not widely supported in AT",
    affectedCombos: ["NVDA+Chrome", "TalkBack+Chrome"],
  },
  application: {
    risk: 15,
    issue: "Application role disables AT virtual mode — dangerous if misused",
    affectedCombos: ["All AT"],
  },
};

/**
 * Known interop risks by ARIA attribute.
 */
export const attributeInteropRisk: Record<string, InteropEntry> = {
  "aria-live": {
    risk: 3,
    issue: "Live region announcement timing and completeness varies",
    affectedCombos: ["TalkBack+Chrome", "VoiceOver+Safari mobile"],
  },
  "aria-relevant": {
    risk: 7,
    issue: "aria-relevant values (additions, removals, text) inconsistently honored",
    affectedCombos: ["Most AT"],
  },
  "aria-atomic": {
    risk: 5,
    issue: "aria-atomic=true not always respected — some AT announce only changed portion",
    affectedCombos: ["TalkBack+Chrome", "NVDA+Firefox"],
  },
  "aria-errormessage": {
    risk: 8,
    issue: "aria-errormessage has low AT support — aria-describedby is more reliable",
    affectedCombos: ["JAWS+Chrome", "NVDA+Firefox", "TalkBack+Chrome"],
  },
  "aria-description": {
    risk: 6,
    issue: "aria-description support is growing but not yet universal",
    affectedCombos: ["NVDA+Firefox", "TalkBack+Chrome"],
  },
  "aria-keyshortcuts": {
    risk: 10,
    issue: "aria-keyshortcuts very rarely announced by AT",
    affectedCombos: ["Most AT"],
  },
  "aria-roledescription": {
    risk: 4,
    issue: "aria-roledescription announced inconsistently — some AT ignore it",
    affectedCombos: ["TalkBack+Chrome"],
  },
  "aria-current": {
    risk: 2,
    issue: "aria-current=page generally well-supported; other values less so",
    affectedCombos: ["TalkBack+Chrome"],
  },
};

/**
 * Compute interop risk penalty for a target based on its role and attributes.
 *
 * Attributes can reduce risk when they indicate ARIA APG conformance.
 * For example, a tab with aria-selected follows the ARIA APG pattern
 * and should have lower interop risk than a bare role="tab".
 */
export function computeInteropRisk(
  role: string,
  attributes?: string[],
): { risk: number; issues: string[] } {
  const issues: string[] = [];
  let totalRisk = 0;

  // Role-based risk (lowercase for case-insensitive lookup)
  const normalizedRole = role.toLowerCase();
  const roleEntry = roleInteropRisk[normalizedRole];
  if (roleEntry && roleEntry.risk > 0) {
    totalRisk += roleEntry.risk;
    issues.push(`${normalizedRole}: ${roleEntry.issue}`);
  }

  // ARIA APG conformance reduces risk — proper attributes indicate the
  // developer followed the standard pattern, improving cross-AT support.
  if (attributes) {
    const attrSet = new Set(attributes.map((a) => a.toLowerCase()));

    // Add risk for attributes with known interop issues
    for (const attr of attrSet) {
      const entry = attributeInteropRisk[attr];
      if (entry && entry.risk > 0) {
        totalRisk += entry.risk;
        issues.push(`${attr}: ${entry.issue}`);
      }
    }

    // APG conformance reductions — well-structured patterns reduce risk
    // Tab with aria-selected → APG-conformant tab pattern
    if (normalizedRole === "tab" && attrSet.has("aria-selected")) {
      totalRisk = Math.max(0, totalRisk - 2);
      if (totalRisk === 0) issues.length = 0;
    }

    // Combobox with aria-expanded + aria-autocomplete → well-structured
    if (normalizedRole === "combobox" && attrSet.has("aria-expanded") && attrSet.has("aria-autocomplete")) {
      totalRisk = Math.max(0, totalRisk - 3);
      if (totalRisk === 0) issues.length = 0;
    }

    // Menu/menuitem with aria-haspopup → expected submenu pattern
    if ((normalizedRole === "menu" || normalizedRole === "menuitem") && attrSet.has("aria-haspopup")) {
      totalRisk = Math.max(0, totalRisk - 2);
      if (totalRisk === 0) issues.length = 0;
    }
  }

  // Cap at 20
  return {
    risk: Math.min(20, totalRisk),
    issues,
  };
}
