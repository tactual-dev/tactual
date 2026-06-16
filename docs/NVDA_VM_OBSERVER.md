# NVDA VM Observer

Tactual can use NVDA output as calibration evidence without copying NVDA code
or running NVDA in normal CI. The lightweight path is a controlled Windows VM:
Tactual captures the page and modeled target announcements, the VM captures what
NVDA spoke for those targets, and `npm run nvda:vm:observe` turns the explicit
speech records into `announcementObservations`.

This is observed/tested evidence, not a universal truth claim. NVDA speech varies
with NVDA version, browser, focus/browse mode, verbosity settings, add-ons,
language, page state, and timing. Store those details with every observation.

## Source Boundary

NVDA is open source, but the NVDA repository states that NVDA is licensed under
a modified GPL-2-or-later license. Tactual is Apache-2.0, so Tactual should not
copy NVDA implementation code or ship a derived NVDA speech engine. It is fine
to cite NVDA, run NVDA as an external program in a VM, and store the output as
observed calibration data.

Useful references:

- NVDA repository and license: https://github.com/nvaccess/nvda and
  https://raw.githubusercontent.com/nvaccess/nvda/master/copying.txt
- NVDA user guide command-line options, log viewer, and speech viewer:
  https://download.nvaccess.org/documentation/userGuide.html

## VM Setup

Use [NVDA_VM_SETUP.md](NVDA_VM_SETUP.md) for host preflight, provider choice,
and guest bootstrap. The short version: NVDA capture must happen inside a
separate Windows guest/session, not on the same desktop where host coding tools,
terminals, or browsers are changing focus.

## Recommended VM Shape

Use a disposable Windows VM snapshot with:

- a fixed NVDA version and a dedicated NVDA configuration directory;
- one browser channel/version per run, usually Chrome stable first;
- a clean Tactual checkout or installed package;
- no unrelated NVDA add-ons enabled;
- fixed speech verbosity, punctuation, language, keyboard layout, and browser
  zoom;
- a shared folder for `analysis.json`, `targets.tsv`, speech logs, and
  calibration output.

The VM should be interactive enough for NVDA to own focus. Do not run this in
normal headless CI. Use Playwright or OS-level input only to prepare the page and
move focus in the controlled browser, then record the speech artifact explicitly.

## Capture Options

Start with the lowest-friction method that is reliable for the run:

1. Use NVDA Speech Viewer or NVDA logs and copy the relevant lines into TSV.
   This is suitable for short OSS review sessions.
2. Use a small external NVDA add-on or speech-driver capture adapter in the VM
   that writes JSONL. Keep that adapter outside Tactual unless its licensing is
   reviewed separately.
3. Use a VM automation layer to drive browser focus and copy the Speech Viewer
   contents into a JSONL/TSV artifact. This improves repeatability but still
   treats NVDA as a black-box external program.

Preferred JSONL shape:

```json
{
  "target": "Search",
  "observedAnnouncement": "Search, edit",
  "targetSelector": "#q",
  "atVersion": "NVDA 2026.1.1",
  "browser": "Chrome 137"
}
```

TSV shape:

```text
target	observedAnnouncement	observedAnnouncementTokens	targetSelector	announcementNotes
Search	Search, edit	Search|edit	#q	browse mode, default verbosity
```

Use `observedAnnouncementTokens` when the exact phrasing is noisy but the stable
role/name/state terms are clear.

## Workflow

Create the run folder and target template from an existing analysis:

```bash
npm run -- nvda:vm:observe -- \
  --analysis checkout-analysis.json \
  --target "Checkout" \
  --target "Payment details" \
  --out build/nvda-vm-observe/checkout
```

Or let the helper run Tactual first:

```bash
npm run build
npm run -- nvda:vm:observe -- \
  --url https://app.example.test/checkout \
  --run-analysis \
  --wait-for-selector main \
  --detect-routes \
  --auto-scroll \
  --descend-frames \
  --target "Checkout" \
  --out build/nvda-vm-observe/checkout
```

After capturing speech in the VM, ingest the artifact:

```bash
npm run -- nvda:vm:observe -- \
  --analysis build/nvda-vm-observe/checkout/analysis.json \
  --speech-log build/nvda-vm-observe/checkout/speech.jsonl \
  --append-calibration calibration/nvda-vm.json \
  --at-version "NVDA 2026.1.1" \
  --browser "Chrome 137" \
  --tester oss-review
```

