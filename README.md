# Tactual

<p align="center">
  <img src="https://raw.githubusercontent.com/tactual-dev/tactual/main/assets/logo.png" alt="Tactual logo" width="160">
</p>

Screen-reader navigation cost analyzer. Measures how many keystrokes a screen-reader user needs to discover, reach, and operate every interactive target on your page — under a specific AT profile (NVDA, JAWS, VoiceOver).

## What it does

Existing accessibility tools check **conformance** — is the ARIA correct? Is the contrast ratio sufficient?

Tactual measures **navigation cost** — how many actions does it take a screen-reader user to reach the checkout button? What happens if they overshoot? Can they even discover it exists? Does the menu actually open on Enter, or only on click? Does focus land on the first menuitem or stay stuck on the trigger?

How it works:

- Captures Playwright accessibility snapshots + screen-reader announcement simulation
- Optionally explores hidden branches (menus, dialogs, tabs, disclosures) and probes them with real keyboard events, including APG-style widget contracts and form-error flows
- Builds a navigation graph with entry points (landmarks, headings, linear Tab) and scores every target
- Optionally validates predicted paths against `@guidepup/virtual-screen-reader` for calibration

Tactual is a developer tool for analyzing your own sites and staging environments. Run it locally, in CI, or via the MCP server in your editor. It is not a public scanning service.

## How it fits

Tactual complements conformance scanners such as axe-core, Lighthouse, and Pa11y. Those tools are still the right first pass for broad WCAG and ARIA rule coverage. Tactual is aimed at the next question: after a page has valid markup, how expensive is it for an AT user to discover, reach, and operate the important targets?

Use Tactual for screen-reader navigation-cost triage, path tracing, measured keyboard/widget evidence, before/after diffs, CI prioritization, and MCP workflows where an agent needs compact findings with source selectors and remediation candidates. Use real screen readers and manual testing for final validation of critical journeys, timing-sensitive flows, browser/AT settings, and implementation patterns that intentionally differ from a common APG example.

## Install

Requires Node.js 20 or later.

```bash
npm install tactual playwright
```

Playwright is an optional peer dependency required for CLI page analysis. The MCP SDK ships as a runtime dependency, so `tactual-mcp` works from an installed `tactual` package without a separate SDK install.

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
npx tactual diff-results baseline.json candidate.json
npx tactual diff-results baseline.json candidate.json --format json

# Print what NVDA would say as you Tab through the page
npx tactual transcript https://example.com
npx tactual transcript https://example.com --at voiceover

# List available AT profiles and scoring presets
npx tactual profiles
npx tactual presets

# Run benchmark suites
npx tactual benchmark
npx tactual benchmark --suite all

Benchmark fixtures ship with the npm package, so the benchmark command works from a fresh install and does not require cloning the repository fixtures into your current directory.

# Validate predicted paths against a virtual screen reader (reachability + step count)
# Requires: npm install jsdom @guidepup/virtual-screen-reader
npx tactual validate-url https://example.com --max-targets 10 --strategy semantic

# Initialize a tactual.json config file
npx tactual init

# Analyze a bot-protected site with stealth + real Chrome
npx tactual analyze-url https://www.npmjs.com/ --stealth --channel chrome

# Deep keyboard probing including revealed widgets and form-error flows
npx tactual analyze-url https://docs.example.com --probe --explore --probe-mode deep

# Focus probing on one opened branch, such as a dialog trigger
npx tactual analyze-url https://app.example.com/settings \
  --probe \
  --entry-selector "[aria-controls='profile-dialog']" \
  --probe-strategy modal-return-focus

# Analyze + inline virtual-SR validation in one command (predicted vs validated steps)
npx tactual analyze-url https://example.com --validate --validate-max-targets 10
```

Console output includes a compacted path line for each finding showing how a screen-reader user reaches it:

```
  ██████░░ 70  link:reference structural
               D:47 R:71 O:100 Rec:100
               getByRole('link', { name: 'Reference' })
               ↪ Tab ×2 "v19.2" → K "Learn" → Tab "Reference"
               → Target is not efficiently reachable via heading or landmark navigation
