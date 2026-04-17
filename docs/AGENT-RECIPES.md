# Agent Recipes

Prompt templates for using Tactual's MCP tools with AI coding agents (Claude Code, Cursor, Windsurf, Cline, GitHub Copilot).

## Setup

Add to your project's MCP config (see README for editor-specific paths):

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

This explores hidden UI (menus, dialogs, tabs) and tests actual keyboard behavior. Takes longer but catches real focus management issues.

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
> - https://myapp.com/
> - https://myapp.com/dashboard
> - https://myapp.com/settings
> - https://myapp.com/checkout
> - https://myapp.com/help

Calls `analyze_pages` for a quick site-level overview (~200 bytes per page), then the agent can drill into the worst page.

### Authenticated content

> Save an auth session for https://myapp.com/login, then analyze the dashboard.

The agent will call `save_auth` with fill/click steps, then `analyze_url` with the saved `storageState`.

**Security:** Never paste real credentials into prompts. Credentials in chat land in conversation logs and may be cached. Instead, log in manually with `npx tactual save-auth` and pass the resulting `storageState` file to subsequent analysis runs.

### Focus on a specific area

> Analyze https://myapp.com but only look at the main content area. Exclude the cookie banner and notification popups.

```
focus: ["main"], excludeSelector: ["#cookie-banner", ".notifications"]
```

### PR review check

> Before I merge this PR, analyze https://preview-123.myapp.com with Tactual using the VoiceOver iOS profile. Are there any severe or high findings?

Uses `minSeverity: "high"` to filter noise and focus on blocking issues.

## CLAUDE.md snippet

Add this to your project's `CLAUDE.md` to make Tactual analysis automatic during accessibility work:

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
