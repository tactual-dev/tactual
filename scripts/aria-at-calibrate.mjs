/**
 * ARIA-AT calibration runner.
 *
 * Fetches assertions from the W3C ARIA-AT project (https://github.com/w3c/aria-at)
 * and verifies that the simulator's predicted announcements convey the
 * required role/name/state for each tested pattern.
 *
 * Run: npm run calibrate (after npm run build)
 *
 * Each ARIA pattern in patternToTarget is represented by a synthetic
 * Target. We fetch the pattern's assertions from the upstream repo,
 * filter to those that apply to a single-target announcement (skipping
 * assertions about contents inside the target), then check whether
 * each AT's predicted announcement conveys the asserted concepts.
 */

import { writeFileSync, mkdirSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { buildAnnouncement } from "../dist/playwright/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, "..", "build", "aria-at");
mkdirSync(outDir, { recursive: true });

const newFormat = [
  "command-button", "checkbox", "switch", "horizontal-slider",
  "modal-dialog", "tabs-manual-activation", "link-span-text",
  "alert", "disclosure-faq", "menu-button-actions", "quantity-spin-button",
];
const oldFormat = ["main", "banner", "contentinfo", "complementary"];

const patternToTarget = {
  "command-button":            { kind: "button", role: "button", name: "Print Page" },
  "checkbox":                  { kind: "formField", role: "checkbox", name: "Sandwich", _attributeValues: { "aria-checked": "true" } },
  "switch":                    { kind: "formField", role: "switch", name: "Notifications", _attributeValues: { "aria-checked": "true" } },
  "horizontal-slider":         { kind: "formField", role: "slider", name: "Temperature", _value: "20" },
  "modal-dialog":              { kind: "dialog", role: "dialog", name: "Add Delivery Address", _attributeValues: { "aria-modal": "true" } },
  "tabs-manual-activation":    { kind: "tab", role: "tab", name: "Nils Frahm", _attributeValues: { "aria-selected": "true" } },
  "link-span-text":            { kind: "link", role: "link", name: "WAI ARIA Authoring Practices" },
  "alert":                     { kind: "statusMessage", role: "alert", name: "Hello" },
  "disclosure-faq":            { kind: "button", role: "button", name: "How do I open a new account", _attributeValues: { "aria-expanded": "false" } },
  "menu-button-actions":       { kind: "button", role: "button", name: "Actions", _attributeValues: { "aria-expanded": "false", "aria-haspopup": "menu" } },
  "quantity-spin-button":      { kind: "formField", role: "spinbutton", name: "Apples", _value: "0" },
  "main":                      { kind: "landmark", role: "main", name: "" },
  "banner":                    { kind: "landmark", role: "banner", name: "" },
  "contentinfo":               { kind: "landmark", role: "contentinfo", name: "" },
  "complementary":             { kind: "landmark", role: "complementary", name: "" },
};

function parseCSV(text) {
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  const header = lines[0].split(",");
  return lines.slice(1).map((line) => {
    const fields = [];
    let cur = "", inQuote = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (c === '"') { inQuote = !inQuote; continue; }
      if (c === "," && !inQuote) { fields.push(cur); cur = ""; continue; }
      cur += c;
    }
    fields.push(cur);
    return Object.fromEntries(header.map((h, i) => [h, fields[i] ?? ""]));
  });
}

async function getAssertionsFor(pattern) {
  const base = `https://raw.githubusercontent.com/w3c/aria-at/master/tests/apg/${pattern}/data`;
  let r = await fetch(`${base}/assertions.csv`);
  if (r.ok) {
    const csv = await r.text();
    return parseCSV(csv).map((row) => ({ statement: row.assertionStatement, priority: row.priority }));
  }
  r = await fetch(`${base}/tests.csv`);
  if (!r.ok) return [];
  const csv = await r.text();
  const rows = parseCSV(csv);
  const set = new Set();
  for (const row of rows) {
    for (const k of ["assertion1", "assertion2", "assertion3", "assertion4"]) {
      if (row[k]?.trim()) set.add(row[k].trim());
    }
  }
  return [...set].map((s) => ({ statement: s, priority: "1" }));
}

// Determine whether an assertion is about the simulated target vs another
// element in the same test scenario (e.g., a link INSIDE the main landmark).
// Also filters out test variants where the assertion expects a state our
// representative target doesn't model (we can only represent one state per target).
function assertionAppliesTo(assertion, target) {
  const tokens = (assertion.match(/'([^']+)'/g) ?? []).map((t) => t.slice(1, -1).toLowerCase());
  const targetName = (target.name ?? "").toLowerCase();
  const targetRole = target.role.toLowerCase();
  const targetAttrs = target._attributeValues ?? {};

  if (/^Role /.test(assertion)) {
    const role = tokens[0];
    return role === targetRole || roleAlias(role) === targetRole;
  }
  if (/^Name /.test(assertion)) {
    return tokens[0] === targetName;
  }
  // State assertions: only apply if our target has that state attribute set
  // to the asserted value. ARIA-AT tests both "checked" and "not checked"
  // variants — our target represents one of those.
  if (/^State of/.test(assertion) || /^State /.test(assertion)) {
    const expected = tokens[0];
    if (expected === "checked") return targetAttrs["aria-checked"] === "true";
    if (expected === "not checked") return targetAttrs["aria-checked"] === "false";
    if (expected === "expanded") return targetAttrs["aria-expanded"] === "true";
    if (expected === "collapsed") return targetAttrs["aria-expanded"] === "false";
    if (expected === "selected") return targetAttrs["aria-selected"] === "true";
    if (expected === "modal") return targetAttrs["aria-modal"] === "true";
    return false;
  }
  // Heading level only applies to heading targets
  if (/^Heading level/.test(assertion)) {
    return target.kind === "heading" && String(target.headingLevel) === tokens[0];
  }
  // Value assertions only apply if the target's _value matches
  if (/^Value /.test(assertion)) {
    return target._value === tokens[0];
  }
  return false;
}
function roleAlias(role) {
  const a = { "menu button": "button", "image": "img" };
  return a[role] ?? role;
}

