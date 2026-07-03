# Running Tomo on macOS (dev mode)

The upstream build tooling (`setup_dev.ps1`, `build_installer.ps1`, `BUILD.md`)
is Windows/PowerShell only and bundles a Windows Python + astra-CUDA runtime.
This branch (`mac-support`) makes the app run on **Apple Silicon macOS** in dev
mode, using the Metal/CPU path of a Mac-capable `vamtoolbox` (no CUDA).

Status: **dev mode works end-to-end** (Vite + Electron window + Flask backend on
Metal). A packaged `.dmg` is not done yet — see "Remaining" below.

## What changed on this branch

- **`UIMain/Front_End/electron/main.cjs`** — Python paths are now per-OS. Windows
  keeps `python.exe` / `Scripts` / `Lib\site-packages`; macOS/Linux use
  `bin/python(3)` / `lib/pythonX.Y/site-packages`.
- **`UIMain/Front_End/package.json`** — added a `mac` electron-builder target
  (dmg, unsigned) alongside the existing `win`/nsis one.
- **`UIMain/Python_Backend/server.py`** — the native file dialogs were
  Windows-only (PowerShell + WinForms). Added macOS implementations via
  `osascript` (`choose file` / `choose file name`), guarded all
  `subprocess.CREATE_NO_WINDOW` uses (a Windows-only flag) with `getattr(..., 0)`,
  and made the voxelize cancel tree-kill cross-platform (psutil on macOS/Linux).

## One-time setup

Requires **Node 20+** (upstream repo predates it; system Node may be old):

```bash
brew install node          # Apple Silicon -> /opt/homebrew/bin/node
```

### Backend venv (Metal/CPU vamtoolbox)

The backend `requirements.txt` under-declares deps and pins the PyPI
`vamtoolbox` (CUDA). For the Mac path, use our Metal-capable checkout instead:

```bash
cd tomo
python3.13 -m venv .venv
.venv/bin/pip install -e /path/to/VAMToolbox        # Metal/CPU vamtoolbox (editable)
.venv/bin/pip install flask flask-cors opencv-python psutil joblib imageio-ffmpeg \
    dill matplotlib pyglet trimesh scikit-image Pillow numpy-stl PyOpenGL lib3mf \
    pyvista tqdm vedo scipy "metalcompute==0.2.9"
```

Verify: `.venv/bin/python -c "import vamtoolbox.util.hardware as h; print(h.detect_system()['metal'])"`
should print `True`.

### Frontend + Electron binary

```bash
cd UIMain/Front_End
npm install                # if the electron postinstall is blocked, see next step
```

If Electron fails at launch with `ENOENT ... electron/path.txt`, its binary
postinstall didn't run. The zip is usually already cached; extract it manually:

```bash
ZIP="$HOME/Library/Caches/electron/*/electron-v*-darwin-arm64.zip"
rm -rf node_modules/electron/dist && mkdir -p node_modules/electron/dist
unzip -q $ZIP -d node_modules/electron/dist
printf 'Electron.app/Contents/MacOS/Electron' > node_modules/electron/path.txt
```

## Run

```bash
cd UIMain/Front_End
npm run app                # Vite dev server + Electron window + spawns the backend
```

The backend reports `cuda: False | metal: True` and serves on `:5274` (dev).

> If launched from an Electron-based terminal/IDE, unset `ELECTRON_RUN_AS_NODE`
> first, or the Electron binary runs headless as Node instead of opening a window.

## Remaining (not done)

- **Packaged `.dmg`.** `extraResources` still points at a Windows `build/python`
  runtime. Needs a macOS Python runtime bundle (PyInstaller via the existing
  `VVAM.spec`, or a relocatable venv) + `TOMO_PY_VER` matching it.
- **File dialogs** are implemented but want a real click-through test (open STL,
  save .mp4) on macOS.
- **`vamtoolbox` dependency list** is incomplete upstream; the explicit pip list
  above compensates. Worth fixing in VAMToolbox's packaging.
