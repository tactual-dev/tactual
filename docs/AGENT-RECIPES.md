# Agent Recipes

Prompt templates for using Tactual's MCP tools with AI coding agents (Claude Code, Cursor, Windsurf, Cline, GitHub Copilot).

## Setup

Install Tactual in the project, then add the MCP server to your agent config (see README for editor-specific paths):

```bash
npm install tactual
```

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

## Recipes

### Quick audit

> Analyze https://myapp.com for screen-reader navigation cost. Show me the worst findings and what to fix first.

The agent will call `analyze_url` with default settings and summarize the results.

### Deep audit with probes

> Run a full Tactual analysis on https://myapp.com with exploration enabled and keyboard probes. Use the NVDA desktop profile.

This explores hidden UI (menus, dialogs, tabs, disclosures) and tests actual keyboard, widget-contract, and form-error behavior. Takes longer but catches real focus management and APG-pattern issues.

### SPA audit

> Analyze https://app.example.com after it hydrates. Wait for main, record route changes, surface lazy content, include iframes, and check mobile/desktop viewport differences.

The agent should call `analyze_url` with `waitForSelector`, `detectRoutes`, `autoScroll`, `descendFrames`, and `diffViewports`. Add `dismissBanners`, `probeHover`, or `walkTabOrder` when the page has consent overlays, hover-only UI, or suspicious focus-order behavior.

### Fix the worst findings

> Analyze https://myapp.com with Tactual, then fix the top 3 findings in our codebase. Run the analysis again after fixing to verify improvement.

The agent will:

1. Run `analyze_url` to identify issues
2. Use the `selector` field on each finding to locate elements in your code
3. Apply fixes (add landmarks, headings, aria-labels, skip links)
4. Re-run and compare using `diff_results`

### Trace a specific element

> Use Tactual to trace the navigation path to the checkout button on https://myshop.com. How many steps does it take a screen reader user to reach it?

Calls `trace_path` and explains each step — what the screen reader announces, what action the user takes, and the cumulative cost.

### Compare before and after

> I just refactored the nav. Run Tactual on https://myapp.com with format=json, save the result, then switch to my feature branch, rebuild, and run it again. Compare the two results and tell me if anything got worse.

Uses `analyze_url` twice and `diff_results` to show what improved, regressed, or changed severity.

### Site triage

> Scan these 5 pages with Tactual and tell me which one needs the most work:
>
> - https://myapp.com/
> - https://myapp.com/dashboard
> - https://myapp.com/settings
> - https://myapp.com/checkout
> - https://myapp.com/help

Calls `analyze_pages` for a site-level overview, including repeated navigation-cost groups across pages, then the agent can drill into the worst page.

### Focused remediation target

> Use Tactual against this local preview and identify one high-confidence accessibility fix candidate. Prefer one root cause in one shared component. Include route, command, evidence, user impact, likely code area, and suggested verification. Do not lead with score movement unless it supports the user impact.

The agent should:

1. Run `analyze_pages` across representative routes when several routes are available
2. Run `analyze_url` with `explore=true`, `probe=true`, and an appropriate desktop AT profile on the strongest route
3. If the likely issue is inside a modal, drawer, form, or widget, rerun `analyze_url` with `entrySelector`, `probeSelector`, and a matching `probeStrategy` so the next pass focuses on that branch
4. Use `remediationCandidates`, `issueGroups`, selectors, and evidence summaries to choose one root cause
5. Inspect the local source to confirm where the behavior comes from
6. If code changes are in scope, patch the shared component, then re-run Tactual and compare before/after with `diff_results`

Use the findings and candidate evidence to keep the proposed change narrow, reproducible, and compatible with the project's review expectations.

### Feed announcement observations back into calibration

> While reviewing this OSS page with Tactual, I verified that NVDA announced the checkout button as "Checkout, link" even though Tactual modeled "Checkout, button". Record this as calibration feedback.

