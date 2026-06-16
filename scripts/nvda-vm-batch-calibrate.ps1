param(
  [string]$VmName = "Tactual-NVDA-Win11",
  [string]$VBoxManage = "C:\Program Files\Oracle\VirtualBox\VBoxManage.exe",
  [string]$GuestUser = "tactual",
  [string]$PasswordFile = "$env:USERPROFILE\VirtualBox VMs\Tactual-NVDA-Win11\tactual-user-password.txt",
  [int]$Port = 41789,
  [string]$HostOut = "build\nvda-vm\calibration-batch",
  [string]$GuestBaseUrl = "",
  [string]$CaseFilter = "",
  [int]$RepeatCount = 1,
  [int]$StepDelaySeconds = 2,
  [int]$InitialSpeechTimeoutSeconds = 5,
  [int]$PostSequenceMinWaitSeconds = 8,
  [int]$PostSequenceQuietSeconds = 4,
  [int]$PostSequenceMaxWaitSeconds = 45,
  [int]$CaseDelaySeconds = 15,
  [int]$CaseTimeoutSeconds = 420,
  [int]$GuestControlProbeTimeoutSeconds = 25,
  [int]$VmRecoveryTimeoutSeconds = 180,
  [int]$VmRecoveryDelaySeconds = 30,
  [int]$NoSpeechRetryCount = 1,
  [bool]$HealthCheckEachCase = $true,
  [switch]$StartVm,
  [switch]$KeepServer,
  [switch]$NoSpeechRetry,
  [switch]$RecycleVmBeforeEachCase,
  [switch]$RecycleVmOnTimeout,
  [switch]$RecycleVmWhenUnhealthy,
  [switch]$StopOnFailure,
  [switch]$SmokeOnly,
  [switch]$IncludeExperimentalDialogCases
)

$ErrorActionPreference = "Stop"

if ($RepeatCount -lt 1) {
  throw "-RepeatCount must be at least 1."
}

function Invoke-Checked {
  param(
    [string]$FilePath,
    [string[]]$Arguments
  )
  & $FilePath @Arguments
  if ($LASTEXITCODE -ne 0) {
    throw "Command failed with exit code ${LASTEXITCODE}: $FilePath $($Arguments -join ' ')"
  }
}

function Invoke-VBoxBestEffort {
  param([string[]]$Arguments)
  if (-not (Test-Path -LiteralPath $VBoxManage)) { return }
  & $VBoxManage @Arguments | Out-Null
}

function ConvertTo-CommandLineArgument {
  param([string]$Value)
  $text = [string]$Value
  if ($text -notmatch '[\s"]') { return $text }
  return '"' + ($text -replace '"', '\"') + '"'
}

function Stop-ProcessTree {
  param([int]$ProcessId)
  $taskkill = Join-Path $env:SystemRoot "System32\taskkill.exe"
  if (Test-Path -LiteralPath $taskkill) {
    & $taskkill /PID $ProcessId /T /F | Out-Null
  } else {
    Stop-Process -Id $ProcessId -Force -ErrorAction SilentlyContinue
  }
}

