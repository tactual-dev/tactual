# Changelog

## 0.2.0 (2026-04-06)

Streamable HTTP transport, improved tool descriptions, and GitHub Actions marketplace support.

### Transport

- MCP server now supports both **stdio** (default) and **Streamable HTTP** transports
- `tactual-mcp --http` starts an HTTP server on port 8787 (configurable with `--port=N` or `PORT` env var)
- Session-based: each client gets an isolated MCP server instance with automatic 10-minute idle cleanup
- `GET /health` endpoint for readiness probes (returns version and active session count)
- Full MCP Streamable HTTP spec: `POST /mcp` (requests), `GET /mcp` (SSE notifications), `DELETE /mcp` (session termination)
- Enables listing on Smithery.ai and other hosted MCP platforms that require HTTP transport
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
