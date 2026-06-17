# Calibration Corpus

This directory contains versioned calibration evidence that is safe to keep with
the repo. Local VM run folders under `build/nvda-vm/` are still useful working
artifacts, but selected runs should be imported here before they are treated as
release evidence.

The corpus is intentionally git-tracked so calibration claims can be reviewed
and reproduced with the same evidence that informed a release. It is excluded
from the npm package by `package.json#files`, so it affects clone size/history
but not installed-package size.

Keep this directory lean:

- `dataset.json` stores portable observations.
- `manifest.json` stores portable case summaries and scoring signals.
- `evidence/**/sequence-plan.json` stores the planned target order needed to
  detect sequence-plan drift.
- `analyses/*.analysis.full.json` stores one shared full analysis snapshot per
  fixture, keyed by `tactual-fixture://...` URLs.

Detailed review queues, speech alignment dumps, host summaries, batch reports,
screen captures, and generated `audit.json` / `matrix.json` outputs belong under
`build/` or `.tmp/` unless a reviewer intentionally promotes a small artifact.
If the durable corpus grows beyond low-megabyte seed evidence, move bulky
artifacts to external storage or Git LFS and keep only portable datasets,
manifests, shared analyses, and minimal sequence-plan evidence in git.

## Current Seed

Imported seed corpora:

- `nvda-vm-at-mapper-form-field-2026-06-12`
  - Fixture: `fixtures/calibration-at-mapper-lab.html`
  - Mode: `form-field`
  - Result: 17/17 planned targets matched; 17 scripted full navigation
    observations imported
- `nvda-vm-widgets-form-field-2026-06-13`
  - Fixture: `fixtures/corpus-widget-contracts.html`
  - Mode: `form-field`
  - Result: 4/4 planned targets matched; 4 scripted full navigation
    observations imported
- `nvda-vm-smoke-mixed-modes-2026-06-12`
  - Fixtures: `fixtures/good-page.html`, `fixtures/interactive-page.html`,
    `fixtures/corpus-widget-contracts.html`,
    `fixtures/calibration-at-mapper-lab.html`
  - Modes: `tab`, `button`, `form-field`
  - Result: 17 reusable announcement observations and 18 scripted full
    navigation observations imported
- `nvda-vm-productive-tab-form-field-2026-06-12`
  - Fixtures: `fixtures/good-page.html`,
    `fixtures/calibration-at-mapper-lab.html`
  - Modes: `tab`, `form-field`
  - Result: 13 reusable announcement observations and 13 scripted full
    navigation observations imported
- `nvda-vm-current-structural-repeat-2026-06-13`
  - Fixtures: `fixtures/good-page.html`,
    `fixtures/calibration-at-mapper-lab.html`
  - Modes: `heading`, `link`, `landmark`
  - Result: 39 reusable announcement observations and 39 scripted full
    navigation observations imported; blocked/weak harness cases summarized as
    scoring signals but not imported as full observations
- `nvda-vm-current-button-single-2026-06-13`
  - Fixture: `fixtures/good-page.html`
  - Mode: `button`
  - Result: 3 reusable announcement observations and 3 scripted full
    navigation observations imported; blocked follow-on cases summarized as
    harness-health signals but not imported as full observations
- `nvda-vm-oopif-form-field-2026-06-14`
  - Fixture: `fixtures/calibration-oopif-parent.html`
  - Mode: `form-field`
  - Result: 7/7 planned targets matched with input-bound extraction and OOPIF
    initial-speech readiness; 7 reusable announcement observations and 7
    scripted full navigation observations imported
- `nvda-vm-oopif-tab-2026-06-14`
  - Fixture: `fixtures/calibration-oopif-parent.html`
  - Mode: `tab`
  - Result: 9/9 planned Tab targets matched, including parent controls and
    cross-origin OOPIF payment controls; 9 reusable announcement observations
    and 9 scripted full navigation observations imported. A weak same-batch
    form-field run is summarized in the manifest but is not used as the
    authoritative form-field corpus.
- `nvda-vm-form-field-input-bound-2026-06-14`
  - Fixtures: `fixtures/good-page.html`,
    `fixtures/corpus-widget-contracts.html`,
    `fixtures/calibration-at-mapper-lab.html`,
    `fixtures/calibration-spa-route-lab.html`
  - Mode: `form-field`
  - Result: 26/26 planned targets matched after requiring speech from the
    scripted `F` navigation key; 26 reusable announcement observations and 26
    scripted full navigation observations imported
- `nvda-vm-spa-button-2026-06-14`
  - Fixture: `fixtures/calibration-spa-route-lab.html`
  - Mode: `button`
  - Result: 2/2 planned targets matched; 2 reusable announcement observations
    and 2 scripted full navigation observations imported
- `nvda-vm-structured-button-2026-06-14`
  - Fixture: `fixtures/calibration-structured-lab.html`
  - Mode: `button`
  - Result: 4/4 planned targets matched; 4 reusable announcement observations
    and 4 scripted full navigation observations imported
