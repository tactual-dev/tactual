# NVDA VM Setup

This page turns the NVDA observer workflow into an isolated VM setup. The goal is
not to hide NVDA; it is to keep NVDA from observing the host desktop where
coding tools, terminal sessions, and unrelated browser windows are changing
focus.

## Local Host Preflight

Run this on the host:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\nvda-vm-preflight.ps1
```

The script writes `build/nvda-vm-preflight.json` and reports:

- whether the shell is elevated;
- whether Hyper-V, Windows Sandbox, VirtualBox, `winget`, and WSL commands are
  present;
- whether NVDA is already running on the host;
- available disk space;
- the recommended provider path.

When Hyper-V or Windows Sandbox is unavailable, VirtualBox is the preferred
local provider. Installing VirtualBox needs an elevated installer because it
installs virtualization drivers.

## Provider Choice

Preferred local path:

1. Install Oracle VirtualBox 7.x on the host.
2. Create a small Windows guest from a licensed Windows ISO or Microsoft
   evaluation ISO.
3. Run a Chromium browser, Playwright, Tactual, and NVDA inside that guest.
4. Share only a folder for analysis inputs, speech artifacts, and calibration
   output.

Useful official references:

- Microsoft Windows 11 Enterprise evaluation:
  <https://www.microsoft.com/en-us/evalcenter/evaluate-windows-11-enterprise>
- Microsoft Evaluation Center:
  <https://www.microsoft.com/en-us/evalcenter>
- Oracle VirtualBox manual:
  <https://www.virtualbox.org/manual/>
- VirtualBox unattended installation:
  <https://docs.oracle.com/en/virtualization/virtualbox/6.0/user/basic-unattended.html>

Windows Sandbox would be lighter than VirtualBox, but it is not available on
this host. Hyper-V Manager is also not available on this host.

## Suggested VM Shape

Use a small Windows guest:

- 2 vCPU;
- 4 GB RAM minimum, 6 GB if Chrome/Playwright is sluggish;
- 64 GB dynamically allocated disk;
- NAT networking;
- shared folder mounted read/write, for example host
  `C:\path\to\Tactual` to guest `Z:\`;
- shared clipboard and drag/drop disabled unless you need them temporarily;
- HDA guest audio enabled. NVDA's speech log depends on a working guest render
  device even when the calibration artifact is the input/output log rather than
  host audio. For VirtualBox this means `--audio-controller hda`,
  `--audio-codec stac9221`, and `--audio-out on`. The bootstrap mutes the
  guest's default render endpoint before starting NVDA, so the speech pipeline
  remains active without routing audible speech to the host.

After the guest is installed and booted:

1. Mount or clone the Tactual repo in the guest.
2. Run the guest bootstrap:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File Z:\scripts\nvda-vm-guest-bootstrap.ps1 `
  -RepoRoot Z:\ `
  -LocalRepoRoot C:\Tactual `
  -CaptureRoot C:\TactualNvdaCapture `
  -StartNvda
```

The bootstrap avoids machine-wide installers after the Windows image is
created. It reuses Edge or Chrome as the Chromium browser, downloads a verified
portable Node zip, downloads a verified NVDA installer, creates a portable NVDA
copy, syncs the shared repo to `C:\Tactual`, builds Tactual there, creates
`C:\TactualNvdaCapture`, mutes guest render audio by default, and can start
NVDA with:

- isolated config: `C:\TactualNvdaCapture\nvda-config`;
- explicit speech log: `C:\TactualNvdaCapture\nvda-io.log`;
- input/output log level: `12`;
- add-ons disabled.

Pass `-AllowAudibleSpeech` to the guest bootstrap or host smoke only when you
want to listen to NVDA during manual review.

Take a VM snapshot after this bootstrap succeeds. The current local baseline is
`post-bootstrap-portable-nvda-hda-audio`: Windows 11 Enterprise Evaluation,
Guest Additions, portable Node, portable NVDA, HDA guest audio, and `C:\Tactual`
built. Revert to that snapshot before repeatable calibration runs.

For a quick host-driven smoke pass after the VM is booted and guest control is
ready:

```powershell
npm run -- nvda:vm:host-smoke
```

The smoke helper starts portable NVDA, waits for `NVDA initialized`, creates a
small local HTML page, launches Edge as a normal guest desktop app, sends Tab
through VirtualBox keyboard scancodes, then copies screenshots and
`nvda-io.log` into `build\nvda-vm\host-smoke`.

The scancode step is important. Programmatic browser focus can change DOM focus
without producing the same desktop accessibility events NVDA reacts to. The
host smoke helper uses the VM's virtual keyboard so NVDA observes a normal
guest interaction path.

For calibration data, use the generalized host runner after the smoke passes:

```powershell
npm run -- nvda:vm:host-calibrate -- `
  -Url https://example.com `
  -RunAnalysis `
  -Mode tab `
  -StepCount 12 `
  -HostOut build\nvda-vm\example-tab `
  -AppendCalibration build\nvda-vm\example-calibration.json
```

`-RunAnalysis` writes a full `AnalysisResult` using `analyze-url --full-json`,
then `nvda-vm-sequence` creates a navigation plan. The host script launches
Edge inside the guest, sends VirtualBox scancodes, copies NVDA's log back to the
host, aligns speech to planned targets, and optionally appends matched records
to a calibration dataset. Use `-Mode heading`, `-Mode landmark`, `-Mode button`,
`-Mode link`, or `-Mode form-field` to test NVDA browse-mode quick-navigation
paths that can reach non-Tab stops.

## Calibration Run Boundary

Inside the guest:

1. Start NVDA with the isolated config/log.
2. Run the target page and browser automation inside the guest.
3. Write `speech-capture.tsv` or JSONL into the shared folder.

On the host or guest:

```powershell
npm run -- nvda:vm:observe -- `
  --analysis build\nvda-calibration\round-2026-06-11-fixtures\good-page.analysis.full.json `
  --speech-log build\nvda-calibration\round-2026-06-11-fixtures\observer\good-page\speech-capture.tsv `
  --append-calibration build\nvda-calibration\round-2026-06-11-fixtures\calibration.json `
  --source nvda-vm `
  --tester vm-nvda `
  --at-version "NVDA 2026.1.1" `
  --browser "Microsoft Edge <version>"
```

Use `announcementSource: "nvda-vm"` only when NVDA, browser focus, and capture
all happened inside the guest. If capture happened on the host desktop, mark it
as `other` or `manual-sr` and document the focus contamination risk.

## Isolation Rules

- Do not run capture on the host desktop when NVDA is already running there.
- Do not use host Speech Viewer or host NVDA logs as VM evidence.
- Keep guest NVDA logs under the capture root and copy only those artifacts
  back to the host.
- Do not enable shared clipboard during automated capture unless the test
  explicitly needs it.
- Revert the VM snapshot between calibration rounds when comparing results.

## Known Limits

This setup does not make NVDA output universal. It gives a controlled
observation for one NVDA version, browser version, guest OS, verbosity setting,
focus mode, and page state. Treat differences as calibration evidence first,
then decide whether the page or simulator should change.
