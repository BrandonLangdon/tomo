#!/usr/bin/env python3
"""Optimize-speed benchmark for VAMToolbox (Metal GPU vs pure-CPU), as driven by Tomo.

Runs the SAME ``VAMPipeline`` the Tomo backend uses (``VAM_Ob.slice``) on a
synthetic target across a sweep of grid sizes / methods / iteration counts, timing
each run on the Metal GPU backend and on the pure-CPU (numpy) backend, then writes
a CSV and prints a summary table with the Metal speed-up.

The CPU path is forced by patching ``hardware._metal_ok()`` to return ``False`` —
the very same lever ``projectorconstructor`` checks when choosing between the Metal
projector and the numpy one. Everything else (target, config, angles) is identical,
so the two timings are directly comparable. CUDA is never used (``use_cuda=False``);
on Apple Silicon "GPU" therefore means Metal.

Usage
-----
  python benchmarks/optimize_bench.py                     # default sweep
  python benchmarks/optimize_bench.py --sizes 65 97 129   # cube edge, in voxels
  python benchmarks/optimize_bench.py --iters 20 --methods OSMO BCLP
  python benchmarks/optimize_bench.py --backends metal    # skip the slow CPU runs
  python benchmarks/optimize_bench.py --angles 180 --absorption

Notes
-----
* A short warm-up run per backend (excluded from timings) absorbs the one-time
  Metal shader-compile / numpy import cost so the reported numbers reflect steady
  state. Disable with ``--no-warmup``.
* Grid compute scales ~ N^3 * n_angles; keep ``--sizes`` modest for the CPU path.
"""
from __future__ import annotations

import argparse
import csv
import os
import sys
import time

import numpy as np


def _add_vamtoolbox_to_path():
    """Prefer the sibling VAMToolbox checkout so the benchmark measures the Metal
    fork, not whatever `pip` happens to have installed."""
    here = os.path.dirname(os.path.abspath(__file__))
    for cand in (os.environ.get("VAMTOOLBOX"),
                 os.path.join(here, "..", "..", "VAMToolbox"),
                 os.path.expanduser("~/Developer/VAMToolbox")):
        if cand and os.path.isdir(os.path.join(cand, "vamtoolbox")):
            sys.path.insert(0, os.path.abspath(cand))
            return os.path.abspath(cand)
    return None


_VAMTB_DIR = _add_vamtoolbox_to_path()

import vamtoolbox                                     # noqa: E402
from vamtoolbox.util import hardware                  # noqa: E402
from vamtoolbox.pipeline import PrintConfig, VAMPipeline  # noqa: E402

_REAL_METAL_OK = hardware._metal_ok


def synthetic_target(n: int) -> np.ndarray:
    """A representative solid: a centred sphere (r=0.4N) with a coaxial hole, so the
    optimizer has both an interior to fill and a void to keep dark — closer to a real
    part than a plain ball. Returned as a float (n, n, n) grid in [0, 1]."""
    ax = (np.arange(n) - (n - 1) / 2.0) / (n / 2.0)      # [-1, 1] per axis
    X, Y, Z = np.meshgrid(ax, ax, ax, indexing="ij")
    r = np.sqrt(X**2 + Y**2 + Z**2)
    solid = r <= 0.8                                     # sphere radius 0.8 of half-extent
    hole = (np.sqrt(X**2 + Y**2) <= 0.2)                 # axial cylindrical void
    return (solid & ~hole).astype(np.float32)


def _force_backend(backend: str):
    """Patch hardware._metal_ok so projectorconstructor selects the desired path."""
    if backend == "cpu":
        hardware._metal_ok = lambda: False
    else:
        hardware._metal_ok = _REAL_METAL_OK