The `npm run -- nvda:vm:observe -- ...` form keeps flag forwarding predictable
in PowerShell and npm versions that otherwise treat trailing `--help` or
`--analysis` as npm options. Calling `node scripts/nvda-vm-observe.mjs ...`
directly is equivalent inside the repo.

For TSV input, rows with a target but no `observedAnnouncement` and no
`observedAnnouncementTokens` are skipped. This lets you use the generated sheet
as a working checklist and ingest partial sessions without deleting every
unfinished row. JSONL remains strict because each line is intended to be a final
observation record.

The helper writes:

- `manifest.json`: exact paths, commands, profile/source metadata, and run
  notes;
- `targets.tsv`: a simple capture template;
- `speech-records.json`: normalized input records when `--speech-log` is used;
- `observation-payloads.json`: modeled-vs-observed comparisons from
  `tactual observe-announcement`;
- the requested calibration dataset, or `calibration.json` in the run folder.

## Automated VM Sequence Runs

The repeatable path is `npm run nvda:vm:host-calibrate`. It keeps NVDA as an
external program, drives the VM with VirtualBox keyboard scancodes, parses
NVDA's input/output log, and aligns observed speech back to a Tactual plan.

Start with a full analysis JSON, not the compact reporter JSON:

```powershell
npm run build
node dist\cli\index.js analyze-url https://example.com `
  --profile nvda-desktop-v0 `
  --format json `
  --full-json `
  --output build\nvda-vm\example\analysis.full.json `
  --no-check-visibility
```

Then run a muted Tab-sequence capture:

```powershell
npm run -- nvda:vm:host-calibrate -- `
  -Analysis build\nvda-vm\example\analysis.full.json `
  -Mode tab `
  -StepCount 12 `
  -HostOut build\nvda-vm\example\tab `
  -AppendCalibration build\nvda-vm\example\calibration.json
```

The same runner can send NVDA quick-navigation keys:

```powershell
npm run -- nvda:vm:host-calibrate -- `
  -Analysis build\nvda-vm\example\analysis.full.json `
  -Mode heading `
  -StepCount 10 `
  -HostOut build\nvda-vm\example\headings
```

Supported modes:

| Mode | VM key | Purpose |
|---|---:|---|
| `tab` | Tab | Focusable keyboard order |
| `heading` | H | Browse-mode heading traversal |
| `landmark` | D | Browse-mode landmark traversal |
| `button` | B | Browse-mode button traversal |
| `link` | K | Browse-mode link traversal |
| `form-field` | F | Browse-mode form-field traversal |

By default, the host runner waits briefly for an initial page announcement after
Edge document focus and records whether it happened. NVDA can be alive while the
browser document is still not ready for browse-mode quick navigation; a zero-hit
quick-nav run without initial document speech is harness-readiness evidence, not
mapper evidence. Pass `-InitialSpeechTimeoutSeconds 0` only when deliberately
debugging raw timing.

Extraction is tied to keyboard input. The host runner passes
`--require-navigation-input`, so page-load say-all output and browse-mode
prelude speech are preserved in `sequence-alignment.json` but cannot satisfy a
planned navigation target. This is especially important for OOPIF fixtures,
where NVDA may auto-read cross-origin frame contents before any scripted key.

When `-HostOut` is inside the repository, the host runner writes the per-case
NVDA log and sequence run-state directly into that shared output directory.
That keeps post-navigation parsing on the host side and avoids a fragile
VirtualBox `guestcontrol copyfrom` after NVDA has already received input.

Run output includes:

- `sequence-plan.json`: targets Tactual expected NVDA to encounter;
- `nvda-io.log`: copied guest NVDA log;
- `speech-records.jsonl`: matched observations suitable for
  `nvda:vm:observe`;
- `sequence-alignment.json`: matched, missing, and unmatched alignment detail;
- `unmatched-speech.json`: speech NVDA produced that did not align to a planned
  Tactual target.

Unmatched speech is not automatically a bug. It can be browser chrome, page
title/context chatter, a timing artifact, or the important case: NVDA reached
something Tactual did not model. Review repeated unmatched patterns as capture
or AT-mapper gaps.

The extractor aligns a target against a short adjacent speech window, not just
one `speech.speech.speak` block. NVDA often splits one focused control into
separate name, role/value, and description blocks, especially in browse-mode
form-field navigation. Keep `--max-window-blocks` small so the aligner can join
those fragments without swallowing unrelated page speech.

