/**
 * Minimal ARIA validation. Catches the high-frequency author errors:
 *
 *   1. role="…" with a non-standard value (typos like role="buton", made-up
 *      roles like role="card", or wrong-context roles).
 *   2. aria-* attribute names that aren't in the standard set (typos like
 *      aria-decribedby).
 *   3. aria-* attribute values that aren't in the allowed enum (e.g.
 *      aria-checked="on" instead of "true"/"false"/"mixed").
 *   4. Required-states-and-properties per role (combobox needs aria-expanded,
 *      slider needs aria-valuenow, etc.).
 *   5. Naming-prohibited roles given an accessible name via aria-label /
 *      aria-labelledby (generic, presentation, paragraph, etc.).
 *   6. Wave 28: aria-* attributes set on a role that does NOT support that
 *      attribute (e.g. aria-checked on role=link, aria-expanded on role=img).
 *
 * NOT validated here (left for follow-up):
 *   - Allowed children per composite role (tablist must contain tabs, etc.)
 *   - Required parents per role (tab must have tablist ancestor, etc.)
 *
 * Source: ARIA 1.2 (W3C). This module embeds the taxonomy as static
 * constants so capture stays self-contained — no schema fetch at runtime.
 */

import type { Frame, Page } from "playwright";

/** ARIA 1.2 standard role values. Source: w3.org/TR/wai-aria-1.2/#role_definitions */
const VALID_ROLES = new Set<string>([
  // Widget roles
  "button", "checkbox", "gridcell", "link", "menuitem", "menuitemcheckbox",
  "menuitemradio", "option", "progressbar", "radio", "scrollbar", "searchbox",
  "separator", "slider", "spinbutton", "switch", "tab", "tabpanel", "textbox",
  "treeitem",
  // Composite widget roles
  "combobox", "grid", "listbox", "menu", "menubar", "radiogroup", "tablist",
  "tree", "treegrid",
  // Document structure roles
  "application", "article", "blockquote", "caption", "cell", "code",
  "columnheader", "definition", "deletion", "directory", "document", "emphasis",
  "feed", "figure", "generic", "group", "heading", "img", "insertion", "list",
  "listitem", "math", "meter", "none", "note", "paragraph", "presentation",
  "row", "rowgroup", "rowheader", "separator", "strong", "subscript",
  "superscript", "table", "term", "time", "toolbar", "tooltip",
  // Landmark roles
  "banner", "complementary", "contentinfo", "form", "main", "navigation",
  "region", "search",
  // Live region roles
  "alert", "log", "marquee", "status", "timer",
  // Window roles
  "alertdialog", "dialog",
]);

/** ARIA 1.2 standard attribute names. Source: w3.org/TR/wai-aria-1.2/#state_prop_def */
const VALID_ARIA_ATTRS = new Set<string>([
  // Widget attributes
  "aria-autocomplete", "aria-checked", "aria-disabled", "aria-errormessage",
  "aria-expanded", "aria-haspopup", "aria-hidden", "aria-invalid",
  "aria-label", "aria-level", "aria-modal", "aria-multiline",
  "aria-multiselectable", "aria-orientation", "aria-placeholder", "aria-pressed",
  "aria-readonly", "aria-required", "aria-selected", "aria-sort", "aria-valuemax",
  "aria-valuemin", "aria-valuenow", "aria-valuetext",
  // Live region attributes
  "aria-atomic", "aria-busy", "aria-live", "aria-relevant",
  // Drag-and-drop attributes
  "aria-dropeffect", "aria-grabbed",
  // Relationship attributes
  "aria-activedescendant", "aria-colcount", "aria-colindex", "aria-colspan",
  "aria-controls", "aria-describedby", "aria-description", "aria-details",
  "aria-flowto", "aria-labelledby", "aria-owns", "aria-posinset",
  "aria-rowcount", "aria-rowindex", "aria-rowspan", "aria-setsize",
  // Other widget/global
  "aria-current", "aria-keyshortcuts", "aria-roledescription",
  // Brand-newer (still standard)
  "aria-braillelabel", "aria-brailleroledescription", "aria-colindextext",
  "aria-rowindextext",
]);