def run_one(target: np.ndarray, method: str, iters: int, angles: int,
            absorption: bool, backend: str) -> dict:
    """Run a single optimize and return timing + final loss. Backend must already be
    forced via _force_backend()."""
    n = target.shape[0]
    tgeo = vamtoolbox.geometry.TargetGeometry(target=target)
    tgeo.zero_dose = None
    cfg = PrintConfig(
        part_height_mm=float(n),         # 1 mm/voxel — physical scale is irrelevant to compute
        voxel_pitch_um=1000.0,
        resolution_scale=1.0,
        n_angles=int(angles),
        method=method,
        n_iterations=int(iters),
        absorption=bool(absorption),
        diffusion=False,
        use_cuda=False,                  # never CUDA here; GPU == Metal
        slab="off",
        verbose=False,
    )
    # Give absorption a vial big enough for the grid so it can't hard-crash.
    if absorption:
        cfg.vial_radius_mm = n * 1.5
    cfg.validate()

    pipe = VAMPipeline(cfg)
    pipe.target = tgeo                    # reuse our target (same as VAM_Ob.slice)

    t0 = time.perf_counter()
    pipe.optimize()
    wall = time.perf_counter() - t0

    opt_s = float((getattr(pipe, "timing", {}) or {}).get("optimize", wall))
    loss = getattr(pipe, "final_loss", None)
    return {"wall_s": wall, "opt_s": opt_s,
            "final_loss": (float(loss) if loss is not None else None)}


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--sizes", type=int, nargs="+", default=[65, 97, 129],
                    help="cube edge length(s) in voxels (compute ~ N^3)")
    ap.add_argument("--methods", nargs="+", default=["OSMO"],
                    help="optimizer method(s): OSMO BCLP ...")
    ap.add_argument("--iters", type=int, default=15, help="optimizer iterations")
    ap.add_argument("--angles", type=int, default=360, help="number of projection angles")
    ap.add_argument("--absorption", action="store_true",
                    help="enable Beer-Lambert absorption (heavier path)")
    ap.add_argument("--backends", nargs="+", default=["metal", "cpu"],
                    choices=["metal", "cpu"], help="which backends to time")
    ap.add_argument("--repeats", type=int, default=1, help="timed repeats per combo (min kept)")
    ap.add_argument("--no-warmup", dest="warmup", action="store_false",
                    help="skip the excluded warm-up run per backend")
    ap.add_argument("--out", default=None, help="CSV output path (default: benchmarks/results/optimize_bench_<ts>.csv)")
    args = ap.parse_args()

    metal_here = _REAL_METAL_OK()
    if "metal" in args.backends and not metal_here:
        print("[bench] no Metal device detected — dropping the 'metal' backend.")
        args.backends = [b for b in args.backends if b != "metal"] or ["cpu"]

    info = hardware.detect_system()
    print("=" * 74)
    print("VAMToolbox optimize benchmark")
    print(f"  vamtoolbox : {os.path.dirname(vamtoolbox.__file__)}")
    print(f"  metal      : {metal_here}   cuda: {info.get('cuda')}   "
          f"cpu_cores: {info.get('cpu_logical')}   ram: {info.get('ram_total_gb')} GB")
    print(f"  sweep      : sizes={args.sizes} methods={args.methods} "
          f"iters={args.iters} angles={args.angles} absorption={args.absorption}")
    print(f"  backends   : {args.backends}  (repeats={args.repeats}, warmup={args.warmup})")
    print("=" * 74)

    # Warm up each backend once on the smallest grid (compile shaders / import), excluded.
    if args.warmup:
        wn = min(args.sizes)
        wt = synthetic_target(wn)
        for backend in args.backends:
            _force_backend(backend)
            print(f"[bench] warm-up {backend} on N={wn} ...", flush=True)
            try:
                run_one(wt, args.methods[0], min(args.iters, 3), args.angles, args.absorption, backend)
            except Exception as e:
                print(f"[bench] warm-up {backend} failed: {type(e).__name__}: {e}")

    rows = []
    for method in args.methods:
        for n in args.sizes:
            tgt = synthetic_target(n)
            voxels = int(tgt.size)
            per_backend = {}
            for backend in args.backends:
                _force_backend(backend)
                best = None
                for rep in range(args.repeats):
                    try:
                        r = run_one(tgt, method, args.iters, args.angles, args.absorption, backend)
                    except Exception as e:
                        print(f"[bench] {method} N={n} {backend} FAILED: {type(e).__name__}: {e}")
                        best = None
                        break
                    if best is None or r["opt_s"] < best["opt_s"]:
                        best = r
                if best is None:
                    continue
                per_backend[backend] = best
                rows.append({
                    "method": method, "N": n, "voxels": voxels, "iters": args.iters,
                    "angles": args.angles, "absorption": int(args.absorption),
                    "backend": backend, "wall_s": round(best["wall_s"], 3),
                    "optimize_s": round(best["opt_s"], 3),
                    "final_loss": (round(best["final_loss"], 6) if best["final_loss"] is not None else ""),
                })
                print(f"  {method:5s} N={n:4d} ({voxels/1e6:5.2f} Mvox) {backend:5s}  "
                      f"optimize={best['opt_s']:8.2f}s  wall={best['wall_s']:8.2f}s  "
                      f"loss={best['final_loss']}", flush=True)
            if "metal" in per_backend and "cpu" in per_backend:
                sp = per_backend["cpu"]["opt_s"] / max(per_backend["metal"]["opt_s"], 1e-9)
                print(f"        -> Metal speed-up: {sp:5.1f}x", flush=True)

    hardware._metal_ok = _REAL_METAL_OK   # restore

    # --- write CSV -----------------------------------------------------------
    out = args.out
    if out is None:
        rdir = os.path.join(os.path.dirname(os.path.abspath(__file__)), "results")
        os.makedirs(rdir, exist_ok=True)
        stamp = time.strftime("%Y%m%d-%H%M%S")
        out = os.path.join(rdir, f"optimize_bench_{stamp}.csv")
    if rows:
        with open(out, "w", newline="") as f:
            w = csv.DictWriter(f, fieldnames=list(rows[0].keys()))
            w.writeheader()
            w.writerows(rows)
        print("=" * 74)
        print(f"[bench] wrote {len(rows)} rows -> {out}")
    else:
        print("[bench] no successful runs — nothing written.")


if __name__ == "__main__":
    main()
