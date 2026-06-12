# Must run before anything imports pyglet (vamtoolbox.voxelize does).  Disabling
# the shared "shadow" window gives each window an independent GL context, which is
# what lets the voxelizer get a HARDWARE OpenGL context from a worker thread (the
# Flask backend voxelizes off the request thread).  Without this, worker-thread
# voxelize falls back to software GL / GL_INVALID_OPERATION.
import pyglet
pyglet.options['shadow_window'] = False

# Headless matplotlib so vamtoolbox's verbose optimizer figure (EvolvingPlot) renders to
# PNG without opening a window.  Must be set BEFORE vamtoolbox imports pyplot.
import matplotlib
matplotlib.use("Agg")
try:
    import matplotlib.backend_bases as _mbb
    _mbb.FigureManagerBase.full_screen_toggle = lambda self: None   # EvolvingPlot calls this; no-op headless
except Exception:
    pass

import io
import os
import sys
import atexit
import base64
import subprocess
import tempfile
import traceback
import uuid

@atexit.register
def _shutdown_worker_pool():
    """On a clean backend exit, kill any joblib/loky worker processes so none orphan."""
    try:
        from joblib.externals.loky import get_reusable_executor
        get_reusable_executor().shutdown(wait=False, kill_workers=True)
    except Exception:
        pass
import trimesh
import trimesh.transformations as tf
from typing import Optional

import numpy as np
import cv2
from PIL import Image
from flask import Flask, jsonify, request, send_file, send_from_directory
from flask_cors import CORS

from VAM_Ob import VAM

# =============================================================================
# PYINSTALLER PATH RESOLUTION
# =============================================================================
if getattr(sys, 'frozen', False):
    base_dir = getattr(sys, '_MEIPASS', os.path.dirname(sys.executable))
else:
    base_dir = os.path.dirname(os.path.abspath(__file__))

frontend_folder = os.path.join(base_dir, 'frontend', 'dist')

# =============================================================================
# FLASK INIT
# =============================================================================
app = Flask(__name__, static_folder=frontend_folder, static_url_path='')
CORS(app, resources={r"/api/*": {"origins": ["http://localhost:5173", "http://127.0.0.1:5173"]}}, supports_credentials=True)

import time
import datetime as _dt
import glob as _glob

# ── Auto debug logging: tee stdout+stderr to a rotating file, keep the last 3 ──
_LOG_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "logs")
try:                                   # fall back to a user dir if resources are read-only (installed app)
    os.makedirs(_LOG_DIR, exist_ok=True)
    _wp = os.path.join(_LOG_DIR, ".wtest"); open(_wp, "w").close(); os.remove(_wp)
except Exception:
    import tempfile as _tf
    _LOG_DIR = os.path.join(os.environ.get("LOCALAPPDATA") or _tf.gettempdir(), "Tomo", "logs")
try:
    os.makedirs(_LOG_DIR, exist_ok=True)
    # delete all but the 2 newest so this session's new file makes 3 total
    for _old in sorted(_glob.glob(os.path.join(_LOG_DIR, "tomo_*.log")))[:-2]:
        try: os.remove(_old)
        except Exception: pass
    _LOG_PATH = os.path.join(_LOG_DIR, "tomo_" + _dt.datetime.now().strftime("%Y%m%d_%H%M%S") + ".log")
    _logf = open(_LOG_PATH, "a", encoding="utf-8", buffering=1)

    class _Tee:
        def __init__(self, *streams):
            self._streams = [s for s in streams if s is not None]
        def write(self, m):
            for st in self._streams:
                try: st.write(m); st.flush()
                except Exception: pass
            return len(m) if isinstance(m, (str, bytes)) else 0
        def flush(self):
            for st in self._streams:
                try: st.flush()
                except Exception: pass
        def fileno(self):
            for st in self._streams:
                try:
                    fn = st.fileno()
                    if fn is not None and fn >= 0:
                        return fn
                except Exception: pass
            raise OSError("Tee stream has no fileno")
        def isatty(self): return False
        def writable(self): return True

    sys.stdout = _Tee(sys.__stdout__, _logf)
    sys.stderr = _Tee(sys.__stderr__, _logf)
    import logging as _logging
    _logging.getLogger("werkzeug").setLevel(_logging.WARNING)   # drop per-request spam
    print(f"[server] debug log -> {_LOG_PATH}")
except Exception as _e:
    print(f"[server] log setup failed: {_e}")

loaded_models  = {}
vam            = VAM(None)
voxelize_done  = False
voxel_info     = None
# --- voxelize progress (worker thread + a time-based estimate reported by /poll) ---
vox_running    = False
vox_done       = False
vox_error      = None
vox_start      = 0.0
vox_estimate_s = 1.0
vox_stage      = ""
vox_grid       = None   # [nx, ny, nz]
vox_cancel     = False
vox_proc       = None   # Popen of the voxelize subprocess (killable on cancel)
slice_done     = False
slice_info     = None
mp4_path       = None
sino_path      = None   # saved sinogram (.npy) for the latest run — reloadable
params_path    = None   # saved run record (.json): parameters + results + timing
preview_frames = None   # list of (H,W) uint8 numpy arrays, built once after slicing
preview_fps    = 30.0   # playback FPS for the preview

# --- optimize progress (the worker thread updates these; /api/poll reports them) ---
slice_running   = False
slice_progress  = 0.0   # 0..1 over the optimize iterations
slice_stage     = ""    # short human label for the current step
slice_error     = None
slice_cancel    = False # set by /api/cancel_slice
slice_proc      = None   # Popen of the optimize subprocess (killable -> instant cancel)
slice_loss_history = []  # [[iter, loss], ...] loaded from the optimize worker
slice_start     = 0.0   # wall-clock at optimize start (for a time-based progress fallback)
slice_estimate_s = 1.0  # estimated optimize wall-time (so the bar moves even at 1 iter)
# vam.__dict__ keys that are NOT JSON-serializable / get rebuilt in the worker.
SLICE_SKIP_ATTRS = {"t_geo", "sino", "recon", "_pipe", "dose_metrics", "_verbose_dir",
                    "_sino_is_rebinned", "_optimize_s"}

import threading
import vamtoolbox

# =============================================================================
# FRONTEND CATCH-ALL ROUTE
# =============================================================================
@app.route('/', defaults={'path': ''})
@app.route('/<path:path>')
def serve(path):
    if path != "" and os.path.exists(os.path.join(app.static_folder, path)):
        return send_from_directory(app.static_folder, path)
    else:
        return send_from_directory(app.static_folder, 'index.html')

# =============================================================================
# API ROUTES
# =============================================================================

