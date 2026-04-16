# Changelog

## 0.3.0 (2026-04-16)

New diagnostics, scoring presets, SR simulator, performance improvements, security hardening, and documentation overhaul.

### Features

- **Scoring presets** — `--preset ecommerce-checkout`, `docs-site`, `dashboard`, `form-heavy`. Named config bundles with focus filters and priority mappings for common use cases. Layers under config files and CLI flags.
- **Heading hierarchy skip** — `heading-skip` diagnostic flags `h1 → h3` (or any +2 level jump) that breaks SR users' mental model
- **Skip link detection** — `no-skip-link` diagnostic warns when pages with 5+ targets lack a skip-to-content link.
- **Landmark completeness** — `no-main-landmark`, `no-banner-landmark`, `no-contentinfo-landmark`, `no-nav-landmark` diagnostics fire when pages have some landmarks but are missing key ones.
- **Structural summary** — `structural-summary` info diagnostic gives a one-line snapshot of page structure for machine consumption.
- **Shared-cause deduplication** — penalties affecting >50% of findings are promoted to page-level diagnostics (`shared-structural-issue`) instead of repeating on every target.
- **SR announcement simulator** — heuristic prediction of what NVDA, JAWS, and VoiceOver each announce for all target kinds (landmarks, headings, controls, form fields, dialogs, status messages, menus, tabs). State-aware: emits "Subscribe, check box, checked", "Country, combo box, collapsed", "Actions, menu button, collapsed", "Mute, button, not pressed", "Condiments, check box, partially checked", "Volume, slider, 75", "Email, edit, invalid entry, required, you must use a work address" (with `aria-describedby` resolved), etc. Encodes documented cross-AT differences. **Calibrated against [W3C ARIA-AT](https://aria-at.w3.org)**: passes 77/77 assertions at 100% across all three ATs (NVDA, JAWS, VoiceOver) for 36 single-target patterns and 4 multi-target landmark scenarios (entering/traversing landmarks). Patterns covered: command-button, toggle-button, all menu-button variants, disclosure-faq, disclosure-navigation, accordion, checkbox, checkbox-tri-state, switch (3 variants), 4 slider variants, modal-dialog, alert, breadcrumb, all link variants, both tabs variants, both combobox variants, both radiogroup variants, rating-radio-group, menubar-editor, quantity-spin-button, all four landmark types, form. Run `npm run calibrate` to verify. Exported from `tactual/playwright`.
- **Cross-AT divergence as a penalty** — automatically flags targets where NVDA/JAWS/VoiceOver produce materially different announcements (e.g., combobox with aria-expanded that VoiceOver renders differently).
- **Navigation transcript** — new `tactual transcript <url> [--at nvda|jaws|voiceover]` command prints the linear sequence of announcements an SR user hears as they Tab through a page. Text and JSON output formats. Library API also exposes `buildNavigationTranscript(targets, options)` for multi-target navigation modes (linear, by-heading, by-landmark, by-form-control) with `from`/`to` ranges — models the ARIA-AT "navigate from X into landmark Y" scenarios.
- **ARIA reference enrichment** — capture pipeline now resolves `aria-describedby` IDs to their text content (appended to announcements) and validates `aria-labelledby` IDs (silently-broken labels surface as penalties).
- **Heading hierarchy skip diagnostic** — new `heading-skip` warning detects `h1 → h3` jumps that break SR users' mental model of structure.
- **Live-region detection** — captures `aria-live` value on every target. Excessive `aria-live="assertive"` (which interrupts the user) on non-status content surfaces as a penalty suggesting `polite`.
- **State-aware penalties** — finding-builder now reads captured ARIA state and emits penalties for: label-state mismatch (e.g., button labeled "Collapse" with `aria-expanded="true"` produces confusing announcements), disabled-but-discoverable controls, tab missing `aria-selected`, combobox/listbox/menu missing `aria-expanded`, orphaned `aria-labelledby`/`aria-describedby` references, and assertive live-region misuse.
- **`--allow-action`** — override the safe-action policy for specific controls during exploration (glob patterns).
- **`--probe-budget`** — configurable max targets to probe (default: 20).
- **Nested focusable detection** (`--probe`) — flags elements with focusable descendants causing duplicate tab stops.
- **Focus indicator suppression** (`--probe`) — detects when CSS suppresses the focus outline without a visible alternative.
- **Skipped elements reporting** — exploration now lists which elements were skipped by the safety policy.
- **`--also-json`** — write JSON output alongside the primary format from a single analysis run. Eliminates double Playwright capture in CI workflows.
- **PR comment action** — `comment-on-pr: "true"` input posts a summary comment on pull requests. Supports multiple URLs/profiles per PR via hidden markers. Updates existing comment on re-run. Comment template is in `scripts/pr-comment.js` (testable, editable).

### Performance

- **Dijkstra with binary min-heap** — `shortestPath` and `reachableWithin` go from O(V²) to O((V+E) log V).
- **Focus filter** — O(n²) loop replaced with Map lookup.
- **Single-pass diagnostics** — `diagnoseCapture` results cached via `states.map()` instead of called twice.
- **Deduplicated globToRegex** — `filter.ts` imports from `trace-helpers.ts` instead of maintaining a separate copy.
- **Action double-run mitigation** — second analysis pass (for score extraction) uses `--summary-only`.

### Bug Fixes

- Slider/spinbutton value suffix parsing in ariaSnapshot capture
- Convergence polling `prevCount` initialized to -1 (was 0, causing false convergence on empty pages)
- P10 score calculation off-by-one
- `escapeRestoresFocus` probe logic inverted
- Activatable semantics: only `stateChanged` probes count, not all probes
- Login-wall false positive from partial path match (`/oauth` matching `/login`)
- Console reporter TTY detection
- Browser/page leak in CLI save-auth and MCP tools
- `checkThreshold` on empty findings
- SARIF sort using `scores.overall` consistently
- `modelAnnouncement` for searchbox/contentinfo roles
- Unicode first-letter support in graph builder
- `stateCount: 0` on graph failure (now uses actual state count)
- Markdown reporter missing selector field
- SR simulator targetId collision for multiple demoted landmarks of the same role

### Security

- MCP HTTP body size limit (1MB) and request timeout (30s)
- Browser pool cleanup on HTTP server shutdown
- Path traversal protection in MCP storage state
- Wait step capped at 60s in `save_auth`
- Storage state file permissions (0o600)
- `save_auth` rejects unknown step types
- Submit buttons moved to "unsafe" tier in safety policy
- Snapshot parsing hard cap at 5,000 targets (DoS prevention for hosted MCP)

### Scoring Drift

Score outputs may differ from v0.2.x on unchanged pages due to bug fixes in probe logic (`escapeRestoresFocus` inversion), activatable semantics, and P10 calculation. Regenerate baselines after upgrading.

### Rules

- Removed `hiddenBranchRule`, `missingAccessibleNameRule`, `excessiveControlSequenceRule` — these overlapped with graph-derived penalties in finding-builder.ts, causing duplicate output. 1 built-in rule remains (`noHeadingAnchorRule`).

### Documentation

- `docs/MCP-TOOLS.md` — full reference for all 7 MCP tools with parameter tables, return shapes, and workflow examples
- `docs/AGENT-RECIPES.md` — prompt templates for Claude Code, Cursor, Windsurf, Cline, GitHub Copilot. Includes CLAUDE.md snippet.
- `docs/CALIBRATION.md` — added working end-to-end example with 2-observation dataset
- `CONTRIBUTING.md` — link to profile types for new profile authors
- README: scoring presets section, regression tracking section, expanded diagnostics table, "who is this for" framing, shortened MCP tools table with link to full reference
- Scoring documentation clarified: floor-at-1 behavior in geometric mean described accurately

## 0.2.1 (2026-04-06)

Registry readiness, packaging fixes, and SARIF improvements.

### Registry & Packaging

- Add `mcpName` and `server.json` for official MCP Registry publishing
- Add Dockerfile and `smithery.yaml` for container-based deployment
- Add project logo (`assets/logo.png`)

### Transport

- HTTP server `--host` flag and `HOST` env var (default: 127.0.0.1, Dockerfile sets 0.0.0.0)
- Validate `--port` and `--host` values — reject invalid input instead of silently misbehaving

### Analysis

- SARIF output now includes Playwright locator `selector` in finding properties

### Dependencies

- Bump zod 3.24 → 4.3.6 (Zod 4 migration: `z.record()` takes explicit key schema)
- Bump commander ^13 → ^14 (Node 20+ only, same as our engine requirement)
- Bump eslint ^9 → ^10 (flat config `name` property, `@eslint/js` now separate)
- Bump vitest ^3 → ^4
- Bump playwright ^1.50 → ^1.59, prettier ^3.4 → ^3.8, tsup ^8.4 → ^8.5, @types/node ^22 → ^25

### Docs

- Document `--probe`, `--wait-for-selector`, `--wait-time`, `--storage-state`, `--summary-only` CLI flags
- Document `--host` flag for HTTP transport
- Document `includeStates`, `statesJson`, `storageState` params in MCP tools table
- Add logo to README
- Update SECURITY.md: supported versions (0.2.x), HTTP transport threat model
- Update ARCHITECTURE.md: complete module graph (was missing ~40% of source files)
- Add `.gitattributes` for consistent line endings across contributors
- Expand npm keywords (`mcp-server`, `model-context-protocol`, `assistive-technology`, `sarif`)

## 0.2.0 (2026-04-06)

Streamable HTTP transport, improved tool descriptions, and GitHub Actions marketplace support.

### Transport

- MCP server now supports both **stdio** (default) and **Streamable HTTP** transports
- `tactual-mcp --http` starts an HTTP server on port 8787 (configurable with `--port=N` or `PORT`, `--host=ADDR` or `HOST`)
- Session-based: each client gets an isolated MCP server instance with automatic 10-minute idle cleanup
- `GET /health` endpoint for readiness probes (returns version and active session count)
- Full MCP Streamable HTTP spec: `POST /mcp` (requests), `GET /mcp` (SSE notifications), `DELETE /mcp` (session termination)
- Enables listing on Smithery.ai and other hosted MCP platforms that require HTTP transport
- Dockerfile and `smithery.yaml` for container-based deployment (Smithery, self-hosted)
- Stdio transport unchanged — `npx tactual-mcp` still works exactly as before

### MCP Tool Descriptions

- All tool descriptions now explicitly disclose read-only/side-effect behavior
- `list_profiles`: expanded from one-liner to full description with return format, relationship to sibling tools, and usage guidance (B → A on Glama quality scoring)
- `diff_results`: added return format, input requirements, when-not-to-use guidance
- `suggest_remediations`: added return format and explicit input format requirement
- `save_auth`: added file overwrite disclosure, side-effect documentation, when-not-to-use note
- `analyze_pages`: added error handling behavior (partial failure continues remaining URLs)
- `analyze_url`, `trace_path`: added explicit read-only disclosure

### GitHub Actions

- Composite action (`action.yml`) for GitHub Actions Marketplace
- Inputs: `url`, `profile`, `explore`, `format`, `fail-below`, `node-version`
- Outputs: `average-score`, `result-file`
- Auto-uploads SARIF to GitHub Code Scanning
- Score threshold gating for CI pass/fail

## 0.1.2 (2026-04-05)

Full CLI/MCP parity, performance improvements, and output polish.

### CLI Parity

All 7 MCP tools are now available as CLI commands:
- `trace-path <url> <target>`: step-by-step SR navigation trace with colored output
- `save-auth <url>`: authenticate and save session state (`--click`, `--fill`, `--wait-for-url`)
- `analyze-pages <urls...>`: multi-page site analysis with aggregated stats
- `suggest-remediations <file>`: extract ranked fixes from analysis JSON

New `analyze-url` flags matching MCP parameters:
- `--wait-for-selector`: CSS selector to wait for (essential for SPAs)
- `--wait-time`: additional milliseconds to wait after page load
- `--storage-state`: Playwright storageState JSON for authenticated pages
- `--summary-only`: compact ~500 byte output for health checks
- `--probe`: opt-in keyboard probes for deep investigation

### Performance

- Keyboard probes now opt-in via `--probe` flag (CLI) and `probe` parameter (MCP). Default analysis runs in 5-15s instead of 2+ minutes.
- Shared browser pool across MCP tool calls eliminates ~2s launch overhead per call
- Network idle replaced with 2s fixed wait + convergence-based polling

### CLI Output

- ANSI colors: red for severe/high, yellow for moderate, green for passing
- Score bars: visual representation at a glance
- Only actionable findings shown (severe/high/moderate) — acceptable/strong filtered from console
- Animated progress indicator with elapsed time
- Issue groups with cleaner descriptions (no redundant counts)
- `actionType` shown inline on findings
- Respects `NO_COLOR` environment variable

### Documentation

- Per-tool MCP setup instructions for Claude Code, GitHub Copilot, Cursor, Windsurf, Cline
- MCP SDK install requirement documented alongside Playwright
- Branch references corrected from `master` to `main` in workflows and README

## 0.1.0 (2026-04-05)

Initial release.

### Core

- Navigation graph analysis: weighted directed graph from Playwright accessibility snapshots, Dijkstra shortest paths, navigation cost per target
- 5-dimension scoring: Discoverability, Reachability, Operability, Recovery, Interop Risk
- Weighted geometric mean composite: near-zero in any dimension drags overall down
- Multiplicative discoverability model with quality-aware branch penalties
- Exponential decay reachability with profile-specific cost sensitivity
- Runtime keyboard probes: focus, activation, Escape recovery, Tab trapping (opt-in)
- First-letter type-ahead navigation modeling for desktop AT profiles in menus
- 5 AT profiles: generic-mobile, VoiceOver iOS, TalkBack Android, NVDA, JAWS — each with distinct weights and cost sensitivity

### MCP Server (7 tools)

- `analyze_url`: page analysis with SARIF/JSON/markdown/console output, severity filtering, exploration, device emulation, SPA support, keyboard probes, element scoping
- `trace_path`: step-by-step navigation trace with modeled SR announcements
- `list_profiles`: available AT profiles
- `diff_results`: semantic comparison with penalties resolved/added and severity changes
- `suggest_remediations`: ranked fix suggestions by impact
- `save_auth`: authenticate and save session state for analyzing auth-gated pages
- `analyze_pages`: multi-page site-level analysis with aggregated P10/median/severity stats

### CLI

- `analyze-url`: all 4 output formats, exploration, device emulation, severity/count filtering, threshold gating for CI
- `trace-path`: step-by-step SR navigation trace
- `save-auth`: authenticate and save session state
- `analyze-pages`: multi-page site analysis
- `suggest-remediations`: extract ranked fixes from analysis JSON
- `diff`: compare two analysis results
- `profiles`: list available AT profiles
- `benchmark`: run benchmark suites against HTML fixtures
- `init`: create tactual.json config file

### Output

- SARIF 2.1.0 for GitHub Code Scanning and CI integration
- Summarized JSON/markdown/console with issue grouping, truncation notes, P10/median/average stats
- Score distribution histogram across 0-100 range
- `summaryOnly` mode: ~500 bytes per page for health checks
- `actionType` classification: code-fix, pattern-review, structural
- Playwright locator selectors in every finding
- Findings deduplicated across explored states

### Analysis Features

- Bounded exploration: menus, tabs, dialogs, disclosures with depth/action/novelty budgets
- Safe-action policy blocks destructive interactions during exploration
- SPA framework detection: React, Next.js, Vue, Nuxt, Angular, Svelte, SvelteKit
- Convergence-based content readiness (no reliance on network idle)
- Login wall detection: path-based redirect and content-based signals
- Diagnostics: bot protection, empty pages, degraded content, missing headings/landmarks
- Interop risk data: version-stamped a11ysupport.io snapshot for 30+ ARIA roles
- ARIA APG conformance reduces interop risk (aria-selected tabs, aria-autocomplete comboboxes)
- Skip-link and jump-link exemption from heading/landmark penalties
- Landmark/heading self-exemption from navigation structure penalties

### Infrastructure

- Shared browser pool across MCP tool calls (eliminates launch overhead)
- `storageState` parameter on all analysis tools for authenticated pages
- Calibration framework for tuning scoring weights against ground-truth data
- Benchmark suite with HTML fixtures and typed assertions
- GitHub Actions CI on Node 20/22
- Reusable accessibility analysis workflow for other repositories

### Documentation

- README: CLI, library API, MCP server, scoring model, diagnostics, output recommendations
- ARCHITECTURE: module graph, data flow, scoring formula, extension points
- CONTRIBUTING: guides for adding profiles, rules, reporters
- CALIBRATION: ground-truth data collection and weight tuning methodology
- SECURITY: threat model, safe-action policy, URL validation, reporting process
