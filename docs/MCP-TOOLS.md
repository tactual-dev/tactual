# MCP Tools Reference

Tactual's MCP server exposes 8 tools for AI-assisted accessibility analysis. Start the server with `npx tactual-mcp` (stdio) or `npx tactual-mcp --http` (HTTP).

## analyze_url

Analyze a web page for screen-reader navigation cost. Returns scored findings showing how hard it is for AT users to discover, reach, and operate interactive targets.

| Parameter           | Type     | Required | Default                    | Description                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ------------------- | -------- | -------- | -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `url`               | string   | yes      |                            | URL to analyze                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `profile`           | string   | no       | `generic-mobile-web-sr-v0` | AT profile ID                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `device`            | string   | no       |                            | Playwright device name (e.g., `iPhone 14`)                                                                                                                                                                                                                                                                                                                                                                                                     |
| `explore`           | boolean  | no       | `false`                    | Explore hidden branches (menus, tabs, disclosures, dialogs)                                                                                                                                                                                                                                                                                                                                                                                    |
| `exploreDepth`      | number   | no       | `2`                        | Max exploration depth (levels of nested branches). Higher = more thorough, slower. CLI default is 3.                                                                                                                                                                                                                                                                                                                                           |
| `exploreBudget`     | number   | no       | `30`                       | Max total actions during exploration. CLI default is 50; MCP default is 30 for tighter agent-loop latency.                                                                                                                                                                                                                                                                                                                                     |
| `exploreTimeout`    | number   | no       | `60000`                    | Total exploration timeout in ms, including initial probes, branch captures, and revealed-state probes when probing is enabled.                                                                                                                                                                                                                                                                                                                  |
| `exploreMaxTargets` | number   | no       | `2000`                     | Max accumulated targets before exploration stops early (safety cap for giant pages).                                                                                                                                                                                                                                                                                                                                                           |
| `allowAction`       | string[] | no       |                            | Glob patterns for controls to explore despite safety policy                                                                                                                                                                                                                                                                                                                                                                                    |
| `format`            | enum     | no       | `sarif`                    | `json`, `markdown`, `console`, or `sarif`                                                                                                                                                                                                                                                                                                                                                                                                      |
| `minSeverity`       | enum     | no       |                            | Only include findings at this severity or worse                                                                                                                                                                                                                                                                                                                                                                                                |
| `waitForSelector`   | string   | no       |                            | CSS selector to wait for before capturing (for SPAs)                                                                                                                                                                                                                                                                                                                                                                                           |
| `waitTime`          | number   | no       | `0`                        | Additional ms to wait after page load                                                                                                                                                                                                                                                                                                                                                                                                          |
| `timeout`           | number   | no       | `30000`                    | Page load timeout in ms                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `focus`             | string[] | no       |                            | Only analyze within these landmarks                                                                                                                                                                                                                                                                                                                                                                                                            |
| `excludeSelector`   | string[] | no       |                            | CSS selectors to hide from analysis                                                                                                                                                                                                                                                                                                                                                                                                            |
| `scopeSelector`     | string[] | no       |                            | CSS selectors that define subtree(s) to capture, score, and probe                                                                                                                                                                                                                                                                                                                                                                              |
| `exclude`           | string[] | no       |                            | Glob patterns to exclude targets by name/role                                                                                                                                                                                                                                                                                                                                                                                                  |
| `maxFindings`       | number   | no       | 15/25                      | Max detailed findings (15 for JSON/markdown, 25 for SARIF)                                                                                                                                                                                                                                                                                                                                                                                     |
| `probe`             | boolean  | no       | `false`                    | Opt-in runtime keyboard probes for interactive targets (focus, activation, Escape recovery, Tab trapping). Also runs menu, dialog, trigger-to-dialog, tab, disclosure, combobox/listbox, and form-error probes. When combined with `explore=true`, probes targets revealed in new states (menu items, dialog bodies, expanded widgets). **Note:** links are not generically probed — clicking would navigate away.                             |
| `probeBudget`       | number   | no       |                            | Override generic-probe budget. Defaults to the value implied by `probeMode`.                                                                                                                                                                                                                                                                                                                                                                   |
| `probeMode`         | enum     | no       | `standard`                 | `fast` (5/5/3/5), `standard` (20/20/10/20), or `deep` (50/40/20/40). Per-layer budgets for generic/menu/modal/widget probes. Budget is shared across initial + all revealed states.                                                                                                                                                                                                                                                            |
| `probeSelector`     | string[] | no       |                            | CSS selectors that narrow probing without changing capture/scoring                                                                                                                                                                                                                                                                                                                                                                             |
| `entrySelector`     | string   | no       |                            | CSS selector for a trigger to activate before capture/probe; newly revealed targets are prioritized                                                                                                                                                                                                                                                                                                                                            |
| `goalTarget`        | string   | no       |                            | Exact-ish target id, name, role, kind, or selector hint for goal-directed probing                                                                                                                                                                                                                                                                                                                                                              |
| `goalPattern`       | string   | no       |                            | Glob pattern matched against target id/name/role/kind/selector for goal-directed probing                                                                                                                                                                                                                                                                                                                                                       |
| `probeStrategy`     | enum     | no       | `all`                      | `all`, `overlay`, `composite-widget`, `form`, `navigation`, `modal-return-focus`, or `menu-pattern`                                                                                                                                                                                                                                                                                                                                            |
| `channel`           | string   | no       |                            | Browser channel: `chrome`, `chrome-beta`, `msedge`. Uses the installed browser instead of bundled Chromium — bypasses most bot-detection heuristics. Setting this bypasses the shared browser pool (each call launches fresh), so use only when needed.                                                                                                                                                                                        |
| `stealth`           | boolean  | no       | `false`                    | Apply anti-bot-detection defaults (realistic UA, override `navigator.webdriver`, spoof plugins/languages). Pair with `channel` for best coverage on Cloudflare-protected sites.                                                                                                                                                                                                                                                                |
| `summaryOnly`       | boolean  | no       | `false`                    | Return only summary stats, no individual findings                                                                                                                                                                                                                                                                                                                                                                                              |
| `includeStates`     | boolean  | no       | `false`                    | Include captured states for passing to `trace_path`                                                                                                                                                                                                                                                                                                                                                                                            |
| `storageState`      | string   | no       |                            | Path to Playwright storageState JSON (from `save_auth`)                                                                                                                                                                                                                                                                                                                                                                                        |
| `checkVisibility`   | boolean  | no       |                            | Run per-icon contrast sampling across profile-declared `(colorScheme × forcedColors)` modes. `undefined` defers to the profile default (desktop AT profiles declare the full matrix; mobile/generic do not). `true` forces enable, `false` forces disable. Adds ~50–200ms per declared mode per page. Emits `Icon invisible in <mode>` / `Low icon contrast in <mode>` / `Author-set SVG fill in <mode>` penalties depending on contrast tier. |