function Invoke-ProcessWithTimeout {
  param(
    [string]$FilePath,
    [string[]]$Arguments,
    [int]$TimeoutSeconds,
    [string]$StdoutPath,
    [string]$StderrPath,
    [string]$WorkingDirectory = $repoRoot
  )

  $parent = Split-Path -Parent $StdoutPath
  if ($parent) { New-Item -ItemType Directory -Force -Path $parent | Out-Null }
  $parent = Split-Path -Parent $StderrPath
  if ($parent) { New-Item -ItemType Directory -Force -Path $parent | Out-Null }

  $argumentLine = ($Arguments | ForEach-Object { ConvertTo-CommandLineArgument $_ }) -join " "
  $process = Start-Process `
    -FilePath $FilePath `
    -ArgumentList $argumentLine `
    -WorkingDirectory $WorkingDirectory `
    -WindowStyle Hidden `
    -RedirectStandardOutput $StdoutPath `
    -RedirectStandardError $StderrPath `
    -PassThru

  $completed = $process.WaitForExit([Math]::Max(1, $TimeoutSeconds) * 1000)
  if (-not $completed) {
    Stop-ProcessTree $process.Id
    return [pscustomobject]@{
      timedOut = $true
      exitCode = $null
      stdout = $StdoutPath
      stderr = $StderrPath
    }
  }
  $process.WaitForExit()
  $process.Refresh()

  return [pscustomobject]@{
    timedOut = $false
    exitCode = $process.ExitCode
    stdout = $StdoutPath
    stderr = $StderrPath
  }
}

function Invoke-VBoxWithTimeout {
  param(
    [string[]]$Arguments,
    [int]$TimeoutSeconds = 30,
    [string]$LogPrefix = "vbox"
  )
  if (-not (Test-Path -LiteralPath $VBoxManage)) {
    return [pscustomobject]@{ timedOut = $false; exitCode = 127; stdout = $null; stderr = $null }
  }
  $safe = ($LogPrefix -replace '[^a-zA-Z0-9._-]', '-')
  $stdout = Join-Path $batchOut "$safe.stdout.log"
  $stderr = Join-Path $batchOut "$safe.stderr.log"
  return Invoke-ProcessWithTimeout `
    -FilePath $VBoxManage `
    -Arguments $Arguments `
    -TimeoutSeconds $TimeoutSeconds `
    -StdoutPath $stdout `
    -StderrPath $stderr `
    -WorkingDirectory $repoRoot
}

function Close-GuestControlSessions {
  Invoke-VBoxWithTimeout @("guestcontrol", $VmName, "closesession", "--all", "--quiet") 15 "guestcontrol-closesession" | Out-Null
}

function Test-GuestControlResponsive {
  param([string]$LogPrefix = "guestcontrol-probe")
  $result = Invoke-VBoxWithTimeout `
    @(
      "guestcontrol",
      $VmName,
      "run",
      "--exe",
      "C:\Windows\System32\cmd.exe",
      "--username",
      $GuestUser,
      "--passwordfile",
      $PasswordFile,
      "--wait-stdout",
      "--wait-stderr",
      "--timeout",
      "10000",
      "--ignore-orphaned-processes",
      "--",
      "/c",
      "whoami"
    ) `
    $GuestControlProbeTimeoutSeconds `
    $LogPrefix
  if (-not $result.timedOut -and $result.exitCode -eq 0) { return $true }

  # VirtualBox occasionally completes a short guestcontrol run but reports a
  # blank process exit code to PowerShell. Treat an otherwise successful
  # whoami transcript as healthy so the batch runner does not reset a usable
  # VM before every case.
  if (-not $result.timedOut -and [string]::IsNullOrWhiteSpace([string]$result.exitCode) -and $result.stdout) {
    try {
      $stdout = Get-Content -LiteralPath $result.stdout -Raw
      if ($stdout.ToLowerInvariant().Contains($GuestUser.ToLowerInvariant())) {
        return $true
      }
    } catch {
      return $false
    }
  }

  return $false
}

function Wait-GuestControlResponsive {
  param([int]$TimeoutSeconds)
  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  while ((Get-Date) -lt $deadline) {
    if (Test-GuestControlResponsive "guestcontrol-recovery-probe") { return $true }
    Close-GuestControlSessions
    Start-Sleep -Seconds 10
  }
  return $false
}

function Restart-VmForRecovery {
  param([string]$Reason)
  Write-Warning "Recovering VM $VmName after $Reason."
  Close-GuestControlSessions
  Invoke-VBoxWithTimeout @("controlvm", $VmName, "audioout", "off") 20 "recovery-audioout-off" | Out-Null
  Invoke-VBoxWithTimeout @("controlvm", $VmName, "audioin", "off") 20 "recovery-audioin-off" | Out-Null

  $reset = Invoke-VBoxWithTimeout @("controlvm", $VmName, "reset") 60 "recovery-reset"
  if ($reset.exitCode -ne 0 -and -not $reset.timedOut) {
    Invoke-VBoxWithTimeout @("startvm", $VmName, "--type", "headless") 60 "recovery-startvm" | Out-Null
  }

  if ($VmRecoveryDelaySeconds -gt 0) {
    Start-Sleep -Seconds $VmRecoveryDelaySeconds
  }
  $ready = Wait-GuestControlResponsive $VmRecoveryTimeoutSeconds
  Invoke-VBoxWithTimeout @("controlvm", $VmName, "audioout", "off") 20 "recovery-post-audioout-off" | Out-Null
  Invoke-VBoxWithTimeout @("controlvm", $VmName, "audioin", "off") 20 "recovery-post-audioin-off" | Out-Null
  return $ready
}

