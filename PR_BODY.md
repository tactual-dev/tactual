# v0.3.0 — Screen-reader simulator, ARIA-AT calibration, and a lot of new diagnostics

Substantial release: 42 commits since the `v0.2.1` tag, 72 files changed (+5261 / -708). The headline shift is from "scores AT navigation cost" to "predicts what AT users actually hear and verifies pattern implementations against the ARIA APG spec." `npm run calibrate` now passes 77/77 ARIA-AT assertions across NVDA, JAWS, and VoiceOver.

## Summary

- **SR announcement simulator** — predicts what NVDA, JAWS, and VoiceOver each announce for every target on a page. State-aware. Calibrated against W3C ARIA-AT with 100% pass rate on tested patterns.
- **8 new diagnostic codes** — skip link, landmark completeness (4 codes), structural summary, shared-cause dedup, heading-hierarchy skip, landmark demotion.
- **Scoring presets** — named bundles for ecommerce-checkout, docs-site, dashboard, form-heavy.
- **GitHub Action PR comments** — opt-in summary on every pull request.
- **`tactual transcript` command** — prints the linear sequence an SR user hears Tabbing through a page.
- **Stateful interaction simulation** — pattern-deviation detection: probe-observed state changes vs ARIA APG spec.
- **Significant performance work** — Dijkstra with binary min-heap, focus filter optimization, single-pass diagnostics.
- **Hardening** across MCP HTTP transport, save_auth, snapshot parsing.
- **One breaking change** in the internal probe API (`activatable` removed; was a duplicate of `stateChanged`). Public API surface preserved.

## What's new for users

### Screen-reader announcement simulator

Predicts what each AT actually says for every interactive target, with state info:

```
"Subscribe, check box, checked"
"Country, combo box, collapsed"
"Actions, menu button, collapsed"
"Mute, button, not pressed"
"Volume, slider, 75"
"Email, edit, invalid entry, required, you must use a work address"
```