After the last scripted keypress, the host waits until the shared NVDA log shows
speech after that final input and then stays quiet for a short window. OOPIF
cases carry longer bounded settle windows because cross-origin frame focus
speech has been observed later than same-origin document speech.

## Batch Calibration Loop

For productive calibration work, prefer the batch runner over isolated runs:

```powershell
npm run build
npm run -- nvda:vm:batch-calibrate -- -StartVm -SmokeOnly
```

The batch runner starts a local fixture server, analyzes the same fixture URL on
the host, opens the guest through the VirtualBox NAT host alias, runs several
navigation modes, and writes:

- `calibration.json`: matched high-confidence `announcementObservations`;
- `batch-summary.json`: per-case execution and alignment totals, including
  `harness-blocked` status for cases where the VM/NVDA received input but did
  not produce usable speech;
- `batch-report.md`: human review summary;
- `review-queue.json`: machine-readable weak cases, missing targets, and
  unmatched speech groups, plus `scoringSignals` for reachability confidence,
  context verbosity, target-name coalescing, mapper drift, observed values, and
  harness health.

Use `-SmokeOnly` when changing harness behavior. Drop it for the full matrix
once smoke cases are stable. To rerun only specific cases:

```powershell
npm run -- nvda:vm:batch-calibrate -- `
  -StartVm `
  -CaseFilter mapper-form-field,mapper-link
```

The default matrix includes ordinary fixtures plus
`fixtures/calibration-at-mapper-lab.html`, a focused lab for form states,
stateful buttons, composite widgets, SPA status changes, and iframe content.
The lab cases pass `-DescendFrames` so iframe observations can challenge
Tactual's frame descent and OOPIF recovery assumptions.
Experimental static dialog cases are intentionally excluded from the default
batch because earlier VM evidence showed that `aria-modal` on an always-visible
section does not create an active modal navigation scope. Pass
`-IncludeExperimentalDialogCases` only when studying that bad pattern; use the
runtime modal probes for release modal confidence.

Read the batch report in this order:

1. **Scoring Signals**: summary candidates for the scoring model. `confirmed`
   signals can increase confidence in the current model. `review` signals need
   repeated evidence before changing weights. `blocked` signals mean harness
   health prevents tuning, and `observed-only` signals should stay
   target-specific.
2. **Harness Blockers**: `harness-blocked` runs mean the VM/NVDA path was not a
   usable observation, commonly because keyboard input reached NVDA but no
   speech blocks were emitted. Fix that before treating the misses as AT mapper
   evidence. Weak link/form-field quick-nav runs with actual speech often mean
   browse mode or focus readiness failed.
3. **Missing Target Groups**: repeated misses by mode/role/kind show where
   Tactual's planned traversal diverged from what NVDA reached.
4. **Unmatched Content Speech**: repeated non-browser speech may be content
   NVDA reached that Tactual did not capture, or extra context the announcement
   mapper should model.
5. **Extra Observed Context Tokens**: non-failing structural terms observed by
   NVDA but not required by the current mapper, such as grouping context,
   region/list boundaries, or native state phrases. Promote repeated terms into
   mapper assumptions only after confirming they are stable for the tested
   NVDA/browser/mode.
6. **Extra Observed Target-Name Tokens**: names of other captured targets that
   appeared in the same speech block. Review these as speech coalescing or
   navigation-order evidence before treating them as values or mapper phrases.
7. **Extra Observed Value Tokens**: current field values or page data heard in
   NVDA output. Preserve them as observation evidence, but do not promote them
   into generic mapper phrasing unless the target value is explicitly captured
   and privacy-reviewed.
8. **Calibration dataset**: only matched records from cases above the match
   threshold are ingested. Low-confidence cases preserve artifacts but skip
   ingestion so the dataset does not drift.

## Acceptance for a Good VM Run

- The run folder includes `manifest.json`, `analysis.json`, speech records, and
  a calibration dataset.
- Every observation records NVDA version, browser version, mode/verbosity notes
  when relevant, and `announcementSource: "nvda-vm"`.
- The same target can be re-run from a clean VM snapshot and produce matching
  role/name/state tokens.
- Mismatches are reviewed as simulator calibration evidence first, not as page
  bugs, unless the page semantics themselves are wrong.
