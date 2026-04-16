# MCP Tools Reference

Tactual's MCP server exposes 7 tools for AI-assisted accessibility analysis. Start the server with `npx tactual-mcp` (stdio) or `npx tactual-mcp --http` (HTTP).

## analyze_url

Analyze a web page for screen-reader navigation cost. Returns scored findings showing how hard it is for AT users to discover, reach, and operate interactive targets.

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `url` | string | yes | | URL to analyze |
| `profile` | string | no | `generic-mobile-web-sr-v0` | AT profile ID |
| `device` | string | no | | Playwright device name (e.g., `iPhone 14`) |
| `explore` | boolean | no | `false` | Explore hidden branches (menus, tabs, dialogs) |
| `allowAction` | string[] | no | | Glob patterns for controls to explore despite safety policy |
| `format` | enum | no | `sarif` | `json`, `markdown`, `console`, or `sarif` |
| `minSeverity` | enum | no | | Only include findings at this severity or worse |
| `waitForSelector` | string | no | | CSS selector to wait for before capturing (for SPAs) |
| `waitTime` | number | no | `0` | Additional ms to wait after page load |
| `timeout` | number | no | `30000` | Page load timeout in ms |
| `focus` | string[] | no | | Only analyze within these landmarks |
| `excludeSelector` | string[] | no | | CSS selectors to hide from analysis |
| `exclude` | string[] | no | | Glob patterns to exclude targets by name/role |
| `maxFindings` | number | no | 15/25 | Max detailed findings (15 for JSON/markdown, 25 for SARIF) |
| `probe` | boolean | no | `false` | Run keyboard probes (focus, activation, Escape, Tab) |
| `summaryOnly` | boolean | no | `false` | Return only summary stats, no individual findings |
| `includeStates` | boolean | no | `false` | Include captured states for passing to `trace_path` |
| `storageState` | string | no | | Path to Playwright storageState JSON (from `save_auth`) |

**Returns** (varies by format):

- `sarif`: SARIF 2.1.0 document with results as Code Scanning findings
- `json`: `{ targets, findings[], diagnostics, metadata, states[] }` (states only with `includeStates`)
- `summaryOnly`: `{ url, profile, stats, severityCounts, diagnostics, topIssues[] }` (~835 bytes)

**Example:**
```json
{ "url": "https://example.com", "explore": true, "probe": true }
```

## trace_path

Trace the step-by-step screen-reader navigation path to a specific target. Shows each action, cost, and modeled SR announcement.

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `url` | string | yes | | URL of the page |
| `target` | string | yes | | Target ID or glob pattern (e.g., `*search*`) |
| `profile` | string | no | `generic-mobile-web-sr-v0` | AT profile ID |
| `device` | string | no | | Playwright device name |
| `waitForSelector` | string | no | | CSS selector to wait for |
| `explore` | boolean | no | `false` | Explore hidden branches before tracing |
| `timeout` | number | no | `30000` | Page load timeout in ms |
| `statesJson` | string | no | | Pre-captured states from `analyze_url` (skips browser launch) |
| `storageState` | string | no | | Path to storageState JSON |

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

| Parameter | Type | Required | Description |
|---|---|---|---|
| `baseline` | string | yes | Baseline result as JSON string (from `analyze_url` with `format='json'`) |
| `candidate` | string | yes | Candidate result as JSON string |

**Returns:** `{ summary: { improved, regressed, added, removed }, penaltiesResolved[], penaltiesAdded[], changes[] }` where each change has `targetId`, `baselineScore`, `candidateScore`, `delta`, `severityChanged`, `status`.

## suggest_remediations

Ranked fix suggestions by impact. Redundant for SARIF output (fixes are inline).

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `analysis` | string | yes | | Analysis result as JSON string |
| `maxSuggestions` | number | no | `10` | Max suggestions to return |

**Returns:** JSON array of `{ targetId, severity, score, fix, penalties[] }`, sorted by severity.

## save_auth

Authenticate with a web app and save session state for analyzing authenticated content.

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `url` | string | yes | | Login page URL |
| `steps` | object[] | yes | | Login steps (see below) |
| `outputPath` | string | no | `tactual-auth.json` | Output file path |
| `timeout` | number | no | `30000` | Timeout per step in ms |

**Step types:**
- `{ click: "button text or selector" }` — click a button or link
- `{ fill: ["input selector", "value"] }` — fill an input field
- `{ wait: 2000 }` — wait N milliseconds (max 60000)
- `{ waitForUrl: "/dashboard" }` — wait for URL to contain this string

**Returns:** `{ saved, cookies, origins, currentUrl, message }`.

**Example:**
```json
{
  "url": "https://myapp.com/login",
  "steps": [
    { "fill": ["#email", "user@example.com"] },
    { "fill": ["#password", "secretpassword"] },
    { "click": "Sign in" },
    { "waitForUrl": "/dashboard" }
  ]
}
```

## analyze_pages

Analyze multiple pages in one call with site-level aggregation. Returns ~200 bytes per page. Use for site triage before diving into individual pages.

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `urls` | string[] | yes | | URLs to analyze (1-20 pages) |
| `profile` | string | no | `generic-mobile-web-sr-v0` | AT profile ID |
| `waitForSelector` | string | no | | CSS selector to wait for on each page |
| `waitTime` | number | no | | Additional wait per page in ms |
| `timeout` | number | no | `30000` | Page load timeout per URL |
| `storageState` | string | no | | Path to storageState JSON |

**Returns:** `{ site: { pagesAnalyzed, totalTargets, p10, median, average, worst, severityCounts }, pages[] }` where each page has `{ url, targets, p10, median, average, worst, severityCounts, diagnostics[], topIssue }`.

## Common Workflows

**Quick health check:**
```json
{ "tool": "analyze_url", "args": { "url": "https://example.com", "summaryOnly": true } }
```

**Deep audit with probes:**
```json
{ "tool": "analyze_url", "args": { "url": "https://example.com", "explore": true, "probe": true, "format": "sarif" } }
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
