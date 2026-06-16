# Calibration Guide

Tactual's scoring model uses weights and decay curves that are currently based on informed estimates, not empirical data. The calibration framework lets us systematically improve these weights using ground-truth observations from real screen-reader users.

The built-in `npm run calibrate` gate compares the simulator against curated ARIA-AT role/name/state-token assertions. Passing those assertions is useful regression protection for covered patterns, but it is not a claim of full screen-reader fidelity. It does not cover every browse mode, verbosity setting, timing behavior, user strategy, browser/AT pairing, or valid widget implementation variant.

For OSS review work where you can deterministically observe what an AT
announced, include that feedback directly on the observation. Use
`observedAnnouncement` for a verbatim string, or `observedAnnouncementTokens`
when the exact phrasing is noisy but the important role/name/state tokens are
known. Add `announcementSource` (`manual-sr`, `nvda-vm`, `virtual-sr`,
`fixture`, `aria-at`, or `other`) so reports do not overstate the evidence. The
calibration runner compares those tokens against Tactual's modeled announcement
and reports missing or unexpected terms.

Calibration also records per-token AT mapper assumptions. For example, a modeled
NVDA announcement of `Submit, button` is backed by separate assumptions for the
captured accessible name and the NVDA role phrase for `button`. If a VM
observation says `Submit, link`, the name assumption is confirmed and
`announcement.nvda.role.button` is marked missing. Treat that as a mapper
calibration signal first: either the simulator phrasing is wrong for the tested
AT/browser/mode, the captured role is wrong, or the page changed between capture
and observation.

## Why calibrate?

The scoring model makes predictions like "this button has reachability score 70" — meaning it thinks the button takes moderate effort to reach. But is that prediction accurate? Does a reachability score of 70 actually correspond to moderate difficulty for a real NVDA user?

Calibration answers this by comparing Tactual's predictions against human tester observations, then measuring where the model is systematically too optimistic or pessimistic.

## What we need

**Observations**: a tester using a real screen reader navigates to specific targets on a page and records:
- How many actions it took to reach the target
- How they found it (heading nav, landmark, search, linear)
- How long discovery took
- Whether they could operate and recover from it
- A 1-5 difficulty rating

**Per observation**: ~2-3 minutes. A full page with 10-15 targets takes 20-30 minutes.

**Target**: 50+ observations per profile for statistically meaningful calibration. Even 10-20 per profile is useful for identifying gross biases.

## How to collect data

### 1. Pick pages to test

Good calibration pages have a mix of:
- Well-structured sections (proper headings, landmarks)
- Poorly-structured sections (deep nesting, missing labels)
- Interactive widgets (menus, dialogs, tabs, forms)