Cross-AT differences encoded where documented (NVDA "edit" vs VoiceOver "text field"; VoiceOver "popup button" for `<select>`-style comboboxes). Calibrated against [W3C ARIA-AT](https://aria-at.w3.org): **77/77 assertions pass at 100% across NVDA, JAWS, VoiceOver** for 36 single-target patterns plus 4 multi-target landmark traversal scenarios. Run `npm run calibrate` to re-verify against upstream assertions.

Also detects landmark demotion — `<header>` inside `<section>` loses its implicit banner role per HTML-AAM. Surfaces as a `landmark-demoted` diagnostic.

Library API:

```typescript
import {
  simulateScreenReader, buildAnnouncement,
  buildMultiATAnnouncement, buildTranscript, buildNavigationTranscript,
  simulateAction, simulateSequence,
} from "tactual/playwright";

buildAnnouncement(target, "voiceover");  // → "Country, popup button"
buildMultiATAnnouncement(target);         // → { nvda, jaws, voiceover }
buildNavigationTranscript(targets, { mode: "by-heading" });
simulateAction(target, "Space");          // → predicted post-state
```

### `tactual transcript` command

```bash
npx tactual transcript https://example.com --at voiceover
```

Prints what an SR user hears as they Tab through the page. Text and JSON output. Verified end-to-end against real sites (Swagger UI, AFFiNE).

### Pattern-deviation detection (`--probe`)

When probes are enabled, finding-builder compares actual observed state changes to the ARIA APG spec. Catches broken implementations:

> "Pattern deviation: pressing Enter on a toggle button should toggle aria-pressed from 'false' to 'true' per the ARIA APG toggle-button pattern, but probe observed aria-pressed='false'."

This is novel — axe-core checks rule conformance (does the role exist?), not implementation correctness (does it behave as spec'd?).

### New diagnostics

| Code | Level | What it catches |
|---|---|---|
| `no-skip-link` | warning | Pages with 5+ targets lacking a skip-to-content link |
| `no-main-landmark` | warning | Missing `<main>` |
| `no-banner-landmark` | info | Missing `<header>` |
| `no-contentinfo-landmark` | info | Missing `<footer>` |
| `no-nav-landmark` | info | Missing `<nav>` |
| `heading-skip` | warning | `h1 → h3` jumps that break SR mental model |
| `structural-summary` | info | One-line snapshot of page structure |
| `shared-structural-issue` | warning | Penalties affecting >50% of findings promoted to page level |
| `landmark-demoted` | warning | HTML landmark exists but stripped by nesting context |

### Scoring presets

```bash
npx tactual analyze-url https://shop.com --preset ecommerce-checkout
npx tactual presets   # list all presets
```

Four presets: `ecommerce-checkout`, `docs-site`, `dashboard`, `form-heavy`. Each bundles focus filters and priority mappings. Layers under config files and CLI flags.

### State-aware penalties

The finding builder now reads captured ARIA attribute values and emits high-signal penalties:

- **Label-state mismatch** — button labeled "Collapse" with `aria-expanded="true"` produces "Collapse, expanded" which reads as a contradiction. Suggests state-neutral labels.
- **Disabled-but-discoverable** — form fields with `aria-disabled` still in the AT tree. Users navigate to them, hear "unavailable", can't interact.
- **Tab missing aria-selected** — NVDA can't announce which tab is current.
- **Combobox/listbox/menu missing aria-expanded** — open/closed state not announced.
- **Orphaned `aria-labelledby`/`aria-describedby`** — referenced ID doesn't exist; label silently dropped.
- **Assertive live-region misuse** — `aria-live="assertive"` interrupts users; suggests `polite` for routine updates.
- **Cross-AT divergence** — flags targets where NVDA/JAWS/VoiceOver materially differ.

### Probe-based detection (`--probe`)

- **Nested focusable** — duplicate tab stops from focusable descendants
- **Focus indicator suppressed** — CSS removes outline without a visible alternative
- **Pattern deviation** — implementation diverges from APG spec (see above)

### CLI flags added

- `--also-json <path>` — write JSON sidecar from the same Playwright run (eliminates double captures in CI)
- `--allow-action <pattern>` — opt specific controls into exploration despite the safety policy
- `--probe-budget <n>` — bound the number of probed targets (default 20)
- `--preset <name>` — apply a scoring preset

### MCP server additions

- `probeBudget` parameter on `analyze_url` (parity with CLI)
- New `landmark-demoted` diagnostic (was previously bucketed under `timeout-during-render`, fixed in this release)

### GitHub Action

- New `comment-on-pr: "true"` input — posts a summary comment on every pull request, updates on re-run, supports multiple URLs/profiles per PR via hidden markers
- Single Playwright capture (`--also-json` internally) instead of double-running
- PR comment template extracted to `scripts/pr-comment.js` (testable)

## Performance

- **Dijkstra with binary min-heap** in `shortestPath` and `reachableWithin` — O(V²) → O((V+E) log V)
- **Focus filter** — O(n²) → O(n) via Map lookup
- **Single-pass diagnostics** — `diagnoseCapture` was running twice per state
- **Deduplicated `globToRegex`** — was implemented twice with slightly different behavior
- **Reusable workflow + composite action** — eliminated double Playwright capture for non-JSON formats

## Bug fixes

- Slider/spinbutton trailing value parsing in ariaSnapshot
- Convergence polling `prevCount` initialized to `-1` (was `0`, causing false convergence on empty pages)
- P10 score calculation off-by-one
- `escapeRestoresFocus` probe logic was inverted
- Activatable semantics: only `stateChanged` probes counted (not all probes)
- Login-wall false positive from partial path match (`/oauth` matching `/login`)
- Console reporter TTY detection
- Browser/page leak in CLI `save-auth` and MCP tools
- HTTP transport: browser pool not closed on server shutdown
- `checkThreshold` on empty findings
- SARIF sorting now uses `scores.overall` consistently
- `modelAnnouncement` for `searchbox` and `contentinfo`
- Unicode first-letter support in graph builder
- `stateCount: 0` reported when graph build failed (now uses actual state count)
- Markdown reporter was missing the `selector` field
- `tactual diff` crashed on JSON reporter output (`worstFindings` vs `findings` shape mismatch)
- Focus-filter "no effect" warning false-positives when focus pattern matched a landmark containing all targets
- PR comment marker collision risk on URLs containing `:` (now uses `|` separator)
- MCP labeled demoted-landmark warnings as `timeout-during-render` (now `landmark-demoted`)
- `detectPatternDeviation` early-returned on first deviation (now reports all)

## Security

- MCP HTTP transport: 1MB request body limit, 30s timeout, browser pool cleanup on shutdown
- Path traversal protection in MCP storage state
- `save_auth` wait step capped at 60s, rejects unknown step types, output mode `0o600`
- Snapshot parsing hard cap at 5,000 targets (DoS prevention for hosted MCP)
- SSRF risk documented in SECURITY.md
- Submit buttons moved to "unsafe" tier in safety policy
- Supported versions table updated (0.3.x current, 0.2.x and earlier unsupported)

## Documentation

- `docs/MCP-TOOLS.md` — full reference for all 7 MCP tools, parameters, return shapes, workflow examples
- `docs/AGENT-RECIPES.md` — prompt templates for Claude Code, Cursor, Windsurf, Cline, GitHub Copilot, plus a CLAUDE.md snippet
- `docs/CALIBRATION.md` — added a working calibration dataset example
- `CONTRIBUTING.md` — link to profile types for new profile authors
- README — scoring presets section, regression tracking section, simulator API examples, mobile profile limitation note, exploration sizing-guidance table, ARIA-AT attribution
- ARCHITECTURE.md — formula clarifications and current module list
- "Scoring Drift" note in CHANGELOG — v0.2.x baselines won't match unchanged-page scores after upgrading

## Internal cleanup

- Removed dead exported rules (`hiddenBranchRule`, `missingAccessibleNameRule`, `excessiveControlSequenceRule`) — overlapped with graph-derived penalties in `finding-builder.ts`. 1 built-in rule remains (`noHeadingAnchorRule`).
- Removed unused `_page` parameter from probes
- `reachabilityCorrrelation` typo fixed in `calibration/types.ts`

## Breaking changes

**Internal API only — public exports preserved:**

- Removed `activatable` field from `ProbeResults` (was a literal duplicate of `stateChanged`; never read distinctly anywhere)

`ProbeResults` and `probeTargets` are not exported from `tactual` or `tactual/playwright`. Library consumers who imported them via deep paths would need to adjust; otherwise zero impact.

## Test plan

- [x] `npm run typecheck` — clean
- [x] `npm run test -- --run` — 486 tests passing across 36 files
- [x] `npm run lint` — clean
- [x] `npm run build` — dist artifacts generated cleanly
- [x] `npm run calibrate` — 77/77 ARIA-AT assertions pass across NVDA, JAWS, VoiceOver
- [x] End-to-end stress tested against AFFiNE and Swagger UI Petstore — all features (probes, exploration, presets, transcript, diff, multi-AT) verified
- [x] Action workflow tested locally with PR comment formatting
