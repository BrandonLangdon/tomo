# -*- mode: python ; coding: utf-8 -*-
# =============================================================================
#  VVAM.spec  —  PyInstaller spec  (miniforge / conda, Windows, Python 3.9)
#
#  BUILD COMMAND (always run from inside the activated conda env):
#      conda activate <your_vvam_env>
#      pyinstaller VVAM.spec
#
#  Output: dist/VVAM/VVAM.exe  (one-folder mode — see note below)
#
#  WHY ONE-FOLDER NOT ONE-FILE
#  astra-toolbox + CUDA DLLs are large; one-file unpacks them on every
#  launch (slow + AV false-positives).  One-folder avoids both.
#
#  FRONTEND
#  Build the React/Vite front-end first:
#      cd frontend && npm run build
#  The dist/ output must be at  frontend/dist/  relative to server.py.
# =============================================================================

import importlib.util
import os
import sys
from pathlib import Path

# ---------------------------------------------------------------------------
#  DECLARE ALL THREE LISTS FIRST — collect_all() returns pieces of all three
#  so they must exist before any collection code runs.
# ---------------------------------------------------------------------------
datas         = []
binaries      = []
hiddenimports = []

# ---------------------------------------------------------------------------
#  Environment paths
# ---------------------------------------------------------------------------
CONDA_PREFIX  = Path(os.environ.get("CONDA_PREFIX", sys.prefix))
CONDA_LIB_BIN = CONDA_PREFIX / "Library" / "bin"   # Windows DLL location
# Locate site-packages (works for conda on Windows and Linux/macOS)
_sp_candidates = [
    Path(sys.prefix) / "Lib" / "site-packages",
    Path(sys.prefix) / "lib" / f"python{sys.version_info.major}.{sys.version_info.minor}" / "site-packages",
]
SITE_PACKAGES = next((p for p in _sp_candidates if p.exists()), _sp_candidates[0])

# ---------------------------------------------------------------------------
#  conda_dlls: grab DLLs/SOs from conda's Library/bin by glob pattern.
# ---------------------------------------------------------------------------
def conda_dlls(*globs):
    result = []
    search = CONDA_LIB_BIN if sys.platform == "win32" else CONDA_PREFIX / "lib"
    for pattern in globs:
        for p in search.glob(pattern):
            result.append((str(p), "."))
    return result

# ---------------------------------------------------------------------------
#  find_pkg: locate a package using the live import system.
#  This works even when dist-info metadata is absent (common in conda envs).
#  collect_data_files / collect_dynamic_libs / collect_all all rely on
#  importlib.metadata dist-info and silently skip packages that lack it —
#  which is why you see "skipping ... as it is not a package" warnings.
# ---------------------------------------------------------------------------
def find_pkg(name):
    try:
        spec = importlib.util.find_spec(name)
        if spec is None:
            return None
        locs = list(spec.submodule_search_locations or [])
        if locs:
            return Path(locs[0])
        if spec.origin and spec.origin != "frozen":
            return Path(spec.origin)
    except Exception:
        pass
    return None

# ---------------------------------------------------------------------------
#  manual_collect: walk a package directory to build datas + hiddenimports.
#  Use this for any package where collect_* emits "not a package" warnings.
# ---------------------------------------------------------------------------
def manual_collect(import_name, dest_override=None):
    pkg = find_pkg(import_name)
    if pkg is None:
        print(f"[VVAM.spec] WARNING: cannot locate '{import_name}', skipping")
        return [], []

    dest = dest_override or import_name.replace(".", os.sep)

    if pkg.is_file():
        # Single compiled extension (.pyd / .so) with no sub-modules
        return [(str(pkg), str(Path(dest).parent or "."))], [import_name]

    # Directory package — walk for .py and .pyd/.so to build module names
    _hidden = []
    for f in sorted(pkg.rglob("*")):
        if f.suffix not in (".py", ".pyd", ".so"):
            continue
        try:
            rel  = f.relative_to(SITE_PACKAGES)
            mod  = ".".join(rel.with_suffix("").parts)
            if mod.endswith(".__init__"):
                mod = mod[:-9]
            if mod and "__pycache__" not in mod:
                _hidden.append(mod)
        except ValueError:
            pass

    return [(str(pkg), dest)], _hidden

