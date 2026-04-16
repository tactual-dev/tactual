# Tactual Architecture

## Data Flow Pipeline

```
URL/Page → Playwright Capture → [Selector Exclusion] → Page States
                                                            ↓
Config/Filters → Target Filtering → Graph Builder → Navigation Graph
                                                            ↓
                                      Entry Points ← Path Analysis
                                                            ↓
Diagnostics ← Capture Analysis        Scoring Engine + Interop Data
    ↓                                         ↓
    ├──────────────── Findings ← Finding Builder ← Score Assembly
    ↓                     ↓
    └─→ Analysis Result ←─┘
             ↓
    Reporters (JSON / Markdown / Console / SARIF)
             ↓
    [Auto] SR Announcement Simulation via sr-simulator (detects demoted landmarks)
```

## Module Dependency Graph

```
index.ts (public API re-exports)
├── core/
│   ├── types.ts          ← Zod schemas: PageState, Target, Edge, Finding, Flow
│   ├── graph.ts          ← NavigationGraph: Dijkstra, dedup, reachability
│   ├── graph-builder.ts  ← Turns PageStates into NavigationGraph edges
│   ├── path-analysis.ts  ← Entry points, multi-path, structural lookups
│   ├── finding-builder.ts← Assembles score inputs, runs rules, builds Finding
│   ├── analyzer.ts       ← Orchestrator: states → graph → findings → result
│   ├── config.ts         ← tactual.json / .tactualrc.json loading and merging
│   ├── diagnostics.ts    ← Detection: bot walls, login walls, sparse content
│   ├── filter.ts         ← Target filtering (exclude, focus, suppress, priority)
│   └── url-validation.ts ← URL sanitization for CLI/MCP inputs
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
│   ├── summarize.ts      ← Summarization: stats, issue groups, score distribution
│   └── index.ts          ← formatReport dispatcher
├── playwright/
│   ├── capture.ts        ← ariaSnapshot → Target extraction
│   ├── attach.ts         ← Flow recording on Page
│   ├── explorer.ts       ← Bounded branch exploration
│   ├── probes.ts         ← Runtime keyboard probes (focus, activate, Escape, Tab)
│   ├── sr-simulator.ts   ← SR announcement simulation (detects demoted landmarks)
│   └── safety.ts         ← Safe-action policy (with --allow-action override)
├── mcp/
│   ├── index.ts          ← MCP server with 7 tools
│   ├── http.ts           ← Streamable HTTP transport (session-based)
│   ├── helpers.ts        ← extractFindings, getOverallScore utilities
│   ├── trace-helpers.ts  ← Target matching, modeled announcements
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
Rather than a monorepo with 7 packages, Tactual is one npm package with sub-path exports (`tactual`, `tactual/playwright`, `tactual/mcp`). Playwright is an optional peer dependency — users who only want the library API don't need to install it.

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

| Signal | Present | Absent |
|---|---|---|
| Heading structure | x1.55 | x0.55 |
| Heading level 1-2 | x1.08 (bonus) | -- |
| Landmark | x1.25 | x0.80 |
| Control navigation | x1.20 | x0.90 |
| Accessible name | x1.20 | x0.60 |
| Role clarity | x1.10 | x0.75 |
| Search discoverable | x1.08 | x0.95 |
| Hidden branch (well-labeled trigger) | x0.85 | -- |
| Hidden branch (labeled trigger) | x0.75 | -- |
| Hidden branch (unlabeled trigger) | x0.55 | -- |

### Reachability (0-100)

Exponential decay from 100: `100 * exp(-k * max(0, cost - 1))` where `k = 0.04 * costSensitivity` (profile-specific). The `- 1` offset gives single-step targets a perfect reachability score. Plus:

- **Efficiency bonus**: page size normalization (`efficiency * 30`, where efficiency = `1 - cost/totalTargets`)
- **Skip nav bonus**: +10 if best path uses heading/landmark navigation
- **Robustness penalty**: if median cost >> best path (ratio > 2), penalty up to -15
- **Unrelated content tax**: -1.5 per item beyond 5
- **Context switch**: -5
- **Hidden branch**: -4 (well-labeled trigger), -8 (labeled), -14 (unlabeled)

### Operability (0-100, runtime probes with role-based fallback)

When a browser is available (MCP/CLI), lightweight keyboard probes test actual behavior:
1. Click to focus the element — is it focusable?
2. Press Enter — does the state change (aria-expanded, etc.)?
3. Press Escape — does focus return to the trigger?
4. Press Tab — is focus trapped or does it move forward?

Probes run on up to 20 interactive targets (prioritizing complex roles like combobox, menu, dialog). Results map to the scoring inputs:
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
