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

## Packaging a `.dmg`

```bash
VAMTOOLBOX=/path/to/VAMToolbox ./build_mac.sh
# -> build/dist-app/Tomo-<version>-arm64.dmg  (~419 MB)
```

`build_mac.sh` assembles a **self-contained, relocatable CPython 3.13** under
`build/python` (from python-build-standalone), pip-installs the backend deps +
**our Metal `vamtoolbox` non-editable** (so the Metal source is copied into the
bundle) + `metalcompute`, verifies `metal == True`, slims it, then runs
`electron-builder`. `electron-builder`'s `extraResources` copies `build/python`
-> `Resources/python` and `Python_Backend` -> `Resources/backend`; `main.cjs`
resolves `Resources/python/bin/python3` + `Resources/python/lib/python3.13/
site-packages` in packaged mode (`TOMO_PY_VER` overrides the `3.13` default).

**Metal acceleration ships in the bundle** — verified: the packaged app spawns
`Tomo.app/Contents/Resources/python/bin/python3`, and that interpreter reports
`metal == True` (`metal_available()` True); `/api/hardware` shows
`"metal": true`, `"gpu": "Apple Metal (GPU)"`.

### Gatekeeper (unsigned build)

The build is **unsigned** (`identity: null` / `CSC_IDENTITY_AUTO_DISCOVERY=false`).
electron-builder ad-hoc signs the app so it runs locally, but macOS Gatekeeper
still prompts on first open of a not-notarized app. To launch:

- **right-click the app -> Open** (once), or
- `xattr -dr com.apple.quarantine "/Applications/Tomo.app"` after installing.

Running the binary directly (`Tomo.app/Contents/MacOS/Tomo`) bypasses the prompt.
For distribution without the prompt you'd need an Apple Developer ID signature +
notarization.

## Known issues / to test

- **[FIXED 2026-07-03] Reopen-after-close hung on the startup screen.** Closing
  the window with the red **X** left the app running in the Dock (correct macOS
  behavior) but `window-all-closed` had *killed the Python backend*; clicking the
  Dock icon re-created the window, whose fresh startup screen then polled a dead
  backend forever. Fix in `electron/main.cjs`: on macOS keep the backend alive
  across window-close (freed on real quit via `before-quit`), and `activate`
  now calls `ensureBackend()` before/with re-creating the window as a safety net.
  *(This may also have been the "resize during launch" hang below — same symptom,
  a backend the UI never reaches — so retest that after this fix.)*

- **Resizing the window during launch can hang it on the loading screen**
  (observed 2026-07-03, macOS packaged build). Repro: start the app and drag-
  resize the window *before* the backend is ready (while the "starting" overlay
  is up). It then never gets past the loading screen.
  *Leads:* the window opens immediately and a `useEffect` polls `/api/hardware`
  until it answers, flipping `backendReady` ([App.jsx](UIMain/Front_End/App.jsx)
  ~L221–236). Its deps are `[]`, so a resize shouldn't restart it — which
  suggests the real cause is a **renderer exception during early Three.js/WebGL
  init on resize** that tears down the React tree; the poll effect's cleanup then
  sets `cancelled = true`, so `backendReady` never flips and the overlay is
  permanent. There's no React error boundary around the init/loading path.
  *To investigate:* reproduce with DevTools open (check the renderer console) and
  read `~/Library/Application Support/Tomo/tomo-main.log`; likely fixes — add an
  error boundary, make the backend-readiness poll survive/restart across a render
  error, and/or debounce resize until `backendReady`. Probably **not Mac-specific**
  (the open-window-before-backend design is upstream), so worth checking on
  Windows too.

## Remaining (not done)

- **File dialogs** are implemented but want a real click-through test (open STL,
  save .mp4) on macOS.
- **Signing/notarization** for friction-free distribution (needs a paid Apple
  Developer ID). Fine unsigned for local/personal use.
- **`vamtoolbox` dependency list** is incomplete upstream; the explicit pip list
  compensates. Worth fixing in VAMToolbox's packaging.