function Invoke-CaseCalibration {
  param(
    [string]$CaseName,
    [string]$CaseOut,
    [string[]]$Arguments,
    [int]$Attempt = 0
  )

  New-Item -ItemType Directory -Force -Path $CaseOut | Out-Null
  $suffix = if ($Attempt -gt 0) { "-retry$Attempt" } else { "" }
  $stdout = Join-Path $CaseOut "host-calibrate$suffix.stdout.log"
  $stderr = Join-Path $CaseOut "host-calibrate$suffix.stderr.log"
  $result = Invoke-ProcessWithTimeout `
    -FilePath "powershell" `
    -Arguments $Arguments `
    -TimeoutSeconds $CaseTimeoutSeconds `
    -StdoutPath $stdout `
    -StderrPath $stderr `
    -WorkingDirectory $repoRoot

  if ($result.timedOut) {
    if ($RecycleVmOnTimeout) {
      Restart-VmForRecovery "case timeout in $CaseName" | Out-Null
    } else {
      Close-GuestControlSessions
    }
    throw "host-calibration-timeout after ${CaseTimeoutSeconds}s: $CaseName (stdout=$stdout, stderr=$stderr)"
  }
  if ([string]::IsNullOrWhiteSpace([string]$result.exitCode) -and (Test-Path -LiteralPath (Join-Path $CaseOut "host-calibration-summary.json"))) {
    $result.exitCode = 0
  }
  if ($result.exitCode -ne 0) {
    throw "host-calibration-command-failed exit $($result.exitCode): $CaseName (stdout=$stdout, stderr=$stderr)"
  }
  return $result
}

function Wait-FixtureServer {
  param(
    [string]$ReadyFile,
    [string]$ProbeUrl,
    [System.Diagnostics.Process]$Process
  )

  $deadline = (Get-Date).AddSeconds(30)
  while ((Get-Date) -lt $deadline) {
    if ($Process.HasExited) {
      throw "Fixture server exited early with code $($Process.ExitCode)."
    }
    if (Test-Path -LiteralPath $ReadyFile) {
      try {
        $response = Invoke-WebRequest $ProbeUrl -UseBasicParsing -TimeoutSec 5
        if ($response.StatusCode -eq 200) { return }
      } catch {
        Start-Sleep -Milliseconds 500
        continue
      }
    }
    Start-Sleep -Milliseconds 500
  }
  throw "Timed out waiting for fixture server at $ProbeUrl."
}

function Read-AlignmentSummary {
  param([string]$CaseOut)
  $alignmentPath = Join-Path $CaseOut "sequence-alignment.json"
  if (-not (Test-Path -LiteralPath $alignmentPath)) { return $null }
  $alignment = Get-Content -LiteralPath $alignmentPath -Raw | ConvertFrom-Json
  return $alignment.summary
}

function Test-NoSpeechCase {
  param($Summary)
  if (-not $Summary) { return $false }
  return ([int]$Summary.plannedTargets -gt 0 -and [int]$Summary.parsedSpeechBlocks -eq 0)
}

function Should-RetryNoSpeechCase {
  param($Summary)
  if ($NoSpeechRetry) { return $false }
  return (Test-NoSpeechCase $Summary)
}

function Get-CaseSetting {
  param(
    $Case,
    [string]$Name,
    $Default
  )
  $property = $Case.PSObject.Properties[$Name]
  if ($property) { return $property.Value }
  return $Default
}

$repoRoot = (Resolve-Path ".").Path
$hostBaseUrl = "http://127.0.0.1:$Port"
if (-not $GuestBaseUrl) {
  $GuestBaseUrl = "http://10.0.2.2:$Port"
}

$stamp = Get-Date -Format "yyyy-MM-dd-HHmmss"
$batchOut = Join-Path $HostOut $stamp
$serverReady = Join-Path $batchOut "fixture-server.ready.json"
$serverStdout = Join-Path $batchOut "fixture-server.stdout.log"
$serverStderr = Join-Path $batchOut "fixture-server.stderr.log"
$calibrationPath = Join-Path $batchOut "calibration.json"
New-Item -ItemType Directory -Force -Path $batchOut | Out-Null