```

Where `Tab` = `nextItem`, `H` = `nextHeading`, `;` = `nextLandmark`, `K` = `nextLink`, `B` = `nextButton`, `Enter` = activate. Consecutive same-action steps collapse (`Tab ×2`).

### From Audit to Fix

For accessibility work in a local app or preview environment, Tactual supplies evidence for small, reviewable changes:

- `selector`, `penalties`, `suggestedFixes`, and evidence summaries on each finding
- grouped `issueGroups` and remediation candidates in summarized output
- `analyze_pages.site.repeatedNavigation` for repeated navigation cost across routes
- `diff-results` / `diff_results` for before-and-after verification

Start with broad triage, then deepen one route before changing code:

```bash
# Site-level triage. Redirect JSON for tool consumption.
npx tactual analyze-pages \
  https://app.example.com/ \
  https://app.example.com/docs \
  https://app.example.com/settings \
  --profile nvda-desktop-v0 \
  --format json > tactual-site.json

# Deepen one route and produce a reviewable markdown report.
npx tactual analyze-url https://app.example.com/docs \
  --profile nvda-desktop-v0 \
  --explore --probe --probe-mode standard \
  --format markdown --output tactual-report.md

# When one branch is the target, open it first and spend probe budget there.
npx tactual analyze-url https://app.example.com/docs \
  --profile nvda-desktop-v0 \
  --probe \
  --entry-selector "[aria-controls='search-panel']" \
  --probe-selector "#search-panel" \
  --probe-strategy composite-widget \
  --format markdown --output tactual-search-panel.md

# Save a baseline before editing, then verify the patch.
npx tactual analyze-url https://app.example.com/docs --explore --probe --format json --output baseline.json
# Edit one root cause in the local repo, rebuild/restart the preview, then re-run:
npx tactual analyze-url https://app.example.com/docs --explore --probe --format json --output candidate.json
npx tactual diff-results baseline.json candidate.json
```

Use the candidate section as a starting point for repeated root causes such as a shared component, navigation pattern, or widget contract. Confirm the source component and include the route, command, finding evidence, user impact, code change, and verification in whatever issue or PR format the project expects. Score movement is useful supporting evidence, but the change should lead with the accessibility behavior that changed.

MCP clients can consume the same compact output and keep the review loop grounded in routes, selectors, evidence, source changes, and before/after verification.

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
  simulateScreenReader,
  buildAnnouncement,
  buildMultiATAnnouncement,
  buildTranscript,
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
buildAnnouncement(tx, "nvda"); // → "Country, combo box, collapsed"
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
  from: "link:before-main",
  to: "heading:welcome",
  mode: "linear",
});

// Demoted landmarks (in DOM but stripped by HTML rules, e.g. <header> in <section>)
for (const d of report.demotedLandmarks) {
  console.warn(d.demotionReason);
}
```

**Validation and calibration APIs** — compare model output against virtual-SR validation runs or human-observation datasets:

```typescript
import { validateFindingsInJsdom } from "tactual/validation";
import { runCalibration, formatCalibrationReport } from "tactual/calibration";

// Given a JSDOM instance, PageState, AnalysisResult, and calibration dataset:
const validation = await validateFindingsInJsdom(dom, state, result.findings, {
  maxTargets: 10,
  strategy: "semantic",
});

const calibration = runCalibration(dataset, [result]);
console.log(validation, formatCalibrationReport(calibration));
```

Or from the CLI:

```bash
npx tactual transcript https://example.com --at voiceover
```

The simulator is heuristic prediction, not real screen-reader output. The simulator itself is fast (pure JavaScript over captured targets — sub-second once targets are in memory), but a full `analyze-url` run includes browser launch + page capture + scoring and takes seconds on small pages, longer with `--probe` (~30s+) and `--explore` (~1–5 min on complex SPAs). Analysis runs in a headless browser by default, so nothing pops up while you work. (Use `--no-headless` or `--channel chrome --stealth` for visible/bot-protected sites.)

