# Tactual Architecture

## Data Flow Pipeline

```
CLI / MCP / Action → pipeline/* → Playwright Capture → [Selector/Scope Filtering] → Page States
                                                            ↓
Config/Filters → Target Filtering → Graph Builder → Navigation Graph
                                                            ↓
                                      Entry Points ← Path Analysis
                                                            ↓
Diagnostics ← Capture Analysis        Scoring Engine + Interop / Evidence Data
    ↓                                         ↓
    ├──────────────── Findings ← Finding Builder ← Score Assembly
    ↓                     ↓
    └─→ Analysis Result ←─┘
             ↓
    Reporters (JSON / Markdown / Console / SARIF)
             ↓
    [Auto] SR announcement simulation, validation, probe, and visibility evidence
```

## Module Dependency Graph

```
index.ts (public API re-exports)
├── core/
│   ├── types.ts              ← Zod schemas: PageState, Target, Edge, Finding, Flow
│   ├── graph.ts              ← NavigationGraph: Dijkstra, dedup, reachability
│   ├── graph-builder.ts      ← Turns PageStates into NavigationGraph edges
│   ├── path-analysis.ts      ← Entry points, multi-path, structural lookups
│   ├── accessible-name.ts    ← Role-aware accessible-name requirements
│   ├── evidence.ts           ← Evidence typing and summaries for reporters
│   ├── glob.ts               ← Shared glob-to-regex utility
│   ├── contrast.ts           ← WCAG-style luminance/contrast helpers
│   ├── context-options.ts    ← Browser/context construction, stealth, storageState validation
│   ├── finding-builder.ts    ← Slim orchestrator: structural context + truncatePath
│   ├── finding-scoring.ts    ← assembleScoreInputs, deriveOperability, deriveRecovery, classifyActionType
│   ├── finding-penalties.ts  ← generatePenalties orchestrator for graph/state/probe penalties
│   ├── finding-state-penalties.ts
│   ├── finding-probe-penalties.ts
│   ├── finding-generic-probe-penalties.ts
│   ├── finding-dialog-probe-penalties.ts
│   ├── finding-menu-probe-penalties.ts
│   ├── finding-widget-probe-penalties.ts
│   ├── finding-form-probe-penalties.ts
│   ├── state-machine.ts      ← APG state prediction (simulateAction) for pattern-deviation detection
│   ├── analyzer.ts           ← Staged analyzer: diagnostics → graph → findings → result
│   ├── config.ts             ← tactual.json / .tactualrc.json loading and merging
│   ├── diagnostics.ts        ← Detection: bot walls, login walls, sparse content (strong vs weak signals)
│   ├── presets.ts            ← Scoring presets (ecommerce-checkout, docs-site, dashboard, form-heavy)
│   ├── result-extraction.ts  ← Shared result-shape normalization for diff/suggest tools
│   ├── trace-helpers.ts      ← Shared target matching and modeled announcement helpers
│   ├── visibility-detection.ts ← Visibility evidence summaries and penalties
│   ├── filter.ts             ← Target filtering (exclude, focus, suppress, priority)
│   └── url-validation.ts     ← URL sanitization for CLI/MCP inputs
├── pipeline/
│   ├── analyze-url.ts        ← Shared analyze-url orchestration for CLI, MCP, and Action
│   ├── validate-url.ts       ← Shared validation pipeline over captured DOM + virtual SR
│   ├── trace-path.ts         ← Shared trace path pipeline
│   ├── analyze-pages.ts      ← Multi-page analysis and repeated navigation-cost grouping
│   ├── diff-results.ts       ← Structured result diff payload
│   ├── save-auth.ts          ← Authentication flow + storageState persistence
│   ├── suggest-remediations.ts ← Ranked remediation extraction
│   ├── inline-validation.ts  ← Optional validation attachment during analyze-url
│   └── probe-helpers.ts      ← Shared probe budgets, targeting, and explore reveal hook
├── scoring/
│   ├── index.ts          ← 5-dimension scoring engine (D/R/O/Rec/IR)
│   └── interop.ts        ← a11ysupport.io risk data for ARIA roles/attributes
├── profiles/
│   ├── types.ts            ← ATProfile interface, CostModifier, CostCondition
│   ├── generic-mobile.ts   ← generic-mobile-web-sr-v0
│   ├── voiceover-ios.ts    ← voiceover-ios-v0
│   ├── talkback-android.ts ← talkback-android-v0
│   ├── nvda-desktop.ts     ← nvda-desktop-v0
│   └── jaws-desktop.ts     ← jaws-desktop-v0
├── rules/
│   └── index.ts          ← Rule interface + built-in rules
├── reporters/
│   ├── json.ts, markdown.ts, console.ts, sarif.ts
│   ├── summarize.ts      ← Summarization: stats, issue groups w/ score-uplift, compact path rendering
│   └── index.ts          ← formatReport dispatcher
├── playwright/
│   ├── capture.ts        ← ariaSnapshot → Target extraction + _rect/_inlineInText/_href enrichment
│   ├── attach.ts         ← Flow recording on Page
│   ├── explorer.ts       ← Bounded branch exploration with onStateRevealed hook
│   ├── probes.ts         ← Runtime keyboard probes (focus, activate, Escape, Tab) + prioritizeTargetsForProbing
│   ├── menu-probe.ts     ← APG menu-pattern probe (event-driven waits, sample-and-broadcast)
│   ├── modal-probe.ts    ← APG dialog-pattern probe (focus trap, shift+tab, Escape)
│   ├── modal-trigger-probe.ts ← Trigger-to-dialog probe (open, focus placement, trap, Escape, focus return)
│   ├── widget-probe.ts   ← Tab/disclosure contract probes
│   ├── composite-widget-probe.ts ← Combobox/listbox contract probes
│   ├── form-error-probe.ts ← Required-field error-flow probes
│   ├── visibility-probe.ts ← Per-icon forced-colors/contrast sampling
│   ├── sr-simulator.ts   ← SR announcement simulation (detects demoted landmarks)
│   └── safety.ts         ← Safe-action policy (with --allow-action override)
├── validation/
│   ├── index.ts          ← validateFindings: @guidepup/virtual-screen-reader driver
│   └── validator.ts      ← Linear and semantic navigation strategies
├── cli/
│   ├── index.ts          ← Slim entry: imports command modules + program.parse()
│   ├── commands/         ← One file per command; large commands delegate to action handlers
│   └── helpers/          ← CLI-only diff formatting and shared utilities
├── mcp/
│   ├── index.ts          ← Slim createMcpServer() — registers 8 tools from tools/
│   ├── tools/            ← One file per tool (analyze_url, validate_url, trace_path, analyze_pages, save_auth, diff_results, suggest_remediations, list_profiles)
│   ├── browser.ts        ← Shared browser pool (reused across calls)
│   ├── http.ts           ← Streamable HTTP transport (session-based)
│   ├── helpers.ts        ← Compatibility re-exports for core result helpers
│   ├── trace-helpers.ts  ← Compatibility re-exports for core trace helpers
│   └── cli.ts            ← tactual-mcp entry point (stdio or --http)
├── calibration/
│   ├── index.ts          ← Public API for calibration framework
│   ├── types.ts          ← CalibrationCase, CalibrationResult types
│   └── runner.ts         ← Calibration runner
└── benchmark/
    ├── types.ts           ← BenchmarkCase, assertion types
    ├── runner.ts          ← Suite executor with assertion validators
    └── suites/public-fixtures.ts ← Built-in benchmark suite
```