$cases = @(
  [pscustomobject]@{ Name = "good-tab"; Fixture = "fixtures/good-page.html"; Mode = "tab"; Steps = 8 },
  [pscustomobject]@{ Name = "good-heading"; Fixture = "fixtures/good-page.html"; Mode = "heading"; Steps = 5 },
  [pscustomobject]@{ Name = "good-link"; Fixture = "fixtures/good-page.html"; Mode = "link"; Steps = 4 },
  [pscustomobject]@{ Name = "good-button"; Fixture = "fixtures/good-page.html"; Mode = "button"; Steps = 3 },
  [pscustomobject]@{ Name = "good-form-field"; Fixture = "fixtures/good-page.html"; Mode = "form-field"; Steps = 2 },
  [pscustomobject]@{ Name = "good-landmark"; Fixture = "fixtures/good-page.html"; Mode = "landmark"; Steps = 4 },
  [pscustomobject]@{ Name = "interactive-tab"; Fixture = "fixtures/interactive-page.html"; Mode = "tab"; Steps = 12 },
  [pscustomobject]@{ Name = "interactive-heading"; Fixture = "fixtures/interactive-page.html"; Mode = "heading"; Steps = 7 },
  [pscustomobject]@{ Name = "interactive-button"; Fixture = "fixtures/interactive-page.html"; Mode = "button"; Steps = 6 },
  [pscustomobject]@{ Name = "interactive-link"; Fixture = "fixtures/interactive-page.html"; Mode = "link"; Steps = 5 },
  [pscustomobject]@{ Name = "interactive-landmark"; Fixture = "fixtures/interactive-page.html"; Mode = "landmark"; Steps = 4 },
  [pscustomobject]@{ Name = "widgets-tab"; Fixture = "fixtures/corpus-widget-contracts.html"; Mode = "tab"; Steps = 12 },
  [pscustomobject]@{ Name = "widgets-heading"; Fixture = "fixtures/corpus-widget-contracts.html"; Mode = "heading"; Steps = 5 },
  [pscustomobject]@{ Name = "widgets-button"; Fixture = "fixtures/corpus-widget-contracts.html"; Mode = "button"; Steps = 6 },
  [pscustomobject]@{ Name = "widgets-form-field"; Fixture = "fixtures/corpus-widget-contracts.html"; Mode = "form-field"; Steps = 6 },
  [pscustomobject]@{ Name = "widgets-landmark"; Fixture = "fixtures/corpus-widget-contracts.html"; Mode = "landmark"; Steps = 3 },
  [pscustomobject]@{ Name = "mapper-tab"; Fixture = "fixtures/calibration-at-mapper-lab.html"; Mode = "tab"; Steps = 16; DescendFrames = $true },
  [pscustomobject]@{ Name = "mapper-heading"; Fixture = "fixtures/calibration-at-mapper-lab.html"; Mode = "heading"; Steps = 8; DescendFrames = $true },
  [pscustomobject]@{ Name = "mapper-link"; Fixture = "fixtures/calibration-at-mapper-lab.html"; Mode = "link"; Steps = 8; DescendFrames = $true },
  [pscustomobject]@{ Name = "mapper-button"; Fixture = "fixtures/calibration-at-mapper-lab.html"; Mode = "button"; Steps = 10; DescendFrames = $true },
  [pscustomobject]@{ Name = "mapper-form-field"; Fixture = "fixtures/calibration-at-mapper-lab.html"; Mode = "form-field"; Steps = 20; DescendFrames = $true },
  [pscustomobject]@{ Name = "mapper-landmark"; Fixture = "fixtures/calibration-at-mapper-lab.html"; Mode = "landmark"; Steps = 7; DescendFrames = $true },
  [pscustomobject]@{ Name = "spa-heading"; Fixture = "fixtures/calibration-spa-route-lab.html"; Mode = "heading"; Steps = 4; DetectRoutes = $true },
  [pscustomobject]@{ Name = "spa-button"; Fixture = "fixtures/calibration-spa-route-lab.html"; Mode = "button"; Steps = 4; DetectRoutes = $true },
  [pscustomobject]@{ Name = "spa-link"; Fixture = "fixtures/calibration-spa-route-lab.html"; Mode = "link"; Steps = 4; DetectRoutes = $true },
  [pscustomobject]@{ Name = "spa-form-field"; Fixture = "fixtures/calibration-spa-route-lab.html"; Mode = "form-field"; Steps = 4; DetectRoutes = $true },
  [pscustomobject]@{ Name = "structured-heading"; Fixture = "fixtures/calibration-structured-lab.html"; Mode = "heading"; Steps = 6 },
  [pscustomobject]@{ Name = "structured-button"; Fixture = "fixtures/calibration-structured-lab.html"; Mode = "button"; Steps = 5 },
  [pscustomobject]@{ Name = "oopif-heading"; Fixture = "fixtures/calibration-oopif-parent.html"; Mode = "heading"; Steps = 5; DescendFrames = $true; InitialSpeechTimeoutSeconds = 10 },
  [pscustomobject]@{ Name = "oopif-button"; Fixture = "fixtures/calibration-oopif-parent.html"; Mode = "button"; Steps = 5; DescendFrames = $true; InitialSpeechTimeoutSeconds = 10 },
  [pscustomobject]@{ Name = "oopif-form-field"; Fixture = "fixtures/calibration-oopif-parent.html"; Mode = "form-field"; Steps = 8; DescendFrames = $true; InitialSpeechTimeoutSeconds = 10; PostSequenceMaxWaitSeconds = 75 },
  [pscustomobject]@{ Name = "oopif-tab"; Fixture = "fixtures/calibration-oopif-parent.html"; Mode = "tab"; Steps = 10; DescendFrames = $true; InitialSpeechTimeoutSeconds = 10; PostSequenceMinWaitSeconds = 15; PostSequenceMaxWaitSeconds = 90 }
)

