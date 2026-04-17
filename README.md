# Tactual

<p align="center">
  <img src="https://raw.githubusercontent.com/tactual-dev/tactual/main/assets/logo.png" alt="Tactual logo" width="160">
</p>

Screen-reader navigation cost analyzer. Measures how hard it is for assistive-technology users to discover, reach, and operate interactive targets on the web.

## What it does

Existing accessibility tools check **conformance** — is the ARIA correct? Is the contrast ratio sufficient?

Tactual measures **navigation cost** — how many actions does it take a screen-reader user to reach the checkout button? What happens if they overshoot? Can they even discover it exists?

It works by capturing Playwright accessibility snapshots, building a navigation graph, and scoring each target under an assistive-technology profile.

Tactual is a developer tool for analyzing your own sites and staging environments. Run it locally, in CI, or via the MCP server in your editor. It is not a public scanning service.

## Install

Requires Node.js 20 or later.

```bash
npm install tactual playwright
```

Playwright and `@modelcontextprotocol/sdk` are optional peer dependencies. Playwright is required for CLI and page analysis. The MCP SDK is required to run the `tactual-mcp` server. Neither is needed if you only use the library API with pre-captured states.

For MCP server usage, also install the SDK: `npm install @modelcontextprotocol/sdk`

## Quick start

### CLI

```bash
# Analyze a URL (default profile: generic-mobile-web-sr-v0)
npx tactual analyze-url https://example.com

# Analyze with a specific AT profile
npx tactual analyze-url https://example.com --profile voiceover-ios-v0

# Explore hidden UI (menus, tabs, dialogs, disclosures)
npx tactual analyze-url https://example.com --explore

# Use a scoring preset for your use case
npx tactual analyze-url https://shop.com --preset ecommerce-checkout
npx tactual analyze-url https://docs.example.com --preset docs-site

# Output as JSON, Markdown, or SARIF
npx tactual analyze-url https://example.com --format json --output report.json
npx tactual analyze-url https://example.com --format sarif --output report.sarif

# Compare two analysis runs
npx tactual diff baseline.json candidate.json

# Print what NVDA would say as you Tab through the page
npx tactual transcript https://example.com
npx tactual transcript https://example.com --at voiceover

# List available AT profiles and scoring presets
npx tactual profiles
npx tactual presets

# Run benchmark suite
npx tactual benchmark

# Initialize a tactual.json config file
npx tactual init
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

**Screen-reader announcement simulator** — predict what NVDA, JAWS, or VoiceOver would announce for every target, with state info (checked, expanded, selected, modal, value, required, invalid, etc.):

```typescript
import {
  simulateScreenReader, buildAnnouncement,
  buildMultiATAnnouncement, buildTranscript,
} from "tactual/playwright";

const report = await simulateScreenReader(page, state.targets);

for (const a of report.formFields) {
  console.log(a.announcement);
  // → "Subscribe, check box, checked"
  // → "Country, combo box, collapsed"
  // → "Email, edit, invalid entry, required, you must use a work address"
}

// Compare across screen readers
const tx = state.targets[5];
buildAnnouncement(tx, "nvda");      // → "Country, combo box, collapsed"
buildAnnouncement(tx, "voiceover"); // → "Country, popup button"

// All three at once
buildMultiATAnnouncement(tx);
// → { nvda: "...", jaws: "...", voiceover: "..." }

// Linear navigation transcript — what an SR user hears Tabbing through
const transcript = buildTranscript(state.targets, "nvda");
// → [{ step: 1, kind: "landmark", announcement: "Main, main landmark" }, ...]

// Multi-target navigation modes (linear, by-heading, by-landmark, by-form-control)
import { buildNavigationTranscript } from "tactual/playwright";

// Heading-only navigation (NVDA: H key)
const headings = buildNavigationTranscript(state.targets, { mode: "by-heading" });

// Navigate from one element to another
const path = buildNavigationTranscript(state.targets, {
  from: "link:before-main", to: "heading:welcome", mode: "linear",
});

// Demoted landmarks (in DOM but stripped by HTML rules, e.g. <header> in <section>)
for (const d of report.demotedLandmarks) {
  console.warn(d.demotionReason);
}
```

Or from the CLI:
```bash
npx tactual transcript https://example.com --at voiceover
```

The simulator is heuristic prediction, not real screen-reader output. It runs in milliseconds and is cross-platform — analysis happens in a headless browser by default, so nothing pops up while you work. (Use `--no-headless` if you need a visible browser, e.g., for bot-blocked sites.)

**Data quality.** Calibrated against the [W3C ARIA-AT project](https://aria-at.w3.org): **77/77 assertions pass at 100% across all three ATs (NVDA, JAWS, VoiceOver)**, covering 36 single-target patterns (button, toggle button, all menu button variants, disclosure, accordion, checkbox/tri-state, switch, sliders, dialog, alert, links, tabs, comboboxes, radiogroups, spin button, menubar) plus 4 multi-target landmark scenarios. Run `npm run calibrate` after `npm run build` to verify against the latest upstream assertions. AT-specific overrides outside the calibrated set are labeled HIGH/MEDIUM/LOW confidence in the source.

### MCP Server

Tactual includes an MCP server for AI agent consumption:

```bash
# Start the MCP server (stdio transport — default)
npx tactual-mcp

