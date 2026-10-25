# Builds the Paradox Desktop Agent and its Windows installer.
#
#   powershell -ExecutionPolicy Bypass -File desktop/build.ps1 -Version 1.0.0
#
# Requires: Python 3.11+ on PATH (py launcher) and Inno Setup 6 for the final
# installer step. Nothing is published automatically: the script only writes
# public/downloads/ once the installer exists and its checksum is known.

param(
  [Parameter(Mandatory = $true)][string]$Version,
  [switch]$SkipInstaller
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$desktop = Join-Path $root "desktop"
$venv = Join-Path $desktop ".venv"
$dist = Join-Path $desktop "dist"
$out = Join-Path $desktop "out"
$downloads = Join-Path $root "public\downloads"

Write-Host "==> Building Paradox Desktop Agent $Version"

# 1. Python environment --------------------------------------------------------
if (-not (Test-Path $venv)) {
  Write-Host "==> Creating virtual environment"
  py -3 -m venv $venv
}

$python = Join-Path $venv "Scripts\python.exe"
& $python -m pip install --upgrade pip
# playwright drives the installed Chrome/Edge over CDP; no browser download
& $python -m pip install pyautogui pillow playwright pyinstaller
if ($LASTEXITCODE -ne 0) { throw "Dependency install failed" }

# 2. Freeze the agent ----------------------------------------------------------
Write-Host "==> Freezing pc-agent/agent.py"
& $python -m PyInstaller `
  --noconfirm `
  --clean `
  --onefile `
  --name ParadoxAgent `
  --collect-all playwright `
  --hidden-import browser_engine `
  --distpath $dist `
  --workpath (Join-Path $desktop "build") `
  --specpath (Join-Path $desktop "build") `
  (Join-Path $root "pc-agent\agent.py")
if ($LASTEXITCODE -ne 0) { throw "PyInstaller failed" }

$exe = Join-Path $dist "ParadoxAgent.exe"
if (-not (Test-Path $exe)) { throw "ParadoxAgent.exe was not produced" }
Write-Host "    $exe"

if ($SkipInstaller) {
  Write-Host "==> Skipping installer as requested"
  exit 0
}

# 3. Installer -----------------------------------------------------------------
$iscc = @(
  "$env:LOCALAPPDATA\Programs\Inno Setup 6\ISCC.exe",
  "C:\Program Files (x86)\Inno Setup 6\ISCC.exe",
  "C:\Program Files\Inno Setup 6\ISCC.exe"
) | Where-Object { Test-Path $_ } | Select-Object -First 1

if (-not $iscc) {
  throw @"
Inno Setup 6 was not found. Install it, then run this script again:
  winget install --id JRSoftware.InnoSetup
The agent executable is ready at $exe
"@
}

New-Item -ItemType Directory -Force -Path $out | Out-Null
& $iscc "/DAppVersion=$Version" "/DSourceExe=$exe" "/DOutputDir=$out" (Join-Path $desktop "installer.iss")
if ($LASTEXITCODE -ne 0) { throw "ISCC failed" }

$installer = Join-Path $out "ParadoxSetup-$Version.exe"
if (-not (Test-Path $installer)) { throw "Installer was not produced" }

# 4. Release manifest ----------------------------------------------------------
New-Item -ItemType Directory -Force -Path $downloads | Out-Null
$hash = (Get-FileHash -Algorithm SHA256 $installer).Hash.ToLower()
$size = (Get-Item $installer).Length
$file = "ParadoxSetup-$Version.exe"

Copy-Item $installer (Join-Path $downloads $file) -Force

$manifest = [ordered]@{
  version    = $Version
  file       = $file
  os         = "Windows 10/11"
  architecture = "x64"
  sha256     = $hash
  bytes      = $size
  releasedAt = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ss.fffZ")
  minimumAppVersion = "0.0.1"
}
$manifest | ConvertTo-Json | Set-Content -Encoding utf8 (Join-Path $downloads "desktop.json")

Write-Host "==> Published $file"
Write-Host "    sha256 $hash"
Write-Host "    Next: sign the installer with signtool before announcing it."
