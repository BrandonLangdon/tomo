# VAMToolbox ↔ GUI integration (UIMain)

This is a **working copy** of the collaborator's React+Flask GUI
(`Python-UI-Dev-js-UI-Test`), wired to our `vamtoolbox` pipeline. The originals
under `Python-UI-Dev-*` are untouched.

## What changed vs the collaborator's version

**Backend (`Python_Backend/`)**
- `VAM_Ob.py`
  - `slice()` now routes through **`vamtoolbox.pipeline.VAMPipeline`**, exposing
    OSMO/BCLP, Beer-Lambert absorption, diffusion correction, z-slabbing and
    low-memory BCLP. Accepts an optional `progress_cb(stage, fraction, message)`.
  - New `get_surface_mesh()` — marching-cubes the voxel grid into flat
    `{vertices, normals}` (same format the viewer already uses for STLs).
  - New config attributes: `method, absorption, diffusion, low_memory, slab,
    diffusion_coeff, print_time_s, rotation_deg_s, vial_radius_mm`.
  - Voxelize, sinogram edits, preview frames and `saveVid` are unchanged.
- `server.py`
  - `/api/start_slice` now reads `method, absorption, diffusion, low_memory, slab,
    vial_radius_mm` from the JSON body.
  - New route **`GET /api/mesh_preview`** → surface mesh of the voxelized target.

**Frontend (`Front_End/`)**
- `MeshViewer.jsx` (new) — renders the marching-cubes surface mesh (replaces the
  raw voxel-cube display) with the same orbit controls + reference cylinder.
- `App.jsx` — Optimize tab now shows `MeshViewer` (fetches `/api/mesh_preview`),
  plus new controls: **Optimizer (OSMO/BCLP)**, **Absorption**, **Diffusion**,
  **Memory (z-slab)**. The slice request sends these new fields.
- `api.jsx` — `slice()` extended with the new fields; added `meshPreview()`.

## Run it

**Backend** (in the repo's `.venv`, which has `vamtoolbox` + `flask` + `flask-cors`):
```
cd UIMain/Python_Backend
../../.venv/Scripts/python.exe server.py      # serves on http://localhost:5174
```

**Frontend** (needs Node.js — not currently on this machine's PATH):
```
cd UIMain/Front_End
npm install
npm run dev                                   # Vite dev server on http://localhost:5173
```
CORS in `server.py` already allows `localhost:5173`.

## Verified
- `server.py` + `VAM_Ob.py` import cleanly against our merged `vamtoolbox`.
- Through the real Flask routes: `/api/mesh_preview` returns a mesh; OSMO and
  BCLP+diffusion both complete via `/api/start_slice`.
- Frontend JSX changes are written but **not build-tested** (no Node here) —
  `npm run dev` will surface any JSX issues.

## Standalone desktop app (Electron)

The frontend now runs as a **standalone Electron window** (not a browser):
`Front_End/electron/main.cjs` opens a `BrowserWindow`, auto-starts the Python
backend if it isn't already running, and loads the Vite dev server (or the built
`dist/` in production). Scripts in `Front_End/package.json`:

```
cd UIMain/Front_End
npm install                 # one-time (installs react, vite, three, electron, ...)
npm run app                 # one command: Vite dev server + Electron window
# or, with Vite already running:  npm run electron
```

Node was installed via `winget install OpenJS.NodeJS.LTS` (user scope, on PATH
after a new shell).

### Two fixes that were required to launch
1. **White screen** — `index.html` referenced `/src/main.jsx`, but the source
   files live in the Front_End **root**. Changed to `/main.jsx`.
2. **Electron ran as Node (no window)** — the environment had
   `ELECTRON_RUN_AS_NODE=1` set, which makes `electron.exe` behave as plain Node
   (`electron --version` prints a Node version). If the window doesn't open and
   you see Node-like behavior, **clear that variable** before launching:
   `Remove-Item Env:ELECTRON_RUN_AS_NODE` (PowerShell) / `set ELECTRON_RUN_AS_NODE=`
   (cmd). In a normal user shell it is usually not set.

## Alternatives to Electron (if ever wanted)
- **pywebview** — Python-native (the backend is already Python); lightest, no Node.
- **Tauri** — Rust shell, much smaller binaries, but adds a Rust toolchain.
Electron was chosen for familiarity.

## Not yet done
- Live per-iteration progress to the browser: `VAM_Ob.slice()` accepts a
  `progress_cb`, but `server.py` runs `slice()` synchronously and the frontend
  polls `/api/poll`. To stream real progress, run `slice()` on a thread and push
  `progress` updates (e.g. into a shared var the existing poll reads).