/**
 * Roles that REQUIRE specific aria-* states/properties to be set. Source:
 * ARIA 1.2 — "Required States and Properties" per role definition. Only
 * roles where missing the attribute leaves the widget functionally unusable
 * for SR users are included; widgets with several optional state attrs are
 * left to per-role probes.
 */
const ROLE_REQUIRED_ATTRS: Record<string, ReadonlySet<string>> = {
  combobox: new Set(["aria-expanded"]),
  scrollbar: new Set(["aria-controls", "aria-valuenow"]),
  slider: new Set(["aria-valuenow"]),
  spinbutton: new Set([]), // valuenow is "supported" but not required by spec
  checkbox: new Set(["aria-checked"]),
  radio: new Set(["aria-checked"]),
  switch: new Set(["aria-checked"]),
  menuitemcheckbox: new Set(["aria-checked"]),
  menuitemradio: new Set(["aria-checked"]),
  option: new Set(["aria-selected"]),
  // Composite-widget children: aria-required-context — required by parent
  // role rather than by the child role itself, so we don't enforce here.
};

/**
 * Roles that PROHIBIT a naming method per ARIA 1.2 — listing aria-label /
 * aria-labelledby on these is a spec violation. Most commonly hit on
 * role="generic" (added in 1.2 as a name-prohibited replacement for the
 * implicit `<div>` semantic).
 */
const NAMING_PROHIBITED_ROLES: ReadonlySet<string> = new Set([
  "caption",
  "code",
  "deletion",
  "emphasis",
  "generic",
  "insertion",
  "paragraph",
  "presentation",
  "none",
  "strong",
  "subscript",
  "superscript",
  "term",
  "time",
]);

/**
 * Wave 28: ARIA 1.2 allowed-attributes-per-role taxonomy.
 *
 * GLOBAL_ARIA_ATTRS: the 14 aria-* attributes ARIA defines as "global states
 * and properties" — allowed on any role (and on any element with no role).
 * Any aria-* attribute NOT in this set is role-restricted: it's only allowed
 * on the roles listed in ROLE_SUPPORTED_ATTRS for that attr's role-list per
 * spec.
 *
 * ROLE_SUPPORTED_ATTRS maps each non-global attribute to the set of roles
 * that "support" it per ARIA 1.2 (spec sections "Supported States and
 * Properties"). Required states are also "supported", so the table is the
 * superset.
 *
 * Source: w3.org/TR/wai-aria-1.2/ — section 7 (state/prop definitions list
 * each attribute's `Used in Roles`). The roleparent inheritance is flattened
 * (e.g. an attribute supported on role=range applies to slider, spinbutton,
 * scrollbar, progressbar, meter — those are all sub-roles of range).
 */
const GLOBAL_ARIA_ATTRS: ReadonlySet<string> = new Set([
  "aria-atomic",
  "aria-busy",
  "aria-controls",
  "aria-current",
  "aria-describedby",
  "aria-description",
  "aria-details",
  "aria-disabled",
  "aria-dropeffect",
  "aria-flowto",
  "aria-grabbed",
  "aria-hidden",
  "aria-invalid",
  "aria-keyshortcuts",
  "aria-label",
  "aria-labelledby",
  "aria-live",
  "aria-owns",
  "aria-relevant",
  "aria-roledescription",
  "aria-braillelabel",
  "aria-brailleroledescription",
]);

/** Roles in the ARIA "range" abstract role family (inherit value-* attrs). */
const RANGE_ROLES = ["meter", "progressbar", "scrollbar", "slider", "spinbutton"];
/** Roles in the "select" / "structure" containers that allow positional attrs. */
const ROW_CHILD_ROLES = ["cell", "columnheader", "gridcell", "rowheader"];
const COMPOSITE_LISTBOX_LIKE = ["combobox", "listbox", "menu", "menubar", "tree", "grid", "treegrid"];

