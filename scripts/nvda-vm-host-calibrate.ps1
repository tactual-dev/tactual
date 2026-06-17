param(
  [string]$VmName = "Tactual-NVDA-Win11",
  [string]$VBoxManage = "C:\Program Files\Oracle\VirtualBox\VBoxManage.exe",
  [string]$GuestUser = "tactual",
  [string]$PasswordFile = "$env:USERPROFILE\VirtualBox VMs\Tactual-NVDA-Win11\tactual-user-password.txt",
  [string]$RepoShareRoot = "Z:\",
  [string]$LocalRepoRoot = "C:\Tactual",
  [string]$CaptureRoot = "C:\TactualNvdaCapture",
  [string]$HostOut = "build\nvda-vm\calibration",
  [string]$Url = "",
  [string]$GuestUrl = "",
  [string]$Analysis = "",
  [string]$Mode = "tab",
  [string]$Profile = "nvda-desktop-v0",
  [int]$StepCount = 12,
  [int]$StepDelaySeconds = 2,
  [int]$Timeout = 30000,
  [int]$InitialSpeechTimeoutSeconds = 5,
  [int]$PostSequenceMinWaitSeconds = 8,
  [int]$PostSequenceQuietSeconds = 4,
  [int]$PostSequenceMaxWaitSeconds = 45,
  [string]$WaitForSelector = "",
  [string]$AppendCalibration = "",
  [string]$AtVersion = "NVDA 2026.1.1",
  [string]$Browser = "Microsoft Edge (guest)",
  [string]$NodeVersion = "24.16.0",
  [double]$MinimumMatchRatio = 0.5,
  [switch]$StartVm,
  [switch]$RunAnalysis,
  [switch]$SkipBuild,
  [switch]$SkipStartNvda,
  [switch]$AllowAudibleSpeech,
  [switch]$DetectRoutes,
  [switch]$DescendFrames,
  [switch]$AutoScroll,
  [switch]$DismissBanners,
  [switch]$AllowPreInputSpeechMatching
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

function Close-GuestControlSessions {
  try {
    & $VBoxManage guestcontrol $VmName closesession --all --quiet | Out-Null
  } catch {
    # A stale Guest Control session should not prevent the next bounded command
    # from proving whether the VM is healthy. The caller will surface failures
    # from the real guest command if cleanup did not help.
  }
}

function Invoke-Guest {
  param(
    [string]$Exe,
    [string[]]$Arguments,
    [int]$TimeoutMs = 120000,
    [int]$RetryCount = 2,
    [int]$RetryDelaySeconds = 5
  )

  for ($attempt = 0; $attempt -le $RetryCount; $attempt += 1) {
    if ($attempt -gt 0) {
      Close-GuestControlSessions
    }
    & $VBoxManage guestcontrol $VmName run `
      --exe $Exe `
      --username $GuestUser `
      --passwordfile $PasswordFile `
      --wait-stdout `
      --wait-stderr `
      --timeout $TimeoutMs `
      --ignore-orphaned-processes `
      -- @Arguments
    if ($LASTEXITCODE -eq 0) { return }
    if ($attempt -lt $RetryCount) {
      Close-GuestControlSessions
      Start-Sleep -Seconds $RetryDelaySeconds
    }
  }

  throw "Guest command failed with exit code ${LASTEXITCODE}: $Exe $($Arguments -join ' ')"
}

function Invoke-GuestBestEffort {
  param(
    [string]$Exe,
    [string[]]$Arguments,
    [int]$TimeoutMs = 120000,
    [int]$RetryCount = 2,
    [int]$RetryDelaySeconds = 5,
    [string]$Operation = "guest command"
  )

  try {
    Invoke-Guest $Exe $Arguments $TimeoutMs $RetryCount $RetryDelaySeconds
  } catch {
    Write-Warning "$Operation did not complete through Guest Control; continuing because this phase is best-effort. $($_.Exception.Message)"
    Close-GuestControlSessions
  }
}

function Wait-GuestControl {
  $deadline = (Get-Date).AddMinutes(10)
  while ((Get-Date) -lt $deadline) {
    Close-GuestControlSessions
    & $VBoxManage guestcontrol $VmName run `
      --exe "C:\Windows\System32\cmd.exe" `
      --username $GuestUser `
      --passwordfile $PasswordFile `
      --wait-stdout `
      --wait-stderr `
      --timeout 15000 `
      --ignore-orphaned-processes `
      -- /c whoami | Out-Null
    if ($LASTEXITCODE -eq 0) { return }
    Close-GuestControlSessions
    Start-Sleep -Seconds 10
  }
  throw "Timed out waiting for guest control."
}

function Get-VmMachineState {
  $info = & $VBoxManage showvminfo $VmName --machinereadable
  if ($LASTEXITCODE -ne 0) {
    throw "Could not read VM state for $VmName."
  }
  $line = $info | Where-Object { $_ -like "VMState=*" } | Select-Object -First 1
  return ($line -replace '^VMState="', '') -replace '"$', ''
}

function Start-VmIfRequested {
  $state = Get-VmMachineState
  if ($state -eq "running") { return }
  if (-not $StartVm) {
    throw "VM $VmName is $state. Start it first or pass -StartVm."
  }
  & $VBoxManage startvm $VmName --type headless | Out-Null
  if ($LASTEXITCODE -ne 0) {
    throw "Could not start VM $VmName."
  }
}

function Wait-NvdaReady {
  param([string]$LogPath = (Join-Path $CaptureRoot "nvda-io.log"))
  Invoke-Guest "C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe" @(
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-Command",
    "`$deadline=(Get-Date).AddSeconds(90); `$logPath='$LogPath'; while((Get-Date) -lt `$deadline){ `$proc=Get-Process nvda_noUIAccess,nvda -ErrorAction SilentlyContinue | Select-Object -First 1; if(Test-Path -LiteralPath `$logPath){ try { `$stream=[System.IO.File]::Open(`$logPath,[System.IO.FileMode]::Open,[System.IO.FileAccess]::Read,[System.IO.FileShare]::ReadWrite); try { `$length=`$stream.Length; `$read=[Math]::Min(`$length, 262144); `$buffer=New-Object byte[] `$read; `$stream.Seek(`$length-`$read,[System.IO.SeekOrigin]::Begin) | Out-Null; [void]`$stream.Read(`$buffer,0,`$read); `$text=[System.Text.Encoding]::UTF8.GetString(`$buffer); if(`$text -match 'NVDA initialized'){ 'NVDA_READY'; exit 0 }; if(`$proc -and `$length -gt 0 -and ((Get-Date) -gt `$deadline.AddSeconds(-70))){ 'NVDA_PROCESS_READY'; exit 0 } } finally { `$stream.Dispose() } } catch { if(`$proc){ 'NVDA_PROCESS_READY'; exit 0 } } }; Start-Sleep -Seconds 2 }; 'NVDA_NOT_READY'; exit 1"
  ) 120000
}

function Wait-InteractiveDesktopReady {
  Invoke-Guest "C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe" @(
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-Command",
    "`$deadline=(Get-Date).AddMinutes(15); while((Get-Date) -lt `$deadline){ `$explorer=Get-Process explorer -ErrorAction SilentlyContinue | Select-Object -First 1; if(`$explorer){ 'DESKTOP_READY'; exit 0 }; Start-Sleep -Seconds 5 }; 'DESKTOP_NOT_READY'; exit 1"
  ) 930000 0
}

function Focus-EdgeWindow {
  Invoke-Guest "C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe" @(
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-Command",
    "`$shell=New-Object -ComObject WScript.Shell; `$deadline=(Get-Date).AddSeconds(45); while((Get-Date) -lt `$deadline){ `$edge=Get-Process msedge -ErrorAction SilentlyContinue | Where-Object { `$_.MainWindowTitle } | Select-Object -First 1; if(`$edge -and `$shell.AppActivate(`$edge.MainWindowTitle)){ 'EDGE_ACTIVE'; exit 0 }; if(`$shell.AppActivate('Microsoft Edge')){ 'EDGE_ACTIVE'; exit 0 }; Start-Sleep -Milliseconds 500 }; 'EDGE_NOT_ACTIVE'; exit 1"
  ) 70000
}

function Invoke-GuestPowerShell {
  param(
    [string]$Script,
    [int]$TimeoutMs = 120000,
    [int]$RetryCount = 2
  )
  $encoded = [Convert]::ToBase64String([System.Text.Encoding]::Unicode.GetBytes($Script))
  Invoke-Guest "C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe" @(
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-EncodedCommand",
    $encoded
  ) $TimeoutMs $RetryCount
}

function Focus-EdgeDocument {
  Invoke-GuestPowerShell @'
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class TactualNativeInput {
  [StructLayout(LayoutKind.Sequential)]
  public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint dx, uint dy, uint data, UIntPtr extraInfo);
}
"@
$shell=New-Object -ComObject WScript.Shell
$edge=Get-Process msedge -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Sort-Object StartTime -Descending | Select-Object -First 1
if(-not $edge){ 'EDGE_WINDOW_NOT_FOUND'; exit 1 }
$shell.AppActivate($edge.Id) | Out-Null
Start-Sleep -Milliseconds 400
$rect=New-Object TactualNativeInput+RECT
if(-not [TactualNativeInput]::GetWindowRect($edge.MainWindowHandle, [ref]$rect)){ 'EDGE_RECT_NOT_FOUND'; exit 1 }
$x=$rect.Left + 120
$y=$rect.Top + 180
[TactualNativeInput]::SetCursorPos($x, $y) | Out-Null
[TactualNativeInput]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero)
Start-Sleep -Milliseconds 80
[TactualNativeInput]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero)
Start-Sleep -Milliseconds 400
'EDGE_DOCUMENT_ACTIVE'
'@ 70000
}