def open_file_dialog(title="Open STL File", filt="STL files (*.stl)|*.stl|All files (*.*)|*.*", multi=False):
    """
    Show a native Windows file-open dialog and return the selected path.

    tkinter's Tk() requires the main thread (or at minimum an STA COM
    apartment) which is not available on Flask worker threads.  Instead we
    spawn a PowerShell process that shows a WinForms OpenFileDialog.

    Flags:
      -STA           Required for WinForms/COM dialogs. PowerShell 7 defaults
                     to MTA; without -STA, ShowDialog() silently returns Cancel.
      -NoProfile     Skip profile scripts for fast startup.
      (no -NonInteractive) That flag can suppress GUI dialogs on some PS builds.
    """
    # A top-most invisible owner form forces the dialog to the FRONT — otherwise it can
    # open behind the Electron window and look like "nothing happened" (the flakiness).
    ps_script = (
        "Add-Type -AssemblyName System.Windows.Forms;"
        "Add-Type -AssemblyName System.Drawing;"
        "[System.Windows.Forms.Application]::EnableVisualStyles();"
        "$owner = New-Object System.Windows.Forms.Form;"
        "$owner.TopMost = $true; $owner.ShowInTaskbar = $false; $owner.Opacity = 0;"
        "$owner.Size = New-Object System.Drawing.Size(1,1); $owner.StartPosition = 'CenterScreen';"
        "$owner.Add_Shown({ $owner.Activate(); $owner.BringToFront() });"
        "$owner.Show();"
        "$d = New-Object System.Windows.Forms.OpenFileDialog;"
        f"$d.Title = '{title}';"
        f"$d.Filter = '{filt}';"
        f"$d.Multiselect = ${'true' if multi else 'false'};"
        "$result = $d.ShowDialog($owner);"
        "$owner.Close();"
        + ("if ($result -eq [System.Windows.Forms.DialogResult]::OK) { $d.FileNames }"
           if multi else
           "if ($result -eq [System.Windows.Forms.DialogResult]::OK) { Write-Output $d.FileName }")
    )
    try:
        result = subprocess.run(
            ["powershell", "-NoProfile", "-STA", "-Command", ps_script],
            capture_output=True,
            text=True,
            timeout=120,
            creationflags=subprocess.CREATE_NO_WINDOW,
        )
        path = result.stdout.strip()
        if not path and result.stderr.strip():
            print(f"[server] File dialog stderr: {result.stderr.strip()}")
        if multi:
            return [p.strip() for p in path.splitlines() if p.strip()] or None
        return path if path else None
    except Exception as e:
        print(f"[server] File dialog error: {e}")
        return None

def load_stl_for_viewer(path: str) -> dict:
    mesh = trimesh.load_mesh(path)
    if isinstance(mesh, trimesh.Scene):
        mesh = trimesh.util.concatenate([g for g in mesh.geometry.values()])
    
    triangles = mesh.triangles.astype(np.float32)
    bounds = mesh.bounds
    centre = (bounds[0] + bounds[1]) * 0.5
    triangles = triangles - centre 
    
    flat_vertices = triangles.reshape(-1).tolist()
    face_normals = mesh.face_normals.astype(np.float32)
    flat_normals = np.repeat(face_normals, 3, axis=0).reshape(-1).tolist()
    
    return {
        "vertices": flat_vertices,
        "normals":  flat_normals,
        "gl_scale": 1.0,
    }

@app.post("/api/open_stl_dialog")
def open_stl_dialog():
    paths = open_file_dialog(multi=True)   # allow selecting several STLs at once
    if not paths:
        return jsonify({"status": "cancelled"})
    if isinstance(paths, str):
        paths = [paths]

    models = []
    for path in paths:
        try:
            mesh_data = load_stl_for_viewer(path)
            bounds    = VAM.get_stl_bounds(path)
            model_id  = str(uuid.uuid4())
            loaded_models[model_id] = {"path": path, "filename": os.path.basename(path)}
            models.append({"model_id": model_id, "filename": os.path.basename(path),
                           "native_bounds": bounds, **mesh_data})
        except Exception as e:
            print(f"[server] failed to load {path}: {e}"); traceback.print_exc()

    if not models:
        return jsonify({"status": "error", "message": "No valid STL could be loaded"}), 500
    return jsonify({"status": "ok", "models": models})

@app.post("/api/load_stl")
def load_stl():
    """Load an STL from a path the client supplies (drag-and-drop in Electron)."""
    data = request.get_json(silent=True) or {}
    path = data.get("path")
    if not path or not os.path.exists(path):
        return jsonify({"status": "error", "message": "File not found"}), 400
    try:
        mesh_data = load_stl_for_viewer(path)
        bounds    = VAM.get_stl_bounds(path)
        model_id  = str(uuid.uuid4())
        loaded_models[model_id] = {"path": path, "filename": os.path.basename(path)}
    except Exception as e:
        traceback.print_exc()
        return jsonify({"status": "error", "message": str(e)}), 500
    return jsonify({"status": "ok", "model_id": model_id,
                    "filename": os.path.basename(path), "native_bounds": bounds, **mesh_data})


@app.post("/api/remove_model")
def remove_model():
    """Drop one loaded model so it isn't included in the next voxelization."""
    data = request.get_json(silent=True) or {}
    mid = data.get("model_id")
    if mid and mid in loaded_models:
        loaded_models.pop(mid, None)
        print(f"[server] removed model {mid} ({len(loaded_models)} left)")
    return jsonify({"status": "ok", "remaining": len(loaded_models)})


@app.get("/api/hardware")
def hardware():
    """Probe the machine so the GUI can tailor the scaling suggestion: a CUDA GPU
    handles big grids fast (rarely needs down-scaling); CPU-only does."""
    try:
        import vamtoolbox.util.hardware as _hw
        info = _hw.detect_system()
        gpus = info.get("gpus", []) or []
        return jsonify({
            "status": "ok",
            "cuda": bool(info.get("cuda")),
            "gpu": (gpus[0]["name"] if gpus else None),
            "vram_gb": (gpus[0].get("vram_total_gb") if gpus else None),
            "cpu_cores": info.get("cpu_logical"),
            "ram_gb": info.get("ram_total_gb"),
        })
    except Exception as e:
        traceback.print_exc()
        return jsonify({"status": "error", "message": str(e)}), 500


def _est_vox_time(voxels):
    """Calibrated voxelize-time estimate (GPU render + embed + TargetGeometry).
    Benchmarked: ~42 M vox/s up to ~1.2 B, then a memory cliff (~4 M vox/s) as the
    multi-GB transient copies thrash RAM.  Piecewise-linear across that knee."""
    KNEE, RATE1, RATE2 = 1.2e9, 42e6, 4.2e6
    if voxels <= KNEE:
        return max(1.5, voxels / RATE1)
    return KNEE / RATE1 + (voxels - KNEE) / RATE2


