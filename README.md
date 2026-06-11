<p align="center">
  <img src="tomoLogo.png" alt="Tomo" width="160"/>
</p>

<h1 align="center">Tomo</h1>

<p align="center">
  <b>A standalone Windows desktop app for tomographic volumetric 3D printing.</b><br/>
  A graphical front end for <a href="https://github.com/computed-axial-lithography/VAMToolbox">VAMToolbox</a> — take an STL to a print-ready light-projection sequence without touching a line of Python.
</p>

---

## What is Tomo?

**Tomo is a desktop GUI wrapper around [VAMToolbox](https://github.com/computed-axial-lithography/VAMToolbox)**, the open-source library for **Computed Axial Lithography (CAL)** / **Volumetric Additive Manufacturing (VAM)**.

In CAL/VAM printing, a part is cured *all at once* inside a rotating vial of photopolymer resin. A projector shines a sequence of images into the vial as it spins; where enough light accumulates over a full rotation, the resin solidifies. Computing *which images to project* — the **sinogram** — is an inverse tomography problem: you reconstruct the light field that, integrated over all angles, deposits the right dose everywhere inside the target geometry and nowhere outside it.

VAMToolbox solves that problem from the command line and Python scripts. **Tomo puts the entire pipeline behind a four-step graphical workflow** — load a model, voxelize it, optimize the projections, preview and export the result — with live 3D previews, hardware auto-tuning, and one-click video export. It ships as a single Windows installer with a self-contained Python/CUDA runtime bundled in, so end users never set up a Python environment.

> **Tomo is a front end, not a fork.** All of the optimization, voxelization, and physics is performed by VAMToolbox. Tomo wires that library to a React UI through a thin Flask backend and packages the whole thing as a desktop app.

---

## Features

### Guided four-stage workflow
Tomo is organized as four tabs that mirror the CAL pipeline:

| Stage | What it does |
|-------|--------------|
| **Prep** | Load one or more STL files, position/scale the part, set physical print parameters (part height, voxel pitch, vial radius, number of projection angles). |
| **Voxelize** | Convert the mesh into a high-resolution voxel target using the GPU OpenGL layer-slicer, with a live 3D voxel/mesh preview and progress + ETA. |
| **Optimize** | Run the projection optimizer (OSMO or BCLP) to compute the sinogram, with per-iteration progress and an inline reconstruction preview. |
| **Preview** | Inspect the optimized sinogram as a rotating projection video, check print quality, and export the print-ready outputs. |

### Optimization
- **Two optimizers** — choose **OSMO** (Object-Space Model Optimization) or **BCLP** (Band-Constrained Linear Programming) from a dropdown.
- **Iteration control** — slider (1–50) plus a free-entry number field for any iteration count.
- **Live per-iteration progress** reported back to the UI during the solve.
- **Dose-target bands** (`d_high` / `d_low`) and learning rate exposed for fine control.

### Physics-aware corrections
- **Absorption compensation** — account for resin optical attenuation (Beer–Lambert) so deep regions still receive the correct dose.
- **Diffusion correction** — compensate for cure/oxygen diffusion blur (available with the **BCLP** optimizer; the control auto-disables for OSMO).
- Corrections use the **real physical pitch** of the voxel grid, not pixel units.

### Built for large parts
- **GPU OpenGL voxelizer** renders the mesh **layer-by-layer to an off-screen framebuffer**, so memory stays bounded per slice and very large XY grids are handled (validated well past 1900×1900). High resolution is never silently coarsened.
- **Memory / z-slab mode** (`Auto` / `Off` / fixed) lets billion-voxel optimizations fit in RAM by chunking the volume along Z.
- **Hardware auto-detection** — Tomo detects your CUDA GPU and auto-tunes the run; CUDA is used when available, with a CPU fallback.

### Previews and output
- **Interactive 3D preview** of the voxelized target and a marching-cubes surface mesh (Three.js), with a reference print vial for scale.
- **Sinogram projection video** export (MP4) showing the exact image sequence the projector will play.
- **Reconstruction / quality check** — preview the simulated cured part and dose metrics before committing resin.
- **Save / load runs** — persist a job and all its parameters, and reload it later.
- **Exports**: projection video, sinogram data, parameter file, and run log.

---

## Architecture

Tomo is a three-layer desktop application packaged with Electron:

```
┌──────────────────────────────────────────────────────────┐
│  Electron shell  (Tomo desktop window)                    │
│                                                           │
│  ┌─────────────────────┐      ┌────────────────────────┐ │
│  │  React + Vite UI     │ HTTP │   Flask backend        │ │
│  │  (Front_End/)        │◄────►│   (Python_Backend/)    │ │
│  │  4-tab workflow,     │ :5174│   server.py            │ │
│  │  Three.js previews   │      │   VAM_Ob.py            │ │
│  └─────────────────────┘      │   optimize_worker.py   │ │
│                                │   voxelize_worker.py   │ │
│                                └───────────┬────────────┘ │
│                                            │              │
│                                ┌───────────▼────────────┐ │
│                                │   VAMToolbox           │ │
│                                │   vamtoolbox.pipeline  │ │
│                                │   + ASTRA (CUDA)       │ │
│                                └────────────────────────┘ │
└──────────────────────────────────────────────────────────┘
```

- **Frontend** — React (Vite), a single-page four-tab app with Three.js 3D viewers.
- **Backend** — a Flask server exposing a REST API (`/api/start_voxelize`, `/api/start_slice`, `/api/mesh_preview`, `/api/poll`, `/api/stream_mp`, …). It threads the long-running voxelize/optimize jobs and reports progress, ETA, and cancellation through a poll endpoint.
- **Engine** — the backend calls **`vamtoolbox.pipeline`** (the clean `PrintConfig` + `VAMPipeline` API), which performs voxelization, optimization, rebinning, and video export. Tomographic projection uses **ASTRA** with CUDA.
- **Packaging** — Electron + electron-builder bundle the UI, the Flask backend, and a **self-contained Python 3.13 runtime** (NumPy/SciPy/ASTRA-CUDA/pyglet/trimesh/OpenCV/VAMToolbox) into a single NSIS installer. No system Python, conda, or CUDA toolkit installation is required by the end user.

---

## Installation (end users)

1. Download the latest **`Tomo Setup <version>.exe`** from the [Releases](https://github.com/computed-axial-lithography/tomo/releases) page.
2. Run the installer. It installs per-user to `%LOCALAPPDATA%\Programs\Tomo` — **no administrator rights required**.
3. Launch **Tomo** from the Start Menu or desktop shortcut.

> **First launch is slow (~90 s)** while Windows Defender scans the freshly installed executables. Subsequent launches are fast.

### Requirements
- **Windows 10 / 11 (64-bit).**
- An **NVIDIA CUDA-capable GPU** is strongly recommended for voxelization and optimization at full resolution. Tomo will fall back to CPU where possible, but large parts at high resolution expect a GPU.
- No Python installation needed — the runtime is bundled.

---

## Building from source (developers)

Tomo lives in this repository under `UIMain/`:

```
UIMain/
  Front_End/        React + Vite UI, Electron shell (electron/main.cjs), build config
  Python_Backend/   Flask server.py, VAM_Ob.py, optimize_worker.py, voxelize_worker.py
```

### Run in dev mode
```powershell
# 1. Backend (Flask, binds :5174) — needs VAMToolbox importable on PYTHONPATH
$env:PYTHONPATH = "<path to your vamtoolbox checkout>"
python UIMain\Python_Backend\server.py

# 2. Frontend + Electron (Vite :5173 + desktop window)
cd UIMain\Front_End
npm install
npm run app
```

The backend requires VAMToolbox and its dependencies (NumPy, SciPy, **ASTRA with CUDA**, pyglet, trimesh, scikit-image, OpenCV, imageio-ffmpeg) plus `flask` and `flask-cors`. See [VAMToolbox](https://github.com/computed-axial-lithography/VAMToolbox) for environment setup.

### Build the installer
A one-command build script and full instructions are in [`BUILD.md`](BUILD.md):

```powershell
powershell -ExecutionPolicy Bypass -File build_installer.ps1
```

This re-syncs VAMToolbox into the bundled runtime, builds the frontend (`vite build`), and packages the NSIS installer (`electron-builder`). Output: `build/dist-app/Tomo Setup <version>.exe`.

---

## Relationship to VAMToolbox

Tomo depends on [VAMToolbox](https://github.com/computed-axial-lithography/VAMToolbox) and does not reimplement any of its math. The GUI calls the high-level `vamtoolbox.pipeline` API (`PrintConfig`, `VAMPipeline`) for the entire job: hardware detection, voxelization, optimization, rebinning to print resolution, video export, and quality metrics. If you want to script the same pipeline or build your own front end, use VAMToolbox directly.

---

## License

See [LICENSE](LICENSE). VAMToolbox is developed by the Computed Axial Lithography group; Tomo is a desktop front end for it. Please cite the underlying VAMToolbox / CAL work when using this software in research.