# ===========================================================================
#  DATA FILES
# ===========================================================================

# Standard packages with proper dist-info — collect_data_files works fine
from PyInstaller.utils.hooks import (
    collect_data_files, collect_dynamic_libs, collect_submodules
)

datas += collect_data_files("vamtoolbox", includes=["**/*"])
datas += collect_data_files("trimesh")
datas += collect_data_files("PIL")
datas += collect_data_files("flask")
datas += collect_data_files("werkzeug")
datas += collect_data_files("jinja2")
datas += collect_data_files("flask_cors")
datas += collect_data_files("scipy", includes=["**/*.pyi", "**/*.json"])

# Project source files
datas += [
    ("VAM_Ob.py",          "."),
    ("openglvoxelizer.py", "."),
]

# React/Vite frontend build
_fe = Path("frontend/dist")
if _fe.exists():
    datas += [(str(_fe), "frontend/dist")]
else:
    print("\n[VVAM.spec] WARNING: frontend/dist not found — run 'npm run build' first\n")

# jaraco.*  —  NOT installed as standalone packages in this conda env.
# pkg_resources vendors them internally at pkg_resources/_vendor/jaraco/.
# The runtime hook aliases them to jaraco.* before pkg_resources loads.
# We must bundle the vendored copies; collect_* can't find them because
# they have no top-level dist-info — use find_pkg on the vendor path.
_jaraco_found = False
for _vparent in ("pkg_resources._vendor", "setuptools._vendor"):
    _jaraco_loc = find_pkg(f"{_vparent}.jaraco")
    if _jaraco_loc is not None:
        print(f"[VVAM.spec] jaraco found vendored under {_vparent}: {_jaraco_loc}")
        _d, _h = manual_collect(f"{_vparent}.jaraco")
        datas         += _d
        hiddenimports += _h
        # Explicit hidden imports so PyInstaller bundles each sub-module
        for _sub in ("text", "functools", "context", "classes"):
            hiddenimports.append(f"{_vparent}.jaraco.{_sub}")
        _jaraco_found = True
        break

if not _jaraco_found:
    print(
        "\n[VVAM.spec] ERROR: Cannot locate jaraco under pkg_resources._vendor "
        "or setuptools._vendor.\nRun this in your conda env to diagnose:\n"
        "  python -c \"import pkg_resources._vendor.jaraco.text\"\n"
    )

# pyfftw — conda install lacks dist-info that collect_* needs
_d, _h = manual_collect("pyfftw")
datas         += _d
hiddenimports += _h

# cv2 (opencv) — same issue
_d, _h = manual_collect("cv2")
datas         += _d
hiddenimports += _h

# Tkinter tcl/tk support data (conda)
for _tdir, _tdest in [
    (CONDA_PREFIX / "Library" / "lib" / "tcl8.6", "tcl8.6"),
    (CONDA_PREFIX / "Library" / "lib" / "tk8.6",  "tk8.6"),
]:
    if _tdir.exists():
        datas += [(str(_tdir), _tdest)]

# ===========================================================================
#  BINARIES
# ===========================================================================

binaries += collect_dynamic_libs("numpy")
binaries += collect_dynamic_libs("scipy")
binaries += collect_dynamic_libs("PIL")
binaries += collect_dynamic_libs("astra")

# CUDA runtime (only present when GPU is available; harmless to include either way)
binaries += conda_dlls(
    "cudart64_*.dll", "cusparse64_*.dll",
    "cufft64_*.dll",  "nvrtc64_*.dll",
    "vcomp*.dll",
    # opencv_videoio_ffmpeg is the FFmpeg back-end used for *reading* video files.
    # For *writing* we now use the mp4v codec which is built into libopencv_videoio
    # and needs no external DLL, so openh264 / ffmpeg write-side DLLs are not
    # required.  We still bundle the videoio DLL so that future read operations work.
    "opencv_videoio_ffmpeg*.dll",
)

# FFTW3 DLLs for pyfftw (live in conda's Library/bin, not inside the package)
binaries += conda_dlls("libfftw3*.dll", "fftw3*.dll")