@app.post("/api/start_voxelize")
def start_voxelize():
    global voxelize_done, voxel_info, slice_done, slice_info
    global vox_running, vox_done, vox_error, vox_start, vox_estimate_s, vox_stage, vox_grid, vox_cancel, vox_proc

    if not loaded_models:
        return jsonify({"status": "error", "message": "No files loaded"}), 400
    if vox_running:
        return jsonify({"status": "busy"}), 409
    if slice_running:
        # Serialize GPU work: a voxelize (OpenGL) + an optimize (CUDA) running at once
        # can exhaust GPU memory / trip a driver reset and crash the backend.
        return jsonify({"status": "busy", "message": "An optimization is still running. Wait for it to finish before voxelizing — running both on the GPU at once can crash."}), 409

    try:
        data = request.get_json(silent=True) or {}
        res_value = float(data.get("resolution", 1.0))
        matrices = data.get("matrices", {})

        vam.t_geo = None
        vam.sino = None
        vam.vox = None
        slice_done = False
        voxelize_done = False

        transformed_meshes = []
        rot_x_neg90 = tf.rotation_matrix(-np.pi/2, [1, 0, 0])
        rot_x_pos90 = tf.rotation_matrix(np.pi/2, [1, 0, 0])

        for m_id, m_info in loaded_models.items():
            if not os.path.exists(m_info["path"]):
                print(f"[server] skipping model with missing file: {m_info['path']}")
                continue
            raw_mesh = trimesh.load_mesh(m_info["path"])
            if isinstance(raw_mesh, trimesh.Scene):
                mesh = trimesh.util.concatenate([g for g in raw_mesh.geometry.values()])
            else:
                mesh = raw_mesh.copy()

            bounds = mesh.bounds
            centre = (bounds[0] + bounds[1]) * 0.5
            mesh.apply_translation(-centre)

            matrix_data = matrices.get(m_id)
            if matrix_data and len(matrix_data) == 16:
                m4 = np.array(matrix_data, dtype=np.float64).reshape((4, 4), order='F')
            else:
                m4 = np.eye(4)

            mesh.apply_transform(rot_x_neg90)
            mesh.apply_transform(m4)
            mesh.apply_transform(rot_x_pos90)
            transformed_meshes.append(mesh)

        if not transformed_meshes:
            return jsonify({"status": "error", "message": "No valid models to voxelize (files missing) — re-add your STL."}), 400

        unified_mesh = trimesh.util.concatenate(transformed_meshes)
        # NOTE: not re-centred — placed position is preserved (center_model=False).

        # Full requested resolution — NEVER coarsened.  Estimate the grid just for
        # the progress bar/ETA (the GPU layer-slicer handles very large grids).
        ext = np.asarray(unified_mesh.extents, dtype=float)
        b = unified_mesh.bounds
        eff_res = res_value
        # Match voxelizeTargetOpenGL (square_xy=True): it centres the part and sizes
        # the XY grid to the XY DIAGONAL (so a rotating part never clips); the worker
        # then re-places it at the part's XY offset (+2*offset).  Replicate exactly so
        # the estimate matches the real grid.
        diag_xy = float(np.hypot(ext[0], ext[1])) if ext.size > 1 else float(ext[0])
        off_x = (float(b[0][0]) + float(b[1][0])) * 0.5
        off_y = (float(b[0][1]) + float(b[1][1])) * 0.5
        xy = int(diag_xy / eff_res) + 2 * int(round(max(abs(off_x), abs(off_y)) / eff_res)) + 1
        z = int(round((float(ext[2]) if ext.size > 2 else 1.0) / eff_res))
        grid = [xy, xy, z]
        voxels = max(1, grid[0] * grid[1] * grid[2])
        est = _est_vox_time(voxels)

        with tempfile.NamedTemporaryFile(suffix=".stl", delete=False) as tmp_file:
            tmp_file.write(unified_mesh.export(file_type='stl'))
            temp_stl_path = tmp_file.name

        vam.path = temp_stl_path
        vam.res = eff_res

        # Run the voxelize in a SEPARATE PROCESS so cancel can kill it outright (the
        # GPU layer-slicer can't be interrupted in-thread).  A monitor thread waits
        # for it and loads the result.
        out_npy = os.path.join(tempfile.mkdtemp(), "vox.npy")
        worker = os.path.join(os.path.dirname(os.path.abspath(__file__)), "voxelize_worker.py")
        repo_root = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
        vox_proc = subprocess.Popen(
            [sys.executable, worker, temp_stl_path, str(eff_res), out_npy],
            stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, cwd=repo_root)
        vox_running, vox_done, vox_error = True, False, None
        vox_cancel = False
        vox_start = time.time()
        vox_estimate_s = est
        vox_stage = "Voxelizing"
        vox_grid = grid
        threading.Thread(target=_run_voxelize_job, args=(temp_stl_path, out_npy), daemon=True).start()
        return jsonify({"status": "started", "grid": grid, "voxels": voxels,
                        "eff_res": eff_res, "requested_res": res_value,
                        "res_bumped": False, "estimate_s": est})

    except Exception as e:
        traceback.print_exc()
        return jsonify({"status": "error", "message": str(e)}), 500


@app.post("/api/cancel_voxelize")
def cancel_voxelize():
    global vox_cancel, vox_running
    vox_cancel = True
    p = vox_proc
    if p is not None and p.poll() is None:
        try:
            p.terminate()                       # kill the voxelize subprocess outright
            try:
                p.wait(timeout=3)
            except Exception:
                p.kill()
        except Exception:
            traceback.print_exc()
    vox_running = False
    print("[server] voxelize cancelled — subprocess killed")
    return jsonify({"status": "ok"})


def _run_voxelize_job(temp_stl_path, out_npy):
    global vox_running, vox_done, vox_error, vox_stage, voxelize_done, voxel_info, vox_proc
    p = vox_proc
    try:
        out = ""
        if p is not None:
            out, _ = p.communicate()            # wait for the subprocess to finish/die
        if out:
            print(out, end="")                  # tee the worker's log into ours
        if vox_cancel:
            vox_stage = "cancelled"
            return
        if p is not None and p.returncode != 0:
            vox_error = f"voxelize worker exited with code {p.returncode}"
            return
        if not os.path.exists(out_npy):
            vox_error = "voxelize produced no output"
            return
        arr = np.load(out_npy)
        vam.t_geo = vamtoolbox.geometry.TargetGeometry(target=arr)
        vam.t_geo.zero_dose = None
        voxel_info = {
            "x": int(arr.shape[0]), "y": int(arr.shape[1]), "z": int(arr.shape[2]),
            "fill_pct": float(arr.sum() / arr.size * 100),
        }
        voxelize_done = True
        vox_done = True
        vox_stage = "done"
        print(f"[server] Voxelization complete: shape={arr.shape}")
    except Exception as e:
        if not vox_cancel:
            vox_error = str(e)
            traceback.print_exc()
    finally:
        vox_running = False
        vox_proc = None
        for pth in (temp_stl_path, out_npy):
            try:
                if pth and os.path.exists(pth):
                    os.remove(pth)
            except Exception:
                pass

@app.get("/api/poll")
def poll():
    # Time-based voxelize progress (the blocking trimesh call can't report real
    # progress, so we estimate from elapsed/estimate and snap to 1.0 when done).
    if vox_running and vox_estimate_s > 0:
        # Asymptotic approach (never races to a hard cap, never jumps backward): even if
        # the estimate is off, the bar keeps creeping toward ~0.97 and slows down.
        import math as _math
        vp = 0.97 * (1.0 - _math.exp(-(time.time() - vox_start) / max(1.0, vox_estimate_s)))
        eta = max(0.0, vox_estimate_s - (time.time() - vox_start))
    elif vox_done:
        vp, eta = 1.0, 0.0
    else:
        vp, eta = 0.0, 0.0
    # Optimize progress: the REAL per-iteration progress drives the bar.  The time
    # estimate is only used for a slow warm-up creep before the first iteration
    # completes — so an under-estimate can no longer race the bar to ~done while the
    # solve is still on iteration 1 (the old max() bug: "hit 95% then showed iters").
    s_prog = slice_progress
    if slice_running and slice_estimate_s > 0:
        s_tb = (time.time() - slice_start) / slice_estimate_s
        if slice_progress <= 0.001:
            s_prog = min(0.10, s_tb)                 # warm-up only, capped at 10%
        else:
            s_prog = slice_progress                  # real iteration fraction (i/n)
    return jsonify({
        "status": "ok",
        "voxelize_done": voxelize_done,
        "voxel_info": voxel_info,
        "vox_running": vox_running,
        "vox_done": vox_done,
        "vox_error": vox_error,
        "vox_progress": vp,
        "vox_stage": vox_stage,
        "vox_grid": vox_grid,
        "vox_eta_s": eta,
        "slice_done": slice_done,
        "slice_info": slice_info,
        "slice_running": slice_running,
        "slice_progress": s_prog,
        "slice_stage": slice_stage,
        "slice_error": slice_error,
        "slice_loss": slice_loss_history,
    })

