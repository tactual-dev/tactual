param(
  [string]$RepoRoot = "C:\Tactual",
  [string]$LocalRepoRoot = "C:\Tactual",
  [string]$CaptureRoot = "C:\TactualNvdaCapture",
  [string]$NvdaLogPath = "",
  [string]$NodeVersion = "24.16.0",
  [string]$NvdaVersion = "2026.1.1",
  [string]$NvdaSha256 = "6e0289eb5a3aa076eb97ea99c5d5465cb48b5ecc6a3257dc3d811f881a1747c9",
  [switch]$SkipInstall,
  [switch]$SkipBuild,
  [switch]$StartNvda,
  [switch]$AllowAudibleSpeech
)

$ErrorActionPreference = "Stop"

function Refresh-ProcessPath {
  $toolsRoot = Join-Path $CaptureRoot "tools"
  $portableNode = Join-Path $toolsRoot "node-v$NodeVersion-win-x64"
  $pathSegments = @(
    $portableNode,
    [Environment]::GetEnvironmentVariable("Path", "Machine"),
    [Environment]::GetEnvironmentVariable("Path", "User"),
    "C:\Program Files\nodejs",
    "C:\Program Files\Git\cmd"
  ) | Where-Object { $_ }

  $env:Path = ($pathSegments -join ";")
}

function Save-Download($Url, $Path) {
  if (Test-Path -LiteralPath $Path) {
    Write-Host "Using cached download: $Path"
    return
  }

  $parent = Split-Path -Parent $Path
  if ($parent) {
    New-Item -ItemType Directory -Force -Path $parent | Out-Null
  }

  Write-Host "Downloading $Url"
  Invoke-WebRequest -Uri $Url -OutFile $Path -UseBasicParsing
}

function Assert-FileSha256($Path, $ExpectedSha256) {
  $actual = (Get-FileHash -Algorithm SHA256 -Path $Path).Hash.ToLowerInvariant()
  if ($actual -ne $ExpectedSha256.ToLowerInvariant()) {
    throw "SHA256 mismatch for $Path. Expected $ExpectedSha256 but got $actual."
  }
}

function Assert-NodeZipHash($ZipPath, $ShasumsPath, $ZipName) {
  $line = Get-Content -Path $ShasumsPath | Where-Object { $_ -match "\s+$([regex]::Escape($ZipName))$" } | Select-Object -First 1
  if (-not $line) {
    throw "Could not find $ZipName in $ShasumsPath"
  }
  $expected = ($line -split "\s+")[0]
  Assert-FileSha256 $ZipPath $expected
}

function Install-PortableNode {
  if ($SkipInstall) {
    Write-Host "Skipping portable Node setup"
    return
  }

  $toolsRoot = Join-Path $CaptureRoot "tools"
  $zipName = "node-v$NodeVersion-win-x64.zip"
  $zipPath = Join-Path $toolsRoot $zipName
  $shasumsPath = Join-Path $toolsRoot "node-v$NodeVersion-SHASUMS256.txt"
  $nodeRoot = Join-Path $toolsRoot "node-v$NodeVersion-win-x64"

  if (-not (Test-Path -LiteralPath (Join-Path $nodeRoot "node.exe"))) {
    Save-Download "https://nodejs.org/dist/v$NodeVersion/$zipName" $zipPath
    Save-Download "https://nodejs.org/dist/v$NodeVersion/SHASUMS256.txt" $shasumsPath
    Assert-NodeZipHash $zipPath $shasumsPath $zipName

    if (Test-Path -LiteralPath $nodeRoot) {
      Remove-Item -LiteralPath $nodeRoot -Recurse -Force
    }
    Expand-Archive -LiteralPath $zipPath -DestinationPath $toolsRoot -Force
  }

  Refresh-ProcessPath
  node --version
  npm --version
}

function Install-PortableNvda {
  if ($SkipInstall) {
    Write-Host "Skipping portable NVDA setup"
    return
  }

  $toolsRoot = Join-Path $CaptureRoot "tools"
  $portableRoot = Join-Path $toolsRoot "nvda-$NvdaVersion-portable"
  $installerPath = Join-Path $toolsRoot "nvda_$NvdaVersion.exe"

  if (Test-Path -LiteralPath (Join-Path $portableRoot "nvda.exe")) {
    Write-Host "Using existing portable NVDA: $portableRoot"
    return
  }

  Save-Download "https://download.nvaccess.org/releases/$NvdaVersion/nvda_$NvdaVersion.exe" $installerPath
  Assert-FileSha256 $installerPath $NvdaSha256

  Write-Host "Creating portable NVDA at $portableRoot"
  & $installerPath --create-portable-silent --portable-path=$portableRoot
  if ($LASTEXITCODE -ne 0) {
    throw "Portable NVDA creation failed with exit code $LASTEXITCODE"
  }
}

