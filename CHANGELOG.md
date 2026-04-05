# Changelog

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