/**
 * For each non-global aria-* attribute, the set of roles where it is
 * supported per ARIA 1.2. Implicit roles (HTML element fallbacks) are
 * resolved at scan time — see ROLE_INHERITS_VALUES below.
 */
const ROLE_SUPPORTED_ATTRS: Record<string, ReadonlySet<string>> = {
  "aria-activedescendant": new Set([
    "application", "combobox", "composite", "group", "textbox",
    "grid", "listbox", "menu", "menubar", "radiogroup", "row", "searchbox",
    "select", "spinbutton", "tablist", "toolbar", "tree", "treegrid",
  ]),
  "aria-autocomplete": new Set(["combobox", "searchbox", "textbox"]),
  "aria-checked": new Set(["checkbox", "menuitemcheckbox", "menuitemradio", "option", "radio", "switch", "treeitem"]),
  "aria-colcount": new Set(["table", "grid", "treegrid"]),
  "aria-colindex": new Set([...ROW_CHILD_ROLES, "row"]),
  "aria-colindextext": new Set([...ROW_CHILD_ROLES, "row"]),
  "aria-colspan": new Set(ROW_CHILD_ROLES),
  "aria-errormessage": new Set([
    "application", "checkbox", "combobox", "gridcell", "listbox", "radiogroup",
    "slider", "spinbutton", "textbox", "tree", "columnheader", "rowheader",
    "searchbox", "switch",
  ]),
  "aria-expanded": new Set([
    "application", "button", "checkbox", "combobox", "gridcell", "link",
    "listbox", "menuitem", "row", "rowheader", "tab", "treeitem",
    "columnheader", "menuitemcheckbox", "menuitemradio", "switch",
  ]),
  "aria-haspopup": new Set([
    "application", "button", "combobox", "gridcell", "link", "menuitem",
    "rowheader", "slider", "tab", "textbox", "treeitem",
    "columnheader", "menuitemcheckbox", "menuitemradio", "searchbox",
  ]),
  "aria-level": new Set(["heading", "listitem", "row", "tablist", "treeitem", "comment"]),
  "aria-modal": new Set(["alertdialog", "dialog"]),
  "aria-multiline": new Set(["searchbox", "textbox"]),
  "aria-multiselectable": new Set([...COMPOSITE_LISTBOX_LIKE]),
  "aria-orientation": new Set([
    "scrollbar", "select", "separator", "slider", "tablist", "toolbar",
    "menu", "menubar", "listbox", "radiogroup", "tree", "treegrid",
  ]),
  "aria-placeholder": new Set(["searchbox", "textbox", "combobox"]),
  "aria-posinset": new Set([
    "article", "listitem", "menuitem", "option", "radio", "row", "tab",
    "treeitem", "comment", "menuitemcheckbox", "menuitemradio",
  ]),
  "aria-pressed": new Set(["button"]),
  "aria-readonly": new Set([
    "checkbox", "combobox", "grid", "gridcell", "listbox", "radiogroup",
    "slider", "spinbutton", "switch", "textbox", "searchbox",
    "columnheader", "rowheader",
  ]),
  "aria-required": new Set([
    "checkbox", "combobox", "gridcell", "listbox", "radiogroup", "spinbutton",
    "textbox", "tree", "searchbox", "switch", "columnheader", "rowheader",
  ]),
  "aria-rowcount": new Set(["table", "grid", "treegrid"]),
  "aria-rowindex": new Set([...ROW_CHILD_ROLES, "row"]),
  "aria-rowindextext": new Set([...ROW_CHILD_ROLES, "row"]),
  "aria-rowspan": new Set(ROW_CHILD_ROLES),
  "aria-selected": new Set([
    "gridcell", "option", "row", "tab", "columnheader", "rowheader", "treeitem",
  ]),
  "aria-setsize": new Set([
    "article", "listitem", "menuitem", "option", "radio", "row", "tab",
    "treeitem", "comment", "menuitemcheckbox", "menuitemradio",
  ]),
  "aria-sort": new Set(["columnheader", "rowheader"]),
  "aria-valuemax": new Set(RANGE_ROLES),
  "aria-valuemin": new Set(RANGE_ROLES),
  "aria-valuenow": new Set(RANGE_ROLES),
  "aria-valuetext": new Set(RANGE_ROLES),
};