**Returns** (varies by format):

- `sarif`: SARIF 2.1.0 document with results as Code Scanning findings
- `json`: summarized `{ targets, findings[], diagnostics, metadata, summary, states[] }` (findings capped by `maxFindings`; states only with `includeStates`). Findings include evidence summaries when measured, validated, modeled, or heuristic evidence is available.
- `summaryOnly`: `{ url, profile, stats, severityCounts, diagnostics, topIssues[] }`

**Example:**

```json
{ "url": "https://example.com", "explore": true, "probe": true }
```

## validate_url

Validate Tactual's predicted paths against a virtual screen reader. Runs `analyze_url` internally, then drives `@guidepup/virtual-screen-reader` over the captured DOM to check reachability + actual step count. Returns per-target `{ reachable, actualSteps, accuracy }` plus a mean accuracy across all validated targets. Closer to 1.0 means Tactual's predictions match this virtual-screen-reader validation run, not a guarantee of full real-AT fidelity.

Useful for calibrating Tactual's profile weights, detecting pages with structural patterns the analyzer doesn't model, and closing the predicted-vs-validated loop in MCP workflows.

| Parameter    | Type    | Required | Default           | Description                                                                                                              |
| ------------ | ------- | -------- | ----------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `url`        | string  | yes      |                   | URL to analyze and validate                                                                                              |
| `profile`    | string  | no       | `nvda-desktop-v0` | AT profile ID                                                                                                            |
| `maxTargets` | number  | no       | `10`              | Max findings to validate (worst-first, 1-50)                                                                             |
| `strategy`   | enum    | no       | `semantic`        | `linear` (Tab/Shift-Tab) or `semantic` (heading/landmark skip). Semantic is more representative for NVDA/JAWS/VoiceOver. |
| `timeout`    | number  | no       | `30000`           | Page load timeout in ms                                                                                                  |
| `waitTime`   | number  | no       |                   | Additional wait after load (ms)                                                                                          |
| `channel`    | string  | no       |                   | Browser channel: `chrome`, `chrome-beta`, `msedge`                                                                       |
| `stealth`    | boolean | no       | `false`           | Apply anti-bot-detection defaults                                                                                        |

