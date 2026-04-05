# Tactual

Screen-reader navigation cost analyzer. Measures how hard it is for assistive-technology users to discover, reach, and operate interactive targets on the web.

## What it does

Existing accessibility tools check **conformance** — is the ARIA correct? Is the contrast ratio sufficient?

Tactual measures **navigation cost** — how many actions does it take a screen-reader user to reach the checkout button? What happens if they overshoot? Can they even discover it exists?

It works by capturing Playwright accessibility snapshots, building a navigation graph, and scoring each target under an assistive-technology profile.

## Install

```bash
# For CLI usage
npm install tactual playwright

# For MCP server usage (AI tools)
npm install tactual playwright @modelcontextprotocol/sdk
```

Playwright and `@modelcontextprotocol/sdk` are optional peer dependencies. Playwright is required for CLI and page analysis. The MCP SDK is required to run the `tactual-mcp` server. Neither is needed if you only use the library API with pre-captured states.

## Quick start

### CLI

```bash
# Analyze a URL (default profile: generic-mobile-web-sr-v0)
tactual analyze-url https://example.com

# Analyze with a specific AT profile
tactual analyze-url https://example.com --profile voiceover-ios-v0

# Explore hidden UI (menus, tabs, dialogs, disclosures)
tactual analyze-url https://example.com --explore

# Output as JSON, Markdown, or SARIF
tactual analyze-url https://example.com --format json --output report.json
tactual analyze-url https://example.com --format sarif --output report.sarif

# Compare two analysis runs
tactual diff baseline.json candidate.json

# List available AT profiles
tactual profiles

# Run benchmark suite
tactual benchmark

# Initialize a tactual.json config file
tactual init
```

### Library API

```typescript
import { analyze, getProfile } from "tactual";
import { captureState } from "tactual/playwright";
import { chromium } from "playwright";

const browser = await chromium.launch();
const page = await browser.newPage();
await page.goto("https://example.com");

const state = await captureState(page);
await browser.close();

const profile = getProfile("generic-mobile-web-sr-v0");
const result = analyze([state], profile);

for (const finding of result.findings) {
  console.log(finding.targetId, finding.scores.overall, finding.severity);
}
```

### MCP Server

Tactual includes an MCP server for AI agent consumption:

```bash
# Start the MCP server (stdio transport)
tactual-mcp
```

**MCP tools available:**

| Tool | Description |
|---|---|
| `analyze_url` | Analyze a web page for SR navigation cost. Default format is `sarif`. Supports `waitForSelector`, `waitTime`, `minSeverity`, `focus`, `excludeSelector`, `exclude`, `maxFindings`, `summaryOnly`, `timeout` params. Findings include Playwright locator selectors. Pass `probe: true` for deep investigation with keyboard probes (focus, activation, Escape recovery). |
| `trace_path` | Trace the step-by-step navigation path to a specific target. Shows each action, cost, and modeled screen-reader announcement. Accepts target ID or glob pattern (e.g., `*search*`). |
| `list_profiles` | List available AT profiles |
| `diff_results` | Compare two analysis results. Shows penalties resolved/added, severity changes, and status per target. |
| `suggest_remediations` | Ranked fix suggestions by impact. Redundant for SARIF output (fixes are inline). |
| `save_auth` | Authenticate with a web app and save session state. Pass the output file path as `storageState` to other tools for analyzing authenticated content. |
| `analyze_pages` | Analyze multiple pages in one call with site-level aggregation. Returns ~200 bytes per page. Use for site triage before diving into individual pages. |

#### Setup by AI tool

First install the required packages in your project:
```bash
npm install tactual playwright @modelcontextprotocol/sdk
```

**Claude Code** — add to `.mcp.json` in your project root:
```json
{
  "mcpServers": {
    "tactual": {
      "type": "stdio",
      "command": "npx",
      "args": ["tactual-mcp"]
    }
  }
}
```

**GitHub Copilot** — add to `.copilot/mcp.json` or `~/.copilot/mcp-config.json`:
```json
{
  "mcpServers": {
    "tactual": {
      "type": "stdio",
      "command": "npx",
      "args": ["tactual-mcp"]
    }
  }
}
```

**Cursor / Windsurf / Cline** — same format in your editor's MCP config:
```json
{
  "mcpServers": {
    "tactual": {
      "command": "npx",
      "args": ["tactual-mcp"]
    }
  }
}
```

**Direct (global install)** — if you prefer not to use npx:
```bash
npm install -g tactual playwright
tactual-mcp  # starts the MCP server on stdio
```

### GitHub Actions

Add to your CI pipeline:

```yaml
- name: Install Tactual
  run: npm install tactual playwright

- name: Install browsers
  run: npx playwright install chromium --with-deps

- name: Run accessibility analysis
  run: npx tactual analyze-url https://your-app.com --format sarif --output results.sarif --threshold 70

- name: Upload SARIF
  uses: github/codeql-action/upload-sarif@v3
  with:
    sarif_file: results.sarif
```