**Data quality.** Calibrated against token-level assertions from the [W3C ARIA-AT project](https://aria-at.w3.org): **77/77 role/name/state-token assertions pass at 100% across all three ATs (NVDA, JAWS, VoiceOver)**, covering role/name/state phrasing for 36 single-target patterns (button, toggle button, all menu button variants, disclosure, accordion, checkbox/tri-state, switch, sliders, dialog, alert, links, tabs, comboboxes, radiogroups, spin button, menubar) plus 4 multi-target landmark scenarios. Run `npm run calibrate` after `npm run build` to verify against the latest upstream assertions. This is simulator calibration, not proof of full screen-reader fidelity across browse modes, verbosity settings, timing, or every valid widget variant. AT-specific overrides outside the calibrated set are labeled HIGH/MEDIUM/LOW confidence in the source.

### MCP Server

Tactual includes an MCP server for AI agent consumption:

```bash
# Start the MCP server (stdio transport — default)
npx tactual-mcp

# Start with HTTP transport (for hosted platforms, remote clients)
npx tactual-mcp --http              # listens on http://127.0.0.1:8787/mcp
npx tactual-mcp --http --port=3000  # custom port (or set PORT env var)
npx tactual-mcp --http --port 3000  # space-separated form is also supported
npx tactual-mcp --http --host=0.0.0.0  # bind to all interfaces (default: 127.0.0.1)
```

For network-facing MCP deployments, put the HTTP transport behind an authenticated TLS proxy and keep it scoped to trusted clients. See [SECURITY.md](SECURITY.md) for the hosted checklist and threat model.

**MCP tools available:**

| Tool                   | Description                                                                                                                                                                                            |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `analyze_url`          | Analyze a page for SR navigation cost (SARIF default). Supports opt-in exploration, keyboard/widget/form probes, scoped/goal-directed probing, stealth/channel for bot-protected sites, and filtering. |
| `trace_path`           | Step-by-step navigation path to a target with modeled SR announcements.                                                                                                                                |
| `validate_url`         | Validate predicted paths against `@guidepup/virtual-screen-reader`. Returns reachable + mean accuracy per strategy (linear/semantic). Closes the predicted-vs-validated loop.                          |
| `list_profiles`        | List available AT profiles.                                                                                                                                                                            |
| `diff_results`         | Compare two analysis results — improvements, regressions, severity changes.                                                                                                                            |
| `suggest_remediations` | Ranked fix suggestions by impact.                                                                                                                                                                      |
| `save_auth`            | Authenticate and save session state for analyzing protected content.                                                                                                                                   |
| `analyze_pages`        | Multi-page site triage with aggregated stats and repeated navigation-cost groups across pages.                                                                                                         |

Full parameter reference: [docs/MCP-TOOLS.md](docs/MCP-TOOLS.md)

#### Setup by AI tool

First install the required packages in your project:

```bash
npm install tactual playwright
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

Use the composite action from the GitHub Actions Marketplace:

```yaml
jobs:
  a11y:
    runs-on: ubuntu-latest
    permissions:
      security-events: write # for SARIF upload
      pull-requests: write # for comment-on-pr
    steps:
      - name: Analyze accessibility
        uses: tactual-dev/tactual@v0.4.1
        with:
          url: https://your-app.com
          profile: nvda-desktop-v0
          explore: "true"
          probe: "true"
          probe-mode: standard
          fail-below: "70"
          comment-on-pr: "true"
```

The action installs Tactual and Playwright, runs the analysis, uploads SARIF to GitHub Code Scanning, and fails the build if the average score is below the threshold. Set `comment-on-pr: "true"` to post a summary comment on pull requests (updates on re-run). Outputs `average-score` and `result-file` for downstream steps. Action version tracks Tactual version — bump the `uses:` line to pick up patches.

Defaults are conservative: `probe` is off unless enabled because it sends real keyboard events, and forced-colors icon checks run only for profiles that declare `visualModes` such as `nvda-desktop-v0` and `jaws-desktop-v0`.

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

#### Regression gate (CI fail on worse-than-baseline)

Pair `--baseline` with `--fail-on-regression` to turn Tactual into a strict CI gate: save a baseline from a known-good build, then fail PR checks whenever a change regresses N+ findings vs the baseline. The `diff-results` command can also be run separately for human-readable before/after reports.

```yaml
# One-time: snapshot main as the baseline
- name: Snapshot baseline
  if: github.ref == 'refs/heads/main'
  run: |
    npx tactual analyze-url https://preview.your-app.com \
      --format json --output tactual-baseline.json

- name: Upload baseline
  if: github.ref == 'refs/heads/main'
  uses: actions/upload-artifact@v4
  with:
    name: tactual-baseline
    path: tactual-baseline.json

# On PRs: compare against the baseline, fail on regressions
- name: Fetch baseline
  uses: actions/download-artifact@v4
  with:
    name: tactual-baseline

- name: Analyze + gate on regressions
  run: |
    npx tactual analyze-url https://pr-preview-${{ github.event.number }}.your-app.com \
      --format sarif --output results.sarif \
      --baseline tactual-baseline.json \
      --fail-on-regression 3     # fail if 3+ findings regressed
```

Or via the action:

```yaml
- uses: tactual-dev/tactual@v0.4.1
  with:
    url: https://pr-preview.your-app.com
    baseline: tactual-baseline.json
    fail-on-regression: "3"
```

The action mirrors the `analyze-url` CLI surface for analysis inputs, and a CI-to-CLI contract test keeps those fields aligned. Some workflow controls are Action orchestration rather than direct CLI flags: `fail-below` wraps CLI `--threshold`, `comment-on-pr` controls the PR comment step, and SARIF upload is handled by the workflow. The common inputs you'll set include `profile`, `explore`, `explore-depth`, `explore-budget`, `explore-timeout`, `probe`, `probe-mode`, `probe-strategy`, `scope-selector`, `probe-selector`, `entry-selector`, `goal-target`, `goal-pattern`, `stealth`, `channel`, `wait-for-selector`, `exclude`, `exclude-selector`, `focus`, `min-severity`, `max-findings`, `baseline`, `fail-on-regression`, `fail-below`, `validate`, `storage-state`, `summary-only`. The direct-CLI invocation pattern above is still the recommended path when you want a different Tactual version than the action pins.

| Surface | Naming convention | Example |
| ------- | ----------------- | ------- |
| CLI | kebab-case flags | `--probe-strategy modal-return-focus` |
| MCP and library options | camelCase fields | `probeStrategy: "modal-return-focus"` |
| GitHub Action | kebab-case inputs | `probe-strategy: modal-return-focus` |

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
  --explore-timeout <ms>          Total exploration timeout; includes probe time when combined with --probe (default: 60000)
  --explore-max-targets <n>       Max accumulated targets before stopping (default: 2000)
  --allow-action <patterns...>    Allow exploring controls matching these patterns (overrides safety)
  --exclude <patterns...>         Exclude targets by name/role glob
  --exclude-selector <css...>     Exclude elements by CSS selector
  --scope-selector <css...>       Capture, score, and probe only these subtrees
  --focus <landmarks...>          Only analyze within these landmarks
  --suppress <codes...>           Suppress diagnostic codes
  --top <n>                       Show only worst N findings
  --min-severity <level>          Minimum severity to report
  --threshold <n>                 Exit non-zero if avg score < N
  --preset <name>                 Scoring preset (ecommerce-checkout, docs-site, dashboard, form-heavy)
  --config <path>                 Path to tactual.json
  --no-headless                   Headed browser (for bot-blocked sites)
  --channel <name>                Browser channel: chrome, chrome-beta, msedge (uses installed browser; bypasses most bot detection)
  --stealth                       Anti-detection defaults: realistic UA, override navigator.webdriver, spoof plugins/languages
  --user-agent <ua>               Override User-Agent string
  --timeout <ms>                  Page load timeout (default: 30000)
  --probe                         Opt-in runtime keyboard probes for interactive targets
                                    (focus, activation, Escape, Tab).
                                    Also probes menu, dialog, tab, disclosure, combobox/listbox,
                                    and form-error patterns.
                                    When combined with --explore, probes revealed-state targets too
                                    (menu items, dialog bodies, expanded widgets).
  --probe-budget <n>              Override generic-probe budget (default: per --probe-mode)
  --probe-mode <mode>             fast | standard (default) | deep.
                                    fast=5 generic/5 menu/3 modal/5 widget;
                                    standard=20/20/10/20; deep=50/40/20/40.
                                    Budget is shared across initial + all revealed states.
  --probe-selector <css...>       Probe only these subtrees without changing capture/scoring
  --entry-selector <css>          Activate this trigger before capture/probe
  --goal-target <target>          Exact-ish target id/name/role/kind/selector hint
  --goal-pattern <pattern>        Glob target id/name/role/kind/selector hint
  --probe-strategy <strategy>     all | overlay | composite-widget | form |
                                    navigation | modal-return-focus | menu-pattern
  --validate                      Run the virtual screen reader over the captured DOM and include
                                    a predicted-vs-validated step comparison in the output.
                                    Requires optional deps: jsdom + @guidepup/virtual-screen-reader.
  --validate-max-targets <n>      Max findings to validate (default: 10)
  --validate-strategy <mode>      Virtual-SR nav strategy: linear | semantic (default: semantic)
  --check-visibility              Force per-icon contrast check across the profile's visualModes
  --no-check-visibility           Disable per-icon contrast check even if profile declares modes
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
  "scopeSelectors": ["main"],
  "probeSelectors": [".checkout-dialog"],
  "probeStrategy": "modal-return-focus",
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

| Profile                    | Platform | Description                                           |
| -------------------------- | -------- | ----------------------------------------------------- |
| `generic-mobile-web-sr-v0` | Mobile   | Normalized mobile SR primitives (default)             |
| `voiceover-ios-v0`         | Mobile   | VoiceOver on iOS Safari — rotor-based navigation      |
| `talkback-android-v0`      | Mobile   | TalkBack on Android Chrome — reading controls         |
| `nvda-desktop-v0`          | Desktop  | NVDA on Windows — browse mode quick keys              |
| `jaws-desktop-v0`          | Desktop  | JAWS on Windows — virtual cursor with auto forms mode |

Profiles define the cost of each navigation action, score dimension weights, `costSensitivity` (scales the reachability decay curve), and context-dependent modifiers. See `src/profiles/` for implementation details.

**Mobile profile limitation.** The `voiceover-ios-v0` and `talkback-android-v0` profiles model action costs and SR announcement phrasing accurately, but Tactual's keyboard probes (`--probe`) only test desktop interactions (Tab, Enter, Escape). They do NOT simulate touch gestures (single-tap, double-tap, swipe-right, three-finger swipe, rotor rotation, etc.). For mobile profiles, score dimensions reflect predicted cost from the profile model — not measured behavior. Real device testing remains necessary to verify mobile a11y.

**Visual modes.** The `nvda-desktop-v0` and `jaws-desktop-v0` profiles declare a `visualModes` matrix (light/dark × forced-colors on/off) so the analyzer captures per-icon contrast under each combination. Mobile and generic profiles omit this — Windows High Contrast Mode isn't a realistic mobile concern. See **Visibility checks** below.

## Visibility checks

When the active profile declares a `visualModes` matrix, Tactual re-emulates each `(colorScheme, forcedColors)` combination after the initial capture and samples per-icon computed styles. The finding builder compares each icon's computed `fill` against the nearest non-transparent ancestor `background-color` and emits a penalty when contrast falls below the WCAG 1.4.11 non-text threshold (3:1).

Four penalty wordings, three scoring tiers:

| Penalty                               | Trigger                                                                                                                                     | Operability impact       |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------ |
| `Icon invisible in <mode>`            | Contrast < 1.5:1, no adjacent text label                                                                                                    | Operability capped at 60 |
| `Decorative icon invisible in <mode>` | Contrast < 1.5:1, control has visible text label                                                                                            | Operability −5           |
| `Low icon contrast in <mode>`         | Contrast 1.5–3.0:1, no adjacent text label                                                                                                  | Operability −5           |
| `Author-set SVG fill in <mode>`       | Contrast OK in Playwright (≥3:1) but mode is `forced-colors: active` and the fill is an author CSS literal (non-system, non-`currentColor`) | Operability −2           |

The check skips icons that are already HCM-safe: `fill="currentColor"`, `fill: ButtonText` (or any system color), `forced-color-adjust: none` (author opt-out), or computed `fill === color` (CSS-applied currentColor). Low-contrast icons next to a visible text label are suppressed entirely — the label identifies the control and the icon is reinforcement.

**Why the substitution-risk tier exists.** Different user HCM themes have different Canvas/ButtonText/system-color values. An author literal fill (e.g. `svg { fill: #e4e6e6 }`) may contrast well against Chromium's default HCM palette but poorly against a specific user theme. Browser rendering of the literal itself is consistent across Playwright, Chrome, and Edge for `forced-color-adjust: preserve-parent-color` (the default for SVG paths) — the concrete concern is theme variability, not a hidden OS-paint substitution. Tactual flags the pattern so you know to verify in real Edge with a representative HCM theme, not because Playwright's contrast measurement is misleading.

Disable explicitly via `--no-check-visibility`, `checkVisibility: false` in `tactual.json`, or `checkVisibility: false` on the MCP `analyze_url` tool. Force-enable via `--check-visibility` even when a profile doesn't declare modes (no-op without modes).

The check adds roughly +50–200ms per declared mode per page — re-emulating media is cheap; there's no new browser context per mode.

## Scoring Presets

Presets bundle focus filters and priority mappings for common use cases. They layer under config files and CLI flags (preset → tactual.json → CLI flags).

| Preset               | Use case       | Focus            | Critical targets                     |
| -------------------- | -------------- | ---------------- | ------------------------------------ |
| `ecommerce-checkout` | Shopping flows | main             | checkout, cart, payment, buy         |
| `docs-site`          | Documentation  | main, navigation | search, nav                          |
| `dashboard`          | Web apps       | main, navigation | save, submit, create, delete, search |
| `form-heavy`         | Form pages     | main             | submit, save, next, continue, error  |

```bash
npx tactual analyze-url https://shop.com --preset ecommerce-checkout
npx tactual presets  # list all presets with details
```

Presets suppress cookie banners and analytics targets by default. To override, use `--exclude` or set `priority` in `tactual.json`. Presets do not compose — only one `--preset` can be active.

## Scoring

Each target receives a **5-dimension score vector**:

| Dimension       | What it measures                                     |
| --------------- | ---------------------------------------------------- |
| Discoverability | Can the user tell the target exists?                 |
| Reachability    | What is the navigation cost to get there?            |
| Operability     | Does the control behave predictably?                 |
| Recovery        | How hard is it to recover from overshooting?         |
| Interop Risk    | How likely is AT/browser support variance? (penalty) |

Dimension weights vary by profile:

| Profile                  | D    | R    | O    | Rec  | costSensitivity |
| ------------------------ | ---- | ---- | ---- | ---- | --------------- |
| generic-mobile-web-sr-v0 | 0.30 | 0.40 | 0.20 | 0.10 | 1.0             |
| voiceover-ios-v0         | 0.30 | 0.35 | 0.20 | 0.15 | 1.1             |
| talkback-android-v0      | 0.25 | 0.45 | 0.20 | 0.10 | 1.3             |
| nvda-desktop-v0          | 0.35 | 0.25 | 0.30 | 0.10 | 0.7             |
| jaws-desktop-v0          | 0.30 | 0.25 | 0.35 | 0.10 | 0.6             |

**Composite:** Weighted geometric mean: `overall = exp(sum(w_i * ln(score_i)) / sum(w_i)) - interopRisk`. Each dimension is floored at 1 before the log to avoid log(0). A zero in any dimension eliminates that dimension's contribution to the geometric mean, significantly dragging the overall score down -- you cannot operate what you cannot reach.

**Severity bands:**

| Score  | Band       | Meaning                    |
| ------ | ---------- | -------------------------- |
| 90-100 | Strong     | Low concern                |
| 75-89  | Acceptable | Improvable                 |
| 60-74  | Moderate   | Should be triaged          |
| 40-59  | High       | Likely meaningful friction |
| 0-39   | Severe     | Likely blocking            |

## Diagnostics

Tactual detects and reports when analysis may be unreliable:

| Code                        | Level   | Meaning                                                                  |
| --------------------------- | ------- | ------------------------------------------------------------------------ |
| `blocked-by-bot-protection` | error   | Cloudflare/bot challenge detected                                        |
| `empty-page`                | error   | No targets found at all                                                  |
| `possibly-degraded-content` | warning | Suspiciously few targets for an http page                                |
| `sparse-content`            | warning | Only 1-4 targets found                                                   |
| `possible-login-wall`       | warning | Auth-gated content (detects `/login`, `/signin`, `/auth` path redirects) |
| `possible-cookie-wall`      | info    | Cookie consent may obscure content                                       |
| `redirect-detected`         | warning | Landed on different domain                                               |
| `no-headings`               | warning | No heading elements found                                                |
| `heading-skip`              | warning | Heading hierarchy skips a level (e.g., h1 → h3)                          |
| `no-landmarks`              | warning | No landmark regions found                                                |
| `no-skip-link`              | warning | No skip-to-content link on pages with 5+ targets                         |
| `no-main-landmark`          | warning | Missing `<main>` landmark                                                |
| `no-banner-landmark`        | info    | Missing `<header>` / banner landmark                                     |
| `no-contentinfo-landmark`   | info    | Missing `<footer>` / contentinfo landmark                                |
| `no-nav-landmark`           | info    | Missing `<nav>` / navigation landmark                                    |
| `structural-summary`        | info    | One-line structural overview (headings, landmarks, skip link)            |
| `shared-structural-issue`   | warning | Penalty affecting >50% of targets promoted to page-level                 |
| `landmark-demoted`          | warning | HTML landmark exists but demoted by nesting context                      |
| `timeout-during-render`     | warning | A `waitForSelector` did not appear in time during MCP capture            |

## Exploration

The `--explore` flag activates bounded branch exploration:

- Opens menus, tabs, disclosures, accordions, and dialogs
- Captures new accessibility states from hidden UI
- Marks discovered targets as `requiresBranchOpen`
- Respects depth, action count, target count, and novelty budgets
- Safe-action policy blocks destructive interactions

Exploration is useful for pages with significant hidden UI (e.g., dropdown menus, tabbed interfaces, modal dialogs).

Exploration candidates are sorted by a stable key (role + name) before iterating, so the same page content produces the same exploration order across runs.

## Probes

The `--probe` flag measures whether important interactive patterns work after they appear in the accessibility tree. Probes are opt-in because they send real keyboard events and add runtime. Since 0.4.0 this includes generic focus/activation checks, menu contracts, modal dialog contracts, trigger-to-dialog flows, tabs, disclosures, comboboxes, listboxes, and required-field error flows. Probe findings include evidence summaries so reports distinguish measured failures from modeled or heuristic scoring.

Goal-directed controls keep deep probes useful on complex SPAs:

| Need                   | CLI                                         | MCP/Action field                   | Effect                                                                                                                                   |
| ---------------------- | ------------------------------------------- | ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Analyze one subtree    | `--scope-selector "#drawer"`                | `scopeSelector` / `scope-selector` | Captures, scores, and probes only the selected subtree(s).                                                                               |
| Probe one subtree      | `--probe-selector "#drawer"`                | `probeSelector` / `probe-selector` | Keeps page-wide scoring but spends probe budget only inside the selected subtree(s).                                                     |
| Open one branch first  | `--entry-selector "[aria-controls='menu']"` | `entrySelector` / `entry-selector` | Activates the trigger before capture/probe and prioritizes newly revealed targets.                                                       |
| Aim at a known target  | `--goal-target "checkout"`                  | `goalTarget` / `goal-target`       | Narrows probing to matching target ids, names, roles, kinds, or selectors.                                                               |
| Aim by glob            | `--goal-pattern "*dialog*"`                 | `goalPattern` / `goal-pattern`     | Same as goal target, with glob matching.                                                                                                 |
| Spend budget by intent | `--probe-strategy modal-return-focus`       | `probeStrategy` / `probe-strategy` | Runs the probe families relevant to `all`, `overlay`, `composite-widget`, `form`, `navigation`, `modal-return-focus`, or `menu-pattern`. |

For example, to evaluate a modal branch without crawling unrelated menus:

```bash
npx tactual analyze-url https://app.example.com/settings \
  --profile nvda-desktop-v0 \
  --probe \
  --entry-selector "[aria-controls='profile-dialog']" \
  --probe-strategy modal-return-focus \
  --format markdown
```

### Exploration budgets

| Budget  | CLI flag                | Default  | Purpose                                                                           |
| ------- | ----------------------- | -------- | --------------------------------------------------------------------------------- |
| Depth   | `--explore-depth`       | 3        | Max recursion depth                                                               |
| Actions | `--explore-budget`      | 50       | Total click budget across all branches                                            |
| Targets | `--explore-max-targets` | 2000     | Stop if accumulated targets exceed this                                           |
| Time    | `--explore-timeout`     | 60000 ms | Bound total exploration time, including initial probes, branch captures, and revealed-state probes |

**Sizing guidance:**

| Page type                                                    | Suggested settings                                                  | Why                                |
| ------------------------------------------------------------ | ------------------------------------------------------------------- | ---------------------------------- |
| Marketing site, docs page, blog                              | defaults                                                            | Small surface, defaults rarely hit |
| Dashboard with sidebar/menu                                  | `--explore-depth 3 --explore-budget 50` (defaults)                  | Captures one level of menu opens   |
| Complex app (Figma, Notion, etc.)                            | `--explore-depth 4 --explore-budget 100 --explore-max-targets 5000` | Deeper menus, more state           |
| Pages with very large hidden UI (emoji pickers, color grids) | `--explore-max-targets 10000` plus `--exclude "emoji-*"`            | Cap or filter out the firehose     |
| Quick triage of unknown page                                 | `--explore-depth 1 --explore-budget 10`                             | Just open obvious branches, fast   |

If exploration hits the timeout before opening useful branches, raise `--explore-timeout` and `--explore-budget` slowly, or use `--entry-selector`, `--probe-selector`, and `--probe-strategy` to spend the same budget on the branch you care about. If output has duplicate-looking targets, lower `--explore-depth` (deep recursion can re-discover the same elements through different paths).

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
npx tactual diff-results baseline.json candidate.json
```

The diff shows targets that improved, regressed, or changed severity, plus penalties resolved and added. In CI, use the `comment-on-pr` action input to post results on every pull request automatically.

## Interop Risk

Tactual includes a static snapshot of ARIA role/attribute support data derived from [a11ysupport.io](https://a11ysupport.io) and the [ARIA-AT project](https://aria-at.w3.org). Roles with known cross-AT/browser support gaps receive an interop risk penalty.

| Role                        | Risk | Note                             |
| --------------------------- | ---- | -------------------------------- |
| `button`, `link`, `heading` | 0    | Well-supported                   |
| `dialog`                    | 5    | Focus management varies          |
| `combobox`                  | 8    | Most interop-problematic pattern |
| `tree`                      | 10   | Poorly supported outside JAWS    |
| `application`               | 15   | Dangerous if misused             |

## Interpreting Findings

Tactual findings intentionally mix several evidence domains:

- **SR navigation**: landmarks, headings, labels, branch discovery, sequential traversal cost, and modeled announcements.
- **Keyboard operability**: focus movement, activation, Escape recovery, Tab trapping, and runtime widget probes.
- **Structural semantics**: missing names, heading/landmark structure, demoted landmarks, repeated shared causes.
- **Interop risk**: roles and states with known cross-AT/browser support gaps.
- **Pointer-adjacent checks**: target-size and icon visibility issues that can affect users outside the screen-reader navigation model.

That means a page can have a strong screen-reader navigation score and still receive skip-link, target-size, or visibility warnings. Treat those as separate fix categories rather than contradictions.

Probe-derived APG findings are measured consistency warnings. Many widgets have valid implementation variants, especially comboboxes and disclosure-like patterns, so verify the warning against the intended pattern before treating it as a mandatory replacement. Critical flows should still be checked with the target browser/AT combination.

## Output Format Recommendations

| Format     | Typical size | Best for                  |
| ---------- | ------------ | ------------------------- |
| `console`  | ~8KB         | Human review in terminal  |
| `markdown` | ~11KB        | PRs and issue comments    |
| `json`     | ~18KB        | Programmatic consumption  |
| `sarif`    | ~4-40KB      | GitHub Code Scanning / CI |

All non-SARIF reporter formats emit summarized output by default: stats, grouped issues, remediation candidates, evidence summaries, and worst findings (capped at 15). SARIF caps at 25 results. When output is truncated, a note appears at the top. The library API exposes the full `AnalysisResult`; CLI and MCP reporter output is intentionally compact unless a specific field such as `includeStates` is requested.

For MCP usage, `sarif` is the default and recommended format. Use `summaryOnly: true` for a compact health check with stats, severity counts, diagnostics, and the top 3 issues.

## Calibration

Tactual includes a calibration framework (`src/calibration/`, exported as `tactual/calibration`) for tuning scoring parameters against ground-truth datasets. See `docs/CALIBRATION.md` for details.

## Development

```bash
npm install                    # Install dependencies
npm run build                  # Build with tsup
npm run test                   # Run unit + integration tests
npm run test:benchmark         # Run benchmark suites
npm run typecheck              # TypeScript type checking
npm run lint                   # ESLint
```

## Security

### Browser sandboxing

Tactual always runs Playwright with default Chromium sandboxing enabled. It never disables web security or modifies the browser's security model. All page interactions happen within the standard Chromium process sandbox.

### Safe-action policy

When exploration is enabled (`--explore`), Tactual classifies interactive elements into three tiers before activating them:

| Tier        | Action              | Examples                                                                               |
| ----------- | ------------------- | -------------------------------------------------------------------------------------- |
| **Safe**    | Activated           | Tabs, menu items, disclosures, accordions, same-page anchors                           |
| **Caution** | Activated with care | External links, ambiguous buttons                                                      |
| **Unsafe**  | Skipped             | Submit buttons (outside search forms), Delete, sign out, purchase, deploy, unsubscribe |

This is a keyword-based heuristic — it cannot detect semantic deception (e.g., a "Save" button that actually deletes data) or inspect server-side behavior. For production use, always run exploration against trusted or sandboxed environments.

### URL validation

All URLs are validated before navigation. Only `http:`, `https:`, and `file:` schemes are accepted; `javascript:`, `data:`, `blob:`, and `vbscript:` are rejected. URLs with embedded credentials (e.g. `https://user:pass@host/`) are also rejected. Private/internal IP ranges are **not** filtered — running Tactual in an environment with access to internal services is equivalent to letting any other Playwright-driven tool reach them, so treat the URL input as trusted input.

## License

Apache-2.0

### Attribution

The simulator's role/state phrasing is calibrated against the [W3C ARIA-AT project](https://github.com/w3c/aria-at), which is licensed under [CC-BY 4.0](https://creativecommons.org/licenses/by/4.0/). Tactual does not bundle ARIA-AT data; the calibration script (`npm run calibrate`) fetches assertions from the upstream repository at run time. If you publish Tactual calibration results, please attribute the W3C ARIA-AT project as the source of the ground-truth assertions.

ARIA role/attribute support data referenced in interop risk scoring is derived from [a11ysupport.io](https://a11ysupport.io) and the same ARIA-AT project.
