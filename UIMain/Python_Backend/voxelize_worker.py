"""Standalone voxelize worker — runs in its OWN process so a long voxelization can
be cancelled by killing the process (the GPU voxelize can't be interrupted in-thread).

Usage:  python voxelize_worker.py <stl_path> <pitch_mm> <out_npy>
Writes the placed, origin-centred uint8 voxel grid to <out_npy>.
"""
import sys
import os
# Make the worker self-sufficient: put the repo root on the path so `vamtoolbox`
# imports even when launched without an inherited PYTHONPATH.
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
import pyglet
pyglet.options['shadow_window'] = False     # match the backend's GL setup
import numpy as np


def _embed_offset(arr, off_mm, pitch):
    """Square, origin-centred grid with the model at its placed XY offset."""
    a0, a1, nz = arr.shape
    ov0 = int(round(off_mm[0] / pitch))
    ov1 = int(round(off_mm[1] / pitch))
    m = max(a0 // 2 + abs(ov0), a1 // 2 + abs(ov1)) + 1
    side = 2 * m + 1
    out = np.zeros((side, side, nz), dtype=np.uint8)
    s0 = m + ov0 - a0 // 2
    s1 = m + ov1 - a1 // 2
    out[s0:s0 + a0, s1:s1 + a1, :] = arr
    return out


def main():
    stl_path = sys.argv[1]
    pitch = float(sys.argv[2])
    out_path = sys.argv[3]

    import trimesh
    import vamtoolbox

    m = trimesh.load(stl_path, force="mesh")
    ext = np.asarray(m.extents, dtype=float)
    z_extent = float(ext[2]) if ext.size > 2 else max(pitch, 1.0)
    n_layers = max(1, int(round(z_extent / pitch)))      # isotropic voxels
    b = m.bounds
    off_mm = (b[0][:2] + b[1][:2]) * 0.5                 # placed XY offset from origin

    arr, _, _ = vamtoolbox.voxelize.voxelizeTargetOpenGL(stl_path, n_layers)  # (nY, nX, nZ)
    arr = (np.asarray(arr) > 0).astype("uint8")
    arr = arr[:, :, ::-1]                                # undo OpenGL Z-inversion
    arr = np.ascontiguousarray(arr.transpose(1, 0, 2))   # -> (nX, nY, nZ)
    out = _embed_offset(arr, off_mm, pitch)
    np.save(out_path, out)
    print(f"WORKER_DONE shape={out.shape}", flush=True)


if __name__ == "__main__":
    main()
