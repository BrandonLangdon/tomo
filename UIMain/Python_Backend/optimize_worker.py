"""Standalone optimize worker — runs the VAM optimize in its OWN process so it can be
cancelled by killing the process (the in-thread optimize can't be interrupted mid-iteration,
so the old cancel only fired at the next iteration boundary).

Usage:  python optimize_worker.py <config_json>
The json holds {t_geo_npy, workdir, attrs}.  Reconstructs a VAM, runs slice(), then:
  - pickles sino + recon into <workdir>/sino.pkl, recon.pkl
  - writes <workdir>/result.json (dose_metrics, loss_history, sino_is_rebinned, optimize_s)
  - streams "@@P\\t<frac>\\t<stage>" progress lines to stdout
  - prints WORKER_DONE on success
Verbose-figure frames go to the shared tempdir/tomo_verbose (the parent serves them).
"""
import sys
import os
import json
import pickle

# Self-sufficient import path (repo root for vamtoolbox, this dir for VAM_Ob).
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import pyglet
pyglet.options['shadow_window'] = False
import matplotlib
matplotlib.use("Agg")          # headless — verbose EvolvingPlot renders to PNG, no window
try:
    import matplotlib.backend_bases as _mbb
    _mbb.FigureManagerBase.full_screen_toggle = lambda self: None
except Exception:
    pass
import numpy as np


def main():
    with open(sys.argv[1]) as f:
        cfg = json.load(f)
    workdir = cfg["workdir"]

    import vamtoolbox
    from VAM_Ob import VAM

    vam = VAM()
    arr = np.load(cfg["t_geo_npy"])
    vam.t_geo = vamtoolbox.geometry.TargetGeometry(target=arr)
    try:
        vam.t_geo.zero_dose = None
    except Exception:
        pass
    for k, v in cfg["attrs"].items():
        setattr(vam, k, v)

    # If a vial-correction rebin will run after the optimize, cap the optimize bar at 95%
    # so it holds at 95% through the rebin, then jumps to 100% when fully done.
    cap = 0.95 if getattr(vam, "vial_correction", False) else 1.0

    def cb(stage, frac, msg=""):
        try:
            if stage == "optimize":      # drives the progress bar (i/n), scaled to leave rebin headroom
                pct = int(round(float(frac) * 100))
                print("@@P\t%s\t%s" % (float(frac) * cap, (msg or "Optimizing… %d%%" % pct)), flush=True)
            else:                        # rebin / other stages just relabel (hold the bar)
                print("@@S\t%s" % (msg or stage), flush=True)
        except Exception:
            pass

    vam.slice(progress_cb=cb)

    # Hand the results back: the Sinogram/Reconstruction objects pickle cleanly and the
    # parent needs the real objects (sino flows into the video/preview encoder).
    with open(os.path.join(workdir, "sino.pkl"), "wb") as f:
        pickle.dump(vam.sino, f)
    with open(os.path.join(workdir, "recon.pkl"), "wb") as f:
        pickle.dump(vam.recon, f)

    try:
        loss = list(getattr(getattr(vam, "_pipe", None), "loss_history", []) or [])
    except Exception:
        loss = []
    try:
        opt_s = float((getattr(vam._pipe, "timing", {}) or {}).get("optimize", 0.0))
    except Exception:
        opt_s = None
    with open(os.path.join(workdir, "result.json"), "w") as f:
        json.dump({
            "dose_metrics": getattr(vam, "dose_metrics", None),
            "loss_history": loss,
            "sino_is_rebinned": bool(getattr(vam, "_sino_is_rebinned", False)),
            "optimize_s": opt_s,
        }, f)

    # Shut the joblib/loky pool (the rebin / CPU-projector workers) down BEFORE we exit,
    # so no worker processes linger after this short-lived process is done.
    try:
        from joblib.externals.loky import get_reusable_executor
        get_reusable_executor().shutdown(wait=True, kill_workers=True)
    except Exception:
        pass
    print("WORKER_DONE", flush=True)


if __name__ == "__main__":
    main()