## Key Design Decisions

### In-memory graph

The navigation graph is a directed weighted adjacency list (core/graph.ts). Graphs are ephemeral — built per analysis run, not persisted. At the scale of a single page (10-500 targets, 50-2000 edges), in-memory Dijkstra is efficient.

### Single package, multiple entry points

Rather than a monorepo with 7 packages, Tactual is one npm package with sub-path exports (`tactual`, `tactual/playwright`, `tactual/mcp`, `tactual/validation`, `tactual/calibration`). Playwright is an optional peer dependency — users who only want the library API don't need to install it. The MCP SDK is a runtime dependency so installed packages can import `tactual/mcp` and run `tactual-mcp` directly.

### Profiles drive costs, not the graph

The NavigationGraph is profile-agnostic in structure. Profiles determine edge costs during graph building (graph-builder.ts). This means the same page produces different graphs under different profiles, which is correct — VoiceOver and TalkBack have different navigation costs.

### Scoring is vector-first, composite-second

Each target gets a 5-dimension score vector (Discoverability, Reachability, Operability, Recovery, Interop Risk). The composite "overall" score is a weighted geometric mean minus interop penalty. The geometric mean ensures a near-zero in any dimension eliminates that dimension's contribution, significantly dragging the overall down -- you cannot operate what you cannot reach. The vector is always surfaced alongside the composite to prevent gaming a single number.

### Safe-action policy is keyword-based

The explorer's safety policy (safety.ts) classifies elements by name/role patterns. This is a best-effort heuristic — it cannot detect semantic deception (a destructive button labeled "Show details"). Explorer should only be run against trusted environments.

## Scoring Formula

```
overall = exp( sum(w_i * ln(max(1, score_i))) / sum(w_i) ) - interopRisk
```

Weighted geometric mean. Each dimension is floored at 1 before the log to avoid log(0). Weights are profile-specific (see profiles/).

### Discoverability (0-100)

Multiplicative factors from a base of 40. Each structural signal is a factor > 1 (present) or < 1 (absent). Factors compound: having heading + landmark + name is worth more than the sum, and missing all three is worse than missing any one.

| Signal                               | Present       | Absent |
| ------------------------------------ | ------------- | ------ |
| Heading structure                    | x1.55         | x0.55  |
| Heading level 1-2                    | x1.08 (bonus) | --     |
| Landmark                             | x1.25         | x0.80  |
| Control navigation                   | x1.20         | x0.90  |
| Accessible name                      | x1.20         | x0.60  |
| Role clarity                         | x1.10         | x0.75  |
| Search discoverable                  | x1.08         | x0.95  |
| Hidden branch (well-labeled trigger) | x0.85         | --     |
| Hidden branch (labeled trigger)      | x0.75         | --     |
| Hidden branch (unlabeled trigger)    | x0.55         | --     |

