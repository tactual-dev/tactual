/**
 * Safe-action policy for bounded exploration.
 *
 * Classifies interactive elements as safe or unsafe to activate during
 * automated exploration. The goal is to allow navigational/state-revealing
 * interactions while blocking destructive or irreversible actions.
 *
 * ## Known Limitations
 *
 * This policy is keyword-based and cannot guarantee safety:
 *
 * - A malicious page could name a destructive button with a safe-sounding
 *   label (e.g., "Show details" that actually deletes data). The policy
 *   cannot detect semantic deception.
 * - The policy does not inspect server-side behavior — it only examines
 *   client-side ARIA roles, names, and attributes.
 * - Custom elements with non-standard roles may not be classified correctly.
 * - Form submissions are blocked by default, but a button that triggers
 *   a fetch() call without type="submit" will not be caught.
 *
 * For production use, always run exploration against trusted or sandboxed
 * environments. The explorer should never be pointed at untrusted pages
 * where destructive side effects are possible.
 */

export type ActionSafety = "safe" | "unsafe" | "caution";

export interface SafetyCheck {
  safety: ActionSafety;
  reason: string;
}

/**
 * Determine whether an interactive element is safe to activate during exploration.
 * If allowPatterns is provided, elements matching any pattern are downgraded
 * from "unsafe" to "caution" (explorable), letting users opt into testing
 * specific controls like checkout buttons or form submissions.
 */
export function checkActionSafety(element: ElementInfo, allowPatterns?: RegExp[]): SafetyCheck {
  const result = classifyAction(element);

  // If classified as unsafe but matches an allow pattern, downgrade to caution
  if (result.safety === "unsafe" && allowPatterns && allowPatterns.length > 0) {
    const id = `${element.role ?? ""}:${element.name ?? ""}`.toLowerCase();
    for (const pattern of allowPatterns) {
      if (pattern.test(id) || pattern.test(element.name ?? "")) {
        return { safety: "caution", reason: `${result.reason} (allowed by --allow-action pattern)` };
      }
    }
  }

  return result;
}

function classifyAction(element: ElementInfo): SafetyCheck {
  const name = (element.name ?? "").toLowerCase();
  const role = (element.role ?? "").toLowerCase();
  const type = (element.type ?? "").toLowerCase();

  // Block destructive actions
  for (const pattern of UNSAFE_PATTERNS) {
    if (pattern.test(name)) {
      return { safety: "unsafe", reason: `Name matches destructive pattern: "${element.name}"` };
    }
  }

  // Block form submissions (unless it's a search)
  if (type === "submit" && !isSearchRelated(name, element)) {
    return { safety: "unsafe", reason: "Submit button — may trigger irreversible server-side action" };
  }

  // Safe roles: these are navigational / state-revealing
  if (SAFE_ROLES.has(role)) {
    return { safety: "safe", reason: `Role "${role}" is navigational` };
  }

  // Safe by aria-expanded or aria-haspopup — these toggle UI
  if (element.expanded !== undefined || element.hasPopup) {
    return { safety: "safe", reason: "Element toggles expandable/popup UI" };
  }

  // Links to same-page anchors are safe
  if (role === "link" && element.href?.startsWith("#")) {
    return { safety: "safe", reason: "Same-page anchor link" };
  }

  // Links to external pages — caution (changes page state)
  if (role === "link") {
    return { safety: "caution", reason: "External link — may navigate away" };
  }

  // Generic buttons — check name for safety signals
  if (role === "button") {
    for (const pattern of SAFE_BUTTON_PATTERNS) {
      if (pattern.test(name)) {
        return { safety: "safe", reason: `Button name suggests safe action: "${element.name}"` };
      }
    }
    return {
      safety: name ? "caution" : "unsafe",
      reason: name ? "Ambiguous button action" : "Unlabeled button — unknown action",
    };
  }

  // Form fields — safe to focus, not to submit
  if (FORM_ROLES.has(role)) {
    return { safety: "safe", reason: "Form field — safe to focus" };
  }

  return { safety: "caution", reason: "Unknown element type" };
}

export interface ElementInfo {
  role?: string;
  name?: string;
  type?: string;
  href?: string;
  expanded?: boolean;
  hasPopup?: boolean;
  disabled?: boolean;
}

// ---------------------------------------------------------------------------
// Pattern lists
// ---------------------------------------------------------------------------

const UNSAFE_PATTERNS = [
  /\bdelete\b/,
  /\bremove\b/,
  /\bdestroy\b/,
  /\bpurge\b/,
  /\bsend\b/,
  /\bsubmit\b/,
  /\bpurchase\b/,
  /\bbuy\b/,
  /\bcheckout\b/,
  /\bpay\b/,
  /\bconfirm order\b/,
  /\bplace order\b/,
  /\bsign out\b/,
  /\blog out\b/,
  /\blogout\b/,
  /\bunsubscribe\b/,
  /\bcancel subscription\b/,
  /\bdeactivate\b/,
  /\breset\b/,
  /\bclear all\b/,
  /\bpublish\b/,
  /\bdeploy\b/,
  /\bexecute\b/,
  /\bapprove\b/,
  /\breject\b/,
  /\bpost\b/,
  /\btweet\b/,
  /\bshare\b/,
];

const SAFE_BUTTON_PATTERNS = [
  /\bmenu\b/,
  /\btoggle\b/,
  /\bexpand\b/,
  /\bcollapse\b/,
  /\bopen\b/,
  /\bclose\b/,
  /\bshow\b/,
  /\bhide\b/,
  /\bmore\b/,
  /\bless\b/,
  /\bnext\b/,
  /\bprevious\b/,
  /\bprev\b/,
  /\bback\b/,
  /\bforward\b/,
  /\bdetails\b/,
  /\binfo\b/,
  /\bfilter\b/,
  /\bsort\b/,
  /\bsearch\b/,
  /\btab\b/,
  /\bnavigate\b/,
  /\bselect\b/,
  /\bcopy\b/,
  /\bview\b/,
  /\bpreview\b/,
  // Pagination / load-more / multi-step flow verbs. Activating these
  // reveals additional content (page N, more items, next step) without
  // the destructive connotations of "submit" or "purchase". Multi-step
  // flows on marketing sites (tutorial wizards, feature walkthroughs)
  // benefit from exploration since later steps often have their own
  // interactive controls that would otherwise be invisible.
  /\bcontinue\b/,
  /\bproceed\b/,
  /\bpage\s+\d+\b/,
  /\bstep\s+\d+\b/,
];

const SAFE_ROLES = new Set([
  "tab",
  "menuitem",
  "menuitemcheckbox",
  "menuitemradio",
  "option",
  "treeitem",
  "switch",
  "disclosure",
]);

const FORM_ROLES = new Set([
  "textbox",
  "searchbox",
  "combobox",
  "listbox",
  "spinbutton",
  "slider",
  "checkbox",
  "radio",
]);

function isSearchRelated(name: string, element: ElementInfo): boolean {
  return /search/i.test(name) || /search/i.test(element.type ?? "");
}