# rtree / libspatialindex (also in conda's Library/bin)
binaries += conda_dlls("spatialindex*.dll", "libspatialindex*.so*")

# ===========================================================================
#  HIDDEN IMPORTS
# ===========================================================================

hiddenimports += collect_submodules("vamtoolbox")
hiddenimports += collect_submodules("astra")
hiddenimports += collect_submodules("scipy")
hiddenimports += collect_submodules("trimesh")
hiddenimports += collect_submodules("PIL")
hiddenimports += collect_submodules("pkg_resources")

hiddenimports += [
    "matplotlib",
    # scipy Cython extensions not found by static analysis
    "scipy.special._ufuncs_cxx",
    "scipy.linalg.cython_blas",
    "scipy.linalg.cython_lapack",
    "scipy._lib.messagestream",
    "scipy.sparse.csgraph._validation",
    # numpy
    "numpy.core._dtype_ctypes",
    "numpy.core._multiarray_umath",
    # trimesh loaders (invoked by name at runtime)
    "trimesh.exchange.load",
    "trimesh.exchange.stl",
    "trimesh.exchange.export",
    "trimesh.voxel.ops",
    "trimesh.voxel.creation",
    # Flask
    "flask_cors",
    "werkzeug.serving",
    "werkzeug.debug",
    "jinja2.ext",
    # cv2 inner module name (resolved dynamically)
    "cv2",
    # tkinter file dialog
    "tkinter",
    "tkinter.filedialog",
    "_tkinter",
    # importlib shims
    "importlib.metadata",
    "importlib.resources",
]

# ===========================================================================
#  ANALYSIS
# ===========================================================================
block_cipher = None

a = Analysis(
    ["server.py"],
    pathex=["."],
    binaries=binaries,
    datas=datas,
    hiddenimports=hiddenimports,
    hookspath=[],
    runtime_hooks=["rthook_jaraco.py"],
    excludes=[
        # Keep setuptools OUT of excludes — pkg_resources lives inside it
        # and the pyi_rth_pkgres runtime hook needs it at startup.
        "PyQt5", "PyQt6", "PySide2", "PySide6",
        "wx", "IPython", "notebook",
        "pytest", "_pytest",
        "sphinx", "docutils",
    ],
    win_no_prefer_redirects=False,
    win_private_assemblies=False,
    cipher=block_cipher,
    noarchive=False,
)

# De-duplicate binaries (conda sometimes contributes the same DLL twice)
_seen = set()
_deduped = []
for _item in a.binaries:
    _key = _item[0].lower()
    if _key not in _seen:
        _seen.add(_key)
        _deduped.append(_item)
a.binaries = TOC(_deduped)

pyz = PYZ(a.pure, a.zipped_data, cipher=block_cipher)

# ===========================================================================
#  EXE + COLLECT
# ===========================================================================
exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name="VVAM",
    debug=False,       # flip to True to get verbose import log on crash
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,         # UPX corrupts numpy/scipy DLLs — always leave off
    console=True,      # Flask server prints to console
    disable_windowed_traceback=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
    # icon="assets/vvam.ico",
)

coll = COLLECT(
    exe,
    a.binaries,
    a.zipfiles,
    a.datas,
    strip=False,
    upx=False,
    upx_exclude=[],
    name="VVAM",
)

# ===========================================================================
#  TROUBLESHOOTING
#
#  "DLL load failed" at runtime
#      Set debug=True above, rerun, search the output for the DLL name,
#      then add it to the appropriate conda_dlls() call.
#
#  "No module named X" at runtime
#      Add X to hiddenimports, or manual_collect(X) if collect_* warns
#      "not a package" for it during the build.
#
#  scipy LAPACK/BLAS crash
#      binaries += conda_dlls("libblas*.dll", "liblapack*.dll", "mkl_*.dll")
#
#  tkinter dialog crash
#      binaries += conda_dlls("tcl86t.dll", "tk86t.dll")
#
#  astra CUDA unavailable (no GPU)
#      Non-fatal — astra falls back to CPU automatically.
# ===========================================================================
