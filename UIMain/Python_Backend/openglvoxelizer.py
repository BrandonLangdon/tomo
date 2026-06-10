"""
openglvoxelizer.py  —  drop-in replacement (no OpenGL / pyglet required)

Keeps the same public interface as the original:
    vox = Voxelizer()
    vox.addMeshes({'model.stl': 'print_body'})
    array = vox.voxelize('print_body', xy_voxel_size=1.0, voxel_value=1)
"""

import numpy as np
import trimesh


class Voxelizer:
    def __init__(self):
        self.meshes = {}          # body_name -> trimesh.Trimesh

    def addMeshes(self, stl_struct: dict) -> None:
        for filepath, body_name in stl_struct.items():
            mesh = trimesh.load_mesh(filepath)
            if isinstance(mesh, trimesh.Scene):
                mesh = trimesh.util.concatenate([g for g in mesh.geometry.values()])
            self.meshes[body_name] = mesh

    def voxelize(
        self,
        body_name: str,
        xy_voxel_size: float,
        voxel_value: float = 1,
        voxel_dtype: str = 'uint8',
        z_voxel_size: float = None,
        square_xy: bool = True,
        center_model: bool = True,
        store_voxel_array: bool = False,
        slice_save_path: str = None,
    ) -> np.ndarray:
        """
        Voxelize a single unified mesh and return a numpy array.
        """
        if z_voxel_size is None:
            z_voxel_size = xy_voxel_size

        # Grab our pre-combined target mesh
        mesh = self.meshes[body_name].copy()

        # Use the smaller of the two voxel sizes as the isotropic pitch so
        # neither axis is coarser than requested.  The mesh is already in mm and
        # the voxel sizes are in mm — do NOT normalize/scale.
        pitch = min(xy_voxel_size, z_voxel_size)

        # The default trimesh 'subdivide' voxelizer caps subdivision at max_iter=10,
        # which raises "max_iter exceeded!" when the pitch is fine relative to the
        # mesh's triangle edges.  Give it enough iterations to actually reach the
        # requested pitch (clamped so a runaway request can't hang forever).
        try:
            _max_edge = float(np.max(mesh.extents))
            _miter = int(np.ceil(np.log2(max(_max_edge / pitch, 2.0)))) + 4
            _miter = int(min(40, max(10, _miter)))
        except Exception:
            _miter = 20

        if center_model:
            # Centre the model in its own grid (loses any placed position).
            bounds = mesh.bounds
            centre = (bounds[0] + bounds[1]) * 0.5
            mesh.apply_translation(-centre)
            array = np.asarray(mesh.voxelized(pitch=pitch, max_iter=_miter).fill().matrix)
            if square_xy:
                ny, nx, nz = array.shape
                side = max(ny, nx)
                padded = np.zeros((side, side, nz), dtype=bool)
                padded[(side - ny) // 2:(side - ny) // 2 + ny,
                       (side - nx) // 2:(side - nx) // 2 + nx, :] = array
                array = padded
        else:
            # Preserve the model's XY position relative to the WORLD ORIGIN
            # (the vial centre): build a grid centred on the origin with the
            # model sitting at its placed offset.  Z stays tight to the part.
            vg = mesh.voxelized(pitch=pitch, max_iter=_miter).fill()
            mat = np.asarray(vg.matrix)
            origin_mm = np.asarray(vg.transform)[:3, 3]   # mm of voxel [0,0,0]
            nx, ny, nz = mat.shape

            def _half(n, omm):
                lo, hi = omm, omm + (n - 1) * pitch
                return int(np.ceil(max(abs(lo), abs(hi)) / pitch)) + 1

            # Square XY grid (downstream assumes nX == nY), centred on the origin
            # (vial axis) with the model sitting at its placed offset.
            m = max(_half(nx, origin_mm[0]), _half(ny, origin_mm[1]))
            side = 2 * m + 1
            stx = m + int(round(origin_mm[0] / pitch))
            sty = m + int(round(origin_mm[1] / pitch))
            array = np.zeros((side, side, nz), dtype=bool)
            array[stx:stx + nx, sty:sty + ny, :] = mat

        out = np.zeros(array.shape, dtype=voxel_dtype)
        out[array] = voxel_value
        return out