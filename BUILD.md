# Building the Tomo installer

## Every build (one command)

```powershell
powershell -ExecutionPolicy Bypass -File C:\Users\wadde\Documents\VAMToolbox-main\build_installer.ps1
```

That script:
1. puts Node/npx on PATH,
2. stops any running Tomo/Electron,
3. **re-syncs `vamtoolbox\` into the bundled runtime** (`build\python\Lib\site-packages\vamtoolbox` is a *copy* — source edits must be pushed in),
4. warns if `torch` crept back into the slim runtime,
5. runs `vite build` then `electron-builder` (NSIS, signing off),
6. prints the output path.

**Output:** `build\dist-app\Tomo Setup <version>.exe` (~547 MB; installs ~1.8 GB to `%LOCALAPPDATA%\Programs\Tomo`, no admin needed).

To change the version, edit `"version"` in `UIMain\Front_End\package.json`.

The backend (`UIMain\Python_Backend\*` — `server.py`, `optimize_worker.py`, `voxelize_worker.py`, `VAM_Ob.py`) is copied **fresh** by electron-builder each build, so no manual sync is needed for it. Only `vamtoolbox` needs the re-sync (step 3).

Notes:
- First launch after a build is slow (~90 s) while Windows Defender scans the fresh exes; subsequent launches are fast.
- Signing is intentionally disabled (`CSC_IDENTITY_AUTO_DISCOVERY=false`).

## One-time: (re)building the bundled Python runtime

Only needed if `build\python\` is missing or you change Python deps. It's a self-contained Python 3.13 + the venv's packages + vamtoolbox + astra-CUDA, with torch removed to stay slim.

```powershell
$base = "$env:LOCALAPPDATA\Programs\Python\Python313"     # base interpreter
robocopy $base build\python /E                            # 1. base Python
robocopy .venv\Lib\site-packages build\python\Lib\site-packages /E   # 2. venv packages (numpy/scipy/astra/pyglet/trimesh/cv2/...)
robocopy vamtoolbox build\python\Lib\site-packages\vamtoolbox /E      # 3. vamtoolbox
# 4. slim it: move torch OUT (unused by OSMO/BCLP) to keep the installer small
Move-Item build\python\Lib\site-packages\torch* scratch\torch-removed\ -ErrorAction SilentlyContinue
```

Verify the runtime:
```powershell
build\python\python.exe -c "import numpy,scipy,astra,pyglet,trimesh,cv2,vamtoolbox.pipeline; print('astra cuda', astra.use_cuda())"
```

See the `packaging-electron-standalone` memory for the full history/rationale.
