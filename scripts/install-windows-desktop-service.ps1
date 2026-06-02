param(
  [string]$CodexBin = "",
  [string]$DataDir = "",
  [string]$ServiceHost = "0.0.0.0",
  [int]$Port = 37631,
  [switch]$AllowUnsupportedNode,
  [switch]$SkipInstall,
  [switch]$SkipBuild,
  [switch]$Start
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version 3.0

function Write-Step {
  param([string]$Message)
  Write-Host ""
  Write-Host "==> $Message"
}

function Fail {
  param([string]$Message)
  Write-Error $Message
  exit 1
}

function Invoke-Checked {
  param(
    [string]$File,
    [string[]]$Arguments
  )
  & $File @Arguments
  if ($LASTEXITCODE -ne 0) {
    Fail "$File $($Arguments -join ' ') failed with exit code $LASTEXITCODE"
  }
}

function Test-WindowsAppsPath {
  param([string]$PathValue)
  return $PathValue -match "\\WindowsApps\\"
}

function Get-NodeInstallHint {
  return "Install Node.js 22 LTS with: winget install -e --id OpenJS.NodeJS.22"
}

function Test-NodeCandidate {
  param([string]$PathValue)
  if ([string]::IsNullOrWhiteSpace($PathValue)) {
    return $false
  }
  if (Test-WindowsAppsPath $PathValue) {
    Write-Warning "Skipping WindowsApps Node.js candidate: $PathValue"
    return $false
  }
  if (-not (Test-Path -LiteralPath $PathValue)) {
    return $false
  }
  try {
    $versionOutput = & $PathValue --version 2>&1
    if ($LASTEXITCODE -ne 0) {
      Write-Warning "Skipping Node.js candidate that cannot run --version: $PathValue"
      Write-Warning (($versionOutput | Out-String).Trim())
      return $false
    }
    return $true
  } catch {
    Write-Warning "Skipping Node.js candidate that failed validation: $PathValue"
    Write-Warning $_.Exception.Message
    return $false
  }
}

function Test-CodexCandidate {
  param([string]$PathValue)
  if ([string]::IsNullOrWhiteSpace($PathValue)) {
    return $false
  }
  if (Test-WindowsAppsPath $PathValue) {
    Write-Warning "Skipping WindowsApps Codex candidate: $PathValue"
    return $false
  }
  if (-not (Test-Path -LiteralPath $PathValue)) {
    return $false
  }

  try {
    $versionOutput = & $PathValue --version 2>&1
    if ($LASTEXITCODE -ne 0) {
      Write-Warning "Skipping Codex candidate that cannot run --version: $PathValue"
      return $false
    }

    $helpOutput = & $PathValue app-server --help 2>&1
    $helpText = ($helpOutput | Out-String)
    if ($LASTEXITCODE -ne 0 -or -not $helpText.Contains("app-server")) {
      Write-Warning "Skipping Codex candidate without app-server support: $PathValue"
      return $false
    }

    Write-Host "Codex CLI: $PathValue"
    Write-Host "Codex version: $(($versionOutput | Out-String).Trim())"
    return $true
  } catch {
    Write-Warning "Skipping Codex candidate that failed validation: $PathValue"
    Write-Warning $_.Exception.Message
    return $false
  }
}

function Find-CodexBinary {
  param([string]$ExplicitCodexBin)

  if (-not ([string]::IsNullOrWhiteSpace($ExplicitCodexBin))) {
    try {
      $resolved = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($ExplicitCodexBin)
    } catch {
      Fail "The supplied -CodexBin path could not be resolved: $ExplicitCodexBin. $($_.Exception.Message)"
    }
    if (Test-CodexCandidate $resolved) {
      return $resolved
    }
    Fail "The supplied -CodexBin path is not usable. Use the Codex binary under %LOCALAPPDATA%\OpenAI\Codex\bin\<version>\codex.exe, not WindowsApps."
  }

  if (-not ([string]::IsNullOrWhiteSpace($env:LOCALAPPDATA))) {
    $localBinRoot = Join-Path $env:LOCALAPPDATA "OpenAI\Codex\bin"
    if (Test-Path -LiteralPath $localBinRoot) {
      $candidates = Get-ChildItem -LiteralPath $localBinRoot -Directory |
        Sort-Object -Property Name -Descending |
        ForEach-Object { Join-Path $_.FullName "codex.exe" }
      foreach ($candidate in $candidates) {
        if (Test-CodexCandidate $candidate) {
          return $candidate
        }
      }
    }
  }

  foreach ($commandName in @("codex.exe", "codex.cmd", "codex")) {
    $command = Get-Command $commandName -ErrorAction SilentlyContinue
    if ($null -ne $command -and (Test-CodexCandidate $command.Source)) {
      return $command.Source
    }
  }

  Fail "Codex CLI was not found. Install Codex Desktop or pass -CodexBin C:\Users\<you>\AppData\Local\OpenAI\Codex\bin\<version>\codex.exe"
}

function ConvertTo-SingleQuotedPowerShellString {
  param([string]$Value)
  return "'" + $Value.Replace("'", "''") + "'"
}

function Get-LocalManagementHost {
  param([string]$HostValue)
  if ([string]::IsNullOrWhiteSpace($HostValue) -or $HostValue -eq "0.0.0.0" -or $HostValue -eq "::") {
    return "localhost"
  }
  return $HostValue
}

if ($env:OS -ne "Windows_NT") {
  Fail "This installer is intended for Windows PowerShell."
}

$repoRoot = Split-Path -Parent $PSScriptRoot
Set-Location $repoRoot

if (-not (Test-Path -LiteralPath (Join-Path $repoRoot "package.json"))) {
  Fail "package.json was not found. Run this script from the repository checkout."
}
if (-not (Test-Path -LiteralPath (Join-Path $repoRoot "mac-service\package.json"))) {
  Fail "mac-service/package.json was not found. Run this script from the repository checkout."
}

if ([string]::IsNullOrWhiteSpace($DataDir)) {
  $DataDir = Join-Path $HOME "Documents\Codex\code-data"
}
try {
  $DataDir = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($DataDir)
} catch {
  Fail "The data directory path could not be resolved: $DataDir. $($_.Exception.Message)"
}

Write-Step "Checking Node.js"
$nodeCommand = Get-Command node -ErrorAction SilentlyContinue
if ($null -eq $nodeCommand) {
  Fail "Node.js was not found. $(Get-NodeInstallHint)"
}
$resolvedNodePath = $nodeCommand.Source
if (-not (Test-NodeCandidate $resolvedNodePath)) {
  Fail "The node.exe found on PATH is not usable: $resolvedNodePath. It may be a WindowsApps alias or blocked executable. $(Get-NodeInstallHint) Then make sure the Node.js install directory appears before WindowsApps on PATH."
}
$nodeVersion = (& $resolvedNodePath --version).Trim()
if ($nodeVersion -notmatch "^v?(\d+)\.") {
  Fail "Could not parse Node.js version: $nodeVersion"
}
$nodeMajor = [int]$Matches[1]
if ($nodeMajor -ne 20 -and $nodeMajor -ne 22) {
  $message = "Node.js $nodeVersion is not the recommended Windows version. Use Node.js 20 LTS or 22 LTS. Node 24 may require Visual Studio C++ Build Tools for better-sqlite3. $(Get-NodeInstallHint)"
  if (-not $AllowUnsupportedNode) {
    Fail "$message Re-run with -AllowUnsupportedNode to continue anyway."
  }
  Write-Warning $message
}
Write-Host "Node.js: $nodeVersion"
Write-Host "Node path: $resolvedNodePath"
$env:PATH = (Split-Path -Parent $resolvedNodePath) + [System.IO.Path]::PathSeparator + $env:PATH

Write-Step "Preparing pnpm"
$pnpmCommand = Get-Command pnpm -ErrorAction SilentlyContinue
if ($null -eq $pnpmCommand) {
  $corepackCommand = Get-Command corepack -ErrorAction SilentlyContinue
  if ($null -eq $corepackCommand) {
    Fail "pnpm and corepack were not found. Install Node.js 20 LTS or 22 LTS, then re-run this script."
  }
  Invoke-Checked "corepack" @("enable")
  Invoke-Checked "corepack" @("prepare", "pnpm@9.15.4", "--activate")
} else {
  Write-Host "pnpm: $($pnpmCommand.Source)"
}

Write-Step "Finding Codex CLI"
$resolvedCodexBin = Find-CodexBinary $CodexBin

Write-Step "Preparing data directory"
New-Item -ItemType Directory -Force -Path $DataDir | Out-Null
Write-Host "Data directory: $DataDir"

if (-not $SkipInstall) {
  Write-Step "Installing workspace dependencies"
  Invoke-Checked "pnpm" @("install", "--frozen-lockfile")
} else {
  Write-Warning "Skipping pnpm install because -SkipInstall was supplied."
}

if (-not $SkipBuild) {
  Write-Step "Building desktop service"
  Invoke-Checked "pnpm" @("--filter", "@code/mac-service", "build")
} else {
  Write-Warning "Skipping build because -SkipBuild was supplied."
}

Write-Step "Writing local start script"
$startScriptPath = Join-Path $DataDir "start-code-desktop-service.ps1"
$quotedRepoRoot = ConvertTo-SingleQuotedPowerShellString $repoRoot
$quotedDataDir = ConvertTo-SingleQuotedPowerShellString $DataDir
$quotedCodexBin = ConvertTo-SingleQuotedPowerShellString $resolvedCodexBin
$quotedNodePath = ConvertTo-SingleQuotedPowerShellString $resolvedNodePath
$managementHost = Get-LocalManagementHost $ServiceHost
$startScript = @"
`$ErrorActionPreference = "Stop"
`$env:CODE_HOST = "$ServiceHost"
`$env:CODE_PORT = "$Port"
`$env:CODE_DATA_DIR = $quotedDataDir
`$env:CODEX_BIN = $quotedCodexBin
Set-Location $quotedRepoRoot
& $quotedNodePath .\mac-service\dist\main.js
"@
Set-Content -LiteralPath $startScriptPath -Value $startScript -Encoding UTF8
Write-Host "Start script: $startScriptPath"

Write-Step "Done"
Write-Host "Run the desktop service:"
Write-Host "  powershell -ExecutionPolicy Bypass -File `"$startScriptPath`""
Write-Host ""
Write-Host "Management page:"
Write-Host "  https://$managementHost`:$Port/"
Write-Host ""
Write-Host "Health checks:"
Write-Host "  curl.exe -k https://$managementHost`:$Port/api/health"
Write-Host "  curl.exe -k https://$managementHost`:$Port/api/codex-preflight"
Write-Host ""
Write-Host "Mobile pairing:"
Write-Host "  The generated start script listens on $ServiceHost by default so paired mobile devices can connect through this PC's LAN address."
Write-Host "  If Windows Defender Firewall prompts, allow Node.js on private networks. If pairing still times out, allow inbound TCP port $Port."
Write-Host ""
Write-Host "Project roots:"
Write-Host "  Open the management page and use Choose Folder to add a writable project root."
Write-Host "  Mobile-created project names are checked for Windows reserved characters and device names."
Write-Host ""
Write-Host "Certificate trust is still installed from the local management page. This script does not silently change the Windows Root store."
Write-Host "Windows startup and screen capture are still unsupported in this phase."

if ($Start) {
  Write-Step "Starting desktop service"
  & powershell -ExecutionPolicy Bypass -File $startScriptPath
}