function Find-NvdaExecutable {
  $portableRoot = Join-Path (Join-Path $CaptureRoot "tools") "nvda-$NvdaVersion-portable"
  $candidates = @(
    (Join-Path $portableRoot "nvda_noUIAccess.exe"),
    (Join-Path $portableRoot "nvda.exe"),
    "C:\Program Files (x86)\NVDA\nvda_noUIAccess.exe",
    "C:\Program Files\NVDA\nvda_noUIAccess.exe",
    "C:\Program Files (x86)\NVDA\nvda.exe",
    "C:\Program Files\NVDA\nvda.exe"
  )
  foreach ($candidate in $candidates) {
    if (Test-Path $candidate) { return $candidate }
  }
  return $null
}

function Find-BrowserExecutable {
  $candidates = @(
    "C:\Program Files\Google\Chrome\Application\chrome.exe",
    "C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
    "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
    "C:\Program Files\Microsoft\Edge\Application\msedge.exe"
  )
  foreach ($candidate in $candidates) {
    if (Test-Path $candidate) { return $candidate }
  }
  return $null
}

function Sync-RepoToLocalDisk {
  param(
    [string]$SourceRoot,
    [string]$DestinationRoot
  )

  $resolvedSource = (Resolve-Path -LiteralPath $SourceRoot).Path
  $resolvedDestination = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($DestinationRoot)

  if ($resolvedSource.TrimEnd("\") -ieq $resolvedDestination.TrimEnd("\")) {
    return $resolvedSource
  }

  Write-Host "Syncing repo from $resolvedSource to $resolvedDestination"
  New-Item -ItemType Directory -Force -Path $resolvedDestination | Out-Null

  & robocopy $resolvedSource $resolvedDestination /MIR /NFL /NDL /NJH /NJS /NP `
    /XD node_modules dist build coverage .git .tmp .audit .claude .github .playwright-mcp .pr-screenshots `
    /XF .mcpregistry_github_token .mcpregistry_registry_token | Out-Null
  $code = $LASTEXITCODE
  if ($code -gt 7) {
    throw "robocopy failed with exit code $code"
  }

  return $resolvedDestination
}

function Set-DefaultRenderMute {
  param([bool]$Muted)

  $code = @"
using System;
using System.Runtime.InteropServices;
namespace TactualAudio {
  public enum EDataFlow { eRender = 0, eCapture = 1, eAll = 2 }
  public enum ERole { eConsole = 0, eMultimedia = 1, eCommunications = 2 }
  [Guid("BCDE0395-E52F-467C-8E3D-C4579291692E"), ComImport]
  public class MMDeviceEnumeratorComObject {}
  [Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  public interface IMMDeviceEnumerator {
    [PreserveSig] int EnumAudioEndpoints(EDataFlow dataFlow, int dwStateMask, IntPtr ppDevices);
    [PreserveSig] int GetDefaultAudioEndpoint(EDataFlow dataFlow, ERole role, out IMMDevice ppEndpoint);
  }
  [Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  public interface IMMDevice {
    [PreserveSig] int Activate(ref Guid iid, int dwClsCtx, IntPtr pActivationParams, [MarshalAs(UnmanagedType.IUnknown)] out object ppInterface);
  }
  [Guid("5CDF2C82-841E-4546-9722-0CF74078229A"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  public interface IAudioEndpointVolume {
    [PreserveSig] int RegisterControlChangeNotify(IntPtr pNotify);
    [PreserveSig] int UnregisterControlChangeNotify(IntPtr pNotify);
    [PreserveSig] int GetChannelCount(out uint pnChannelCount);
    [PreserveSig] int SetMasterVolumeLevel(float fLevelDB, ref Guid pguidEventContext);
    [PreserveSig] int SetMasterVolumeLevelScalar(float fLevel, ref Guid pguidEventContext);
    [PreserveSig] int GetMasterVolumeLevel(out float pfLevelDB);
    [PreserveSig] int GetMasterVolumeLevelScalar(out float pfLevel);
    [PreserveSig] int SetChannelVolumeLevel(uint nChannel, float fLevelDB, ref Guid pguidEventContext);
    [PreserveSig] int SetChannelVolumeLevelScalar(uint nChannel, float fLevel, ref Guid pguidEventContext);
    [PreserveSig] int GetChannelVolumeLevel(uint nChannel, out float pfLevelDB);
    [PreserveSig] int GetChannelVolumeLevelScalar(uint nChannel, out float pfLevel);
    [PreserveSig] int SetMute([MarshalAs(UnmanagedType.Bool)] bool bMute, ref Guid pguidEventContext);
    [PreserveSig] int GetMute(out bool pbMute);
  }
  public static class Muter {
    const int CLSCTX_ALL = 23;
    public static bool SetMute(bool mute) {
      var enumerator = (IMMDeviceEnumerator)(new MMDeviceEnumeratorComObject());
      IMMDevice device;
      int hr = enumerator.GetDefaultAudioEndpoint(EDataFlow.eRender, ERole.eMultimedia, out device);
      Marshal.ThrowExceptionForHR(hr);
      Guid iid = typeof(IAudioEndpointVolume).GUID;
      object volumeObj;
      hr = device.Activate(ref iid, CLSCTX_ALL, IntPtr.Zero, out volumeObj);
      Marshal.ThrowExceptionForHR(hr);
      var volume = (IAudioEndpointVolume)volumeObj;
      Guid ctx = Guid.Empty;
      hr = volume.SetMute(mute, ref ctx);
      Marshal.ThrowExceptionForHR(hr);
      bool muted;
      hr = volume.GetMute(out muted);
      Marshal.ThrowExceptionForHR(hr);
      return muted;
    }
  }
}
"@

  Add-Type -TypeDefinition $code
  return [TactualAudio.Muter]::SetMute($Muted)
}

New-Item -ItemType Directory -Force -Path $CaptureRoot | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $CaptureRoot "nvda-config") | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $CaptureRoot "tools") | Out-Null

$browserExe = Find-BrowserExecutable
if ($browserExe) {
  Write-Host "Using existing Chromium browser: $browserExe"
} else {
  Write-Warning "No Chrome or Edge executable was found. Install a Chromium browser manually before browser-driven capture."
}

Refresh-ProcessPath
Install-PortableNode
Install-PortableNvda
$browserExe = Find-BrowserExecutable
$effectiveRepoRoot = $RepoRoot

if (Test-Path $RepoRoot) {
  if (-not $SkipBuild) {
    $effectiveRepoRoot = Sync-RepoToLocalDisk $RepoRoot $LocalRepoRoot
    Write-Host "Installing/building Tactual at $effectiveRepoRoot"
    Push-Location $effectiveRepoRoot
    try {
      npm install
      if ($LASTEXITCODE -ne 0) { throw "npm install failed with exit code $LASTEXITCODE" }
      npm run build
      if ($LASTEXITCODE -ne 0) { throw "npm run build failed with exit code $LASTEXITCODE" }
    } finally {
      Pop-Location
    }
  }
} else {
  Write-Warning "RepoRoot not found: $RepoRoot"
  Write-Warning "Map or clone the repo, then rerun this script or run npm install/build manually."
  $effectiveRepoRoot = $RepoRoot
}

$nvdaExe = Find-NvdaExecutable
$guestAudioMuted = $null
if ($StartNvda) {
  if (-not $nvdaExe) {
    throw "NVDA executable not found after bootstrap."
  }
  $logPath = if ($NvdaLogPath) { $NvdaLogPath } else { Join-Path $CaptureRoot "nvda-io.log" }
  $logParent = Split-Path -Parent $logPath
  if ($logParent) {
    New-Item -ItemType Directory -Force -Path $logParent | Out-Null
  }
  if (Test-Path $logPath) { Remove-Item -LiteralPath $logPath -Force }
  $configPath = Join-Path $CaptureRoot "nvda-config"

  if (-not $AllowAudibleSpeech) {
    Write-Host "Muting guest render audio before starting NVDA"
    try {
      $guestAudioMuted = Set-DefaultRenderMute $true
      if (-not $guestAudioMuted) {
        Write-Warning "Guest render endpoint did not report muted; relying on the VM-level audio mute."
      }
    } catch {
      $guestAudioMuted = $false
      Write-Warning "Could not mute the guest render endpoint; relying on the VM-level audio mute. $($_.Exception.Message)"
    }
  } else {
    $guestAudioMuted = $false
    Write-Host "Leaving guest render audio audible because -AllowAudibleSpeech was set"
  }

  Write-Host "Starting NVDA with isolated config/log"
  Start-Process -FilePath $nvdaExe -ArgumentList @(
    "--minimal",
    "--disable-addons",
    "--lang=en",
    "--config-path=$configPath",
    "--log-file=$logPath",
    "--log-level=12"
  ) | Out-Null

  Write-Host "NVDA log: $logPath"
}

$summary = [ordered]@{
  generatedAt = (Get-Date).ToUniversalTime().ToString("o")
  repoRoot = $RepoRoot
  repoRootExists = Test-Path $RepoRoot
  effectiveRepoRoot = $effectiveRepoRoot
  captureRoot = $CaptureRoot
  nvdaLogPath = $logPath
  browserExecutable = $browserExe
  nvdaExecutable = $nvdaExe
  nodeVersion = $NodeVersion
  nvdaVersion = $NvdaVersion
  startedNvda = [bool]$StartNvda
  guestAudioMuted = $guestAudioMuted
  tools = @("portable-node", "portable-nvda", "existing-chromium-browser")
  nextSteps = @(
    "Take a clean VM snapshot after package install/build.",
    "Start NVDA inside the guest with -StartNvda or from the Start menu.",
    "Run Playwright/Tactual capture inside the guest so NVDA only observes guest focus.",
    "Write speech TSV/JSONL into the shared capture folder, then ingest on host or guest."
  )
}

$summaryPath = Join-Path $CaptureRoot "bootstrap-summary.json"
$summaryJson = $summary | ConvertTo-Json -Depth 6
$summaryFullPath = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($summaryPath)
[System.IO.File]::WriteAllText($summaryFullPath, "$summaryJson`n", [System.Text.UTF8Encoding]::new($false))
Write-Host "Bootstrap summary: $summaryPath"