if ($IncludeExperimentalDialogCases) {
  $cases += @(
    [pscustomobject]@{ Name = "dialog-heading"; Fixture = "fixtures/calibration-dialog-lab.html"; Mode = "heading"; Steps = 4 },
    [pscustomobject]@{ Name = "dialog-button"; Fixture = "fixtures/calibration-dialog-lab.html"; Mode = "button"; Steps = 5 },
    [pscustomobject]@{ Name = "dialog-form-field"; Fixture = "fixtures/calibration-dialog-lab.html"; Mode = "form-field"; Steps = 8 },
    [pscustomobject]@{ Name = "dialog-landmark"; Fixture = "fixtures/calibration-dialog-lab.html"; Mode = "landmark"; Steps = 5 }
  )
}

if ($SmokeOnly) {
  $cases = $cases | Where-Object { $_.Name -in @("good-tab", "interactive-button", "widgets-form-field", "mapper-form-field") }
}

if ($CaseFilter) {
  $selectedCases = $CaseFilter -split "," | ForEach-Object { $_.Trim() } | Where-Object { $_ }
  $cases = $cases | Where-Object { $selectedCases -contains $_.Name }
  if (-not $cases -or @($cases).Count -eq 0) {
    throw "No calibration cases matched -CaseFilter $CaseFilter."
  }
}

if ($RepeatCount -gt 1) {
  $baseCases = @($cases)
  $cases = @()
  for ($repeat = 1; $repeat -le $RepeatCount; $repeat += 1) {
    foreach ($case in $baseCases) {
      $props = [ordered]@{}
      foreach ($property in $case.PSObject.Properties) {
        $props[$property.Name] = $property.Value
      }
      $props["BaseName"] = $case.Name
      $props["Name"] = "$($case.Name)-r$repeat"
      $props["RepeatIndex"] = $repeat
      $props["RepeatCount"] = $RepeatCount
      $cases += [pscustomobject]$props
    }
  }
}

$serverArgs = @(
  "scripts\nvda-vm-fixture-server.mjs",
  "--port",
  "$Port",
  "--host",
  "0.0.0.0",
  "--root",
  $repoRoot,
  "--ready-file",
  $serverReady
)

$server = $null
$results = @()