function announcementConveys(announcement, assertion) {
  const a = announcement.toLowerCase();
  const m = assertion.match(/'([^']+)'/g);
  if (!m) return null;
  const tokens = m.map((t) => t.slice(1, -1).toLowerCase());

  const synonyms = {
    "main": ["main", "main landmark", "main region"],
    "banner": ["banner", "banner landmark", "banner region"],
    "contentinfo": ["content info", "content information", "contentinfo"],
    "complementary": ["complementary", "complementary landmark", "complementary region"],
    "button": ["button"],
    "link": ["link"],
    "checkbox": ["checkbox", "check box"],
    "switch": ["switch", "toggle"],
    "slider": ["slider"],
    "spinbutton": ["spin button", "spinbutton", "stepper"],
    "combobox": ["combobox", "combo box", "popup button", "menu pop up"],
    "menu": ["menu"],
    "menuitem": ["menu item"],
    "tab": ["tab"],
    "alert": ["alert"],
    "dialog": ["dialog"],
    "textbox": ["edit", "text field"],
    "searchbox": ["search edit", "search text field"],
    "heading": ["heading"],
    "expanded": ["expanded"],
    "collapsed": ["collapsed"],
    "checked": ["checked"],
    "not checked": ["not checked"],
    "selected": ["selected"],
    "modal": ["modal"],
    "true": ["true", "checked", "expanded", "selected"],
    "false": ["false", "not checked", "collapsed", "not selected"],
    "0": ["0"],
    "20": ["20"],
  };

  return tokens.every((token) => {
    const syns = synonyms[token] ?? [token];
    return syns.some((s) => a.includes(s));
  });
}

const results = { byPattern: {}, byAT: { nvda: { match: 0, miss: 0, skip: 0 }, jaws: { match: 0, miss: 0, skip: 0 }, voiceover: { match: 0, miss: 0, skip: 0 } } };

for (const pattern of [...newFormat, ...oldFormat]) {
  const target = patternToTarget[pattern];
  if (!target) continue;
  const assertions = await getAssertionsFor(pattern);
  const patternResult = { assertions: assertions.length, byAT: {} };

  for (const at of ["nvda", "jaws", "voiceover"]) {
    const announcement = buildAnnouncement(target, at);
    let match = 0, miss = 0, skip = 0;
    const misses = [];
    for (const ass of assertions) {
      // Only check assertions actually about this target
      if (!assertionAppliesTo(ass.statement, target)) { skip++; continue; }
      const conveys = announcementConveys(announcement, ass.statement);
      if (conveys === null) { skip++; continue; }
      if (conveys) match++;
      else { miss++; misses.push(ass.statement); }
    }
    patternResult.byAT[at] = { announcement, match, miss, skip, misses };
    results.byAT[at].match += match;
    results.byAT[at].miss += miss;
    results.byAT[at].skip += skip;
  }
  results.byPattern[pattern] = patternResult;
}

console.log("\n=== ARIA-AT CALIBRATION RESULTS ===\n");
console.log("By AT (overall):");
for (const at of ["nvda", "jaws", "voiceover"]) {
  const r = results.byAT[at];
  const total = r.match + r.miss;
  const pct = total > 0 ? ((r.match / total) * 100).toFixed(1) : "n/a";
  console.log(`  ${at.padEnd(10)} ${r.match}/${total} match (${pct}%) — ${r.skip} skipped (no role/name/state token)`);
}

console.log("\nMisses by pattern:");
for (const [pat, r] of Object.entries(results.byPattern)) {
  const totalMisses = ["nvda", "jaws", "voiceover"].reduce((s, at) => s + r.byAT[at].miss, 0);
  if (totalMisses === 0) continue;
  console.log(`\n  ${pat}:`);
  for (const at of ["nvda", "jaws", "voiceover"]) {
    const ar = r.byAT[at];
    if (ar.miss === 0) continue;
    console.log(`    ${at}: "${ar.announcement}"`);
    ar.misses.forEach((m) => console.log(`      MISS: ${m}`));
  }
}

writeFileSync(join(outDir, "results.json"), JSON.stringify(results, null, 2));
console.log(`\nFull results: ${join(outDir, "results.json")}`);

// Exit non-zero if any AT has misses (so this can run in CI)
const totalMisses = ["nvda", "jaws", "voiceover"].reduce(
  (s, at) => s + results.byAT[at].miss, 0,
);
process.exit(totalMisses > 0 ? 1 : 0);
