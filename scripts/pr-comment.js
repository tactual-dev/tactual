#!/usr/bin/env node
/**
 * Generate a Tactual PR comment body from analysis JSON.
 *
 * Usage: node pr-comment.js <json-file> <avg-score> <url> <profile>
 * Outputs the markdown comment body to stdout.
 */

import { readFileSync } from "fs";

const [jsonFile, avgScore, url, profile] = process.argv.slice(2);

if (!jsonFile || !avgScore) {
  console.error("Usage: node pr-comment.js <json-file> <avg-score> <url> <profile>");
  process.exit(1);
}

const r = JSON.parse(readFileSync(jsonFile, "utf8"));
const s = r.stats || r.metadata || {};
const sc = r.severityCounts || {};
const findings = r.findings || [];

const severe = sc.severe || findings.filter((f) => f.severity === "severe").length;
const high = sc.high || findings.filter((f) => f.severity === "high").length;
const moderate = sc.moderate || findings.filter((f) => f.severity === "moderate").length;
const targets = s.targetCount || 0;
const avg = Number(avgScore);

let icon = "\u{1F7E2}"; // green circle
if (severe > 0) icon = "\u{1F534}"; // red
else if (high > 0) icon = "\u{1F7E0}"; // orange
else if (moderate > 0) icon = "\u{1F7E1}"; // yellow

const safeUrl = String(url || "").replace(/[<>]/g, "");
const safeProfile = String(profile || "generic-mobile-web-sr-v0").replace(/[<>]/g, "");

const lines = [];
lines.push(`<!-- tactual-pr-comment:${safeUrl}:${safeProfile} -->`);
lines.push(`## ${icon} Tactual: Screen-Reader Navigation Cost`);
lines.push("");
lines.push("| Metric | Value |");
lines.push("|---|---|");
lines.push(`| Average Score | **${avg}** / 100 |`);
lines.push(`| Targets | ${targets} |`);
lines.push(`| Profile | \`${safeProfile}\` |`);

if (severe + high + moderate > 0) {
  lines.push("");
  lines.push(`**Findings:** ${severe} severe, ${high} high, ${moderate} moderate`);
}

const worst = findings.slice(0, 3);
if (worst.length > 0) {
  lines.push("");
  lines.push("**Worst targets:**");
  for (const f of worst) {
    lines.push(`- \`${f.targetId}\` \u2014 ${f.scores.overall}/100 [${f.severity}]`);
  }
}

lines.push("");
lines.push("<sub>Posted by [Tactual](https://github.com/tactual-dev/tactual)</sub>");

console.log(lines.join("\n"));