**Requires (optional deps):** `jsdom` + `@guidepup/virtual-screen-reader`. Install with `npm install jsdom @guidepup/virtual-screen-reader` in your project. The tool returns a clear install message if missing.

**Returns** `{ url, profile, strategy, totalValidated, reachable, unreachable, meanAccuracy, results: [{ targetId, predictedCost, actualSteps, reachable, accuracy, ... }] }`.

**Example:**

```json
{ "url": "https://react.dev", "maxTargets": 10, "strategy": "semantic" }
```

## trace_path

Trace the step-by-step screen-reader navigation path to a specific target. Shows each action, cost, and modeled SR announcement.

| Parameter         | Type    | Required | Default                    | Description                                                   |
| ----------------- | ------- | -------- | -------------------------- | ------------------------------------------------------------- |
| `url`             | string  | yes      |                            | URL of the page                                               |
| `target`          | string  | yes      |                            | Target ID or glob pattern (e.g., `*search*`)                  |
| `profile`         | string  | no       | `generic-mobile-web-sr-v0` | AT profile ID                                                 |
| `device`          | string  | no       |                            | Playwright device name                                        |
| `waitForSelector` | string  | no       |                            | CSS selector to wait for                                      |
| `explore`         | boolean | no       | `false`                    | Explore hidden branches before tracing                        |
| `timeout`         | number  | no       | `30000`                    | Page load timeout in ms                                       |
| `statesJson`      | string  | no       |                            | Pre-captured states from `analyze_url` (skips browser launch) |
| `storageState`    | string  | no       |                            | Path to storageState JSON                                     |

**Returns:** `{ url, profile, matchCount, traces[] }` where each trace contains:

- `targetId`, `targetName`, `targetRole`, `reachable`, `totalCost`, `stepCount`
- `steps[]` — each step has `action`, `cost`, `cumulativeCost`, `from`, `to`, `modeledAnnouncement`

**Example:**

```json
{ "url": "https://example.com", "target": "*checkout*" }
```

## list_profiles

List available AT profiles.

No parameters.

**Returns:** JSON array of `{ id, name, platform, description }`.

## diff_results

Compare two analysis results (before/after). Shows penalties resolved/added, severity changes, and status per target.

| Parameter   | Type   | Required | Description                                                              |
| ----------- | ------ | -------- | ------------------------------------------------------------------------ |
| `baseline`  | string | yes      | Baseline result as JSON string (from `analyze_url` with `format='json'`) |
| `candidate` | string | yes      | Candidate result as JSON string                                          |

**Returns:** `{ summary: { improved, regressed, added, removed }, penaltiesResolved[], penaltiesAdded[], changes[] }` where each change has `targetId`, `baselineScore`, `candidateScore`, `delta`, `severityChanged`, `status`.

## suggest_remediations

Ranked fix suggestions by impact. Redundant for SARIF output (fixes are inline).

| Parameter        | Type   | Required | Default | Description                    |
| ---------------- | ------ | -------- | ------- | ------------------------------ |
| `analysis`       | string | yes      |         | Analysis result as JSON string |
| `maxSuggestions` | number | no       | `10`    | Max suggestions to return      |

**Returns:** JSON array of `{ targetId, severity, score, fix, penalties[] }`, sorted by severity.

## save_auth

Authenticate with a web app and save session state for analyzing authenticated content.