The `fixtures/` directory in the [Tactual GitHub repo](https://github.com/tactual-dev/tactual/tree/main/fixtures) has HTML files suitable for local testing. The npm package also ships those fixtures so release smoke tests and local calibration examples can resolve them from an installed package. Real-world pages (GitHub, Wikipedia, your own app) are even better.

### 2. Run Tactual on each page

```bash
npx tactual analyze-url https://example.com -p nvda-desktop-v0 -f json --full-json -o example-nvda.json
```

This gives you Tactual's predictions to compare against.

### 3. Record observations

Create a JSON file following this schema:

```json
{
  "name": "my-calibration-set",
  "collectedAt": "2026-04-03T12:00:00Z",
  "observations": [
    {
      "url": "https://example.com",
      "profileId": "nvda-desktop-v0",
      "targetName": "Search",
      "observedAnnouncement": "Search, edit",
      "observedAnnouncementTokens": ["Search", "edit"],
      "announcementSource": "manual-sr",
      "actualStepsToReach": 3,
      "strategyUsed": "landmark",
      "requiredStrategySwitch": false,
      "knewTargetExisted": true,
      "timeToDiscoverSeconds": 1,
      "discoveryMethod": "landmark-nav",
      "couldOperate": true,
      "couldRecover": true,
      "difficultyRating": 1,
      "testerId": "tester-alice",
      "atVersion": "NVDA 2024.4",
      "browser": "Chrome 131",
      "timestamp": "2026-04-03T12:05:00Z"
    }
  ]
}
```

#### Field reference

| Field | Type | Description |
|---|---|---|
| `url` | string | Page URL (must match the URL you ran Tactual on) |
| `profileId` | string | Tactual profile ID matching the AT used |
| `targetName` | string | Target name or text (matched against Tactual's targets) |
| `targetSelector` | string? | Optional CSS selector for precise matching |
| `announcementAt` | string? | Optional simulator target for announcement comparison: `nvda`, `jaws`, or `voiceover`; defaults from `profileId` when possible |
| `observedAnnouncement` | string? | Verbatim AT output observed during review or produced by a deterministic fixture |
| `observedAnnouncementTokens` | string[]? | Semantic tokens observed in AT output when exact wording is noisy |
| `announcementSource` | string? | `manual-sr`, `nvda-vm`, `virtual-sr`, `fixture`, `aria-at`, or `other`; defaults to `manual-sr` |
| `actualStepsToReach` | number | Discrete actions from page load to target |
| `strategyUsed` | string | "linear", "heading", "landmark", "search", "mixed" |
| `requiredStrategySwitch` | boolean | Had to change strategy to find it? |
| `knewTargetExisted` | boolean | Did you know it was there before looking? |
| `timeToDiscoverSeconds` | number | Seconds to realize the target exists |
| `discoveryMethod` | string | "heading-nav", "landmark-nav", "linear-scan", "search", "guessed" |
| `couldOperate` | boolean | Could you activate/use the target? |
| `couldRecover` | boolean | Could you get back to a known position? |
| `recoverySteps` | number? | Actions to return to known position |
| `difficultyRating` | 1-5 | 1=trivial, 2=easy, 3=moderate, 4=hard, 5=blocking |
| `testerId` | string | Anonymous identifier |
| `atVersion` | string? | e.g., "NVDA 2024.4", "VoiceOver iOS 18" |
| `browser` | string? | e.g., "Chrome 131", "Safari 18" |
| `timestamp` | string | ISO 8601 timestamp |
| `observationSource` | string? | Optional full-observation provenance: `manual-sr`, `nvda-vm-scripted`, `fixture-derived`, or `other` |
| `observationUse` | object? | Optional per-dimension hints. Scripted VM records set reachability/announcement to true and mark subjective dimensions as proxy or false. |

`actualAnnouncement` and `actualAnnouncementTokens` are accepted as
compatibility aliases for pre-release datasets. Prefer the `observed*` fields
for new data because AT output changes with version, browser, verbosity, focus
mode, and page state.

### 4. Run calibration

Most users should run calibration through the CLI so dataset URLs, analysis
files, and scoring signals are checked in one workflow:

```bash
npx tactual calibration-report my-calibration.json \
  --analysis example-nvda.json \
  --format markdown \
  --output calibration-report.md
```

For multi-page datasets, pass every saved full analysis JSON or point at a
directory of JSON files:

```bash
npx tactual calibration-report my-calibration.json \
  --analysis-dir calibration/analyses \
  --format json \
  --output calibration-report.json
```

By default the command fails when an observation URL has no matching full
analysis JSON. Use `--allow-missing` only when intentionally producing a partial
report.

Agents can run the same workflow through MCP `calibration_report`, which returns
JSON by default and restricts dataset/analysis file inputs to the current
working directory:

```json
{
  "datasetPath": "calibration/my-calibration.json",
  "analysisDir": "calibration/analyses",
  "format": "json"
}
```

The same runner is available from TypeScript:

```typescript
import { runCalibration, formatCalibrationReport } from "tactual/calibration";
import { readFileSync } from "fs";

// Load your observations
const dataset = JSON.parse(readFileSync("my-calibration.json", "utf-8"));

// Load the Tactual analysis for each page you tested.
// Keys are URLs, values are the full JSON analysis result.
const analyses = new Map();
for (const url of new Set(dataset.observations.map((o) => o.url))) {
  const slug = new URL(url).hostname.replace(/\./g, "-");
  const result = JSON.parse(readFileSync(`${slug}-nvda.json`, "utf-8"));
  analyses.set(url, result);
}

const report = runCalibration(dataset, analyses);
console.log(formatCalibrationReport(report));
```

`report.scoringSignals` is the bridge from calibration evidence to future score
tuning. It records confirmed reachability fits, review-only score bias,
strategy-switch pressure, mapper phrasing drift, and no-actionable regression
evidence as structured data. Treat `review` signals as candidates for repeated
calibration, not automatic weight changes.

Announcement-only feedback can be stored separately when you did not collect
steps, strategy, discovery time, or difficulty rating:

```json
{
  "name": "announcement-observations",
  "collectedAt": "2026-06-11T12:00:00Z",
  "observations": [],
  "announcementObservations": [
    {
      "url": "https://example.com",
      "profileId": "nvda-desktop-v0",
      "targetName": "Search",
      "observedAnnouncement": "Search, edit",
      "announcementSource": "manual-sr",
      "atVersion": "NVDA 2025.1",
      "browser": "Chrome 137",
      "testerId": "oss-review",
      "timestamp": "2026-06-11T12:05:00Z"
    }
  ]
}
```

Use the CLI helper to generate or append this shape from a saved analysis:

```bash
npx tactual observe-announcement "Search" \
  --analysis example-nvda.json \
  --observed-file nvda-search-announcement.txt \
  --source manual-sr \
  --at-version "NVDA 2025.1" \
  --browser "Chrome 137" \
  --output calibration.json \
  --append
```

For repeatable NVDA VM collection, generate a sequence plan from that full
analysis and let the VirtualBox helper collect observed speech:

```powershell
npm run -- nvda:vm:host-calibrate -- `
  -Analysis example-nvda.json `
  -Mode tab `
  -StepCount 12 `
  -HostOut build\nvda-vm\checkout-tab `
  -AppendCalibration calibration\nvda-vm.json
```

Use `-Mode heading`, `-Mode landmark`, `-Mode button`, `-Mode link`, or
`-Mode form-field` to send NVDA browse-mode quick-navigation keys instead of
Tab. Those modes are useful when NVDA reaches headings, landmarks, or browse
mode content that is not part of ordinary keyboard focus. The helper writes
matched observations to `speech-records.jsonl` and unmatched NVDA speech to
`unmatched-speech.json`; review unmatched speech as possible browser chrome
noise, contextual landmark chatter, timing noise, or evidence that Tactual's
target model missed content NVDA could reach.

For repeated calibration, run the VM batch loop:

```powershell
npm run build
npm run -- nvda:vm:batch-calibrate -- -StartVm -CaseFilter good-heading -CaseDelaySeconds 15
npm run -- nvda:vm:batch-calibrate -- -StartVm -CaseFilter good-button
```

Keep VM batches small. Current VirtualBox/NVDA evidence shows that one-case or
narrow case-filtered runs are much more reliable than broad repeated batches.
The batch runner now bounds each case with `-CaseTimeoutSeconds`, writes
per-case `host-calibrate*.stdout.log` / `host-calibrate*.stderr.log`, probes
Guest Control before each case, and records timed-out cases as
`harness-blocked` instead of hanging the whole batch. Use
`-RecycleVmWhenUnhealthy -RecycleVmOnTimeout` for longer unattended runs where
a hard VM reset is acceptable recovery; otherwise review the blocked case and
restart the VM manually before continuing.
Use `-RecycleVmBeforeEachCase` for release-grade evidence batches where clean
per-case isolation matters more than runtime.

For normal repo-relative `-HostOut` folders, host calibration writes the NVDA
log and run state directly through the VM shared folder before navigation
starts. This avoids a fragile post-navigation `guestcontrol copyfrom` step.
The host runner now waits briefly for initial page speech by default and records
whether that happened. Browse-mode calibration is not stable when NVDA never
announces the focused document before quick-nav input; if a run then produces no
matched targets, treat it as harness readiness until repeated with successful
initial speech. OOPIF cases use a longer per-case readiness window because
cross-origin child-frame speech can arrive later than ordinary document speech.

Extraction is input-bound for calibration runs: observed speech must follow the
planned navigation key (`Tab`, `H`, `F`, etc.) before it can satisfy a planned
target. Page-load say-all speech and browse-mode prelude speech are preserved in
alignment artifacts, but they do not become navigation matches.

Prefer importing multiple small clean batches over one large batch with mixed
harness health. Weak or blocked cases still produce useful review artifacts,
but only clean, matched cases should be promoted into `calibration/corpus/`.

Each batch writes `batch-report.md` and `review-queue.json` next to
`calibration.json`. Treat them as the calibration triage queue:

- matched high-confidence speech becomes `announcementObservations`;
- `scoringSignals` summarizes which evidence is safe to use later for scoring:
  confirmed reachability matches, review-only context verbosity, target-name
  coalescing, mapper drift, observed values, and harness blockers;
- `harness-blocked` cases, such as zero parsed NVDA speech after keyboard
  input, keep their artifacts but are excluded from mapper evidence groups;
- weak cases below the match threshold keep their artifacts but skip ingestion;
- repeated missing target groups become navigation-model or mapper follow-up;
- repeated unmatched content speech becomes evidence that NVDA reached content
  Tactual did not model, or that the announcement mapper is missing context.
- repeated extra observed announcement tokens are non-failing mapper
  opportunities. Use them to decide whether context, values, or native state
  phrases should become explicit modeled assumptions. The core calibration
  comparator treats those extra tokens as review evidence, not mapper drift,
  when every modeled target token was observed.

The focused calibration fixtures are designed to challenge assumptions before
applying those assumptions to real sites:

- `calibration-at-mapper-lab.html`: form states, stateful buttons, composite
  widgets, SPA live status, and same-origin iframe content.
- `calibration-dialog-lab.html`: experimental static ARIA dialog structure.
  It is useful for studying why `aria-modal` alone is not the same as an active
  modal workflow, but it is excluded from the default VM batch. Pass
  `-IncludeExperimentalDialogCases` only when intentionally collecting that
  bad-pattern evidence. Release modal confidence comes from runtime modal
  trigger/dialog probes, not static ARIA scope assumptions.
- `calibration-spa-route-lab.html`: pushState/hash route changes, live status
  announcements, route headings, links, buttons, and a persistent search field.
- `calibration-structured-lab.html`: native table, ARIA grid, tree, and
  treegrid roles. Tactual currently keeps these visible as conservative
  `other` targets with interop pressure instead of granting table/grid/tree
  quick-navigation credit before more AT evidence exists.
- `calibration-oopif-parent.html` plus `calibration-oopif-child.html`:
  two-origin iframe descent. Run through `nvda:vm:batch-calibrate` or the
  fixture server so the parent is served on the primary port and the child on
  the secondary port.

### 5. Promote vetted runs into the corpus

VM output under `build/nvda-vm/` is local working evidence. Import selected,
reviewed batches into `calibration/corpus/` before treating them as release
evidence:

```powershell
node scripts/calibration-corpus.mjs import-nvda-batch `
  --batch build\nvda-vm\calibration-batch-name\YYYY-MM-DD-HHMMSS `
  --out calibration\corpus\my-corpus-name `
  --label my-corpus-name `
  --derive-full-observations
```

The importer rewrites transient host/guest localhost URLs to portable
`tactual-fixture://...` URLs and copies the matching full analysis JSON.
`--derive-full-observations` promotes clean `sequence-alignment.json` matches
into full `GroundTruthObservation` records and copies each case's sequence plan
under corpus `evidence/`. Alignment dumps, host summaries, review queues, and
batch reports remain local `build/` artifacts unless a reviewer explicitly
promotes a small artifact.

Derived VM full observations are deterministic reachability records: they
capture the number of quick-navigation or Tab actions needed to reach a matched
target and the NVDA speech observed there. They should drive reachability and
action-cost calibration first. They should not be treated as manual evidence for
subjective severity, operability, or recovery without separate SR review.

Audit the corpus after imports:

```bash
npm run calibration:corpus
node scripts/calibration-corpus.mjs audit --format json --output build/calibration-corpus-audit.json
```

Build the tuning queue after the audit:

```bash
npm run build
npm run calibration:matrix
node scripts/calibration-matrix.mjs --format json --output build/calibration-matrix.json
```

The matrix reports per-profile, per-mode, per-role, per-fixture, and per-source
MAE, bias, and variance. Positive reachability bias means observed NVDA steps
exceeded Tactual's predicted path cost, so Tactual was optimistic. Use the
tuning queue to pick calibration work: high MAE plus low variance is a good
weight/model candidate; high variance should usually be repeated or isolated in
a fixture before changing weights.

The matrix also compares each scripted full observation with the imported
`sequence-plan.json` that produced it. If a record follows an older plan index
but disagrees with the current sequence mapper, it is reported as
sequence-plan drift and excluded from reachability tuning. Keep those records
for announcement evidence and harness history, but regenerate the run before
using its step count to change action costs.

The audit reports profile counts, mode coverage, role coverage, imported VM
scoring signals, and explicit blockers against the current goals:

- 50+ full navigation observations per profile before score-weight tuning.
  Scripted VM full observations count for reachability/action-cost tuning;
  manual SR full observations are still needed before tuning subjective
  severity, operability, or recovery weights;
- 50+ announcement observations per profile before mapper-confidence claims;
- repeated mode coverage across Tab, heading, landmark, button/link, and
  form-field navigation;
- multiple fixtures and real pages before broad release claims.

A minimal working dataset with 2 observations:

```json
{
  "name": "quick-check",
  "collectedAt": "2026-04-16T12:00:00Z",
  "observations": [
    {
      "url": "https://example.com",
      "profileId": "nvda-desktop-v0",
      "targetName": "More information...",
      "actualStepsToReach": 4,
      "strategyUsed": "heading",
      "requiredStrategySwitch": false,
      "knewTargetExisted": false,
      "timeToDiscoverSeconds": 3,
      "discoveryMethod": "heading-nav",
      "couldOperate": true,
      "couldRecover": true,
      "difficultyRating": 2,
      "testerId": "tester-1",
      "timestamp": "2026-04-16T12:05:00Z"
    },
    {
      "url": "https://example.com",
      "profileId": "nvda-desktop-v0",
      "targetName": "Search",
      "actualStepsToReach": 12,
      "strategyUsed": "linear",
      "requiredStrategySwitch": true,
      "knewTargetExisted": true,
      "timeToDiscoverSeconds": 8,
      "discoveryMethod": "linear-scan",
      "couldOperate": true,
      "couldRecover": false,
      "difficultyRating": 4,
      "testerId": "tester-1",
      "timestamp": "2026-04-16T12:10:00Z"
    }
  ]
}
```

## Reading the report

### Key metrics

| Metric | Good | Concerning | What it means |
|---|---|---|---|
| **Overall Score MAE** | < 10 | > 20 | Average point error in Tactual's predictions |
| **Overall Score Bias** | -5 to +5 | > +10 or < -10 | Positive = too optimistic, negative = too pessimistic |
| **Severity Accuracy** | > 70% | < 50% | How often predicted severity matches human rating |
| **Reachability MAE** | < 3 steps | > 5 steps | Average step-count prediction error |
| **Reachability Correlation** | > 0.7 | < 0.4 | Whether step count trends match (direction, not magnitude) |
| **Announcement Accuracy** | > 0.9 | < 0.8 | How often modeled role/name/state tokens appeared in observed AT output |

### Confusion matrix

The severity confusion matrix shows where the model mis-classifies:

```
              Ground Truth
              severe  high  moderate  acceptable  strong
Predicted
  severe        3      1      0         0          0     ← true positives on diagonal
  high          1      5      2         0          0
  moderate      0      1      8         3          0
  acceptable    0      0      1        12          2
  strong        0      0      0         1         10
```

Off-diagonal entries show misclassifications. If the model puts many "acceptable" observations into "strong" (bottom-right corner), it's too optimistic for easy targets.

### Dimension bias

- **Discoverability bias > 0**: model overestimates how easy targets are to find. Suggests the heading/landmark factors are too generous.
- **Reachability bias > 0**: model underestimates how many steps targets actually need. Suggests the graph is missing navigation paths or the decay curve is too gentle.
- **Announcement mismatches**: modeled announcement tokens did not appear in observed output, or supplied observed tokens were not predicted. This is a simulator-calibration issue, not necessarily a page accessibility bug.
- **AT mapper assumptions to review**: the specific name, role, state, value, or
  description assumptions contradicted by observed output. Repeated misses for
  the same assumption ID are stronger evidence than a one-off mismatch from a
  noisy page state.

## How calibration data improves the model

1. **Severity band thresholds**: if "moderate" targets consistently feel "high" to testers, the 60-74 band should shift.
2. **Discoverability factor weights**: if targets under headings are rated harder than the model predicts, the heading factor (currently ×1.55) should decrease.
3. **Reachability decay coefficient**: if the model consistently underestimates step counts for deep targets, the base coefficient (0.04) should increase.
4. **Profile weights**: if NVDA testers report more operability issues than mobile testers, the NVDA operability weight should increase.
5. **costSensitivity**: if TalkBack testers report proportionally higher difficulty on long paths than the model predicts, TalkBack's costSensitivity (currently 1.3) should increase.

Each adjustment is a single number change in the profile or scoring module, guided by the calibration report's bias metrics rather than guesswork.