function Wait-NvdaInitialPageSpeech {
  param(
    [int]$TimeoutSeconds = 25,
    [string]$LogPath = (Join-Path $CaptureRoot "nvda-io.log"),
    [string]$RunStatePath = (Join-Path $CaptureRoot "sequence-run-state.json")
  )
  $script = @"
`$ErrorActionPreference = "Stop"
`$ProgressPreference = "SilentlyContinue"
`$statePath = "$RunStatePath"
`$logPath = "$LogPath"
`$deadline = (Get-Date).AddSeconds($TimeoutSeconds)
while ((Get-Date) -lt `$deadline) {
  if ((Test-Path -LiteralPath `$statePath) -and (Test-Path -LiteralPath `$logPath)) {
    try {
      `$state = Get-Content -LiteralPath `$statePath -Raw | ConvertFrom-Json
      `$offset = [int64]`$state.logOffset
      `$bytes = [System.IO.File]::ReadAllBytes(`$logPath)
      if (`$bytes.Length -gt `$offset) {
        `$delta = [System.Text.Encoding]::UTF8.GetString(`$bytes, [int]`$offset, [int](`$bytes.Length - `$offset))
        if (`$delta -match 'IO - speech\.speech\.speak' -and `$delta -match 'Speaking \[') {
          "NVDA_INITIAL_SPEECH_READY"
          exit 0
        }
      }
    } catch {
      Start-Sleep -Milliseconds 500
      continue
    }
  }
  Start-Sleep -Milliseconds 500
}
"NVDA_INITIAL_SPEECH_NOT_READY"
exit 1
"@
  Invoke-GuestPowerShell $script (($TimeoutSeconds + 15) * 1000) 0
}

function Test-LogDeltaPattern {
  param(
    [string]$Path,
    [int64]$Offset,
    [string]$Pattern
  )

  if (-not (Test-Path -LiteralPath $Path)) { return $false }
  try {
    $delta = Read-LogDeltaText $Path $Offset
    if (-not $delta) { return $false }
    return [regex]::IsMatch($delta, $Pattern)
  } catch {
    return $false
  }
}

function Wait-HostArtifact {
  param(
    [string]$Path,
    [int]$TimeoutSeconds = 20
  )

  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  while ((Get-Date) -lt $deadline) {
    if (Test-Path -LiteralPath $Path) { return $true }
    Start-Sleep -Milliseconds 500
  }
  return $false
}

function Read-LogDeltaText {
  param(
    [string]$Path,
    [int64]$Offset
  )

  if (-not (Test-Path -LiteralPath $Path)) { return "" }
  $stream = $null
  try {
    $stream = [System.IO.File]::Open(
      $Path,
      [System.IO.FileMode]::Open,
      [System.IO.FileAccess]::Read,
      [System.IO.FileShare]::ReadWrite -bor [System.IO.FileShare]::Delete
    )
    if ($stream.Length -le $Offset) { return "" }
    $length = [int]($stream.Length - $Offset)
    $bytes = New-Object byte[] $length
    $stream.Seek($Offset, [System.IO.SeekOrigin]::Begin) | Out-Null
    [void]$stream.Read($bytes, 0, $length)
    return [System.Text.Encoding]::UTF8.GetString(
      $bytes,
      0,
      $bytes.Length
    )
  } catch {
    return ""
  } finally {
    if ($stream) { $stream.Dispose() }
  }
}

function Get-NvdaNavigationLogState {
  param(
    [string]$Path,
    [int64]$Offset
  )

  $delta = Read-LogDeltaText $Path $Offset
  $inputMatches = [regex]::Matches($delta, "Input:\s+kb\([^)]+\):")
  $speakingMatches = [regex]::Matches($delta, "Speaking\s+\[")
  $lastInputIndex = $delta.LastIndexOf("Input: kb(", [System.StringComparison]::OrdinalIgnoreCase)
  $lastSpeakingIndex = $delta.LastIndexOf("Speaking [", [System.StringComparison]::OrdinalIgnoreCase)
  $length = 0
  try {
    if (Test-Path -LiteralPath $Path) {
      $length = (Get-Item -LiteralPath $Path).Length
    }
  } catch {
    $length = 0
  }

  return [pscustomobject]@{
    length = $length
    inputCount = $inputMatches.Count
    speakingCount = $speakingMatches.Count
    hasInputAfterOffset = $lastInputIndex -ge 0
    hasSpeechAfterLastInput = ($lastInputIndex -ge 0 -and $lastSpeakingIndex -gt $lastInputIndex)
  }
}

function Wait-NvdaPostSequenceSpeech {
  param(
    [string]$Path,
    [int64]$Offset,
    [int]$MinWaitSeconds,
    [int]$QuietSeconds,
    [int]$MaxWaitSeconds
  )

  if ($MaxWaitSeconds -le 0) { return }
  $started = Get-Date
  $deadline = $started.AddSeconds($MaxWaitSeconds)
  $stableSince = $null
  $lastLength = -1

  while ((Get-Date) -lt $deadline) {
    $state = Get-NvdaNavigationLogState $Path $Offset
    if ($state.length -ne $lastLength) {
      $lastLength = $state.length
      $stableSince = Get-Date
    } elseif ($null -eq $stableSince) {
      $stableSince = Get-Date
    }

    $elapsed = ((Get-Date) - $started).TotalSeconds
    $quietElapsed = if ($stableSince) { ((Get-Date) - $stableSince).TotalSeconds } else { 0 }
    if (
      $elapsed -ge $MinWaitSeconds -and
      $state.hasInputAfterOffset -and
      $state.hasSpeechAfterLastInput -and
      $quietElapsed -ge $QuietSeconds
    ) {
      return
    }

    Start-Sleep -Milliseconds 500
  }
}

function Copy-GuestFileToHost {
  param([string]$GuestPath, [string]$HostPath)
  $parent = Split-Path -Parent $HostPath
  if ($parent) {
    New-Item -ItemType Directory -Force -Path $parent | Out-Null
  }

  for ($attempt = 0; $attempt -le 4; $attempt += 1) {
    if ($attempt -gt 0) {
      Close-GuestControlSessions
    }
    & $VBoxManage guestcontrol $VmName copyfrom `
      --username $GuestUser `
      --passwordfile $PasswordFile `
      $GuestPath `
      $HostPath
    if ($LASTEXITCODE -eq 0) { return }
    if ($attempt -lt 4) {
      Close-GuestControlSessions
      Start-Sleep -Seconds 5
    }
  }

  throw "Could not copy $GuestPath from guest."
}

function Convert-ToGuestSharePath {
  param([string]$HostPath)
  $repo = (Resolve-Path ".").Path.TrimEnd("\")
  $absolute = (Resolve-Path $HostPath).Path
  if (-not $absolute.StartsWith($repo, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Path is outside the repository and cannot be addressed through ${RepoShareRoot}: $HostPath"
  }
  $relative = $absolute.Substring($repo.Length).TrimStart("\")
  $share = $RepoShareRoot.TrimEnd("\", "/")
  return "$share\$relative"
}

function Join-GuestPath {
  param(
    [string]$Base,
    [string]$Child
  )
  $normalized = ([string]$Base).TrimEnd([char[]]@("\", "/"))
  return "$normalized\$Child"
}

function Invoke-HostNode {
  param([string[]]$Arguments)
  & node @Arguments
  if ($LASTEXITCODE -ne 0) {
    throw "Host node command failed: node $($Arguments -join ' ')"
  }
}

function Ensure-HostBuild {
  if (Test-Path -LiteralPath "dist\cli\index.js") { return }
  if ($SkipBuild) {
    throw "Missing dist\cli\index.js. Run npm run build first or omit -SkipBuild."
  }
  & npm run build
  if ($LASTEXITCODE -ne 0) {
    throw "npm run build failed."
  }
}

if (-not (Test-Path -LiteralPath $VBoxManage)) {
  throw "VBoxManage not found: $VBoxManage"
}

if (-not $Analysis -and -not $Url) {
  throw "Provide -Analysis <full analysis JSON> or -Url <url>."
}

New-Item -ItemType Directory -Force -Path $HostOut | Out-Null

if (-not $Analysis) {
  if (-not $RunAnalysis) {
    throw "No -Analysis supplied. Pass -RunAnalysis to capture a full analysis for -Url."
  }
  Ensure-HostBuild
  $Analysis = Join-Path $HostOut "analysis.full.json"
  $analyzeArgs = @(
    "dist\cli\index.js",
    "analyze-url",
    $Url,
    "--profile",
    $Profile,
    "--format",
    "json",
    "--full-json",
    "--output",
    $Analysis,
    "--no-check-visibility",
    "--timeout",
    "$Timeout"
  )
  if ($WaitForSelector) { $analyzeArgs += @("--wait-for-selector", $WaitForSelector) }
  if ($DetectRoutes) { $analyzeArgs += "--detect-routes" }
  if ($DescendFrames) { $analyzeArgs += "--descend-frames" }
  if ($AutoScroll) { $analyzeArgs += "--auto-scroll" }
  if ($DismissBanners) { $analyzeArgs += "--dismiss-banners" }
  Invoke-HostNode $analyzeArgs
}

$planPath = Join-Path $HostOut "sequence-plan.json"
$planArgs = @(
  "scripts\nvda-vm-sequence.mjs",
  "plan",
  "--analysis",
  $Analysis,
  "--mode",
  $Mode,
  "--max-steps",
  "$StepCount"
)
if ($GuestUrl) {
  $planArgs += @("--url", $GuestUrl)
}
$planArgs += @(
  "--out",
  $planPath
)
Invoke-HostNode $planArgs

$plan = Get-Content -LiteralPath $planPath -Raw | ConvertFrom-Json
if (-not $plan.navigation.scancodes -or $plan.navigation.scancodes.Count -eq 0) {
  throw "Plan did not include keyboard scancodes."
}

$hostRunStatePath = Join-Path $HostOut "sequence-run-state.json"
$hostLogPath = Join-Path $HostOut "nvda-io.log"
$guestPlanPath = Convert-ToGuestSharePath $planPath
$guestRunStatePath = Join-GuestPath $CaptureRoot "sequence-run-state.json"
$guestLogPath = Join-GuestPath $CaptureRoot "nvda-io.log"
$useSharedArtifacts = $false
try {
  $guestHostOut = Convert-ToGuestSharePath $HostOut
  $guestRunStatePath = Join-GuestPath $guestHostOut "sequence-run-state.json"
  $guestLogPath = Join-GuestPath $guestHostOut "nvda-io.log"
  $useSharedArtifacts = $true
} catch {
  Write-Warning "HostOut is not available through the VM share; falling back to Guest Control copyfrom for NVDA artifacts. $($_.Exception.Message)"
}

Start-VmIfRequested
Wait-GuestControl
Wait-InteractiveDesktopReady
if ($AllowAudibleSpeech) {
  & $VBoxManage controlvm $VmName audioout on | Out-Null
} else {
  & $VBoxManage controlvm $VmName audioout off | Out-Null
}
& $VBoxManage controlvm $VmName audioin off | Out-Null

Invoke-GuestBestEffort "C:\Windows\System32\cmd.exe" @(
  "/c",
  "taskkill /IM msedge.exe /F 2>NUL & taskkill /IM nvda_noUIAccess.exe /F 2>NUL & taskkill /IM OneDrive.exe /F 2>NUL & exit /B 0"
) 60000 4 8 "Guest process cleanup"

if (-not $SkipStartNvda) {
  $bootstrapArgs = @(
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    "$RepoShareRoot\scripts\nvda-vm-guest-bootstrap.ps1",
    "-RepoRoot",
    $RepoShareRoot,
    "-LocalRepoRoot",
    $LocalRepoRoot,
    "-CaptureRoot",
    $CaptureRoot,
    "-NvdaLogPath",
    $guestLogPath,
    "-SkipInstall",
    "-SkipBuild",
    "-StartNvda"
  )
  if ($AllowAudibleSpeech) {
    $bootstrapArgs += "-AllowAudibleSpeech"
  }
  Invoke-Guest "C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe" $bootstrapArgs 120000
}

Wait-NvdaReady $guestLogPath

Invoke-Guest "C:\Windows\System32\cmd.exe" @(
  "/c",
  "$CaptureRoot\tools\node-v$NodeVersion-win-x64\node.exe $RepoShareRoot\scripts\nvda-vm-sequence.mjs prepare --plan `"$guestPlanPath`" --capture-root `"$CaptureRoot`" --log `"$guestLogPath`" --out `"$guestRunStatePath`""
) 120000

$preparedRunState = $null
if ($useSharedArtifacts) {
  if (-not (Wait-HostArtifact $hostRunStatePath 20)) {
    throw "Shared run-state artifact was not written by the guest: $hostRunStatePath"
  }
  $preparedRunState = Get-Content -LiteralPath $hostRunStatePath -Raw | ConvertFrom-Json
}

Start-Sleep -Seconds 8
Focus-EdgeDocument
& $VBoxManage controlvm $VmName screenshotpng (Join-Path $HostOut "edge-open.png") | Out-Null

$initialPageSpeechObserved = $null
if ($InitialSpeechTimeoutSeconds -gt 0) {
  try {
    Wait-NvdaInitialPageSpeech $InitialSpeechTimeoutSeconds $guestLogPath $guestRunStatePath
    $initialPageSpeechObserved = $true
  } catch {
    Write-Warning "No initial NVDA page speech after first document focus; refocusing once before navigation."
    Focus-EdgeDocument
    try {
      Wait-NvdaInitialPageSpeech ([Math]::Max(5, [Math]::Floor($InitialSpeechTimeoutSeconds / 2))) $guestLogPath $guestRunStatePath
      $initialPageSpeechObserved = $true
    } catch {
      Write-Warning "No initial NVDA page speech observed before navigation; continuing so extraction can decide whether retry is needed."
      $initialPageSpeechObserved = $false
    }
  }
}

if ($plan.navigation.preludeScancodes -and $plan.navigation.preludeScancodes.Count -gt 0) {
  & $VBoxManage controlvm $VmName keyboardputscancode @($plan.navigation.preludeScancodes) | Out-Null
  Start-Sleep -Seconds $StepDelaySeconds
}

for ($i = 0; $i -lt $StepCount; $i += 1) {
  & $VBoxManage controlvm $VmName keyboardputscancode @($plan.navigation.scancodes) | Out-Null
  Start-Sleep -Seconds $StepDelaySeconds
}

if ($useSharedArtifacts -and $preparedRunState -and $preparedRunState.logOffset -ne $null) {
  Wait-NvdaPostSequenceSpeech `
    -Path $hostLogPath `
    -Offset ([int64]$preparedRunState.logOffset) `
    -MinWaitSeconds $PostSequenceMinWaitSeconds `
    -QuietSeconds $PostSequenceQuietSeconds `
    -MaxWaitSeconds $PostSequenceMaxWaitSeconds
} else {
  Start-Sleep -Seconds $PostSequenceMinWaitSeconds
}
& $VBoxManage controlvm $VmName screenshotpng (Join-Path $HostOut "edge-after-sequence.png") | Out-Null

if ($useSharedArtifacts) {
  $deadline = (Get-Date).AddSeconds(20)
  while ((Get-Date) -lt $deadline) {
    if ((Test-Path -LiteralPath $hostRunStatePath) -and (Test-Path -LiteralPath $hostLogPath)) { break }
    Start-Sleep -Milliseconds 500
  }
  if (-not (Test-Path -LiteralPath $hostRunStatePath)) {
    throw "Shared run-state artifact was not written by the guest: $hostRunStatePath"
  }
  if (-not (Test-Path -LiteralPath $hostLogPath)) {
    throw "Shared NVDA log artifact was not written by the guest: $hostLogPath"
  }
} else {
  Copy-GuestFileToHost $guestRunStatePath $hostRunStatePath
  Copy-GuestFileToHost $guestLogPath $hostLogPath
}

$runState = Get-Content -LiteralPath $hostRunStatePath -Raw | ConvertFrom-Json
$speechJsonl = Join-Path $HostOut "speech-records.jsonl"
$alignmentPath = Join-Path $HostOut "sequence-alignment.json"
$unmatchedPath = Join-Path $HostOut "unmatched-speech.json"

$extractArgs = @(
  "scripts\nvda-vm-sequence.mjs",
  "extract",
  "--plan",
  $planPath,
  "--log",
  $hostLogPath,
  "--offset",
  "$($runState.logOffset)",
  "--jsonl-out",
  $speechJsonl,
  "--alignment-out",
  $alignmentPath,
  "--unmatched-out",
  $unmatchedPath,
  "--source",
  "nvda-vm",
  "--at-version",
  $AtVersion,
  "--browser",
  $Browser
)
if (-not $AllowPreInputSpeechMatching) {
  $extractArgs += "--require-navigation-input"
}
Invoke-HostNode $extractArgs

$alignment = Get-Content -LiteralPath $alignmentPath -Raw | ConvertFrom-Json
$plannedTargets = 0.0
$matchedTargets = 0.0
$parsedSpeechBlocks = 0.0
if ($alignment.summary -and $null -ne $alignment.summary.plannedTargets) {
  $plannedTargets = [double]$alignment.summary.plannedTargets
}
if ($alignment.summary -and $null -ne $alignment.summary.matchedTargets) {
  $matchedTargets = [double]$alignment.summary.matchedTargets
}
if ($alignment.summary -and $null -ne $alignment.summary.parsedSpeechBlocks) {
  $parsedSpeechBlocks = [double]$alignment.summary.parsedSpeechBlocks
}
$matchRatio = if ($plannedTargets -gt 0) { $matchedTargets / $plannedTargets } else { 1 }
$ingestionSkipped = $false
$ingestionSkipReason = $null
$inputReceivedAfterOffset = Test-LogDeltaPattern `
  -Path $hostLogPath `
  -Offset ([int64]$runState.logOffset) `
  -Pattern "IO - inputCore\.InputManager\.executeGesture"
$harnessIssue = $null
$harnessIssueDetail = $null

if ($plannedTargets -gt 0 -and $parsedSpeechBlocks -eq 0) {
  if ($inputReceivedAfterOffset) {
    $harnessIssue = "input-received-no-speech"
    $harnessIssueDetail = "NVDA logged keyboard gestures after the run offset but emitted no speech blocks."
  } else {
    $harnessIssue = "no-input-or-speech"
    $harnessIssueDetail = "No NVDA speech blocks or keyboard gestures were logged after the run offset."
  }
}
if (-not $harnessIssue -and $plannedTargets -gt 0 -and $matchedTargets -eq 0 -and $initialPageSpeechObserved -eq $false) {
  $harnessIssue = "initial-document-speech-missing"
  $harnessIssueDetail = "NVDA did not emit initial document speech after focusing the browser document; browse-mode navigation evidence is not stable for this run."
}

if ($AppendCalibration -and $harnessIssue) {
  $ingestionSkipped = $true
  $ingestionSkipReason = $harnessIssueDetail
  Write-Warning "Skipping calibration ingestion: $ingestionSkipReason"
} elseif ($AppendCalibration -and $plannedTargets -eq 0) {
  $ingestionSkipped = $true
  $ingestionSkipReason = "no planned targets for mode $Mode"
  Write-Warning "Skipping calibration ingestion: $ingestionSkipReason"
} elseif ($AppendCalibration -and $matchRatio -lt $MinimumMatchRatio) {
  $ingestionSkipped = $true
  $ingestionSkipReason = "match ratio $([Math]::Round($matchRatio, 3)) below minimum $MinimumMatchRatio"
  Write-Warning "Skipping calibration ingestion: $ingestionSkipReason"
}

if ($AppendCalibration -and -not $ingestionSkipped) {
  Ensure-HostBuild
  Invoke-HostNode @(
    "scripts\nvda-vm-observe.mjs",
    "--analysis",
    $Analysis,
    "--speech-log",
    $speechJsonl,
    "--append-calibration",
    $AppendCalibration,
    "--out",
    (Join-Path $HostOut "observer"),
    "--source",
    "nvda-vm",
    "--tester",
    "vm-nvda",
    "--at-version",
    $AtVersion,
    "--browser",
    $Browser
  )
}

$summary = [ordered]@{
  schema = "tactual-nvda-vm-host-calibration@1"
  generatedAt = (Get-Date).ToUniversalTime().ToString("o")
  vmName = $VmName
  analysis = (Resolve-Path $Analysis).Path
  url = $Url
  guestUrl = $GuestUrl
  mode = $Mode
  stepCount = $StepCount
  initialSpeechTimeoutSeconds = $InitialSpeechTimeoutSeconds
  initialPageSpeechObserved = $initialPageSpeechObserved
  postSequenceMinWaitSeconds = $PostSequenceMinWaitSeconds
  postSequenceQuietSeconds = $PostSequenceQuietSeconds
  postSequenceMaxWaitSeconds = $PostSequenceMaxWaitSeconds
  requireNavigationInput = -not [bool]$AllowPreInputSpeechMatching
  plan = (Resolve-Path $planPath).Path
  speechRecords = (Resolve-Path $speechJsonl).Path
  alignment = (Resolve-Path $alignmentPath).Path
  unmatchedSpeech = (Resolve-Path $unmatchedPath).Path
  calibration = $AppendCalibration
  ingestionSkipped = $ingestionSkipped
  ingestionSkipReason = $ingestionSkipReason
  matchRatio = $matchRatio
  parsedSpeechBlocks = $parsedSpeechBlocks
  matchedTargets = $matchedTargets
  plannedTargets = $plannedTargets
  inputReceivedAfterOffset = $inputReceivedAfterOffset
  harnessIssue = $harnessIssue
  harnessIssueDetail = $harnessIssueDetail
  minimumMatchRatio = $MinimumMatchRatio
}
$summaryPath = Join-Path $HostOut "host-calibration-summary.json"
$summary | ConvertTo-Json -Depth 6 | Set-Content -Path $summaryPath -Encoding utf8

Write-Host "NVDA VM calibration output: $HostOut"
Write-Host "Speech records: $speechJsonl"
Write-Host "Alignment: $alignmentPath"
Write-Host "Unmatched speech: $unmatchedPath"