| Parameter    | Type     | Required | Default             | Description             |
| ------------ | -------- | -------- | ------------------- | ----------------------- |
| `url`        | string   | yes      |                     | Login page URL          |
| `steps`      | object[] | yes      |                     | Login steps (see below) |
| `outputPath` | string   | no       | `tactual-auth.json` | Output file path        |
| `timeout`    | number   | no       | `30000`             | Timeout per step in ms  |

**Step types:**

- `{ click: "button text or selector" }` — click a button or link
- `{ fill: ["input selector", "value"] }` — fill an input field
- `{ wait: 2000 }` — wait N milliseconds (max 60000)
- `{ waitForUrl: "/dashboard" }` — wait for URL to contain this string

**Returns:** `{ saved, cookies, origins, currentUrl, message }`.

**Security:** Never paste real credentials into AI prompts. Credentials in chat land in conversation logs and may be cached. Instead, run `save_auth` with placeholder values during development, or use `npx tactual save-auth` in a terminal and pass the resulting file to `storageState`.

**Example:**

```json
{
  "url": "https://myapp.com/login",
  "steps": [
    { "fill": ["#email", "test@example.com"] },
    { "fill": ["#password", "test-only-password"] },
    { "click": "Sign in" },
    { "waitForUrl": "/dashboard" }
  ]
}
```

## analyze_pages

Analyze multiple pages in one call with site-level aggregation. Use for site triage before diving into individual pages. The site summary also groups repeated targets that impose navigation cost across many pages.

| Parameter         | Type     | Required | Default                    | Description                           |
| ----------------- | -------- | -------- | -------------------------- | ------------------------------------- |
| `urls`            | string[] | yes      |                            | URLs to analyze (1-20 pages)          |
| `profile`         | string   | no       | `generic-mobile-web-sr-v0` | AT profile ID                         |
| `waitForSelector` | string   | no       |                            | CSS selector to wait for on each page |
| `waitTime`        | number   | no       |                            | Additional wait per page in ms        |
| `timeout`         | number   | no       | `30000`                    | Page load timeout per URL             |
| `storageState`    | string   | no       |                            | Path to storageState JSON             |

**Returns:** `{ site: { pagesAnalyzed, totalTargets, p10, median, average, worst, severityCounts, repeatedNavigation }, pages[] }` where each page has `{ url, targets, p10, median, average, worst, severityCounts, diagnostics[], topIssue }`.

## Common Workflows

**Quick health check:**

```json
{ "tool": "analyze_url", "args": { "url": "https://example.com", "summaryOnly": true } }
```

**Deep audit with probes:**

```json
{
  "tool": "analyze_url",
  "args": { "url": "https://example.com", "explore": true, "probe": true, "format": "sarif" }
}
```

**Target one branch:**

```json
{
  "tool": "analyze_url",
  "args": {
    "url": "https://app.com/settings",
    "probe": true,
    "entrySelector": "[aria-controls='profile-dialog']",
    "probeStrategy": "modal-return-focus",
    "format": "sarif"
  }
}
```

**Trace a path without re-launching the browser:**

```json
// First: analyze with includeStates
{ "tool": "analyze_url", "args": { "url": "https://example.com", "format": "json", "includeStates": true } }
// Then: pass the states array to trace_path
{ "tool": "trace_path", "args": { "url": "https://example.com", "target": "*search*", "statesJson": "..." } }
```

**Authenticated analysis:**

```json
// First: save auth
{ "tool": "save_auth", "args": { "url": "https://app.com/login", "steps": [...] } }
// Then: analyze with storageState
{ "tool": "analyze_url", "args": { "url": "https://app.com/dashboard", "storageState": "tactual-auth.json" } }
```

**Site triage then drill down:**

```json
// First: scan all pages
{ "tool": "analyze_pages", "args": { "urls": ["https://app.com/", "https://app.com/settings", "https://app.com/checkout"] } }
// Then: deep-dive the worst page
{ "tool": "analyze_url", "args": { "url": "https://app.com/checkout", "explore": true, "probe": true } }
```

When the broad scan identifies a specific modal, drawer, form, or widget, rerun `analyze_url` with `scopeSelector`, `probeSelector`, `entrySelector`, and a `probeStrategy` so the next pass spends budget on the relevant branch rather than the whole page.