@app.get("/api/voxel_preview")
def voxel_preview():
    if vam.t_geo is None:
        return jsonify({"status": "error", "message": "No voxel data"}), 400
    try:
        arr  = vam.t_geo.array.astype(np.uint8)
        step = max(1, max(arr.shape) // 64)
        arr  = arr[::step, ::step, ::step]
        return jsonify({
            "status": "ok", 
            "shape": list(arr.shape), 
            "data": arr.flatten().tolist(),
            "step": step  # <-- Add this!
        })
    except Exception as e:
        traceback.print_exc()
        return jsonify({"status": "error", "message": str(e)}), 500

@app.get("/api/mesh_preview")
def mesh_preview():
    """Marching-cubes surface mesh of the voxelized target (smooth surface for the
    3D viewer, replacing the raw voxel-cube display).  Same {vertices, normals}
    format as /api/open_stl_dialog so the existing mesh renderer can show it."""
    if vam.t_geo is None:
        return jsonify({"status": "error", "message": "No voxel data"}), 400
    try:
        full = request.args.get("full", "0") in ("1", "true", "True")
        shp = vam.t_geo.array.shape
        if full:
            # "Full res": no down-scaling up to a memory-safe input cap (~500 M voxels so
            # marching-cubes can't OOM), and refuse (too_large) if the mesh would be huge.
            mesh = vam.get_surface_mesh(max_dim=10 ** 9, budget=500_000_000, max_faces=8_000_000)
        else:
            mesh = vam.get_surface_mesh()              # adaptive (indexed, budgeted)
        mesh["full_grid"] = [int(s) for s in shp]      # so the UI can report display vs full
        return jsonify({"status": "ok", **mesh})
    except Exception as e:
        traceback.print_exc()
        return jsonify({"status": "error", "message": str(e)}), 500


@app.post("/api/reset")
def reset():
    """Clear all loaded models + results so the user can start a fresh part."""
    global loaded_models, voxelize_done, voxel_info, slice_done, slice_info
    global mp4_path, preview_frames, vox_running, vox_done, slice_running
    loaded_models = {}
    vam.t_geo = None
    vam.sino = None
    vam.recon = None
    vam.path = None
    voxelize_done = False; voxel_info = None
    slice_done = False; slice_info = None
    preview_frames = None
    mp4_path = None
    vox_running = False; vox_done = False
    slice_running = False
    print("[server] reset — cleared all models/results for a new part")
    return jsonify({"status": "ok"})


_GPU_FACTOR = None
def _gpu_speed_factor():
    """Rough optimize-time multiplier vs the RTX 4070 the estimate model is tuned on
    (>1 = slower GPU). Coarse FP32-class tiers for now; refine from optimize_times.csv
    as per-GPU data accumulates. Cached (one nvidia probe)."""
    global _GPU_FACTOR
    if _GPU_FACTOR is not None:
        return _GPU_FACTOR
    name = ""
    try:
        import vamtoolbox.util.hardware as _hw
        gpus = _hw.detect_system().get("gpus", []) or []
        name = (gpus[0]["name"] if gpus else "").upper()
    except Exception:
        pass
    tiers = [("5090", 0.35), ("5080", 0.55), ("4090", 0.45), ("4080", 0.65),
             ("4070 TI", 0.8), ("4070", 1.0), ("4060", 1.5), ("3090", 0.7),
             ("3080", 0.85), ("3070", 1.1), ("3060", 1.7), ("2070", 2.0),
             ("2060", 2.3), ("1660", 3.0), ("1650", 3.6)]
    f = 1.0
    for key, val in tiers:
        if key in name:
            f = val
            break
    _GPU_FACTOR = f
    return f


@app.get("/api/estimate")
def estimate():
    """Estimated optimize time for the current voxel grid (drives the ETA shown
    before optimizing).  Query: n_iter, cuda, method."""
    if vam.t_geo is None:
        return jsonify({"status": "error", "message": "No voxel data"}), 400
    try:
        n_iter = int(request.args.get("n_iter", vam.n_iter))
        cuda = str(request.args.get("cuda", "false")).lower() in ("1", "true", "yes")
        method = str(request.args.get("method", "OSMO")).upper()
        voxels = int(vam.t_geo.array.size)
        est = vamtoolbox.util.timing.estimateOptimizeTime(
            voxels, n_iter, "gpu" if cuda else "sparse", 360)
        secs = float(est["total_s"]) * (1.5 if method == "BCLP" else 1.0)
        if cuda:
            secs *= _gpu_speed_factor()      # adjust the generic GPU rate for this card
        try:
            pretty = vamtoolbox.util.timing.formatDuration(secs)
        except Exception:
            pretty = f"{secs:.0f}s"
        return jsonify({"status": "ok", "seconds": secs, "pretty": pretty,
                        "per_iter_s": float(est.get("per_iter_s", 0.0)), "voxels": voxels})
    except Exception as e:
        traceback.print_exc()
        return jsonify({"status": "error", "message": str(e)}), 500


@app.post("/api/start_slice")
def start_slice():
    """Kick off the optimize on a worker thread and return immediately.  The
    frontend polls /api/poll for slice_progress (0..1) and slice_done."""
    global slice_running, slice_done, slice_error, slice_progress, slice_stage
    if vam.t_geo is None:
        return jsonify({"status": "error", "message": "Voxelize first"}), 400
    if slice_running:
        return jsonify({"status": "busy"}), 409
    if vox_running:
        # Serialize GPU work (see start_voxelize): concurrent CUDA + OpenGL can crash.
        return jsonify({"status": "busy", "message": "A voxelization is still running. Wait for it to finish before optimizing — running both on the GPU at once can crash."}), 409
    data = request.get_json(silent=True) or {}
    vam.n_iter = int(data.get("n_iter", 5))
    vam.d_h = float(data.get("d_h", 0.6))
    vam.d_l = float(data.get("d_l", 0.5))
    vam.learning_rate = float(data.get("learning_rate", 0.005))   # BCLP
    vam.eps = float(data.get("eps", 0.1))                         # BCLP band ±
    vam.weight = float(data.get("weight", 1.0))                   # BCLP Lp weight
    vam.filt = str(data.get("filter", "hamming"))
    vam.cuda = bool(data.get("cuda", False))
    vam.method = str(data.get("method", "OSMO")).upper()
    vam.absorption = bool(data.get("absorption", False))
    vam.diffusion = bool(data.get("diffusion", False))
    vam.low_memory = bool(data.get("low_memory", False))
    vam.slab = str(data.get("slab", "auto"))
    vam.verbose = bool(data.get("verbose", False))
    if "vial_radius_mm" in data:
        vam.vial_radius_mm = float(data["vial_radius_mm"])
    if "resin_ri" in data:
        vam.resin_ri = float(data["resin_ri"])
    if "diffusion_coeff" in data:
        vam.diffusion_coeff = float(data["diffusion_coeff"])
    if "absorption_coeff" in data:
        vam.absorption_coeff = float(data["absorption_coeff"])
    vam.vial_correction = bool(data.get("vial_correction", False))
    # Projector (pixel dimensions + physical FOV) — drives output-video resolution
    if "proj_px_w" in data: vam.proj_px_w = int(data["proj_px_w"])
    if "proj_px_h" in data: vam.proj_px_h = int(data["proj_px_h"])
    if "proj_width" in data: vam.proj_width = float(data["proj_width"])
    # Telecentric (collimated) -> throw_ratio = inf; otherwise the projector's finite throw ratio
    if "telecentric" in data or "throw_ratio" in data:
        vam.throw_ratio = (float("inf") if data.get("telecentric", True)
                           else float(data.get("throw_ratio", 0.0) or 0.0))
    # Video output settings
    vam.video_fps = float(data.get("video_fps", 54))
    vam.video_rpm = float(data.get("video_rpm", 1.0))
    vam.video_duration_s = float(data.get("video_duration_s", 300.0))
    vam.video_codec = str(data.get("video_codec", "h265"))

    global slice_cancel, slice_start, slice_estimate_s
    slice_cancel = False
    # Estimate the optimize wall-time so the progress bar moves smoothly even with
    # very few iterations (per-iteration callbacks alone would jump 0 -> 100%).
    try:
        import vamtoolbox.util.timing as _tim
        voxels = int(vam.t_geo.array.size)
        backend = "gpu" if vam.cuda else "sparse"
        _est = _tim.estimateOptimizeTime(voxels, vam.n_iter, backend, 360)
        _gpu_f = _gpu_speed_factor() if vam.cuda else 1.0
        slice_estimate_s = max(5.0, float(_est["total_s"]) * (1.5 if vam.method == "BCLP" else 1.0) * _gpu_f)
    except Exception:
        slice_estimate_s = max(10.0, vam.n_iter * 30.0)
    slice_start = time.time()
    slice_running, slice_done, slice_error = True, False, None
    slice_progress, slice_stage = 0.0, "Starting…"
    vam._pipe = None       # drop the previous run's pipeline so the loss chart / stage
                           # don't show frozen values from the last optimization
    try:                   # wipe stale verbose-figure frames NOW so a re-run never shows last run's graph
        import glob as _g, tempfile as _tf
        for _f in _g.glob(os.path.join(_tf.gettempdir(), "tomo_verbose", "*.png")):
            try: os.remove(_f)
            except Exception: pass
    except Exception: pass
    threading.Thread(target=_run_slice_job, daemon=True).start()
    return jsonify({"status": "started"})


class _Cancelled(Exception):
    pass


@app.post("/api/cancel_slice")
def cancel_slice():
    """Cancel the running optimize by KILLING its subprocess — stops immediately, mid-iteration."""
    global slice_cancel, slice_running
    slice_cancel = True
    p = slice_proc
    if p is not None and p.poll() is None:
        try:
            if sys.platform == "win32":
                # kill the worker AND any loky children (rebin / CPU projector pool) so nothing orphans
                subprocess.run(["taskkill", "/pid", str(p.pid), "/T", "/F"],
                               capture_output=True, creationflags=subprocess.CREATE_NO_WINDOW)
            else:
                p.terminate()
            try:
                p.wait(timeout=3)
            except Exception:
                p.kill()
        except Exception:
            traceback.print_exc()
    slice_running = False
    print("[server] Optimize cancel requested — subprocess tree killed")
    return jsonify({"status": "ok"})


def _gather_run_params(v):
    """Everything it took to produce the current result — parameters + grid + timing
    + dose quality — so a run is fully reproducible/inspectable."""
    t = v.t_geo.array if getattr(v, "t_geo", None) is not None else None
    pipe_t = getattr(getattr(v, "_pipe", None), "timing", {}) or {}
    return {
        "timestamp": _dt.datetime.now().isoformat(timespec="seconds"),
        "resolution_mm": float(v.res),
        "pitch_um": round(float(v.res) * 1000, 1),
        "method": v.method,
        "n_iterations": int(v.n_iter),
        "d_h": float(v.d_h), "d_l": float(v.d_l),
        "absorption": bool(v.absorption),
        "diffusion": bool(v.diffusion),
        "cuda": bool(v.cuda),
        "slab": str(v.slab),
        "vial_radius_mm": float(v.vial_radius_mm),
        "grid_shape": (list(t.shape) if t is not None else None),
        "voxel_count": (int(t.size) if t is not None else None),
        "sinogram_shape": (list(v.sino.array.shape) if v.sino is not None else None),
        "n_angles": (int(v.sino.array.shape[1]) if v.sino is not None else None),
        "video": {"fps": v.video_fps, "rpm": v.video_rpm,
                  "duration_s": v.video_duration_s, "codec": v.video_codec},
        "timing_s": {k: round(float(val), 2) for k, val in pipe_t.items()},
        "dose_metrics": getattr(v, "dose_metrics", None),
    }


@app.post("/api/download_sinogram")
def download_sinogram():
    """The reloadable sinogram as a vamtoolbox .sino (dill) — keeps angles/metadata,
    loads back with vamtoolbox.loadVolume()."""
    if vam.sino is None:
        return jsonify({"status": "error", "message": "Run a print first"}), 400
    try:
        tmp = tempfile.mkdtemp()
        vam.sino.save(os.path.join(tmp, "Tomo_run"))     # -> Tomo_run.sino
        return send_file(os.path.join(tmp, "Tomo_run.sino"), mimetype="application/octet-stream",
                         as_attachment=True, download_name="Tomo_run.sino")
    except Exception as e:
        traceback.print_exc()
        return jsonify({"status": "error", "message": str(e)}), 500


@app.post("/api/download_params")
def download_params():
    """The run record (every parameter + result + timing) as JSON."""
    import json as _json
    if vam.sino is None:
        return jsonify({"status": "error", "message": "Run a print first"}), 400
    try:
        tmp = tempfile.mkdtemp()
        pj = os.path.join(tmp, "Tomo_run.json")
        with open(pj, "w") as f:
            _json.dump(_gather_run_params(vam), f, indent=2, default=str)
        return send_file(pj, mimetype="application/json",
                         as_attachment=True, download_name="Tomo_run.json")
    except Exception as e:
        traceback.print_exc()
        return jsonify({"status": "error", "message": str(e)}), 500


@app.post("/api/export_log")
def export_log():
    """Combine every debug log + the optimize-time CSV into one downloadable text file."""
    try:
        parts = ["===== Tomo combined log export =====",
                 f"exported : {_dt.datetime.now().isoformat(timespec='seconds')}",
                 f"log dir  : {_LOG_DIR}", ""]
        if os.path.exists(_OPT_CSV):
            parts.append("===== optimize_times.csv (estimate-model data) =====")
            with open(_OPT_CSV, "r", encoding="utf-8", errors="replace") as f:
                parts.append(f.read())
        for lp in sorted(_glob.glob(os.path.join(_LOG_DIR, "tomo_*.log")), reverse=True):
            parts.append(f"\n===== {os.path.basename(lp)} =====")
            with open(lp, "r", encoding="utf-8", errors="replace") as f:
                parts.append(f.read())
        out = os.path.join(tempfile.mkdtemp(), "Tomo_logs.txt")
        with open(out, "w", encoding="utf-8") as f:
            f.write("\n".join(parts))
        return send_file(out, mimetype="text/plain", as_attachment=True, download_name="Tomo_logs.txt")
    except Exception as e:
        traceback.print_exc()
        return jsonify({"status": "error", "message": str(e)}), 500


def save_file_dialog(default_name):
    """Native Windows Save-As dialog (PowerShell WinForms, top-most). Returns the
    chosen path or None.  Same approach as open_file_dialog (tkinter can't run on a
    Flask worker thread)."""
    ps = (
        "Add-Type -AssemblyName System.Windows.Forms;"
        "Add-Type -AssemblyName System.Drawing;"
        "[System.Windows.Forms.Application]::EnableVisualStyles();"
        "$o = New-Object System.Windows.Forms.Form;"
        "$o.TopMost=$true; $o.ShowInTaskbar=$false; $o.Opacity=0;"
        "$o.Size=New-Object System.Drawing.Size(1,1); $o.StartPosition='CenterScreen';"
        "$o.Add_Shown({ $o.Activate(); $o.BringToFront() }); $o.Show();"
        "$d = New-Object System.Windows.Forms.SaveFileDialog;"
        "$d.Title='Save run (choose the .mp4 location)';"
        "$d.Filter='MP4 video (*.mp4)|*.mp4';"
        "$d.FileName='" + str(default_name).replace("'", "''") + "';"
        "$r = $d.ShowDialog($o); $o.Close();"
        "if ($r -eq [System.Windows.Forms.DialogResult]::OK) { Write-Output $d.FileName }"
    )
    try:
        res = subprocess.run(["powershell", "-NoProfile", "-STA", "-Command", ps],
                             capture_output=True, text=True, timeout=300,
                             creationflags=subprocess.CREATE_NO_WINDOW)
        path = res.stdout.strip()
        return path if path else None
    except Exception as e:
        print(f"[server] Save dialog error: {e}")
        return None


@app.post("/api/save_run")
def save_run():
    """One native Save dialog (for the .mp4), then auto-write the rest beside it with
    the same base name.  Always saves .mp4 + .json; saves the .npy sinogram only when
    the GUI toggle (off by default) asks for it."""
    global mp4_path
    if vam.sino is None:
        return jsonify({"status": "error", "message": "Run a print first"}), 400
    data = request.get_json(silent=True) or {}
    default_name = (str(data.get("default_name", "Tomo_run")).strip() or "Tomo_run")
    save_sino = bool(data.get("save_sinogram", False))
    vam.video_intensity = float(data.get("video_intensity", 1.0))
    if "video_rpm" in data: vam.video_rpm = float(data["video_rpm"])          # rpm/duration now set on the video page
    if "video_fps" in data: vam.video_fps = float(data["video_fps"])
    if "video_duration_s" in data: vam.video_duration_s = float(data["video_duration_s"])
    path = save_file_dialog(default_name + ".mp4")
    if not path:
        return jsonify({"status": "cancelled"})
    base = os.path.splitext(path)[0]                 # dir + stem (strip .mp4)
    import json as _json
    try:
        # 1) mp4 — encode fresh to the chosen path so the current intensity is applied
        vam.saveVid(out_path=base + ".mp4")
        mp4_path = base + ".mp4"
        # 2) params .json (always)
        with open(base + ".json", "w") as f:
            _json.dump(_gather_run_params(vam), f, indent=2, default=str)
        saved = [base + ".mp4", base + ".json"]
        # 3) combined reloadable project (.tomo): sinogram + reconstruction + dose + ALL the
        #    GUI settings in one dill file, so Load restores the whole run (optional toggle).
        if save_sino:
            import dill
            with open(base + ".tomo", "wb") as f:
                dill.dump({
                    "version": 1,
                    "sino": vam.sino,
                    "recon": vam.recon,
                    "dose_metrics": getattr(vam, "dose_metrics", None),
                    "sino_is_rebinned": bool(getattr(vam, "_sino_is_rebinned", False)),
                    "gui_settings": data.get("gui_settings"),
                    "run_params": _gather_run_params(vam),
                }, f)
            saved.append(base + ".tomo")
        print(f"[server] Saved run -> {', '.join(os.path.basename(s) for s in saved)}")
        return jsonify({"status": "ok", "saved": saved})
    except Exception as e:
        traceback.print_exc()
        return jsonify({"status": "error", "message": str(e)}), 500


@app.post("/api/load_run")
def load_run():
    """Load a combined .tomo project — restores the sinogram + reconstruction + dose and
    returns the embedded GUI settings so the whole run can be reopened from one file."""
    global preview_frames, preview_fps, mp4_path, slice_info
    path = open_file_dialog(title="Load Tomo run",
                            filt="Tomo run (*.tomo)|*.tomo|All files (*.*)|*.*")
    if not path:
        return jsonify({"status": "cancelled"})
    try:
        import dill
        with open(path, "rb") as f:
            d = dill.load(f)
        vam.sino = d.get("sino")
        vam.recon = d.get("recon")
        vam.dose_metrics = d.get("dose_metrics")
        vam._sino_is_rebinned = bool(d.get("sino_is_rebinned", False))
        if vam.sino is None:
            return jsonify({"status": "error", "message": "File has no sinogram"}), 400
        mp4_path = None
        try:                                  # rebuild the looping preview from the loaded sino
            preview_frames, preview_fps = vam.get_preview_frames()
        except Exception as e:
            print("[server] load preview build failed:", e); traceback.print_exc()
        sino = vam.sino.array
        slice_info = {"angles": int(sino.shape[1]), "frames": int(sino.shape[1]),
                      "dose": vam.dose_metrics}
        print(f"[server] Loaded run -> {os.path.basename(path)} (sino {tuple(sino.shape)})")
        return jsonify({"status": "ok", "gui_settings": d.get("gui_settings"),
                        "dose": vam.dose_metrics,
                        "name": os.path.splitext(os.path.basename(path))[0]})
    except Exception as e:
        traceback.print_exc()
        return jsonify({"status": "error", "message": str(e)}), 500


_OPT_CSV = os.path.join(_LOG_DIR, "optimize_times.csv")   # persistent, accumulates (NOT rotated)

def _append_optimize_record(v):
    """Append one row (part size, resolution, settings, optimize time, hardware) to a
    persistent CSV so the time-estimate model can be improved from real runs.  Separate
    from the rotating debug log."""
    try:
        import csv
        t = v.t_geo.array if getattr(v, "t_geo", None) is not None else None
        opt_s = (getattr(getattr(v, "_pipe", None), "timing", {}) or {}).get("optimize", None)
        if opt_s is None:
            opt_s = getattr(v, "_optimize_s", None)   # subprocess run: time comes from the worker
        nx, ny, nz = (list(t.shape) if t is not None else (0, 0, 0))
        try:
            import psutil; ram = round(psutil.virtual_memory().total / 1e9, 1)
        except Exception:
            ram = ""
        gpus = []
        try:
            import vamtoolbox.util.hardware as _hw
            gpus = _hw.detect_system().get("gpus", []) or []
        except Exception:
            pass
        row = {
            "timestamp": _dt.datetime.now().isoformat(timespec="seconds"),
            "nx": nx, "ny": ny, "nz": nz, "voxels": (int(t.size) if t is not None else 0),
            "pitch_um": round(float(v.res) * 1000, 1),
            "method": v.method, "n_iter": int(v.n_iter), "cuda": int(bool(v.cuda)),
            "slab": str(v.slab), "absorption": int(bool(v.absorption)), "diffusion": int(bool(v.diffusion)),
            "cpu_cores": os.cpu_count() or 0, "ram_gb": ram,
            "gpu": (gpus[0]["name"] if gpus else ""),
            "optimize_s": (round(float(opt_s), 2) if opt_s is not None else ""),
        }
        new = not os.path.exists(_OPT_CSV)
        with open(_OPT_CSV, "a", newline="", encoding="utf-8") as f:
            w = csv.DictWriter(f, fieldnames=list(row.keys()))
            if new:
                w.writeheader()
            w.writerow(row)
        print(f"[server] optimize record -> {_OPT_CSV}")
    except Exception as e:
        print("optimize-record append failed:", e)


def _run_slice_job():
    global slice_running, slice_done, slice_info, slice_progress, slice_stage, slice_error
    global mp4_path, preview_frames, preview_fps, slice_proc, slice_loss_history
    import json as _json, pickle as _pickle, shutil as _shutil
    workdir = None
    try:
        slice_loss_history = []
        # --- serialize the optimize inputs for the killable worker process ---
        workdir = tempfile.mkdtemp(prefix="tomo_opt_")
        tgeo_npy = os.path.join(workdir, "tgeo.npy")
        np.save(tgeo_npy, np.ascontiguousarray(vam.t_geo.array))
        attrs = {k: val for k, val in vam.__dict__.items()
                 if k not in SLICE_SKIP_ATTRS and isinstance(val, (int, float, str, bool, type(None), list))}
        cfg_path = os.path.join(workdir, "cfg.json")
        with open(cfg_path, "w") as f:
            _json.dump({"t_geo_npy": tgeo_npy, "workdir": workdir, "attrs": attrs}, f)

        # --- run the optimize in a SEPARATE process so Cancel can kill it instantly ---
        worker = os.path.join(os.path.dirname(os.path.abspath(__file__)), "optimize_worker.py")
        repo_root = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
        slice_proc = subprocess.Popen(
            [sys.executable, worker, cfg_path],
            stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, cwd=repo_root, bufsize=1)
        for line in slice_proc.stdout:                       # stream progress + tee the log
            if line.startswith("@@P\t"):
                try:
                    _, _frac, _stg = line.rstrip("\n").split("\t", 2)
                    slice_progress = float(_frac); slice_stage = _stg
                except Exception:
                    pass
            elif line.startswith("@@S\t"):
                slice_stage = line.rstrip("\n").split("\t", 1)[1]
            else:
                sys.stdout.write(line)
        slice_proc.wait()

        if slice_cancel:
            slice_stage = "cancelled"; print("[server] Optimize cancelled — subprocess killed"); return
        if slice_proc.returncode != 0:
            raise RuntimeError(f"optimize worker exited with code {slice_proc.returncode}")

        # --- load the worker's results back into our vam ---
        with open(os.path.join(workdir, "sino.pkl"), "rb") as f:
            vam.sino = _pickle.load(f)
        with open(os.path.join(workdir, "recon.pkl"), "rb") as f:
            vam.recon = _pickle.load(f)
        with open(os.path.join(workdir, "result.json")) as f:
            _res = _json.load(f)
        vam.dose_metrics = _res.get("dose_metrics")
        vam._sino_is_rebinned = bool(_res.get("sino_is_rebinned", False))
        vam._optimize_s = _res.get("optimize_s")
        slice_loss_history = _res.get("loss_history") or []

        _append_optimize_record(vam)        # log size/res/time for estimate-model tuning

        sino = vam.sino.array
        slice_info = {"angles": int(sino.shape[1]), "frames": int(sino.shape[1]),
                      "dose": getattr(vam, "dose_metrics", None)}

        if slice_cancel:
            raise _Cancelled()
        slice_stage = "Rendering preview…"
        try:
            preview_frames, preview_fps = vam.get_preview_frames()
            print(f"[server] Preview frames cached: {len(preview_frames)} @ {preview_fps:.2f} fps")
        except Exception as e:
            print("Preview frame cache failed:", e); traceback.print_exc()

        # Don't encode the full-length video here — only the one-rotation preview above.
        # The full video is encoded on demand when the user saves (download_mp4), so the
        # optimize finishes immediately and the looping preview shows right away.
        mp4_path = None

        # Log the full run record (every parameter + result + timing) to the debug log.
        try:
            import json as _json
            print("[server] ===== RUN RECORD =====\n"
                  + _json.dumps(_gather_run_params(vam), indent=2, default=str)
                  + "\n[server] ======================")
        except Exception as e:
            print("Run-record logging failed:", e)

        slice_progress, slice_stage, slice_done = 1.0, "done", True
    except _Cancelled:
        slice_stage = "cancelled"
        print("[server] Optimize cancelled by user")
    except Exception as e:
        slice_error = str(e)
        traceback.print_exc()
    finally:
        slice_running = False
        slice_proc = None
        try:
            if workdir:
                _shutil.rmtree(workdir, ignore_errors=True)
        except Exception:
            pass
        # The rebin's loky workers now live inside the killed subprocess, but shut down any
        # pool in THIS process too so nothing lingers.
        try:
            from joblib.externals.loky import get_reusable_executor
            get_reusable_executor().shutdown(wait=False, kill_workers=True)
        except Exception:
            pass

@app.post("/api/modify_sino")
def modify_sino():
    global preview_frames, preview_fps, mp4_path
    
    if vam.sino is None:
        return jsonify({"status": "error", "message": "No sinogram available"}), 400

    data = request.get_json(silent=True) or {}
    action = data.get("action")
    val = float(data.get("value", 0.0))

    try:
        # 1. Apply the requested modification
        if action == "scale":
            vam.scaleSino(val)
        elif action == "rotate":
            vam.rotateSino(val)
        elif action == "invertH":
            vam.invertSinoH()
        elif action == "invertV":
            vam.invertSinoV()
        else:
            return jsonify({"status": "error", "message": "Unknown action"}), 400

        # 2. Regenerate the preview frame cache
        preview_frames, preview_fps = vam.get_preview_frames()

        # 3. Invalidate the cached MP4 so it regenerates on the next download
        if mp4_path and os.path.exists(mp4_path):
            try:
                os.remove(mp4_path)
            except Exception:
                pass
        mp4_path = None

        return jsonify({
            "status": "ok", 
            "frame_count": len(preview_frames), 
            "fps": preview_fps
        })
    except Exception as e:
        traceback.print_exc()
        return jsonify({"status": "error", "message": str(e)}), 500

@app.post("/api/update_video_config")
def update_video_config():
    global preview_frames, preview_fps, mp4_path
    
    if vam.sino is None:
        return jsonify({"status": "error", "message": "No sinogram available"}), 400

    data = request.get_json(silent=True) or {}
    vam.rot_vel = float(data.get("rot_vel", vam.rot_vel))
    vam.proj_width = float(data.get("proj_width", vam.proj_width))
    # Add these two lines:
    vam.proj_px_w = int(data.get("proj_px_w", vam.proj_px_w))
    vam.proj_px_h = int(data.get("proj_px_h", vam.proj_px_h))
    vam.video_v_offset_mm = float(data.get("v_offset_mm", vam.video_v_offset_mm))   # GUI vertical (Z) projection offset

    try:
        # Regenerate the preview cache with the new true_scale and fps
        preview_frames, preview_fps = vam.get_preview_frames()

        # Invalidate the old MP4
        if mp4_path and os.path.exists(mp4_path):
            try:
                os.remove(mp4_path)
            except Exception:
                pass
        mp4_path = None

        return jsonify({
            "status": "ok", 
            "frame_count": len(preview_frames), 
            "fps": preview_fps
        })
    except Exception as e:
        traceback.print_exc()
        return jsonify({"status": "error", "message": str(e)}), 500

@app.get("/api/stream_mp4")
def stream_mp4():
    if not mp4_path or not os.path.exists(mp4_path):
        return jsonify({"status": "error", "message": "No video available"}), 404
    response = send_file(
        mp4_path,
        mimetype="video/mp4",
        conditional=True,
        download_name="Tomo_Output.mp4",
    )
    response.headers["Cache-Control"] = "no-store"
    return response


@app.get("/api/preview_info")
def preview_info():
    """Return frame count and FPS for the current sinogram preview."""
    if preview_frames is None:
        return jsonify({"status": "error", "message": "No preview available"}), 400
    return jsonify({"status": "ok", "frame_count": len(preview_frames), "fps": preview_fps})


@app.get("/api/preview_frame/<int:index>")
def preview_frame(index):
    """
    Return a single sinogram frame as a JPEG image.

    The React frontend cycles through frames with setInterval, requesting each
    by index.  JPEG over HTTP needs no codec — every browser supports it natively.
    """
    if preview_frames is None:
        return jsonify({"status": "error"}), 400
    try:
        gray = preview_frames[index % len(preview_frames)]   # (H, W) uint8
        ok, buf = cv2.imencode(".jpg", gray, [cv2.IMWRITE_JPEG_QUALITY, 85])
        if not ok:
            return jsonify({"status": "error", "message": "JPEG encode failed"}), 500
        return send_file(
            io.BytesIO(buf.tobytes()),
            mimetype="image/jpeg",
            max_age=0,
        )
    except Exception as e:
        traceback.print_exc()
        return jsonify({"status": "error", "message": str(e)}), 500


@app.get("/api/recon_slice")
def recon_slice():
    """Mid-Z slice of the predicted-dose reconstruction (the 'simulation' view),
    colour-mapped so the dose distribution is readable."""
    try:
        recon = getattr(vam, "recon", None)
        if recon is None:
            return jsonify({"status": "error", "message": "no reconstruction"}), 400
        arr = np.asarray(getattr(recon, "array", recon), dtype=np.float32)
        sl = arr[:, :, arr.shape[2] // 2]
        mx = float(sl.max()) or 1.0
        g = np.clip(sl / mx * 255.0, 0, 255).astype(np.uint8)
        cm = cv2.applyColorMap(g, cv2.COLORMAP_VIRIDIS)
        ok, buf = cv2.imencode(".jpg", cm, [cv2.IMWRITE_JPEG_QUALITY, 88])
        if not ok:
            return jsonify({"status": "error"}), 500
        return send_file(io.BytesIO(buf.tobytes()), mimetype="image/jpeg", max_age=0)
    except Exception as e:
        traceback.print_exc()
        return jsonify({"status": "error", "message": str(e)}), 500


@app.get("/api/verbose_frame")
def verbose_frame():
    """Latest BCLP verbose-figure frame (vamtoolbox EvolvingPlot) during optimization."""
    try:
        import glob as _g
        d = os.path.join(tempfile.gettempdir(), "tomo_verbose")   # the optimize worker writes here
        if not os.path.isdir(d):
            return jsonify({"status": "none"}), 404
        pngs = _g.glob(os.path.join(d, "*.png"))
        if not pngs:
            return jsonify({"status": "none"}), 404
        # most-recently-WRITTEN frame (not highest index) so a shorter re-run never
        # shows a stale high-index frame from the previous, longer run.
        return send_file(max(pngs, key=os.path.getmtime), mimetype="image/png", max_age=0)
    except Exception as e:
        return jsonify({"status": "error", "message": str(e)}), 500


@app.post("/api/download_verbose")
def download_verbose():
    """The final verbose optimization figure (EvolvingPlot) as a downloadable PNG."""
    try:
        d = os.path.join(tempfile.gettempdir(), "tomo_verbose")
        pngs = _glob.glob(os.path.join(d, "*.png")) if os.path.isdir(d) else []
        if not pngs:
            return jsonify({"status": "error", "message": "No verbose figure — run an optimize with Verbose enabled first."}), 404
        return send_file(max(pngs, key=os.path.getmtime), mimetype="image/png",
                         as_attachment=True, download_name="Tomo_convergence.png", max_age=0)
    except Exception as e:
        traceback.print_exc()
        return jsonify({"status": "error", "message": str(e)}), 500


@app.post("/api/download_mp4")
def download_mp4():
    """Encode (if needed) and serve the full-length MP4.  Encoding is deferred to the
    save action so the optimize finishes fast and only the looping preview is built
    up front; the result is cached so a re-download / Save run reuses it."""
    global mp4_path
    if not mp4_path or not os.path.exists(mp4_path):
        if vam.sino is None:
            return jsonify({"status": "error", "message": "No sinogram available — run Optimize first"}), 400
        try:
            out = os.path.join(tempfile.mkdtemp(), "Tomo_Output.mp4")
            vam.saveVid(out_path=out)
            mp4_path = out
        except Exception as e:
            traceback.print_exc()
            return jsonify({"status": "error", "message": str(e)}), 500
    return send_file(mp4_path, mimetype="video/mp4", as_attachment=True, download_name="Tomo_Output.mp4")

from werkzeug.exceptions import HTTPException
import traceback

@app.errorhandler(Exception)
def handle_exception(e):
    """Force all unhandled exceptions to return JSON instead of Flask's default HTML."""
    code = 500
    if isinstance(e, HTTPException):
        code = e.code
    
    tb = traceback.format_exc()
    return jsonify({
        "status": "error", 
        "message": f"Fatal Crash: {str(e)} | {tb}"
    }), code

if __name__ == "__main__":
    # Port is env-driven so a dev build (:5274) never collides with an installed
    # Tomo (:5174) on the same machine.  Electron passes TOMO_BACKEND_PORT.
    app.run(host="localhost", port=int(os.environ.get("TOMO_BACKEND_PORT", "5174")), debug=False, threaded=True)