param(
  [string]$VmName = "Tactual-NVDA-Win11",
  [string]$VBoxManage = "C:\Program Files\Oracle\VirtualBox\VBoxManage.exe",
  [string]$GuestUser = "tactual",
  [string]$PasswordFile = "$env:USERPROFILE\VirtualBox VMs\Tactual-NVDA-Win11\tactual-user-password.txt",
  [string]$RepoShareRoot = "Z:\",
  [string]$LocalRepoRoot = "C:\Tactual",
  [string]$CaptureRoot = "C:\TactualNvdaCapture",
  [string]$HostOut = "build\nvda-vm\host-smoke",
  [string]$NodeVersion = "24.16.0",
  [int]$TabCount = 5,
  [switch]$SkipStartNvda,
  [switch]$AllowAudibleSpeech
)

$ErrorActionPreference = "Stop"

function Invoke-Guest {
  param(
    [string]$Exe,
    [string[]]$Arguments,
    [int]$Timeout = 120000,
    [int]$RetryCount = 2,
    [int]$RetryDelaySeconds = 5
  )

  for ($attempt = 0; $attempt -le $RetryCount; $attempt += 1) {
    & $VBoxManage guestcontrol $VmName run `
      --exe $Exe `
      --username $GuestUser `
      --passwordfile $PasswordFile `
      --wait-stdout `
      --wait-stderr `
      --timeout $Timeout `
    -- @Arguments
    if ($LASTEXITCODE -eq 0) { return }
    if ($attempt -lt $RetryCount) {
      Start-Sleep -Seconds $RetryDelaySeconds
    }
  }

  throw "Guest command failed with exit code ${LASTEXITCODE}: $Exe $($Arguments -join ' ')"
}

function Wait-GuestControl {
  $deadline = (Get-Date).AddMinutes(10)
  while ((Get-Date) -lt $deadline) {
    & $VBoxManage guestcontrol $VmName run `
      --exe "C:\Windows\System32\cmd.exe" `
      --username $GuestUser `
      --passwordfile $PasswordFile `
      --wait-stdout `
      --wait-stderr `
      --timeout 15000 `
      -- /c whoami | Out-Null
    if ($LASTEXITCODE -eq 0) { return }
    Start-Sleep -Seconds 10
  }
  throw "Timed out waiting for guest control."
}

function Wait-NvdaReady {
  Invoke-Guest "C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe" @(
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-Command",
    "`$deadline=(Get-Date).AddSeconds(90); while((Get-Date) -lt `$deadline){ if((Test-Path $CaptureRoot\nvda-io.log) -and (Select-String -Path $CaptureRoot\nvda-io.log -Pattern 'NVDA initialized' -Quiet)){ 'NVDA_READY'; exit 0 }; Start-Sleep -Seconds 2 }; 'NVDA_NOT_READY'; exit 1"
  ) 120000
}

function Focus-EdgeSmokeWindow {
  Invoke-Guest "C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe" @(
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-Command",
    "`$shell=New-Object -ComObject WScript.Shell; `$deadline=(Get-Date).AddSeconds(30); while((Get-Date) -lt `$deadline){ if(`$shell.AppActivate('Tactual NVDA smoke')){ 'EDGE_ACTIVE'; exit 0 }; Start-Sleep -Milliseconds 500 }; 'EDGE_NOT_ACTIVE'; exit 1"
  ) 60000
}

function Copy-GuestFileToHost {
  param([string]$GuestPath, [string]$HostPath)
  $parent = Split-Path -Parent $HostPath
  if ($parent) {
    New-Item -ItemType Directory -Force -Path $parent | Out-Null
  }
  & $VBoxManage guestcontrol $VmName copyfrom `
    --username $GuestUser `
    --passwordfile $PasswordFile `
    $GuestPath `
    $HostPath
  if ($LASTEXITCODE -ne 0) {
    throw "Could not copy $GuestPath from guest."
  }
}

if (-not (Test-Path -LiteralPath $VBoxManage)) {
  throw "VBoxManage not found: $VBoxManage"
}

New-Item -ItemType Directory -Force -Path $HostOut | Out-Null
Wait-GuestControl
if ($AllowAudibleSpeech) {
  & $VBoxManage controlvm $VmName audioout on | Out-Null
} else {
  & $VBoxManage controlvm $VmName audioout off | Out-Null
}
& $VBoxManage controlvm $VmName audioin off | Out-Null

Invoke-Guest "C:\Windows\System32\cmd.exe" @(
  "/c",
  "taskkill /IM msedge.exe /F 2>NUL & taskkill /IM nvda_noUIAccess.exe /F 2>NUL & taskkill /IM OneDrive.exe /F 2>NUL & exit /B 0"
) 60000

Invoke-Guest "C:\Windows\System32\cmd.exe" @(
  "/c",
  "rmdir /S /Q `"$CaptureRoot\edge-profile`" 2>NUL & exit /B 0"
) 60000

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
    "-SkipInstall",
    "-SkipBuild",
    "-StartNvda"
  )
  if ($AllowAudibleSpeech) {
    $bootstrapArgs += "-AllowAudibleSpeech"
  }
  Invoke-Guest "C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe" $bootstrapArgs 120000
}

Wait-NvdaReady

Invoke-Guest "C:\Windows\System32\cmd.exe" @(
  "/c",
  "copy /Y $RepoShareRoot\scripts\nvda-vm-smoke.mjs $LocalRepoRoot\scripts\nvda-vm-smoke.mjs && $CaptureRoot\tools\node-v$NodeVersion-win-x64\node.exe $LocalRepoRoot\scripts\nvda-vm-smoke.mjs --prepare-only"
) 120000

Invoke-Guest "C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe" @(
  "-NoProfile",
  "-ExecutionPolicy",
  "Bypass",
  "-Command",
  "`$edge='C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe'; Start-Process -FilePath `$edge -ArgumentList @('--user-data-dir=$CaptureRoot\edge-profile','--no-first-run','--no-default-browser-check','--disable-features=msEdgeFirstRunExperience','--app=file:///C:/TactualNvdaCapture/nvda-smoke.html')"
) 60000

Start-Sleep -Seconds 10
Focus-EdgeSmokeWindow
& $VBoxManage controlvm $VmName screenshotpng (Join-Path $HostOut "edge-open.png") | Out-Null

for ($i = 0; $i -lt $TabCount; $i += 1) {
  & $VBoxManage controlvm $VmName keyboardputscancode 0f 8f | Out-Null
  Start-Sleep -Seconds 2
}

Start-Sleep -Seconds 8
& $VBoxManage controlvm $VmName screenshotpng (Join-Path $HostOut "edge-after-tabs.png") | Out-Null

$logPath = Join-Path $HostOut "nvda-io.log"
$speechPath = Join-Path $HostOut "speech-lines.txt"
Copy-GuestFileToHost "$CaptureRoot\nvda-io.log" $logPath

Select-String -Path $logPath -Pattern "IO - speech|Speaking|Start order|Email address|Help center|button|edit|link|Checkout smoke|Microsoft Edge" |
  ForEach-Object { $_.Line } |
  Set-Content -Path $speechPath -Encoding utf8

Write-Host "NVDA VM smoke output: $HostOut"
Write-Host "Speech lines: $speechPath"