Or use the reusable workflow:

```yaml
jobs:
  a11y:
    uses: tactual-dev/tactual/.github/workflows/a11y-analysis.yml@main
    with:
      url: https://your-app.com
      explore: true
      fail-below: 70
```

## Configuration

### CLI flags

```
Options:
  -p, --profile <id>              AT profile (default: generic-mobile-web-sr-v0)
  -f, --format <format>           json | markdown | console | sarif (default: console)
  -o, --output <path>             Write to file instead of stdout
  -d, --device <name>             Playwright device emulation
  -e, --explore                   Explore hidden branches
  --explore-depth <n>             Max exploration depth (default: 3)
  --explore-budget <n>            Max exploration actions (default: 50)
  --explore-max-targets <n>       Max accumulated targets before stopping (default: 2000)
  --exclude <patterns...>         Exclude targets by name/role glob
  --exclude-selector <css...>     Exclude elements by CSS selector
  --focus <landmarks...>          Only analyze within these landmarks
  --suppress <codes...>           Suppress diagnostic codes
  --top <n>                       Show only worst N findings
  --min-severity <level>          Minimum severity to report
  --threshold <n>                 Exit non-zero if avg score < N
  --config <path>                 Path to tactual.json
  --no-headless                   Headed browser (for bot-blocked sites)
  --timeout <ms>                  Page load timeout (default: 30000)
  -q, --quiet                     Suppress info diagnostics
```

### tactual.json

Create with `tactual init` or manually:

```json
{
  "profile": "voiceover-ios-v0",
  "exclude": ["easter*", "admin*", "debug*"],
  "excludeSelectors": ["#easter-egg", ".admin-only", ".third-party-widget"],
  "focus": ["main"],
  "suppress": ["possible-cookie-wall"],
  "threshold": 70,
  "priority": {
    "checkout*": "critical",
    "footer*": "low",
    "analytics*": "ignore"
  }
}
```

Config is auto-detected from the working directory (`tactual.json` or `.tactualrc.json`). CLI flags merge with and override config settings.

## AT Profiles

| Profile | Platform | Description |
|---|---|---|
| `generic-mobile-web-sr-v0` | Mobile | Normalized mobile SR primitives (default) |
| `voiceover-ios-v0` | Mobile | VoiceOver on iOS Safari — rotor-based navigation |
| `talkback-android-v0` | Mobile | TalkBack on Android Chrome — reading controls |
| `nvda-desktop-v0` | Desktop | NVDA on Windows — browse mode quick keys |
| `jaws-desktop-v0` | Desktop | JAWS on Windows — virtual cursor with auto forms mode |

Profiles define the cost of each navigation action, score dimension weights, `costSensitivity` (scales the reachability decay curve), and context-dependent modifiers. See `src/profiles/` for implementation details.

## Scoring

Each target receives a **5-dimension score vector**:

| Dimension | What it measures |
|---|---|
| Discoverability | Can the user tell the target exists? |
| Reachability | What is the navigation cost to get there? |
| Operability | Does the control behave predictably? |
| Recovery | How hard is it to recover from overshooting? |
| Interop Risk | How likely is AT/browser support variance? (penalty) |

Dimension weights vary by profile:

| Profile | D | R | O | Rec | costSensitivity |
|---|---|---|---|---|---|
| generic-mobile-web-sr-v0 | 0.30 | 0.40 | 0.20 | 0.10 | 1.0 |
| voiceover-ios-v0 | 0.30 | 0.35 | 0.20 | 0.15 | 1.1 |
| talkback-android-v0 | 0.25 | 0.45 | 0.20 | 0.10 | 1.3 |
| nvda-desktop-v0 | 0.35 | 0.25 | 0.30 | 0.10 | 0.7 |
| jaws-desktop-v0 | 0.30 | 0.25 | 0.35 | 0.10 | 0.6 |

**Composite:** Weighted geometric mean: `overall = exp(sum(w_i * ln(score_i)) / sum(w_i)) - interopRisk`. Each dimension is floored at 1 before the log to avoid log(0). This means a zero in any dimension drags the overall score down sharply -- you cannot operate what you cannot reach.

**Severity bands:**

| Score | Band | Meaning |
|---|---|---|
| 90-100 | Strong | Low concern |
| 75-89 | Acceptable | Improvable |
| 60-74 | Moderate | Should be triaged |
| 40-59 | High | Likely meaningful friction |
| 0-39 | Severe | Likely blocking |

## Diagnostics

Tactual detects and reports when analysis may be unreliable:

| Code | Level | Meaning |
|---|---|---|
| `blocked-by-bot-protection` | error | Cloudflare/bot challenge detected |
| `empty-page` | error | No targets found at all |
| `possibly-degraded-content` | warning | Suspiciously few targets for an http page |
| `sparse-content` | warning | Only 1-4 targets found |
| `possible-login-wall` | warning | Auth-gated content (detects `/login`, `/signin`, `/auth` path redirects) |
| `possible-cookie-wall` | info | Cookie consent may obscure content |
| `redirect-detected` | warning | Landed on different domain |
| `no-headings` | warning | No heading elements found |
| `no-landmarks` | warning | No landmark regions found |

## Exploration

The `--explore` flag activates bounded branch exploration:

- Opens menus, tabs, disclosures, accordions, and dialogs
- Captures new accessibility states from hidden UI
- Marks discovered targets as `requiresBranchOpen`
- Respects depth, action count, target count, and novelty budgets
- Safe-action policy blocks destructive interactions

Exploration is useful for pages with significant hidden UI (e.g., dropdown menus, tabbed interfaces, modal dialogs).

Exploration candidates are sorted by a stable key (role + name) before iterating, so the same page content produces the same exploration order across runs.

### Exploration budgets

| Budget | CLI flag | Default | Purpose |
|--------|----------|---------|---------|
| Depth | `--explore-depth` | 3 | Max recursion depth |
| Actions | `--explore-budget` | 50 | Total click budget across all branches |
| Targets | `--explore-max-targets` | 2000 | Stop if accumulated targets exceed this |
| Time | (library only) | 120s | Global wall-clock timeout |

### SPA framework detection

Tactual detects when SPA content has rendered before capturing the accessibility tree. Detected frameworks: React, Next.js, Vue, Nuxt, Angular, Svelte, and SvelteKit. Generic HTML5 content signals (landmarks, headings, navigation, links) are also checked. For SPAs not covered by auto-detection, use `--wait-for-selector` (CLI) or `waitForSelector` (MCP/API) to specify a CSS selector that indicates your app has hydrated.

After initial framework detection, Tactual uses convergence-based polling — repeatedly snapshotting the accessibility tree until the target count stabilizes — which works regardless of framework.

## Interop Risk

Tactual includes a static snapshot of ARIA role/attribute support data derived from [a11ysupport.io](https://a11ysupport.io) and the [ARIA-AT project](https://aria-at.w3.org). Roles with known cross-AT/browser support gaps receive an interop risk penalty.

| Role | Risk | Note |
|---|---|---|
| `button`, `link`, `heading` | 0 | Well-supported |
| `dialog` | 5 | Focus management varies |
| `combobox` | 8 | Most interop-problematic pattern |
| `tree` | 10 | Poorly supported outside JAWS |
| `application` | 15 | Dangerous if misused |

## Output Format Recommendations

| Format | Typical size | Best for |
|---|---|---|
| `console` | ~8KB | Human review in terminal |
| `markdown` | ~11KB | PRs and issue comments |
| `json` | ~18KB | Programmatic consumption |
| `sarif` | ~43KB | GitHub Code Scanning / CI |

All non-SARIF formats emit summarized output: stats, grouped issues, and worst findings (capped at 15). SARIF caps at 25 results. When output is truncated, a note appears at the top.

For MCP usage, `sarif` is the default and recommended format. Use `summaryOnly: true` for a minimal health check (~835 bytes: stats, severity counts, top 3 issues).

## Calibration

Tactual includes a calibration framework (`src/calibration/`, exported as `tactual/calibration`) for tuning scoring parameters against ground-truth datasets. See `docs/CALIBRATION.md` for details.

## Development

```bash
npm install                    # Install dependencies
npm run build                  # Build with tsup
npm run test                   # Run unit + integration tests
npm run test:benchmark         # Run benchmark suite
npm run typecheck              # TypeScript type checking
npm run lint                   # ESLint
```

## Security

### Browser sandboxing

Tactual always runs Playwright with default Chromium sandboxing enabled. It never disables web security or modifies the browser's security model. All page interactions happen within the standard Chromium process sandbox.

### Safe-action policy

When exploration is enabled (`--explore`), Tactual classifies interactive elements into three tiers before activating them:

| Tier | Action | Examples |
|------|--------|----------|
| **Safe** | Activated | Tabs, menu items, disclosures, accordions, same-page anchors |
| **Caution** | Activated with care | External links, ambiguous buttons, submit buttons |
| **Unsafe** | Skipped | Delete, sign out, purchase, deploy, unsubscribe |

This is a keyword-based heuristic — it cannot detect semantic deception (e.g., a "Save" button that actually deletes data) or inspect server-side behavior. For production use, always run exploration against trusted or sandboxed environments.

### URL validation

All URLs are validated before navigation. Private/internal IP ranges and non-HTTP(S) schemes are rejected by default.

## License

Apache-2.0