/**
 * Native HTML elements have implicit ARIA roles — when the author hasn't
 * set role="…" we apply this mapping so we can validate aria-* support
 * against the actual computed role. Conservative: only the elements where
 * the implicit role is unambiguous (i.e. not contextual on attributes
 * beyond what's listed). Source: html.spec.whatwg.org "ARIA in HTML".
 */
const IMPLICIT_ROLE_BY_TAG: Record<string, string> = {
  a: "link", // only when href present — handled at scan
  area: "link",
  article: "article",
  aside: "complementary",
  button: "button",
  datalist: "listbox",
  dd: "definition",
  details: "group",
  dfn: "term",
  dialog: "dialog",
  dt: "term",
  fieldset: "group",
  figure: "figure",
  footer: "contentinfo", // approximate — only when not nested in article/section
  form: "form",
  h1: "heading",
  h2: "heading",
  h3: "heading",
  h4: "heading",
  h5: "heading",
  h6: "heading",
  header: "banner", // approximate
  hr: "separator",
  img: "img", // only with non-empty alt — handled at scan
  li: "listitem",
  main: "main",
  math: "math",
  menu: "list",
  meter: "meter",
  nav: "navigation",
  ol: "list",
  optgroup: "group",
  option: "option",
  output: "status",
  progress: "progressbar",
  search: "search",
  section: "region",
  select: "combobox", // when no multiple/size>1 — approximate
  summary: "button",
  table: "table",
  tbody: "rowgroup",
  td: "cell",
  textarea: "textbox",
  tfoot: "rowgroup",
  th: "cell",
  thead: "rowgroup",
  tr: "row",
  ul: "list",
};

/** Attributes whose value must be one of an enumerated set. Other aria-*
 *  attributes accept free-form strings, IDs, or numbers (validated only at
 *  use site). */
const ENUM_ATTR_VALUES: Record<string, ReadonlySet<string>> = {
  "aria-checked": new Set(["true", "false", "mixed", "undefined"]),
  "aria-pressed": new Set(["true", "false", "mixed", "undefined"]),
  "aria-expanded": new Set(["true", "false", "undefined"]),
  "aria-selected": new Set(["true", "false", "undefined"]),
  "aria-disabled": new Set(["true", "false"]),
  "aria-hidden": new Set(["true", "false", "undefined"]),
  "aria-busy": new Set(["true", "false"]),
  "aria-modal": new Set(["true", "false"]),
  "aria-multiline": new Set(["true", "false"]),
  "aria-multiselectable": new Set(["true", "false"]),
  "aria-readonly": new Set(["true", "false"]),
  "aria-required": new Set(["true", "false"]),
  "aria-atomic": new Set(["true", "false"]),
  "aria-grabbed": new Set(["true", "false", "undefined"]),
  "aria-haspopup": new Set(["false", "true", "menu", "listbox", "tree", "grid", "dialog"]),
  "aria-autocomplete": new Set(["inline", "list", "both", "none"]),
  "aria-orientation": new Set(["horizontal", "vertical", "undefined"]),
  "aria-sort": new Set(["ascending", "descending", "none", "other"]),
  "aria-current": new Set(["page", "step", "location", "date", "time", "true", "false"]),
  "aria-invalid": new Set(["grammar", "false", "spelling", "true"]),
  "aria-live": new Set(["off", "polite", "assertive"]),
  "aria-relevant": new Set(["additions", "removals", "text", "all", "additions text"]),
  "aria-dropeffect": new Set(["copy", "execute", "link", "move", "none", "popup"]),
};