Prefer the `observe-announcement` CLI helper. It can reuse a saved analysis so
the reviewer does not need to keep the live page and screen reader active while
typing notes:

```bash
npx tactual observe-announcement "Checkout" \
  --analysis checkout-nvda.json \
  --observed-file nvda-checkout-announcement.txt \
  --source nvda-vm \
  --at-version "NVDA 2025.1" \
  --browser "Chrome 137" \
  --output calibration.json \
  --append
```

Use `observedAnnouncement` when the output is known verbatim, or
`observedAnnouncementTokens` when only the stable role/name/state tokens matter.
Include `announcementSource` so reports distinguish manual SR output from
virtual SR, fixture, or ARIA-AT evidence. The calibration runner compares those
tokens against Tactual's modeled announcement and reports missing or unexpected
tokens.

```json
{
  "url": "https://preview.example.com/checkout",
  "profileId": "nvda-desktop-v0",
  "targetName": "Checkout",
  "observedAnnouncement": "Checkout, link",
  "announcementSource": "nvda-vm",
  "testerId": "oss-review",
  "timestamp": "2026-06-11T12:00:00Z"
}
```

### Run calibration scoring review

> I collected NVDA VM observations in calibration/nvda-vm.json and saved full Tactual analyses in calibration/analyses. Run the calibration report and tell me which scoring assumptions are confirmed, which need review, and which should not affect scoring yet.

The agent should call MCP `calibration_report` so the output is structured and
easy to inspect:

```json
{
  "datasetPath": "calibration/nvda-vm.json",
  "analysisDir": "calibration/analyses",
  "format": "json"
}
```

Read `scoringSignals` first. Treat `confirmed` signals as regression evidence,
`review` signals as candidates for repeated calibration, `observed-only` signals
as useful but not weight-changing yet, and `blocked` signals as harness issues to
fix before drawing scoring conclusions. Do not tune weights from a single noisy
announcement mismatch; look for repeated assumption IDs, repeated strategy
switches, or consistent reachability/discoverability bias.

### Authenticated content

> Save an auth session for https://myapp.com/login, then analyze the dashboard.

The agent will call `save_auth` with fill/click steps, then `analyze_url` with the saved `storageState`.

**Security:** Never paste real credentials into prompts. Credentials in chat land in conversation logs and may be cached. Instead, log in manually with `npx tactual save-auth` and pass the resulting `storageState` file to subsequent analysis runs.

### Focus on a specific area

> Analyze https://myapp.com but only look at the main content area. Exclude the cookie banner and notification popups.

```
focus: ["main"], scopeSelector: ["main"], excludeSelector: ["#cookie-banner", ".notifications"]
```

### Probe a specific branch

> Open the settings dialog on https://myapp.com/settings and test whether the modal flow works for keyboard and screen-reader users.

```json
{
  "url": "https://myapp.com/settings",
  "profile": "nvda-desktop-v0",
  "probe": true,
  "entrySelector": "[aria-controls='settings-dialog']",
  "probeStrategy": "modal-return-focus"
}
```

### PR review check

> Before I merge this PR, analyze https://preview-123.myapp.com with Tactual using the VoiceOver iOS profile. Are there any severe or high findings?

Uses `minSeverity: "high"` to filter noise and focus on blocking issues.

## CLAUDE.md snippet

Add this to your project's `CLAUDE.md` to make Tactual available during accessibility work:

```markdown
## Accessibility

This project uses Tactual for screen-reader navigation cost analysis.
When working on UI changes, run `analyze_url` on the affected page before
and after changes. Use `diff_results` to verify no regressions. Focus on
findings with severity "severe" or "high" — these indicate real barriers
for screen-reader users.

Key Tactual patterns:

- Missing landmarks → add <main>, <nav>, <header>, <footer>
- Missing headings → add heading hierarchy (h1 > h2 > h3)
- No skip link → add a skip-to-content link as first focusable element
- Nested focusable → remove inner tabindex or set outer to tabindex="-1"
- No accessible name → add aria-label or visible text
```