# Start with HTTP transport (for hosted platforms, remote clients)
npx tactual-mcp --http              # listens on http://127.0.0.1:8787/mcp
npx tactual-mcp --http --port=3000  # custom port (or set PORT env var)
npx tactual-mcp --http --host=0.0.0.0  # bind to all interfaces (default: 127.0.0.1)
```

**MCP tools available:**

| Tool | Description |
|---|---|
| `analyze_url` | Analyze a page for SR navigation cost (SARIF default). Supports exploration, keyboard probes, filtering. |
| `trace_path` | Step-by-step navigation path to a target with modeled SR announcements. |
| `list_profiles` | List available AT profiles. |
| `diff_results` | Compare two analysis results — improvements, regressions, severity changes. |
| `suggest_remediations` | Ranked fix suggestions by impact. |
| `save_auth` | Authenticate and save session state for analyzing protected content. |
| `analyze_pages` | Multi-page site triage with aggregated stats (~200 bytes/page). |

Full parameter reference: [docs/MCP-TOOLS.md](docs/MCP-TOOLS.md)

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
npm install -g tactual playwright @modelcontextprotocol/sdk
tactual-mcp  # starts the MCP server on stdio
```

### GitHub Actions

Use the composite action from the GitHub Actions Marketplace:

```yaml
jobs:
  a11y:
    runs-on: ubuntu-latest
    permissions:
      security-events: write   # for SARIF upload
      pull-requests: write     # for comment-on-pr
    steps:
      - name: Analyze accessibility
        uses: tactual-dev/tactual@v0.3.0
        with:
          url: https://your-app.com
          explore: "true"
          fail-below: "70"
          comment-on-pr: "true"
```

The action installs Tactual and Playwright, runs the analysis, uploads SARIF to GitHub Code Scanning, and fails the build if the average score is below the threshold. Set `comment-on-pr: "true"` to post a summary comment on pull requests (updates on re-run). Outputs `average-score` and `result-file` for downstream steps. Action version tracks Tactual version — bump the `uses:` line to pick up patches.

Or use the CLI directly for more control:

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
  --allow-action <patterns...>    Allow exploring controls matching these patterns (overrides safety)
  --exclude <patterns...>         Exclude targets by name/role glob
  --exclude-selector <css...>     Exclude elements by CSS selector
  --focus <landmarks...>          Only analyze within these landmarks
  --suppress <codes...>           Suppress diagnostic codes
  --top <n>                       Show only worst N findings
  --min-severity <level>          Minimum severity to report
  --threshold <n>                 Exit non-zero if avg score < N
  --preset <name>                 Scoring preset (ecommerce-checkout, docs-site, dashboard, form-heavy)
  --config <path>                 Path to tactual.json
  --no-headless                   Headed browser (for bot-blocked sites)
  --timeout <ms>                  Page load timeout (default: 30000)
  --probe                         Run keyboard probes (focus, activation, Escape, Tab)
  --probe-budget <n>              Max targets to probe (default: 20)
  --wait-for-selector <css>       Wait for selector before capturing (for SPAs)
  --wait-time <ms>                Additional wait after page load
  --storage-state <path>          Playwright storageState JSON for authenticated pages
  --also-json <path>              Also write JSON to this path (single analysis run for CI)
  --summary-only                  Return only summary stats, no individual findings
  -q, --quiet                     Suppress info diagnostics
