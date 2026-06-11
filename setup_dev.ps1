<#
.SYNOPSIS
    Set up a Tomo development environment and link it to VAMToolbox.

.DESCRIPTION
    You only need this to run Tomo FROM SOURCE. The released installer already
    bundles VAMToolbox + ASTRA, so end users never run this.

    In dev mode the Electron app launches the Flask backend with the Python
    interpreter at  <Tomo repo root>\.venv\Scripts\python.exe  and expects
    `import vamtoolbox` to work in that environment. This script builds that
    environment:

      1. Creates  .venv  at the Tomo repo root.
      2. Installs VAMToolbox (and its ASTRA CUDA backend + requirements) into
         that venv by delegating to VAMToolbox's own install.ps1.
      3. Installs the backend's extra web deps (flask, flask-cors).
      4. Installs the frontend npm dependencies (Front_End).

    Provide a local VAMToolbox checkout with -VamToolboxPath, or let the script
    clone it from GitHub.

.PARAMETER VamToolboxPath
    Path to a local VAMToolbox checkout (must contain install.ps1). If omitted,
    VAMToolbox is cloned into  .vamtoolbox-src  at the Tomo repo root.

.PARAMETER VamToolboxRepo
    Git URL to clone when -VamToolboxPath is not given.
    Default: https://github.com/computed-axial-lithography/VAMToolbox

.PARAMETER SkipTorch
    Pass through to VAMToolbox install.ps1 (smaller install; torch is optional).

.PARAMETER SkipFrontend
    Skip the `npm install` step (backend-only setup).

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File setup_dev.ps1

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File setup_dev.ps1 -VamToolboxPath ..\VAMToolbox -SkipTorch
#>
[CmdletBinding()]
param(
    [string]$VamToolboxPath = "",
    [string]$VamToolboxRepo = "https://github.com/computed-axial-lithography/VAMToolbox",
    [switch]$SkipTorch,
    [switch]$SkipFrontend
)

$ErrorActionPreference = "Stop"
$root = $PSScriptRoot
$venv = Join-Path $root ".venv"
$venvPy = Join-Path $venv "Scripts\python.exe"
function Info($m) { Write-Host "[setup-dev] $m" -ForegroundColor Cyan }
function Warn($m) { Write-Host "[setup-dev] $m" -ForegroundColor Yellow }
function Die($m)  { Write-Host "[setup-dev] ERROR: $m" -ForegroundColor Red; exit 1 }

# ---------------------------------------------------------------------------
# 1. Locate (or fetch) a VAMToolbox checkout that has install.ps1
# ---------------------------------------------------------------------------
if ($VamToolboxPath) {
    if (-not (Test-Path $VamToolboxPath)) { Die "VamToolboxPath not found: $VamToolboxPath" }
    $vamtb = (Resolve-Path $VamToolboxPath).Path
} else {
    $vamtb = Join-Path $root ".vamtoolbox-src"
    if (Test-Path (Join-Path $vamtb ".git")) {
        Info "Reusing VAMToolbox checkout at $vamtb"
    } else {
        if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
            Die "git not found. Install git, or pass -VamToolboxPath <path to a VAMToolbox checkout>."
        }
        Info "Cloning VAMToolbox -> $vamtb"
        git clone --depth 1 $VamToolboxRepo $vamtb
        if ($LASTEXITCODE -ne 0) { Die "git clone failed." }
    }
}

$vamInstall = Join-Path $vamtb "install.ps1"
if (-not (Test-Path $vamInstall)) {
    Die "install.ps1 not found in $vamtb. Use a VAMToolbox checkout that includes install.ps1 (VAMToolbox 3.0.0+)."
}

# ---------------------------------------------------------------------------
# 2. Build the venv + install ASTRA + VAMToolbox (via VAMToolbox install.ps1)
# ---------------------------------------------------------------------------
Info "Installing ASTRA + VAMToolbox into $venv (via VAMToolbox install.ps1) ..."
$vamArgs = @("-VenvPath", $venv)
if ($SkipTorch) { $vamArgs += "-SkipTorch" }
& $vamInstall @vamArgs
if ($LASTEXITCODE -ne 0) { Die "VAMToolbox install.ps1 failed." }
if (-not (Test-Path $venvPy)) { Die "Expected venv python not found at $venvPy" }

# ---------------------------------------------------------------------------
# 3. Backend web dependencies (not part of VAMToolbox)
# ---------------------------------------------------------------------------
Info "Installing backend web deps (flask, flask-cors) ..."
& $venvPy -m pip install flask flask-cors
if ($LASTEXITCODE -ne 0) { Die "pip install of flask/flask-cors failed." }

# ---------------------------------------------------------------------------
# 4. Frontend dependencies
# ---------------------------------------------------------------------------
if (-not $SkipFrontend) {
    if (Get-Command npm -ErrorAction SilentlyContinue) {
        Info "Installing frontend npm dependencies ..."
        Push-Location (Join-Path $root "UIMain\Front_End")
        try { npm install } finally { Pop-Location }
        if ($LASTEXITCODE -ne 0) { Warn "npm install reported a non-zero exit code; check the output above." }
    } else {
        Warn "npm not found - skipping frontend install. Install Node.js LTS, then run 'npm install' in UIMain\Front_End."
    }
}

# ---------------------------------------------------------------------------
# 5. Verify the link
# ---------------------------------------------------------------------------
Info "Verifying VAMToolbox link ..."
$check = "import vamtoolbox, astra, flask, flask_cors; print('vamtoolbox', vamtoolbox.__version__, '| astra CUDA:', astra.use_cuda())"
$verify = & $venvPy -c $check 2>&1 | Out-String
Write-Host $verify
if ($LASTEXITCODE -ne 0) { Die "Verification failed - the backend would not be able to import vamtoolbox." }

Write-Host ""
Info "Dev environment ready."
Write-Host "      Run Tomo from source with:" -ForegroundColor Green
Write-Host "          cd UIMain\Front_End" -ForegroundColor Green
Write-Host "          npm run app        # starts Vite (:5173) + Flask backend (:5174) + the Electron window" -ForegroundColor Green