### Reachability (0-100)

Exponential decay from 100: `100 * exp(-k * max(0, cost - 1))` where `k = 0.04 * costSensitivity` (profile-specific). The `- 1` offset gives single-step targets a perfect reachability score. Plus:

- **Efficiency bonus**: page size normalization (`efficiency * 30`, where efficiency = `1 - cost/totalTargets`)
- **Skip nav bonus**: +10 if best path uses heading/landmark navigation
- **Robustness penalty**: if median cost >> best path (ratio > 2), penalty up to -15
- **Unrelated content tax**: -1.5 per item beyond 5
- **Context switch**: -5
- **Hidden branch**: -4 (well-labeled trigger), -8 (labeled), -14 (unlabeled)

### Operability (0-100, runtime probes with role-based fallback)

When a browser is available (MCP/CLI), three probe layers test actual behavior:

**Generic probe (probes.ts)** — focuses the element via `locator.focus()` (keyboard-equivalent, not click), presses Enter, and measures:

1. Is it focusable?
2. Does the state change (aria-expanded etc.)?
3. Does Escape return focus to the trigger (overlay triggers only)?
4. Is focus trapped or does Tab advance?
5. Where did focus land after activation? (stayed / moved-inside / moved-away / moved-to-body)

**Menu probe (menu-probe.ts)** — DOM-first discovery of `aria-haspopup` triggers, then drives the four APG menu invariants: opens + focus-moves-into-menu, ArrowDown advances, Escape restores focus, outside-click closes. Uses event-driven waits (MutationObserver + rAF) so fast pages stay fast. Sample-and-broadcast collapses oversized sig-groups (e.g., 12 repeated menu triggers → probe 2, broadcast the rest).

**Modal probe (modal-probe.ts)** — DOM-first discovery of `role="dialog"` / `alertdialog`, drives the three APG dialog invariants: focus trap forward, trap backward (Shift+Tab), Escape closes.

**Modal trigger probe (modal-trigger-probe.ts)** — DOM-first discovery of `aria-haspopup="dialog"` or `aria-controls` dialog triggers, then drives the opener-to-dialog flow: activation opens a dialog, focus moves inside, Tab stays contained, Escape closes, and focus returns to the opener. Repeated same-structure triggers can be sampled from exemplars to bound runtime.

**Pipeline reorder**: when `--explore` is enabled with `--probe`, the explorer's `onStateRevealed` hook runs probes against each revealed state while the page is still live. Budget is a shared mutable object across initial + all revealed states, so `--probe-mode standard` (20 generic) caps total work at 20 regardless of state count. `scopeSelector`, `probeSelector`, `entrySelector`, `goalTarget`, `goalPattern`, and `probeStrategy` all feed the same probe runner so initial and revealed-state probes use the same targeting rules.

**Probe mode presets**: fast (5/5/3/5 generic/menu/modal/widget), standard (20/20/10/20), deep (50/40/20/40).

Results map to the scoring inputs:

- Focusable → keyboardCompatible
- State changed → stateChangesAnnounced
- Escape restored focus → focusCorrectAfterActivation

When no browser is available (library API with pre-captured states), falls back to role-based inference:

- Role correct: +30
- State changes announced: +25 (penalized for stateful roles)
- Focus correct after activation: +25 (penalized for focus-managing roles)
- Keyboard compatible: +20

### Recovery (0-100, runtime probes with structural fallback)

When probe data is available:

- Escape restores focus → canDismiss, focusReturnsLogically
- Tab not trapped → branchesPredictable
- Headings/landmarks exist → canRelocateContext

Structural fallback:

- Can dismiss: +30
- Focus returns logically: +30
- Can relocate context: +25
- Branches predictable: +15

### Severity Bands

- 90-100: Strong
- 75-89: Acceptable
- 60-74: Moderate
- 40-59: High concern
- 0-39: Severe

## Extension Points

### Adding a profile

1. Create `src/profiles/your-profile.ts` implementing `ATProfile`
2. Register it in `src/profiles/index.ts`
3. It's immediately available to CLI, MCP, and library users

### Adding a rule

1. Implement the `Rule` interface in `src/rules/index.ts`
2. Add it to the `builtinRules` array
3. It runs automatically during analysis

### Adding a reporter

1. Create `src/reporters/your-format.ts` with a format function
2. Add the format to `ReportFormat` type and `formatReport` switch in index.ts
3. Add `--format your-format` to CLI

## Security Model

- **URL validation**: All URLs are validated before navigation (url-validation.ts). Blocks javascript:, data:, vbscript:, blob: protocols and embedded credentials.
- **Safe-action policy**: Explorer won't click elements matching destructive patterns (delete, submit, purchase, etc.). See safety.ts for known limitations.
- **No data exfiltration**: Tactual reads the accessibility tree but never sends data to external services. All processing is local.
- **Playwright sandboxing**: Analysis runs in Playwright's Chromium which has its own sandbox. No raw filesystem access from analyzed pages.
