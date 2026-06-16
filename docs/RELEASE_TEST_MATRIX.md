# Release Test Matrix

Run `npm run test:release` before cutting a public release candidate. It is the
canonical local release gate and intentionally splits browser-heavy tests into
bounded chunks.

For targeted local debugging, list shards with `npm run test:shard -- --list`
and run one with `npm run test:shard -- <shard>`. `npm run test:shards` runs
the same shard set without the audit/build/calibration/smoke release gates.

## Required Gates

| Area | Gate |
|---|---|
| Production dependencies | `npm audit --omit=dev` |
| Type safety | `npm run typecheck` |
| Static checks | `npm run lint` |
| Unit and integration tests | named Vitest shards from `scripts/vitest-shards.mjs` |
| Build artifacts and declarations | `npm run build` |
| Announcement simulator calibration | `npm run calibrate` |
| Calibration corpus coverage audit | `npm run calibration:corpus` |
| Calibration tuning matrix | `npm run calibration:matrix` |
| Installed package smoke | `npm run smoke:pack` |
| Release smoke evidence | `npm run smoke:release` |

## Feature Coverage Checklist

| Capability | Deterministic coverage |
|---|---|
| Chromium OOPIF recovery | `src/playwright/capture-frames.test.ts`, `src/playwright/cdp-ax-serializer.test.ts`, SPA pipeline fixture |
| Same-origin iframe parity | `src/playwright/cdp-ax-serializer.test.ts` calibration fixture |
| Firefox/WebKit inaccessible-frame behavior | capture tests assert graceful skip semantics rather than CDP-only assumptions |
| Nested and capped frame descent | `src/playwright/capture-frames.test.ts` |
| Lazy iframe content after auto-scroll | `src/pipeline/spa-navigation-targets.test.ts`, `src/benchmark/benchmark.test.ts` |
| SPA route mutation | `src/pipeline/spa-crawl-integration.test.ts`, `src/pipeline/spa-navigation-targets.test.ts`, benchmark pipeline coverage |
| Dense navigation distractors | SPA navigation-target fixture |
| Composite widgets and active descendants | `src/core/graph-builder.test.ts`, widget/probe tests, SPA navigation-target fixture |
| ARIA relationship jumps | `src/core/graph-builder.test.ts`, SPA navigation-target fixture |
| Mobile/touch exploration paths | profile graph tests and SPA navigation-target fixture |
| Calibration report output and CLI scoring-signal workflow | `src/calibration/calibration.test.ts`, `src/cli/cli.test.ts` |
| Versioned calibration corpus import/audit | `src/cli/calibration-corpus-script.test.ts`, `calibration/corpus/README.md` |
| Calibration tuning matrix script | `src/cli/calibration-matrix-script.test.ts`, `scripts/calibration-matrix.mjs` |
| Modeled vs observed announcement feedback | `src/calibration/calibration.test.ts`, `src/cli/cli.test.ts` |
| Controlled NVDA VM observation artifacts | `scripts/nvda-vm-observe.mjs`, `src/cli/nvda-vm-observe-script.test.ts` |
| CLI/MCP/Action surface parity | CLI tests, MCP handler/tool tests, Action/workflow docs review |

## Smoke Evidence

`npm run smoke:release` writes `build/release-smoke/summary.json`.

By default it analyzes packaged local fixtures. To add live targets for a release
candidate, provide a comma- or newline-separated list:

```bash
TACTUAL_RELEASE_SMOKE_URLS="https://example.com,https://app.example.test" npm run smoke:release
```

Live smoke targets should be treated as release evidence, not as stable CI
fixtures. Public websites change, block automation, and may expose different
content by region, account state, viewport, consent state, or anti-bot policy.

## Known-Pages Benchmark

`npm run benchmark:known-pages` runs the built CLI against a curated set of
complex SPA/component-library documentation pages with the 0.5 capture helpers
enabled (`--detect-routes`, `--auto-scroll`, `--descend-frames`,
`--dismiss-banners`, `--probe-hover`, `--walk-tab-order`, `--diff-viewports`,
and bounded `--explore`). It writes ignored artifacts under
`build/known-pages-*`.

This benchmark is optional release evidence, not a required gate. The report
separates documentation-shell navigation cost, component implementation issues,
composite-widget interop, visual-mode checks, and capture-quality failures so
live-site surprises can be triaged without confusing a blocked/challenged
reference page for a widget-quality result.

For a bounded release-candidate smoke, use
`node scripts/known-pages-corpus.mjs --build --limit 1`. Add
`--include-capture-probes` when you specifically want to document whether live
APG/W3C references are reachable from the current browser environment.

## Drift Review

Use `npm run release:drift -- <baseline.json> <candidate.json>` when scoring,
capture, or graph modeling changes. The script summarizes target/finding count
changes, severity mix, mean path movement, frame recovery/skips, diagnostics,
and largest finding score changes. Include expected drift in release notes when
baselines need regeneration.