export interface AriaValidationIssue {
  kind: "invalid-role" | "unknown-attr" | "invalid-attr-value" | "unsupported-attr-for-role";
  /** Short element-locator-ish description like `div#header` or `button.cta`. */
  selector: string;
  /** The offending attribute or role name. */
  name: string;
  /** Bad value (for invalid-attr-value) or empty. */
  value: string;
  /** Human-friendly hint (e.g. "did you mean aria-describedby?"). */
  hint?: string;
}

export interface AriaValidationResult {
  invalidRoles: AriaValidationIssue[];
  unknownAttrs: AriaValidationIssue[];
  invalidAttrValues: AriaValidationIssue[];
  missingRequiredAttrs: AriaValidationIssue[];
  prohibitedNaming: AriaValidationIssue[];
  /** Wave 28: aria-* attribute set on a role that doesn't support it. */
  unsupportedAttrsForRole: AriaValidationIssue[];
}

export async function validateAriaUsage(page: Page | Frame): Promise<AriaValidationResult> {
  return page
    .evaluate(
      ({
        validRoles,
        validAttrs,
        enumAttrValues,
        roleRequiredAttrs,
        namingProhibitedRoles,
        globalAttrs,
        roleSupportedAttrs,
        implicitRoleByTag,
      }: {
        validRoles: string[];
        validAttrs: string[];
        enumAttrValues: Record<string, string[]>;
        roleRequiredAttrs: Record<string, string[]>;
        namingProhibitedRoles: string[];
        globalAttrs: string[];
        roleSupportedAttrs: Record<string, string[]>;
        implicitRoleByTag: Record<string, string>;
      }) => {
        const validRoleSet = new Set(validRoles);
        const validAttrSet = new Set(validAttrs);
        const enumValueMap: Record<string, Set<string>> = {};
        for (const [k, v] of Object.entries(enumAttrValues)) enumValueMap[k] = new Set(v);
        const requiredAttrsByRole: Record<string, Set<string>> = {};
        for (const [k, v] of Object.entries(roleRequiredAttrs)) requiredAttrsByRole[k] = new Set(v);
        const namingProhibitedSet = new Set(namingProhibitedRoles);
        const globalAttrSet = new Set(globalAttrs);
        const supportedAttrsByRole: Record<string, Set<string>> = {};
        for (const [k, v] of Object.entries(roleSupportedAttrs)) supportedAttrsByRole[k] = new Set(v);

        const describe = (el: Element): string => {
          const tag = el.tagName.toLowerCase();
          const id = el.id ? `#${el.id}` : "";
          const cls = el.className && typeof el.className === "string"
            ? "." + el.className.split(/\s+/).filter(Boolean).slice(0, 2).join(".")
            : "";
          return `${tag}${id}${cls}`.slice(0, 80);
        };

        // Levenshtein distance for "did you mean" hints.
        const levenshtein = (a: string, b: string): number => {
          if (a === b) return 0;
          const m = a.length, n = b.length;
          if (m === 0 || n === 0) return Math.max(m, n);
          let prev = new Array(n + 1).fill(0);
          let cur = new Array(n + 1).fill(0);
          for (let j = 0; j <= n; j++) prev[j] = j;
          for (let i = 1; i <= m; i++) {
            cur[0] = i;
            for (let j = 1; j <= n; j++) {
              const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
              cur[j] = Math.min(cur[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
            }
            [prev, cur] = [cur, prev];
          }
          return prev[n];
        };
        const didYouMean = (typo: string, candidates: Iterable<string>): string | undefined => {
          let best: string | undefined;
          let bestDist = Infinity;
          for (const cand of candidates) {
            const d = levenshtein(typo.toLowerCase(), cand.toLowerCase());
            if (d < bestDist && d <= 2) {
              best = cand;
              bestDist = d;
            }
          }
          return best;
        };

        const invalidRoles: AriaValidationIssue[] = [];
        const unknownAttrs: AriaValidationIssue[] = [];
        const invalidAttrValues: AriaValidationIssue[] = [];
        const missingRequiredAttrs: AriaValidationIssue[] = [];
        const prohibitedNaming: AriaValidationIssue[] = [];
        const unsupportedAttrsForRole: AriaValidationIssue[] = [];

        // Resolve the role we'll use for support-checks. Author-provided
        // role wins; otherwise apply the implicit-role table. Returns
        // undefined when no role can be resolved (e.g. role-less <div>) —
        // such elements get no role-restricted aria-* validation.
        const resolveRole = (el: Element): string | undefined => {
          const explicit = el.getAttribute("role");
          if (explicit) {
            const tokens = explicit.trim().split(/\s+/).filter(Boolean);
            for (const t of tokens) {
              const lower = t.toLowerCase();
              if (validRoleSet.has(lower)) return lower;
            }
            return undefined;
          }
          const tag = el.tagName.toLowerCase();
          // Tag-specific carve-outs:
          if (tag === "a" || tag === "area") {
            return el.hasAttribute("href") ? "link" : undefined;
          }
          if (tag === "img") {
            const alt = el.getAttribute("alt");
            if (alt === null) return "img"; // missing alt — img role still applies for ATs
            return alt === "" ? "presentation" : "img";
          }
          if (tag === "input") {
            const t = (el.getAttribute("type") ?? "text").toLowerCase();
            if (t === "button" || t === "submit" || t === "reset" || t === "image") return "button";
            if (t === "checkbox") return "checkbox";
            if (t === "radio") return "radio";
            if (t === "range") return "slider";
            if (t === "number") return "spinbutton";
            if (t === "search") return "searchbox";
            if (t === "email" || t === "tel" || t === "text" || t === "url" || t === "password") return "textbox";
            return undefined;
          }
          return implicitRoleByTag[tag];
        };

        const SCAN_CAP = 5000;
        // CSS selectors can't express "any attribute starting with aria-*",
        // so match against all elements and check for role / aria-* in JS.
        // Bounded by SCAN_CAP to keep cost predictable.
        const all = document.querySelectorAll("*");
        for (let i = 0; i < all.length && i < SCAN_CAP; i++) {
          const el = all[i];
          // Cheap pre-filter: only enter the per-attribute loop when the
          // element actually has either a role or any aria-* attribute.
          let hasAriaSomething = el.hasAttribute("role");
          if (!hasAriaSomething) {
            for (let k = 0; k < el.attributes.length; k++) {
              if (el.attributes[k].name.startsWith("aria-")) {
                hasAriaSomething = true;
                break;
              }
            }
          }
          if (!hasAriaSomething) continue;

          // Role validation
          const role = el.getAttribute("role");
          let primaryRole: string | undefined;
          if (role) {
            // Multiple roles allowed (space-separated, first valid wins per spec)
            const tokens = role.trim().split(/\s+/).filter(Boolean);
            for (const token of tokens) {
              const lower = token.toLowerCase();
              if (!validRoleSet.has(lower)) {
                if (invalidRoles.length < 10) {
                  invalidRoles.push({
                    kind: "invalid-role",
                    selector: describe(el),
                    name: token,
                    value: "",
                    hint: didYouMean(token, validRoleSet),
                  });
                }
              } else if (!primaryRole) {
                primaryRole = lower;
              }
            }
            if (primaryRole) {
              // Required-attrs check
              const required = requiredAttrsByRole[primaryRole];
              if (required) {
                for (const reqAttr of required) {
                  if (!el.hasAttribute(reqAttr)) {
                    if (missingRequiredAttrs.length < 10) {
                      missingRequiredAttrs.push({
                        kind: "invalid-role",
                        selector: describe(el),
                        name: primaryRole,
                        value: reqAttr,
                        hint: `role="${primaryRole}" requires ${reqAttr}`,
                      });
                    }
                  }
                }
              }
              // Naming-prohibited check
              if (namingProhibitedSet.has(primaryRole)) {
                if (el.hasAttribute("aria-label") || el.hasAttribute("aria-labelledby")) {
                  if (prohibitedNaming.length < 10) {
                    const which = el.hasAttribute("aria-label") ? "aria-label" : "aria-labelledby";
                    prohibitedNaming.push({
                      kind: "invalid-role",
                      selector: describe(el),
                      name: primaryRole,
                      value: which,
                      hint: `role="${primaryRole}" prohibits ${which} per ARIA 1.2`,
                    });
                  }
                }
              }
            }
          }

          // ARIA attribute validation
          // Resolve effective role (explicit OR implicit) for the support check.
          const effectiveRole = primaryRole ?? resolveRole(el);
          for (let j = 0; j < el.attributes.length; j++) {
            const attr = el.attributes[j];
            if (!attr.name.startsWith("aria-")) continue;
            const lowerName = attr.name.toLowerCase();
            if (!validAttrSet.has(lowerName)) {
              if (unknownAttrs.length < 10) {
                unknownAttrs.push({
                  kind: "unknown-attr",
                  selector: describe(el),
                  name: attr.name,
                  value: attr.value.slice(0, 40),
                  hint: didYouMean(attr.name, validAttrSet),
                });
              }
              continue;
            }
            // Wave 28: per-role support check. Globals are allowed everywhere;
            // for everything else, the attribute must appear in the role's
            // supported-attrs set. Skip when no role resolves (role-less
            // <div>/<span> — author hasn't claimed any semantics, so we can't
            // know what's "wrong"). Don't double-flag missing-required
            // (those are handled above).
            if (
              !globalAttrSet.has(lowerName) &&
              effectiveRole &&
              supportedAttrsByRole[lowerName] // attr is role-restricted
            ) {
              const supported = supportedAttrsByRole[lowerName];
              if (!supported.has(effectiveRole)) {
                if (unsupportedAttrsForRole.length < 10) {
                  const sample = [...supported].slice(0, 5).join(", ");
                  unsupportedAttrsForRole.push({
                    kind: "unsupported-attr-for-role",
                    selector: describe(el),
                    name: attr.name,
                    value: effectiveRole,
                    hint: `${attr.name} is not supported on role="${effectiveRole}"; use it on: ${sample}`,
                  });
                }
              }
            }
            const allowed = enumValueMap[lowerName];
            if (!allowed) continue; // not enum-restricted
            const v = attr.value.trim().toLowerCase();
            if (v === "") continue; // empty value tolerated by most attrs
            if (!allowed.has(v)) {
              if (invalidAttrValues.length < 10) {
                invalidAttrValues.push({
                  kind: "invalid-attr-value",
                  selector: describe(el),
                  name: attr.name,
                  value: attr.value.slice(0, 40),
                  hint: `expected one of: ${[...allowed].join(", ")}`,
                });
              }
            }
          }
        }

        return {
          invalidRoles,
          unknownAttrs,
          invalidAttrValues,
          missingRequiredAttrs,
          prohibitedNaming,
          unsupportedAttrsForRole,
        };
      },
      {
        validRoles: [...VALID_ROLES],
        validAttrs: [...VALID_ARIA_ATTRS],
        enumAttrValues: Object.fromEntries(
          Object.entries(ENUM_ATTR_VALUES).map(([k, v]) => [k, [...v]]),
        ),
        roleRequiredAttrs: Object.fromEntries(
          Object.entries(ROLE_REQUIRED_ATTRS).map(([k, v]) => [k, [...v]]),
        ),
        namingProhibitedRoles: [...NAMING_PROHIBITED_ROLES],
        globalAttrs: [...GLOBAL_ARIA_ATTRS],
        roleSupportedAttrs: Object.fromEntries(
          Object.entries(ROLE_SUPPORTED_ATTRS).map(([k, v]) => [k, [...v]]),
        ),
        implicitRoleByTag: IMPLICIT_ROLE_BY_TAG,
      },
    )
    .catch(
      () =>
        ({
          invalidRoles: [],
          unknownAttrs: [],
          invalidAttrValues: [],
          missingRequiredAttrs: [],
          prohibitedNaming: [],
          unsupportedAttrsForRole: [],
        }) as AriaValidationResult,
    );
}