- `nvda-vm-structured-heading-shared-2026-06-14`
  - Fixture: `fixtures/calibration-structured-lab.html`
  - Mode: `heading`
  - Result: 4/4 planned targets matched using shared VM artifacts; 4 reusable
    announcement observations and 4 scripted full navigation observations
    imported
- `nvda-vm-spa-heading-link-formfield-2026-06-14`
  - Fixture: `fixtures/calibration-spa-route-lab.html`
  - Modes: `heading`, `link`, `form-field`
  - Result: 8/8 planned targets matched with per-case VM recycling; 8 reusable
    announcement observations and 8 scripted full navigation observations
    imported
- `nvda-vm-oopif-heading-button-2026-06-14`
  - Fixture: `fixtures/calibration-oopif-parent.html`
  - Modes: `heading`, `button`
  - Result: 7/7 planned heading/button targets matched; 7 reusable
    announcement observations and 7 scripted full navigation observations
    imported; blocked form-field/tab cases are summarized as scoring signals
    but not imported as full observations

Current audited coverage:

- Full navigation observations: 161
- Scripted VM full observations: 161
- Manual full observations: 0
- Announcement observations: 160
- Profiles: `nvda-desktop-v0`
- Source: `nvda-vm`
- Mode coverage: `form-field`, `link`, `heading`, `tab`, `landmark`,
  `button`
- Fixture coverage: 7 fixture pages
- Role coverage: 14 roles (`link`, `button`, `heading`, `checkbox`,
  `combobox`, `radio`, `region`, `textbox`, `searchbox`, `spinbutton`,
  `banner`, `main`, `navigation`, `listbox`)
- AT/browser: NVDA 2026.1.1 with Microsoft Edge in the guest VM
- Readiness: mapper confidence met; scripted reachability tuning met;
  subjective score tuning not met

This meets the numeric mapper-confidence threshold for the NVDA desktop profile,
and the numeric full-observation threshold for scripted VM reachability
evidence. Use these full records for reachability/action-cost calibration first;
they are not a substitute for manual SR observations when tuning subjective
severity, operability, or recovery weights.

The tuning matrix is stricter than the raw coverage audit: it excludes scripted
records when their imported `sequence-plan.json` came from an older planner that
omitted targets the current mapper now knows NVDA reaches. Those records remain
useful announcement evidence, but they should not pull action-cost tuning.

## Commands

Import a vetted NVDA batch:

```powershell
node scripts/calibration-corpus.mjs import-nvda-batch `
  --batch build\nvda-vm\calibration-batch-name\YYYY-MM-DD-HHMMSS `
  --out calibration\corpus\my-corpus-name `
  --label my-corpus-name `
  --derive-full-observations
```

Audit coverage:

```bash
npm run calibration:corpus
node scripts/calibration-corpus.mjs audit --format json --output build/calibration-corpus-audit.json
```

Report the calibration tuning matrix:

```bash
npm run build
npm run calibration:matrix
node scripts/calibration-matrix.mjs --format json --output build/calibration-matrix.json
```

Current matrix highlights:

- Matched full observations: 161.
- Trusted reachability observations: 145.
- Sequence-plan drift observations excluded from tuning: 16.
- Trusted reachability MAE: 0 steps.
- Trusted reachability bias: 0 steps.
- No non-zero trusted reachability drift groups remain in the current seeded
  corpus.
- All full evidence is still scripted VM evidence; use it for reachability and
  action costs before subjective score weights.

Run a calibration report for one imported corpus:

```bash
npx tactual calibration-report \
  calibration/corpus/nvda-vm-at-mapper-form-field-2026-06-12/dataset.json \
  --analysis-dir calibration/corpus/analyses \
  --format json
```

## Collection Targets

Before score-weight tuning:

- 50+ full `GroundTruthObservation` records per profile.
- Scripted VM full observations are enough to tune reachability/action-cost
  assumptions; manual SR full observations are still required before tuning
  subjective severity, operability, or recovery weights.
- Repeated targets across at least `tab`, `heading`, `landmark`, `button/link`,
  and `form-field` modes.
- Multiple fixtures and real-page captures, especially SPAs, OOPIF payment
  fields, auth/account flows, search/filter pages, dialogs, and composite
  widgets.
- Repeat target/mode runs where feasible so timing and speech-block coalescing
  can be separated from stable mapper behavior.

Before mapper-confidence claims:

- 50+ announcement observations per profile.
- Repeat observed mismatches by assumption ID before changing generic phrasing.
- Keep value/user-data tokens as target-specific observations unless the value
  is intentionally captured and privacy-reviewed.

## Interpretation

`manifest.json` preserves portable case summaries and VM-derived
`scoringSignals`. `dataset.json` contains portable observation records with
transient localhost URLs rewritten to `tactual-fixture://...` URLs. The shared
`analyses/` directory contains matching full analysis JSON with the same
portable URLs.

Treat `confirmed` signals as regression evidence, `review` signals as candidates
for repeated collection, `observed-only` signals as evidence that should not
change weights, and `blocked` signals as harness issues.