```

### tactual.json

Create with `tactual init` or manually:

```json
{
  "preset": "ecommerce-checkout",
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

**Mobile profile limitation.** The `voiceover-ios-v0` and `talkback-android-v0` profiles model action costs and SR announcement phrasing accurately, but Tactual's keyboard probes (`--probe`) only test desktop interactions (Tab, Enter, Escape). They do NOT simulate touch gestures (single-tap, double-tap, swipe-right, three-finger swipe, rotor rotation, etc.). For mobile profiles, score dimensions reflect predicted cost from the profile model — not measured behavior. Real device testing remains necessary to verify mobile a11y.

## Scoring Presets

Presets bundle focus filters and priority mappings for common use cases. They layer under config files and CLI flags (preset → tactual.json → CLI flags).

| Preset | Use case | Focus | Critical targets |
|---|---|---|---|
| `ecommerce-checkout` | Shopping flows | main | checkout, cart, payment, buy |
| `docs-site` | Documentation | main, navigation | search, nav |
| `dashboard` | Web apps | main, navigation | save, submit, create, delete, search |
| `form-heavy` | Form pages | main | submit, save, next, continue, error |

```bash
npx tactual analyze-url https://shop.com --preset ecommerce-checkout
npx tactual presets  # list all presets with details
```

Presets suppress cookie banners and analytics targets by default. To override, use `--exclude` or set `priority` in `tactual.json`. Presets do not compose — only one `--preset` can be active.

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

**Composite:** Weighted geometric mean: `overall = exp(sum(w_i * ln(score_i)) / sum(w_i)) - interopRisk`. Each dimension is floored at 1 before the log to avoid log(0). A zero in any dimension eliminates that dimension's contribution to the geometric mean, significantly dragging the overall score down -- you cannot operate what you cannot reach.

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
| `heading-skip` | warning | Heading hierarchy skips a level (e.g., h1 → h3) |
| `no-landmarks` | warning | No landmark regions found |
| `no-skip-link` | warning | No skip-to-content link on pages with 5+ targets |
| `no-main-landmark` | warning | Missing `<main>` landmark |
| `no-banner-landmark` | info | Missing `<header>` / banner landmark |
| `no-contentinfo-landmark` | info | Missing `<footer>` / contentinfo landmark |
| `no-nav-landmark` | info | Missing `<nav>` / navigation landmark |
| `structural-summary` | info | One-line structural overview (headings, landmarks, skip link) |
| `shared-structural-issue` | warning | Penalty affecting >50% of targets promoted to page-level |
| `landmark-demoted` | warning | HTML landmark exists but demoted by nesting context |
| `timeout-during-render` | warning | A `waitForSelector` did not appear in time during MCP capture |

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

**Sizing guidance:**

| Page type | Suggested settings | Why |
|---|---|---|
| Marketing site, docs page, blog | defaults | Small surface, defaults rarely hit |
| Dashboard with sidebar/menu | `--explore-depth 3 --explore-budget 50` (defaults) | Captures one level of menu opens |
| Complex app (Figma, Notion, etc.) | `--explore-depth 4 --explore-budget 100 --explore-max-targets 5000` | Deeper menus, more state |
| Pages with very large hidden UI (emoji pickers, color grids) | `--explore-max-targets 10000` plus `--exclude "emoji-*"` | Cap or filter out the firehose |
| Quick triage of unknown page | `--explore-depth 1 --explore-budget 10` | Just open obvious branches, fast |

If exploration takes more than 60s, raise `--explore-budget` slowly — each extra click adds ~1-2s. If output has duplicate-looking targets, lower `--explore-depth` (deep recursion can re-discover the same elements through different paths).

### SPA framework detection

Tactual detects when SPA content has rendered before capturing the accessibility tree. Detected frameworks: React, Next.js, Vue, Nuxt, Angular, Svelte, and SvelteKit. Generic HTML5 content signals (landmarks, headings, navigation, links) are also checked. For SPAs not covered by auto-detection, use `--wait-for-selector` (CLI) or `waitForSelector` (MCP/API) to specify a CSS selector that indicates your app has hydrated.

After initial framework detection, Tactual uses convergence-based polling — repeatedly snapshotting the accessibility tree until the target count stabilizes — which works regardless of framework.

## Regression Tracking

Compare two analysis runs to catch regressions:

```bash
# Save a baseline
npx tactual analyze-url https://your-app.com --format json --output baseline.json

# After changes, run again and diff
npx tactual analyze-url https://your-app.com --format json --output candidate.json
npx tactual diff baseline.json candidate.json
```

The diff shows targets that improved, regressed, or changed severity, plus penalties resolved and added. In CI, use the `comment-on-pr` action input to post results on every pull request automatically.

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
| `sarif` | ~4-40KB | GitHub Code Scanning / CI |

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

### Attribution

The simulator's role/state phrasing is calibrated against the [W3C ARIA-AT project](https://github.com/w3c/aria-at), which is licensed under [CC-BY 4.0](https://creativecommons.org/licenses/by/4.0/). Tactual does not bundle ARIA-AT data; the calibration script (`npm run calibrate`) fetches assertions from the upstream repository at run time. If you publish Tactual calibration results, please attribute the W3C ARIA-AT project as the source of the ground-truth assertions.

ARIA role/attribute support data referenced in interop risk scoring is derived from [a11ysupport.io](https://a11ysupport.io) and the same ARIA-AT project.