try {
  $server = Start-Process `
    -FilePath "node" `
    -ArgumentList $serverArgs `
    -WorkingDirectory $repoRoot `
    -WindowStyle Hidden `
    -RedirectStandardOutput $serverStdout `
    -RedirectStandardError $serverStderr `
    -PassThru

  Wait-FixtureServer `
    -ReadyFile $serverReady `
    -ProbeUrl "$hostBaseUrl/fixtures/good-page.html" `
    -Process $server

  Close-GuestControlSessions
  Invoke-VBoxBestEffort @("controlvm", $VmName, "audioout", "off")
  Invoke-VBoxBestEffort @("controlvm", $VmName, "audioin", "off")

  foreach ($case in $cases) {
    $caseOut = Join-Path $batchOut $case.Name
    New-Item -ItemType Directory -Force -Path $caseOut | Out-Null
    $hostUrl = "$hostBaseUrl/$($case.Fixture)"
    $guestUrl = "$GuestBaseUrl/$($case.Fixture)"
    $caseInitialSpeechTimeoutSeconds = Get-CaseSetting $case "InitialSpeechTimeoutSeconds" $InitialSpeechTimeoutSeconds
    $casePostSequenceMinWaitSeconds = Get-CaseSetting $case "PostSequenceMinWaitSeconds" $PostSequenceMinWaitSeconds
    $casePostSequenceQuietSeconds = Get-CaseSetting $case "PostSequenceQuietSeconds" $PostSequenceQuietSeconds
    $casePostSequenceMaxWaitSeconds = Get-CaseSetting $case "PostSequenceMaxWaitSeconds" $PostSequenceMaxWaitSeconds
    if ($CaseDelaySeconds -gt 0) {
      Start-Sleep -Seconds $CaseDelaySeconds
    }
    Close-GuestControlSessions

    if ($RecycleVmBeforeEachCase) {
      $ready = Restart-VmForRecovery "pre-case isolation before $($case.Name)"
      if (-not $ready) {
        $message = "VM recovery did not produce responsive Guest Control before $($case.Name)."
        $results += [pscustomobject]@{
          name = $case.Name
          baseName = if ($case.BaseName) { $case.BaseName } else { $case.Name }
          repeatIndex = if ($case.RepeatIndex) { $case.RepeatIndex } else { 1 }
          repeatCount = $RepeatCount
          fixture = $case.Fixture
          mode = $case.Mode
          steps = $case.Steps
          status = "harness-blocked"
          hostUrl = $hostUrl
          guestUrl = $guestUrl
          output = (Resolve-Path $caseOut).Path
          initialSpeechTimeoutSeconds = $caseInitialSpeechTimeoutSeconds
          postSequenceMinWaitSeconds = $casePostSequenceMinWaitSeconds
          postSequenceQuietSeconds = $casePostSequenceQuietSeconds
          postSequenceMaxWaitSeconds = $casePostSequenceMaxWaitSeconds
          harnessIssue = "guest-control-unresponsive"
          harnessIssueDetail = $message
          plannedTargets = 0
          parsedSpeechBlocks = 0
          matchedTargets = 0
          missingTargets = 0
          unmatchedSpeechBlocks = 0
          error = $message
        }
        Write-Warning $message
        if ($StopOnFailure) { throw $message }
        continue
      }
    }

    if ($HealthCheckEachCase) {
      $healthy = Test-GuestControlResponsive "$($case.Name)-guestcontrol-preflight"
      $attemptedRecovery = $false
      if (-not $healthy -and $RecycleVmWhenUnhealthy) {
        $attemptedRecovery = $true
        $healthy = Restart-VmForRecovery "unresponsive Guest Control before $($case.Name)"
      }
      if (-not $healthy -and ($attemptedRecovery -or -not $StartVm)) {
        $message = "Guest Control was not responsive before $($case.Name)."
        $results += [pscustomobject]@{
          name = $case.Name
          baseName = if ($case.BaseName) { $case.BaseName } else { $case.Name }
          repeatIndex = if ($case.RepeatIndex) { $case.RepeatIndex } else { 1 }
          repeatCount = $RepeatCount
          fixture = $case.Fixture
          mode = $case.Mode
          steps = $case.Steps
          status = "harness-blocked"
          hostUrl = $hostUrl
          guestUrl = $guestUrl
          output = (Resolve-Path $caseOut).Path
          initialSpeechTimeoutSeconds = $caseInitialSpeechTimeoutSeconds
          postSequenceMinWaitSeconds = $casePostSequenceMinWaitSeconds
          postSequenceQuietSeconds = $casePostSequenceQuietSeconds
          postSequenceMaxWaitSeconds = $casePostSequenceMaxWaitSeconds
          harnessIssue = "guest-control-unresponsive"
          harnessIssueDetail = $message
          plannedTargets = 0
          parsedSpeechBlocks = 0
          matchedTargets = 0
          missingTargets = 0
          unmatchedSpeechBlocks = 0
          error = $message
        }
        Write-Warning $message
        if ($StopOnFailure) { throw $message }
        continue
      } elseif (-not $healthy) {
        Write-Warning "Guest Control probe failed before $($case.Name); continuing because -StartVm lets the case bootstrap or time out cleanly."
      }
    }

    $arguments = @(
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      "scripts\nvda-vm-host-calibrate.ps1",
      "-VmName",
      $VmName,
      "-VBoxManage",
      $VBoxManage,
      "-GuestUser",
      $GuestUser,
      "-PasswordFile",
      $PasswordFile,
      "-Url",
      $hostUrl,
      "-GuestUrl",
      $guestUrl,
      "-RunAnalysis",
      "-Mode",
      $case.Mode,
      "-StepCount",
      "$($case.Steps)",
      "-StepDelaySeconds",
      "$StepDelaySeconds",
      "-InitialSpeechTimeoutSeconds",
      "$caseInitialSpeechTimeoutSeconds",
      "-PostSequenceMinWaitSeconds",
      "$casePostSequenceMinWaitSeconds",
      "-PostSequenceQuietSeconds",
      "$casePostSequenceQuietSeconds",
      "-PostSequenceMaxWaitSeconds",
      "$casePostSequenceMaxWaitSeconds",
      "-HostOut",
      $caseOut,
      "-AppendCalibration",
      $calibrationPath,
      "-StartVm"
    )
    if ($case.DescendFrames) { $arguments += "-DescendFrames" }
    if ($case.DetectRoutes) { $arguments += "-DetectRoutes" }
    if ($case.AutoScroll) { $arguments += "-AutoScroll" }
    if ($case.DismissBanners) { $arguments += "-DismissBanners" }

    try {
      Write-Host "Running $($case.Name): $guestUrl ($($case.Mode), $($case.Steps) steps)"
      $runResult = Invoke-CaseCalibration $case.Name $caseOut $arguments 0
      $summary = Read-AlignmentSummary $caseOut
      $retryAttempts = 0
      while ((Should-RetryNoSpeechCase $summary) -and $retryAttempts -lt $NoSpeechRetryCount) {
        $nextAttempt = $retryAttempts + 1
        Write-Warning "No NVDA speech parsed for $($case.Name); retrying after guest/NVDA warmup ($nextAttempt/$NoSpeechRetryCount)."
        Start-Sleep -Seconds 8
        $runResult = Invoke-CaseCalibration $case.Name $caseOut $arguments $nextAttempt
        $summary = Read-AlignmentSummary $caseOut
        $retryAttempts += 1
      }
      $caseStatus = "passed"
      $harnessIssue = $null
      if (-not $summary) {
        $caseStatus = "harness-blocked"
        $harnessIssue = "missing sequence alignment summary"
      } elseif (Test-NoSpeechCase $summary) {
        $caseStatus = "harness-blocked"
        $harnessIssue = "no NVDA speech parsed after keyboard input"
      }
      $results += [pscustomobject]@{
        name = $case.Name
        baseName = if ($case.BaseName) { $case.BaseName } else { $case.Name }
        repeatIndex = if ($case.RepeatIndex) { $case.RepeatIndex } else { 1 }
        repeatCount = $RepeatCount
        fixture = $case.Fixture
        mode = $case.Mode
        steps = $case.Steps
        status = $caseStatus
        retryAttempts = $retryAttempts
        harnessIssue = $harnessIssue
        hostUrl = $hostUrl
        guestUrl = $guestUrl
        output = (Resolve-Path $caseOut).Path
        initialSpeechTimeoutSeconds = $caseInitialSpeechTimeoutSeconds
        postSequenceMinWaitSeconds = $casePostSequenceMinWaitSeconds
        postSequenceQuietSeconds = $casePostSequenceQuietSeconds
        postSequenceMaxWaitSeconds = $casePostSequenceMaxWaitSeconds
        hostCalibrateStdout = $runResult.stdout
        hostCalibrateStderr = $runResult.stderr
        plannedTargets = $summary.plannedTargets
        parsedSpeechBlocks = $summary.parsedSpeechBlocks
        matchedTargets = $summary.matchedTargets
        missingTargets = $summary.missingTargets
        unmatchedSpeechBlocks = $summary.unmatchedSpeechBlocks
      }
    } catch {
      $errorMessage = $_.Exception.Message
      $harnessIssue = $null
      if ($errorMessage -match "host-calibration-timeout") {
        $harnessIssue = "host-calibration-timeout"
      } elseif ($errorMessage -match "host-calibration-command-failed|Guest command failed|VBoxManage|EDGE_|NVDA|DESKTOP_|no NVDA speech") {
        $harnessIssue = "host-calibration-command-failed"
      }
      $results += [pscustomobject]@{
        name = $case.Name
        baseName = if ($case.BaseName) { $case.BaseName } else { $case.Name }
        repeatIndex = if ($case.RepeatIndex) { $case.RepeatIndex } else { 1 }
        repeatCount = $RepeatCount
        fixture = $case.Fixture
        mode = $case.Mode
        steps = $case.Steps
        status = if ($harnessIssue) { "harness-blocked" } else { "failed" }
        hostUrl = $hostUrl
        guestUrl = $guestUrl
        output = $caseOut
        initialSpeechTimeoutSeconds = $caseInitialSpeechTimeoutSeconds
        postSequenceMinWaitSeconds = $casePostSequenceMinWaitSeconds
        postSequenceQuietSeconds = $casePostSequenceQuietSeconds
        postSequenceMaxWaitSeconds = $casePostSequenceMaxWaitSeconds
        harnessIssue = $harnessIssue
        harnessIssueDetail = $errorMessage
        plannedTargets = 0
        parsedSpeechBlocks = 0
        matchedTargets = 0
        missingTargets = 0
        unmatchedSpeechBlocks = 0
        error = $errorMessage
      }
      Write-Warning "Calibration case failed: $($case.Name): $errorMessage"
      Close-GuestControlSessions
      if ($StopOnFailure) { throw }
    }
  }
} finally {
  if ($server -and -not $KeepServer -and -not $server.HasExited) {
    Stop-Process -Id $server.Id -Force
  }
}

