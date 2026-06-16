param(
  [string]$Out = "build/nvda-vm-preflight.json",
  [switch]$SkipPackageSearch
)

$ErrorActionPreference = "Stop"

function Test-IsAdmin {
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = [Security.Principal.WindowsPrincipal]::new($identity)
  return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Get-CommandSummary($Name) {
  $cmd = Get-Command $Name -ErrorAction SilentlyContinue | Select-Object -First 1
  if (-not $cmd -and ($Name -eq "VBoxManage" -or $Name -eq "VirtualBoxVM")) {
    $candidate = Join-Path ${env:ProgramFiles} "Oracle\VirtualBox\$Name.exe"
    if (Test-Path -LiteralPath $candidate) {
      $version = try {
        [System.Diagnostics.FileVersionInfo]::GetVersionInfo($candidate).ProductVersion
      } catch {
        $null
      }
      return [ordered]@{ name = $Name; found = $true; source = $candidate; version = $version }
    }
  }
  if (-not $cmd) {
    return [ordered]@{ name = $Name; found = $false; source = $null; version = $null }
  }
  return [ordered]@{
    name = $Name
    found = $true
    source = $cmd.Source
    version = if ($cmd.Version) { $cmd.Version.ToString() } else { $null }
  }
}

function Get-OptionalFeatureSummary($Name) {
  try {
    $feature = Get-WindowsOptionalFeature -Online -FeatureName $Name -ErrorAction Stop
    return [ordered]@{ name = $Name; state = $feature.State.ToString(); available = $true }
  } catch {
    return [ordered]@{ name = $Name; state = "Unavailable"; available = $false }
  }
}

function Get-WingetPackage($Id) {
  $winget = Get-Command winget -ErrorAction SilentlyContinue
  if (-not $winget -or $SkipPackageSearch) {
    return [ordered]@{ id = $Id; available = $null; version = $null }
  }

  $output = & winget search --exact $Id --source winget 2>$null
  $line = $output | Where-Object { $_ -match [regex]::Escape($Id) } | Select-Object -First 1
  if (-not $line) {
    return [ordered]@{ id = $Id; available = $false; version = $null }
  }

  $parts = $line -split "\s{2,}"
  return [ordered]@{
    id = $Id
    available = $true
    version = if ($parts.Length -ge 3) { $parts[2] } else { $null }
  }
}

$computer = Get-ComputerInfo -Property WindowsProductName,WindowsVersion,OsBuildNumber
$features = @(
  "Microsoft-Hyper-V-All",
  "Microsoft-Hyper-V",
  "Containers-DisposableClientVM",
  "VirtualMachinePlatform",
  "HypervisorPlatform"
) | ForEach-Object { Get-OptionalFeatureSummary $_ }

$commands = @(
  "VBoxManage",
  "VirtualBoxVM",
  "WindowsSandbox",
  "New-VM",
  "Get-VM",
  "winget",
  "wsl"
) | ForEach-Object { Get-CommandSummary $_ }

$packages = @(
  "Oracle.VirtualBox",
  "Google.Chrome",
  "OpenJS.NodeJS.LTS",
  "Git.Git",
  "NVAccess.NVDA"
) | ForEach-Object { Get-WingetPackage $_ }

$drives = Get-PSDrive -PSProvider FileSystem | ForEach-Object {
  [ordered]@{
    name = $_.Name
    root = $_.Root
    freeGB = [math]::Round($_.Free / 1GB, 1)
    usedGB = [math]::Round($_.Used / 1GB, 1)
  }
}

$nvdaProcesses = Get-Process nvda -ErrorAction SilentlyContinue | ForEach-Object {
  [ordered]@{
    id = $_.Id
    startTime = if ($_.StartTime) { $_.StartTime.ToString("o") } else { $null }
    mainWindowTitle = $_.MainWindowTitle
  }
}

$hasVirtualBox = ($commands | Where-Object { $_.name -eq "VBoxManage" -and $_.found }).Count -gt 0
$hasSandbox = ($commands | Where-Object { $_.name -eq "WindowsSandbox" -and $_.found }).Count -gt 0
$hasWinget = ($commands | Where-Object { $_.name -eq "winget" -and $_.found }).Count -gt 0

$recommendation = if ($hasSandbox) {
  "windows-sandbox"
} elseif ($hasVirtualBox) {
  "virtualbox-ready"
} elseif ($hasWinget) {
  "install-virtualbox"
} else {
  "manual-provider-install"
}

$result = [ordered]@{
  generatedAt = (Get-Date).ToUniversalTime().ToString("o")
  user = [Security.Principal.WindowsIdentity]::GetCurrent().Name
  isAdmin = Test-IsAdmin
  os = [ordered]@{
    productName = $computer.WindowsProductName
    version = $computer.WindowsVersion
    build = $computer.OsBuildNumber
  }
  commands = $commands
  optionalFeatures = $features
  wingetPackages = $packages
  drives = $drives
  nvdaRunning = @($nvdaProcesses)
  recommendation = $recommendation
  notes = @(
    "Do not run NVDA capture on the host desktop. Use a guest VM/session where NVDA owns focus.",
    "Windows Home commonly lacks Hyper-V Manager and Windows Sandbox. VirtualBox is the likely local provider here.",
    "VirtualBox installation requires an elevated installer because it installs virtualization drivers.",
    "Use a Windows evaluation ISO or licensed Windows ISO inside the VM; keep VM snapshots disposable."
  )
}

$outParent = Split-Path -Parent $Out
if ($outParent) {
  $outPath = Resolve-Path -LiteralPath $outParent -ErrorAction SilentlyContinue
  if (-not $outPath) {
    New-Item -ItemType Directory -Force -Path $outParent | Out-Null
  }
}
$json = $result | ConvertTo-Json -Depth 8
$outFullPath = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($Out)
[System.IO.File]::WriteAllText($outFullPath, "$json`n", [System.Text.UTF8Encoding]::new($false))

Write-Host "NVDA VM preflight written to $Out"
Write-Host "Recommendation: $recommendation"
Write-Host "Admin: $($result.isAdmin)"
Write-Host "NVDA processes on host: $(@($nvdaProcesses).Count)"
Write-Host ""
Write-Host "Provider commands:"
$commands | ForEach-Object {
  Write-Host ("  {0}: {1}" -f $_.name, $(if ($_.found) { $_.source } else { "not found" }))
}
