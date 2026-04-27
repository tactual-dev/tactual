# Copilot Instructions — Tactual

## Surface Parity Mandate (REQUIRED)

Tactual is a single-package TypeScript repo with several public surfaces:

- Library exports: `tactual`, `tactual/playwright`, `tactual/mcp`, `tactual/validation`, `tactual/calibration`
- CLI: `tactual`
- MCP server: `tactual-mcp` (stdio by default, Streamable HTTP optional)
- GitHub Action: `action.yml`
- Hosted/container metadata: `Dockerfile`, `smithery.yaml`, `glama.json`

Before changing user-visible behavior, check and keep these in sync:

- `src/cli/index.ts`
- `src/mcp/index.ts`
- `README.md`
- `CHANGELOG.md`
- `action.yml` when the GitHub Action surface is affected
- Relevant tests (`src/cli/cli.test.ts`, `src/mcp/mcp.test.ts`, reporter/playwright tests as appropriate)

If a change affects marketplace or registry metadata, also check `package.json`, `server.json`, `glama.json`, and `smithery.yaml`.

## Architecture Overview

- `src/core/` — shared types, config/filtering, graph building, path analysis, analyzer, finding builder
- `src/playwright/` — page capture, exploration, probes, and safe-action policy
- `src/reporters/` — JSON / Markdown / Console / SARIF output
- `src/mcp/` — MCP tool registration, trace helpers, HTTP transport
- `src/profiles/` — AT profile definitions and registration
- `src/rules/` — rule-based penalties and fix suggestions
- `src/calibration/` and `src/benchmark/` — tuning and validation surfaces
- Tests are mostly colocated as `*.test.ts`

Read `ARCHITECTURE.md` before larger refactors and `README.md` before changing user-facing claims or examples.

## Output Contract (REQUIRED)

- `json`, `markdown`, and `console` output are summarized. The summary contract lives in `src/reporters/summarize.ts`; do not replace it with raw full-result dumps casually.
- `sarif` is the concise actionable format for CI/MCP use. `src/reporters/sarif.ts` intentionally caps results to stay LLM-friendly.
- Findings carry Playwright-style locator selectors. Do **not** describe them as CSS selectors unless the representation is intentionally changed across code, docs, and tests.
- `summaryOnly` already exists in both CLI and MCP. If you change its shape or behavior, update both surfaces and their docs/tests together.

## Exploration and Safety (REQUIRED)

- Explore mode is bounded and safety-filtered. Preserve exploration budgets, `provenance: "explored"`, `requiresBranchOpen`, and safe-action checks unless the change explicitly redefines that contract.
- `excludeSelector` and `waitForSelector` accept CSS selectors. Findings do not.
- `save_auth` has real side effects; keep tool descriptions explicit about writes and browser interactions.
- URL validation, selector handling, storage-state path handling, and safe-action policy are security-sensitive. Read `SECURITY.md` before changing them.

## Public API and Extension Guidance

- New AT profile: add a file under `src/profiles/`, register it in `src/profiles/index.ts`, update tests, and document it if public.
- New reporter: add the formatter, wire `src/reporters/index.ts`, update CLI/MCP exposure if needed, and document when to use it.
- New rule or scoring change: update the relevant tests and refresh `README.md` / `ARCHITECTURE.md` if scoring semantics or terminology change.
- New MCP tool or parameter: update the tool schema/description, CLI parity where applicable, README setup/examples, and `src/mcp/mcp.test.ts` / `src/cli/cli.test.ts`.

## Validation Commands

```bash
npm run build
npm run test
npm run typecheck
npm run lint
npm run test:benchmark
npx playwright install chromium
```

Use benchmark/integration coverage when changing Playwright capture, browser timing, exploration, probes, or other behavior that depends on live page interaction.
