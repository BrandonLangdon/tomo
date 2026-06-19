# =============================================================================
#  build_installer.ps1  -  Build the Tomo Windows installer (NSIS .exe)
#
#  Usage (from anywhere):
#     powershell -ExecutionPolicy Bypass -File C:\Users\wadde\Documents\VAMToolbox-main\build_installer.ps1
#
#  Output:  build\dist-app\Tomo Setup <version>.exe   (~547 MB; installs ~1.8 GB)
#
#  Notes (why each step):
#   * App = Electron + Flask/Python backend + a bundled Python runtime at
#     build\python\ (Python 3.13 + .venv packages + vamtoolbox + astra-CUDA,
#     torch removed to stay slim).
#   * vamtoolbox inside build\python is a COPY, so repo edits to vamtoolbox\
#     must be re-synced in (step 3).
#   * The backend (UIMain\Python_Backend: server.py, optimize_worker.py,
#     voxelize_worker.py, VAM_Ob.py) is copied FRESH by electron-builder each
#     build, so no manual sync needed for it.
#   * Signing is disabled (CSC_IDENTITY_AUTO_DISCOVERY=false) for speed.
# =============================================================================
$ErrorActionPreference = "Stop"
$repo = "C:\Users\wadde\Documents\VAMToolbox-main"
Set-Location $repo
Write-Host "=== Tomo installer build ==="

# 1) Put Node/npx on PATH (WinGet-installed; pick the newest version dir).
$nodeDir = (Get-ChildItem "C:\Users\wadde\AppData\Local\Microsoft\WinGet\Packages\OpenJS.NodeJS.LTS_*\node-*-win-x64" -Directory -ErrorAction SilentlyContinue | Sort-Object Name -Descending | Select-Object -First 1).FullName
if (-not $nodeDir) { $nodeDir = (Get-Command node -ErrorAction SilentlyContinue | Select-Object -First 1).Source | Split-Path -Parent }
if ($nodeDir) { $env:PATH = "$nodeDir;$env:PATH"; Write-Host ("node: " + $nodeDir) }
else { throw "Node.js not found. Install it (winget install OpenJS.NodeJS.LTS) or add it to PATH." }

# 2) Stop any running dev/installed app (holds files + port 5174).
Get-Process Tomo, electron, python -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep 2

# 3) Re-sync the bundled vamtoolbox COPY with the repo source.
if (-not (Test-Path "build\python\python.exe")) { throw "build\python runtime missing - rebuild it first (see BUILD.md)." }
Write-Host "Re-syncing vamtoolbox -> build\python ..."
robocopy vamtoolbox build\python\Lib\site-packages\vamtoolbox /E /NFL /NDL /NJH /NJS /NC /NS | Out-Null
if ($LASTEXITCODE -ge 8) { throw "robocopy failed (exit $LASTEXITCODE)" }

# 4) Diffusion runtime (1.0.1+): torch (CPU FFT) + cupy (GPU separable) are now
#    bundled on purpose so the diffusion deconvolution is fast (GPU ~1.4 min, torch
#    CPU ~20 min) instead of the single-threaded scipy fallback (~2 hrs).  cupy
#    resolves its CUDA libs from the system CUDA Toolkit at runtime (machines without
#    one fall back to CPU gracefully).  ~+0.7 GB runtime vs the old slim build.
if (-not (Test-Path "build\python\Lib\site-packages\torch")) { Write-Warning "torch missing from build\python - diffusion will fall back to slow scipy. Copy torch+cupy from .venv first." }
if (-not (Test-Path "build\python\Lib\site-packages\cupy"))  { Write-Warning "cupy missing from build\python - no GPU diffusion acceleration in the package." }

# 5) Build: frontend (vite) then NSIS installer (electron-builder).
$env:CSC_IDENTITY_AUTO_DISCOVERY = "false"
Set-Location "$repo\UIMain\Front_End"
Write-Host "vite build ..."
npx vite build
Write-Host "electron-builder (NSIS) ..."
npx electron-builder

# 6) Report.
$ver = (Get-Content "$repo\UIMain\Front_End\package.json" | ConvertFrom-Json).version
$out = Join-Path $repo ("build\dist-app\Tomo Setup " + $ver + ".exe")
if (Test-Path $out) {
    $mb = [math]::Round((Get-Item $out).Length / 1MB)
    Write-Host ""
    Write-Host ("DONE -> " + $out)
    Write-Host ("Size : " + $mb + " MB")
} else {
    Write-Warning ("Build finished but installer not found at: " + $out)
}