$summaryPath = Join-Path $batchOut "batch-summary.json"
$summary = [ordered]@{
  schema = "tactual-nvda-vm-batch-calibration@1"
  generatedAt = (Get-Date).ToUniversalTime().ToString("o")
  vmName = $VmName
  repeatCount = $RepeatCount
  caseDelaySeconds = $CaseDelaySeconds
  initialSpeechTimeoutSeconds = $InitialSpeechTimeoutSeconds
  postSequenceMinWaitSeconds = $PostSequenceMinWaitSeconds
  postSequenceQuietSeconds = $PostSequenceQuietSeconds
  postSequenceMaxWaitSeconds = $PostSequenceMaxWaitSeconds
  recycleVmBeforeEachCase = [bool]$RecycleVmBeforeEachCase
  hostBaseUrl = $hostBaseUrl
  guestBaseUrl = $GuestBaseUrl
  calibration = $calibrationPath
  server = @{
    pid = $server.Id
    readyFile = $serverReady
    stdout = $serverStdout
    stderr = $serverStderr
  }
  totals = @{
    cases = $results.Count
    passed = @($results | Where-Object { $_.status -eq "passed" }).Count
    failed = @($results | Where-Object { $_.status -eq "failed" }).Count
    harnessBlocked = @($results | Where-Object { $_.status -eq "harness-blocked" }).Count
    plannedTargets = ($results | Measure-Object -Property plannedTargets -Sum).Sum
    parsedSpeechBlocks = ($results | Measure-Object -Property parsedSpeechBlocks -Sum).Sum
    matchedTargets = ($results | Measure-Object -Property matchedTargets -Sum).Sum
    missingTargets = ($results | Measure-Object -Property missingTargets -Sum).Sum
    unmatchedSpeechBlocks = ($results | Measure-Object -Property unmatchedSpeechBlocks -Sum).Sum
  }
  results = $results
}
$summary | ConvertTo-Json -Depth 8 | Set-Content -Path $summaryPath -Encoding utf8

Invoke-Checked "node" @(
  "scripts\nvda-vm-batch-report.mjs",
  "--batch",
  $batchOut
)

Write-Host "NVDA VM batch calibration output: $batchOut"
Write-Host "Calibration dataset: $calibrationPath"
Write-Host "Batch summary: $summaryPath"
