# Benchmarks

## `optimize_bench.py` — optimize speed (Metal GPU vs CPU)

Times the **same `VAMPipeline`** the Tomo backend uses (`VAM_Ob.slice`) on a
synthetic target, across a sweep of grid sizes / methods / iteration counts, on
both the **Metal** GPU projector and the **pure-CPU (numpy/skimage)** projector.

CPU is forced by patching `hardware._metal_ok()` → `False` — the exact lever
`projectorconstructor` checks when choosing a backend. Everything else (target,
config, angles) is identical, so the two timings are directly comparable. CUDA is
never used (`use_cuda=False`); on Apple Silicon "GPU" therefore means Metal.

```bash
# from the tomo repo root, using the backend venv (has our Metal vamtoolbox)
VAMTOOLBOX="$HOME/Developer/VAMToolbox" .venv/bin/python benchmarks/optimize_bench.py

# custom sweep
.venv/bin/python benchmarks/optimize_bench.py --sizes 65 97 129 --iters 15 --angles 360
.venv/bin/python benchmarks/optimize_bench.py --methods OSMO BCLP --backends metal
.venv/bin/python benchmarks/optimize_bench.py --absorption          # heavier path
```

Options: `--sizes` (cube edge in voxels, compute ~ N³·angles), `--methods`,
`--iters`, `--angles`, `--absorption`, `--backends metal|cpu`, `--repeats`
(min kept), `--no-warmup`, `--out <csv>`.

Results (per-run timing + final loss) print as a table and are written to
`benchmarks/results/optimize_bench_<timestamp>.csv` (git-ignored). A per-combo
`Metal speed-up` is shown whenever both backends run. The **final loss is identical
across backends** — the Metal projector is a drop-in that changes speed, not the
result — so a divergence there flags a correctness regression.

### Reference numbers (Apple M-series, 8-core, OSMO, 180 angles, 10 iter)

| grid (N³) | voxels | Metal | CPU | speed-up |
|-----------|--------|-------|-----|----------|
| 65³       | 0.27 M | 0.29 s | 4.76 s | 16.3× |
| 97³       | 0.91 M | 1.11 s | 12.62 s | 11.4× |

(Indicative only — regenerate on your own hardware. The CPU path uses skimage's
radon since `astra` isn't available on macOS.)
