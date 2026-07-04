import os
import tempfile
import trimesh
import openglvoxelizer
import vamtoolbox as vamtb
import numpy as np


class VAM:
    """
    Voxelization and optimization wrapper.
    No Qt dependency — used directly by Flask.
    """

    def __init__(self, file_path=None):
        self.path = file_path
        self.t_geo = None
        self.sino  = None

        self.cuda   = False
        self.use_metal = True   # Apple Metal GPU projector (auto on Apple Silicon); False -> CPU
        self.res    = 1.0
        self.n_iter = 5
        self.d_h    = 0.6
        self.d_l    = 0.5
        self.learning_rate = 0.005   # BCLP gradient step
        self.eps    = 0.1            # BCLP band tolerance ±eps
        self.weight = 1.0            # BCLP Lp weighting
        self.filt   = "hamming"

        # ---- feature toggles routed through vamtoolbox.pipeline (new) ----
        self.method        = "OSMO"     # "OSMO" | "BCLP"
        self.absorption    = False      # Beer-Lambert attenuation
        self.diffusion     = False      # light/heat diffusion blur (BCLP only)
        self.low_memory    = False      # buffer-reusing BCLP variant
        self.slab          = "auto"     # "auto" | "off" | "<int>"
        self.diffusion_coeff = 1e-4     # mm^2/s
        self.absorption_coeff = 0.33    # mu (cm^-1) at the write wavelength (from material)
        self.print_time_s    = 10.0
        self.rotation_deg_s  = 24.0
        self.vial_radius_mm  = 48.8     # inner radius of the resin vial
        self.resin_ri        = 1.51     # resin refractive index at write wl (from material)
        self.vial_correction = False    # if True: rebin the sinogram for vial-wall refraction
        self.throw_ratio     = float("inf")  # inf = telecentric/collimated; finite = diverging projector
        self.recon = None               # predicted dose reconstruction

        self.savePath = "Tomo"
        self.rot_vel  = 30
        # Projector in PORTRAIT (long 1920 axis vertical = vial HEIGHT) — VAM vials are
        # taller than wide, so the height needs the high-res axis.  proj_width is the
        # DIAMETER-axis FOV; proj_width/proj_px_w = mm/px (0.1 here, keep them consistent).
        self.proj_width = 108.0   # diameter-axis field of view (mm)  -> 0.1 mm/px
        self.proj_px_w  = 1080    # diameter-axis pixels
        self.proj_px_h  = 1920    # height-axis pixels  (1920*0.1 = 192 mm tall printable)
        self.n_loops  = 1

        # Video output settings (overridden per request by the GUI)
        self.video_fps        = 54.0    # output frame rate
        self.video_rpm        = 1.0     # vial rotation speed
        self.video_duration_s = 300.0   # total print/video length (~5 min)
        self.video_codec      = "h265"  # "h265" | "mp4v"
        self.video_intensity  = 1.0     # projected-pattern brightness scale (GUI intensity control)
        self.video_v_offset_mm = 0.0    # vertical (Z) shift of the projection in the frame, mm (GUI control)

        # Full 4x4 column-major matrix from Three.js (flat list of 16 floats).
        # None = identity = use STL as-is.
        self.transform_matrix = None
        self.gl_scale: float  = 1.0   # mm per GL unit

    # ------------------------------------------------------------------
    #  Static helpers
    # ------------------------------------------------------------------

    @staticmethod
    def get_stl_bounds(path: str) -> dict:
        mesh = vamtb.threemf.load_mesh_any(path)   # .stl/.obj via trimesh, .3mf via lib3mf
        lo, hi = mesh.bounds
        return {
            "x_mm": float(hi[0] - lo[0]),
            "y_mm": float(hi[1] - lo[1]),
            "z_mm": float(hi[2] - lo[2]),
        }

    # ------------------------------------------------------------------
    #  Transform helpers
    # ------------------------------------------------------------------

    def _needs_transform(self) -> bool:
        if self.transform_matrix is None:
            return False
        M = np.array(self.transform_matrix, dtype=np.float64).reshape(4, 4).T
        return not np.allclose(M[:3, :3], np.eye(3), atol=1e-5)

    def _apply_transform_and_export(self) -> str:
        """
        Apply the rotation+scale portion of the Three.js matrix to the mesh
        and export to a temp STL. Returns the temp path (caller must delete).

        Three.js column-major layout: elements[col*4 + row]
        We transpose to get row-major for numpy.

        We take only the top-left 3x3 (rotation × scale) and ignore
        translation — the voxelizer centres the mesh automatically.
        The 3x3 is dimensionless (scale is a ratio, rotation is orthogonal)
        so it applies directly to the mm-space STL.
        """
        mesh = trimesh.load_mesh(self.path)

        M_col = np.array(self.transform_matrix, dtype=np.float64).reshape(4, 4)
        M_row = M_col.T   # now row-major: M_row[row, col]

        # Build a 4x4 that only carries rotation+scale, no translation
        M_apply = np.eye(4)
        M_apply[:3, :3] = M_row[:3, :3]

        mesh.apply_transform(M_apply)

        fd, tmp_path = tempfile.mkstemp(suffix=".stl")
        os.close(fd)
        mesh.export(tmp_path)
        return tmp_path

    # ------------------------------------------------------------------
    #  Core operations
    # ------------------------------------------------------------------

    def voxelize(self) -> None:
        import numpy as _np
        import trimesh as _trimesh
        tmp_path = None
        try:
            if self._needs_transform():
                tmp_path = self._apply_transform_and_export()
                stl_path = tmp_path
                print(f"[VAM] Voxelizing transformed mesh: {tmp_path}")
            else:
                stl_path = self.path
                print(f"[VAM] Voxelizing original mesh: {stl_path}")

            pitch = float(self.res)          # mm per voxel (NEVER coarsened)
            print_body = None

            # Preferred: vamtoolbox's GPU (pyglet/OpenGL) layer-slicer — the SAME
            # voxelizer used for the verified billion-voxel runs.  Fast and scales
            # to very large grids; we never reduce the requested pitch.
            try:
                _m = _trimesh.load(stl_path, force="mesh")
                ext = _np.asarray(_m.extents, dtype=float)
                z_extent = float(ext[2]) if ext.size > 2 else max(pitch, 1.0)
                n_layers = max(1, int(round(z_extent / pitch)))   # isotropic voxels
                b = _m.bounds
                off_mm = (b[0][:2] + b[1][:2]) * 0.5              # placed XY offset
                arr, _, _ = vamtb.voxelize.voxelizeTargetOpenGL(stl_path, n_layers)
                arr = (_np.asarray(arr) > 0).astype('uint8')      # (nY, nX, nZ)
                arr = arr[:, :, ::-1]                             # undo OpenGL Z-inversion (top was at z=0)
                arr = _np.ascontiguousarray(arr.transpose(1, 0, 2))  # -> (nX, nY, nZ)
                print_body = self._embed_offset(arr, off_mm, pitch)
                print(f"[VAM] GPU voxelize -> {arr.shape}, placed {print_body.shape}")
            except Exception as e:
                import traceback; traceback.print_exc()
                # The trimesh CPU fallback OOMs/hangs on huge grids, so only use it
                # for modest sizes; otherwise fail clearly (the GPU voxelizer needs
                # hardware OpenGL — the backend must run in an interactive session).
                try:
                    est_vox = (float(_np.max(ext)) / pitch) ** 3
                except Exception:
                    est_vox = 0.0
                if est_vox > 3e8:
                    raise RuntimeError(
                        f"GPU/OpenGL voxelizer unavailable ({type(e).__name__}: {e}) and the "
                        f"grid is too large (~{est_vox/1e9:.2f} B voxels) for the CPU fallback. "
                        f"The backend needs GPU/OpenGL access — launch it in an interactive "
                        f"desktop session (Electron does this automatically)."
                    ) from e
                print(f"[VAM] GPU voxelizer unavailable ({type(e).__name__}: {e}); trimesh fallback (small grid)")
                vox = openglvoxelizer.Voxelizer()
                vox.addMeshes({stl_path: 'print_body'})
                print_body = vox.voxelize(
                    'print_body', xy_voxel_size=pitch, z_voxel_size=pitch,
                    voxel_value=1, center_model=False,
                )

            self.t_geo = vamtb.geometry.TargetGeometry(target=print_body)
            self.t_geo.zero_dose = None
            print(f"[VAM] Voxelization complete: shape={self.t_geo.array.shape}")

        finally:
            if tmp_path and os.path.exists(tmp_path):
                os.remove(tmp_path)

    @staticmethod
    def _embed_offset(arr, off_mm, pitch):
        """Place a centred voxel grid (nX, nY, nZ) into a square, origin-centred
        grid with the model sitting at its placed XY offset, so off-centre
        placement relative to the vial axis is preserved."""
        import numpy as _np
        a0, a1, nz = arr.shape
        ov0 = int(round(off_mm[0] / pitch))   # X -> axis 0
        ov1 = int(round(off_mm[1] / pitch))   # Y -> axis 1
        m = max(a0 // 2 + abs(ov0), a1 // 2 + abs(ov1)) + 1
        side = 2 * m + 1
        out = _np.zeros((side, side, nz), dtype=arr.dtype)
        s0 = m + ov0 - a0 // 2
        s1 = m + ov1 - a1 // 2
        out[s0:s0 + a0, s1:s1 + a1, :] = arr
        return out

    def slice(self, progress_cb=None):
        """Optimize via vamtoolbox's high-level pipeline so OSMO/BCLP, absorption,
        diffusion, z-slabbing and low-memory BCLP are all available.  `progress_cb`
        (stage, fraction, message) is forwarded for per-iteration progress."""
        from vamtoolbox.pipeline import PrintConfig, VAMPipeline

        # Verbose BCLP figure frames (EvolvingPlot) go here; clear stale frames first.
        self._verbose_dir = None
        if self.verbose:
            try:
                import glob as _g, tempfile as _tf
                self._verbose_dir = os.path.join(_tf.gettempdir(), "tomo_verbose")
                os.makedirs(self._verbose_dir, exist_ok=True)
                for _f in _g.glob(os.path.join(self._verbose_dir, "*.png")):
                    try: os.remove(_f)
                    except Exception: pass
            except Exception:
                self._verbose_dir = None

        nz = int(self.t_geo.array.shape[2])
        # Absorption needs the vial (container) radius >= the grid's simulation
        # radius.  The voxel grid is sized to the part (origin-centred), so bump the
        # container to at least that to avoid a hard crash; the GUI's out-of-bounds
        # banner already warns when a part is genuinely wider than the vial.
        sim_r = (max(self.t_geo.array.shape[0], self.t_geo.array.shape[1]) / 2.0) * self.res
        if self.absorption and self.vial_radius_mm < sim_r * 1.02:
            print(f"[VAM] vial radius {self.vial_radius_mm:.1f} mm < grid radius {sim_r:.1f} mm — "
                  f"bumping to {sim_r * 1.02:.1f} mm so the absorption model is valid")
            self.vial_radius_mm = sim_r * 1.02
        cfg = PrintConfig(
            part_height_mm=nz * self.res,
            voxel_pitch_um=self.res * 1000.0,
            resolution_scale=1.0,
            vial_radius_mm=self.vial_radius_mm,
            resin_ri=self.resin_ri,                       # vial-correction refraction index
            proj_u_px=int(self.proj_px_w),                # projector diameter-axis pixels
            proj_v_px=int(self.proj_px_h),                # projector height-axis pixels
            mm_per_pix=self.proj_width / max(self.proj_px_w, 1),
            vial_print_height_mm=nz * self.res,
            throw_ratio=float(getattr(self, "throw_ratio", float("inf"))),  # inf = telecentric; finite = diverging projector
            method=self.method,
            n_iterations=int(self.n_iter),
            d_high=self.d_h,
            d_low=self.d_l,
            learning_rate=float(self.learning_rate),
            eps=float(self.eps),
            weight=float(self.weight),
            absorption=self.absorption,
            absorption_coeff_cm=(self.absorption_coeff if (self.absorption and self.absorption_coeff and self.absorption_coeff > 0) else None),
            diffusion=self.diffusion,
            diffusion_coeff=self.diffusion_coeff,
            print_time_s=self.print_time_s,
            rotation_deg_s=self.rotation_deg_s,
            use_cuda=bool(self.cuda),
            use_metal=bool(self.use_metal),
            slab=str(self.slab),
            low_memory=self.low_memory,
            verbose=bool(getattr(self, "verbose", False)),
            save_img_path=self._verbose_dir,
        )
        cfg.validate()
        # Leave at least one core free so the machine stays responsive during the
        # CPU optimize + rebin (don't peg every logical CPU).
        _nj = max(1, (os.cpu_count() or 4) - 1)
        try:
            import vamtoolbox.projector.Projector3DParallel as _p3d
            _p3d._N_JOBS = _nj
        except Exception:
            pass
        try:
            cfg.rebin_jobs = _nj          # pipeline applies this to geometry.REBIN_N_JOBS
        except Exception:
            pass
        print(f"[VAM] Slicing — {self.method} iter={self.n_iter} d_h={self.d_h} "
              f"d_l={self.d_l} cuda={self.cuda} abs={self.absorption} diff={self.diffusion} "
              f"workers={_nj}/{os.cpu_count()}")
        pipe = VAMPipeline(cfg, on_progress=progress_cb)
        pipe.target = self.t_geo                 # reuse the already-voxelized target
        pipe.optimize()
        self._pipe = pipe
        try:
            tdict = getattr(pipe, "timing", {}) or {}
            print(f"[VAM] Optimize took {tdict.get('optimize', 0.0):.1f}s "
                  f"({self.method} {self.n_iter} iter, grid {self.t_geo.array.shape}, "
                  f"{'GPU' if self.cuda else 'CPU'})")
        except Exception:
            pass
        self.sino = pipe.sinogram
        self._sino_is_rebinned = False     # drives _video_scale (rebinned == projector px → 1.0)
        # Vial-curvature correction: rebin the parallel sinogram for refraction at the
        # vial wall (telecentric — throw_ratio=inf in the config), then drive the
        # printer video from the rebinned sinogram instead of the parallel one.
        if self.vial_correction:
            try:
                _tc = "telecentric" if self.throw_ratio == float("inf") else f"throw={self.throw_ratio:.2f}"
                print(f"[VAM] Vial correction — rebinning sinogram ({_tc}, n={self.resin_ri:.3f})")
                pipe.rebin()
                if getattr(pipe, "rebinned", None) is not None:
                    self.sino = pipe.rebinned
                    self._sino_is_rebinned = True
                    print(f"[VAM] Rebinned sinogram shape={tuple(pipe.rebinned.array.shape)}")
            except Exception as e:
                import traceback; traceback.print_exc()
                # Fall back to the PARALLEL sinogram at its TRUE scale — never leave a
                # half-corrected / empty video (this was the blank output-page failure).
                print(f"[VAM] Vial-correction rebin failed ({e}); using parallel sinogram at its true scale")
        self.recon = pipe.reconstruction
        self.dose_metrics = self._compute_dose_metrics()
        if self.dose_metrics:
            m = self.dose_metrics
            _eff = " [effective post-diffusion dose]" if m.get("effective") else ""
            print(f"[VAM] Dose quality{_eff} — in-part min {m['in_min']:.2f} / out-part max {m['out_max']:.2f} "
                  f"| process window {m['window']:+.2f} | voxel error {m['ver_pct']:.2f}% "
                  f"(in under {m['in_under_pct']:.2f}%, out over {m['out_over_pct']:.2f}%)")
        print("[VAM] Slicing complete")

    def _effective_dose(self, r, tg, target_voxels=64_000_000):
        """Effective CURED dose = recon convolved with the diffusion PSF (the projected
        dose, spread by diffusion, is what crosses the gel threshold).  Both the recon
        and the binary target are downsampled (stride) so the metric stays cheap, and
        the PSF is rebuilt at the coarser pitch to match.  Returns (effective_dose,
        downsampled_binary_target)."""
        import vamtoolbox as _vamtb
        nvox = int(r.size)
        stride = 1
        while nvox // (stride ** 3) > target_voxels:
            stride += 1
        rd = np.ascontiguousarray(r[::stride, ::stride, ::stride]) if stride > 1 else r
        tgd = tg[::stride, ::stride, ::stride] if stride > 1 else tg
        pitch = float(self.res) * stride
        dker = _vamtb.response.blur_ker(
            pitch, self.diffusion_coeff, self.print_time_s, self.rotation_deg_s,
            optical=getattr(self, "diffusion_optical", False))
        eff = _vamtb.response._diffusion_convolve(rd, dker)
        return np.asarray(eff, dtype=np.float32), tgd

    def _compute_dose_metrics(self):
        """In-part vs out-of-part dose quality of the optimized reconstruction.
        in-part voxels should reach the gel dose; out-of-part (inside the vial)
        should stay below it.  Returns normalized-dose stats + a 'process window'
        (in_min - out_max; >0 means a single global threshold prints cleanly)."""
        try:
            if self.recon is None or self.t_geo is None:
                return None
            # self.recon may be a geometry.Reconstruction wrapper — unwrap to its array
            r = np.asarray(getattr(self.recon, "array", self.recon), dtype=np.float32)
            tg = np.asarray(self.t_geo.array)
            # Diffusion-aware: with diffusion correction the PROJECTED dose (recon) is
            # intentionally non-uniform (fine features boosted), so judging it against a
            # uniform binary expectation is wrong.  What actually CURES is the recon
            # convolved with the diffusion PSF — measure THAT effective dose so in-part
            # uniformity / process window are physically meaningful.
            self._dose_is_effective = False
            if getattr(self, "diffusion", False):
                try:
                    r, tg = self._effective_dose(r, tg)
                    self._dose_is_effective = True
                except Exception as _e:
                    print(f"[VAM] effective-dose metric unavailable ({_e}); using raw recon")
            rmax = float(r.max()) or 1.0
            r = r / rmax                                   # normalized dose [0,1]
            tgt = tg > (0.5 * float(tg.max()) if tg.max() > 0 else 0.5)
            nX, nY = r.shape[0], r.shape[1]
            yy, xx = np.ogrid[:nX, :nY]
            circle = (((xx - nX / 2.0) ** 2 + (yy - nY / 2.0) ** 2) <= (min(nX, nY) / 2.0) ** 2)[..., None]
            in_d = r[tgt]
            out_d = r[(~tgt) & circle]
            T = float(self.d_l)                            # gel threshold
            in_under = float((in_d < T).mean()) if in_d.size else 0.0
            out_over = float((out_d >= T).mean()) if out_d.size else 0.0
            # total voxel error = voxels on the WRONG side of the gel threshold: in-part
            # under-cured (missing features) + out-of-part over-cured (stray curing).
            ver = (in_under * in_d.size + out_over * out_d.size) / max(1, in_d.size + out_d.size)
            # Dose-distribution histogram (the classic VAM in-part vs out-part plot),
            # normalized to a fraction of each population so both are comparable.
            BINS = 50
            in_h, edges = np.histogram(in_d, bins=BINS, range=(0.0, 1.0))
            out_h, _ = np.histogram(out_d, bins=BINS, range=(0.0, 1.0))
            in_h = in_h.astype(np.int64); out_h = out_h.astype(np.int64)   # raw counts (log-frequency, like vamtoolbox)
            return {
                "in_min": float(in_d.min()) if in_d.size else 0.0,
                "in_mean": float(in_d.mean()) if in_d.size else 0.0,
                "out_max": float(out_d.max()) if out_d.size else 0.0,
                "out_mean": float(out_d.mean()) if out_d.size else 0.0,
                "window": (float(in_d.min()) - float(out_d.max())) if (in_d.size and out_d.size) else 0.0,
                "in_under_pct": in_under * 100.0,
                "out_over_pct": out_over * 100.0,
                "ver_pct": ver * 100.0,
                "dose_error": getattr(getattr(self, "_pipe", None), "final_loss", None),  # final optimizer dose error
                "in_hist": in_h.tolist(), "out_hist": out_h.tolist(),       # dose histograms (fraction per bin)
                "hist_edges": edges.tolist(), "threshold": T,
                "effective": bool(getattr(self, "_dose_is_effective", False)),  # metric on post-diffusion dose
            }
        except Exception as e:
            print(f"[VAM] dose-metric computation failed: {e}")
            return None

    def get_surface_mesh(self, max_dim=512, budget=120_000_000, max_faces=7_000_000):
        """Marching-cubes the voxel grid into an INDEXED (vertices, normals, indices)
        mesh for the 3D viewer — ~3x lighter than expanded triangles, so we can show
        more display detail for the same transfer/render cost.  `budget` caps the
        marching-cubes INPUT (memory/time); `max_faces` caps the OUTPUT (refuses
        rather than ship a mesh too big to transfer/render)."""
        from skimage.measure import marching_cubes

        if self.t_geo is None:
            return {"vertices": [], "normals": [], "indices": [], "gl_scale": 1.0}
        # Decimate FIRST on the raw (uint8) grid, THEN cast only the small result to
        # float32.  Casting the full grid up front turned a 2.8 GB uint8 grid into an
        # 11 GB float32 (× billions of voxels) and was the memory balloon after voxelize.
        raw = self.t_geo.array
        # Bound BOTH by a linear cap (max_dim) AND a voxel budget so a mid-size grid
        # (e.g. 752³) can't slip through with step=1 and run marching-cubes on hundreds
        # of millions of voxels.
        step = max(1,
                   max(raw.shape) // max_dim,
                   int(np.ceil((raw.size / float(budget)) ** (1.0 / 3.0))))
        if step > 1:
            raw = raw[::step, ::step, ::step]
        vol = np.ascontiguousarray(raw).astype(np.float32)   # only the DECIMATED grid -> float32
        disp_dim = list(vol.shape)                        # decimated grid actually rendered
        if not np.any(vol > 0.5):
            return {"vertices": [], "normals": [], "indices": [], "gl_scale": 1.0, "display_dim": disp_dim, "step": int(step)}

        vol = np.pad(vol, 1, mode="constant", constant_values=0.0)
        verts, faces, normals, _ = marching_cubes(vol, level=0.5)
        if max_faces and faces.shape[0] > max_faces:     # too heavy to ship/render — refuse cleanly
            return {"vertices": [], "normals": [], "indices": [], "gl_scale": 1.0,
                    "display_dim": disp_dim, "step": int(step),
                    "too_large": True, "n_faces": int(faces.shape[0])}
        verts = (verts - 1.0) * step                     # back to full-grid voxel units
        centre = (verts.min(axis=0) + verts.max(axis=0)) * 0.5
        verts = (verts - centre).astype(np.float32)      # centre on origin for the viewer
        return {
            "vertices": verts.reshape(-1).tolist(),
            "normals":  normals.astype(np.float32).reshape(-1).tolist(),
            "indices":  faces.astype(np.uint32).reshape(-1).tolist(),
            "gl_scale": 1.0,
            "display_dim": disp_dim,
            "step": int(step),
        }

    def scaleSino(self, scale_factor: float):
        if self.sino is not None:
            self.sino.array = vamtb.imagesequence._scaleSize(self.sino.array, scale_factor)
            print(f"[VAM] Scaled sinogram by factor {scale_factor}")
        else:
            print("[VAM] No sinogram to scale")

    def rotateSino(self, angle_deg: float):
        if self.sino is not None:
            self.sino.array = vamtb.imagesequence._rotate(self.sino.array, angle_deg)
            print(f"[VAM] Rotated sinogram by {angle_deg} degrees")
        else:
            print("[VAM] No sinogram to rotate")

    def invertSinoH(self):
        if self.sino is not None:
            self.sino.array = vamtb.imagesequence._invertU(self.sino.array)
            print("[VAM] Inverted sinogram horizontally")
        else:
            print("[VAM] No sinogram to invert")

    def invertSinoV(self):
        if self.sino is not None:
            self.sino.array = vamtb.imagesequence._invertV(self.sino.array)
            print("[VAM] Inverted sinogram vertically")
        else:
            print("[VAM] No sinogram to invert")

    def _video_scale(self):
        """Projector px-per-voxel scale, clamped so the sinogram fits the canvas.

        The intended scale is (res * proj_px_w / proj_width).  If the part is taller
        (or wider) than the projector can show at that scale, vamtoolbox raises
        instead of rendering, so we clamp to the largest scale that fits and warn —
        the preview/video then always renders (adjust proj_width/res for the true
        physical scale)."""
        # Rebinned sinogram is already in projector pixels (base 1.0); the parallel
        # sinogram maps voxels->projector via res*proj_px_w/proj_width.
        if getattr(self, "_sino_is_rebinned", False):
            true_scale = 1.0
        else:
            true_scale = (self.res * self.proj_px_w) / self.proj_width
        if self.sino is None:
            return true_scale
        arr = self.sino.array
        n_r, n_z = arr.shape[0], arr.shape[2]      # detector width, z-height
        # ALWAYS clamp so the frame fits the canvas — a part taller/wider than the
        # projector FOV (e.g. a rebinned sinogram 1191 px tall on a 1080 px screen)
        # made vamtoolbox raise -> blank output page.  Clamp + warn instead.
        fit = min(self.proj_px_h / max(n_z, 1), self.proj_px_w / max(n_r, 1)) * 0.98
        if true_scale > fit:
            print(f"[VAM] sinogram {n_r}x{n_z} exceeds the "
                  f"{int(self.proj_px_w)}x{int(self.proj_px_h)} projector canvas; clamping "
                  f"scale {true_scale:.2f}->{fit:.2f} (part is larger than the printable area).")
            return fit
        return true_scale

    def _v_offset_px(self, true_scale):
        """Vertical (Z) projection offset in projector pixels, from video_v_offset_mm.
        +mm moves the part UP in the displayed (np.flipud'd) frame, so the sign is
        negated for ImageConfig.  Clamped so the sinogram stays inside the projector
        canvas — otherwise vamtoolbox's _insertImage raises 'extends out of screen'."""
        if self.sino is None:
            return 0
        mm_per_px = self.proj_width / max(self.proj_px_w, 1)
        off_px = -(float(getattr(self, "video_v_offset_mm", 0.0)) / max(mm_per_px, 1e-9))
        s_v = self.sino.array.shape[2] * true_scale            # part height in projector px
        max_off = max(0.0, (int(self.proj_px_h) - s_v) / 2.0 - 1)
        return int(round(max(-max_off, min(max_off, off_px))))

    def get_preview_frames(self):
        """
        Return the sinogram rendered as a list of (H, W) uint8 numpy arrays
        and the playback FPS, without writing any file.

        Used by the Flask MJPEG streaming endpoint so the browser <img> tag
        can display the animation without needing H.264 / any codec support.

        Returns
        -------
        frames : list of np.ndarray  shape (H, W) uint8
        fps    : float
        """
        true_scale = self._video_scale()
        
        iconfig = vamtb.imagesequence.ImageConfig(
            image_dims=(int(self.proj_px_w), int(self.proj_px_h)),
            rotated_angle=0,
            size_scale=true_scale,
            v_offset=self._v_offset_px(true_scale),   # GUI vertical (Z) projection offset
            normalization_percentile=99.9,
        )
        image_seq = vamtb.imagesequence.ImageSeq(
            image_config=iconfig, sinogram=self.sino
        )
        # vamtoolbox's DLP projector path (dlp/players.py) flips every frame
        # vertically (np.flipud) before projecting, because pyglet textures are
        # bottom-origin.  The cv2/ffmpeg paths here are top-origin, so without the
        # same flip the preview/video is upside-down vs what actually gets printed.
        frames = [np.ascontiguousarray(np.flipud(im)) for im in image_seq.images]
        n = len(frames)
        # Preview shows exactly ONE rotation (the n sinogram angles) and the
        # frontend loops it; pick an fps that plays a rotation in a few seconds.
        fps = max(12.0, min(30.0, n / 8.0))
        return frames, fps

    def saveVid(self, out_path: str = None):
        """
        Encode the rotation video through the ffmpeg binary that ships INSIDE the
        ``imageio-ffmpeg`` package, so a packaged/standalone build needs no system
        codecs or HEVC extensions.  vamtoolbox's ImageConfig / ImageSeq still
        pre-process the sinogram into frames; we just pipe them to bundled ffmpeg
        (libx265 / libx264), with an OpenCV mp4v fallback.

        Parameters
        ----------
        out_path : str, optional
            Full path to the output .mp4 file.
            When omitted the legacy ``self.savePath + '.mp4'`` is used.
        """
        import cv2

        save_path = out_path if out_path is not None else (self.savePath + '.mp4')

        true_scale = self._video_scale()

        iconfig = vamtb.imagesequence.ImageConfig(
            image_dims=(int(self.proj_px_w), int(self.proj_px_h)),
            rotated_angle=0,
            size_scale=true_scale,
            v_offset=self._v_offset_px(true_scale),   # GUI vertical (Z) projection offset
            normalization_percentile=99.9,
            intensity_scale=float(getattr(self, "video_intensity", 1.0)),  # vamtoolbox-native intensity gain
        )
        image_seq = vamtb.imagesequence.ImageSeq(
            image_config=iconfig, sinogram=self.sino
        )

        n_images = len(image_seq.images)            # one full 360° rotation

        fps        = float(getattr(self, "video_fps", 54.0))
        rpm        = float(getattr(self, "video_rpm", 1.0))
        duration_s = float(getattr(self, "video_duration_s", 300.0))
        codec      = str(getattr(self, "video_codec", "h265")).lower()

        # The vial turns at `rpm`; each output frame advances the projected angle
        # by rpm*6 deg/s ÷ fps, sampling the sinogram (which repeats every 360°).
        total_frames  = max(1, int(round(fps * duration_s)))
        deg_per_frame = rpm * 6.0 / fps

        W = iconfig.N_u
        H = iconfig.N_v

        import numpy as np

        def _frame(k):
            angle = (k * deg_per_frame) % 360.0
            idx = int(angle / 360.0 * n_images) % n_images
            # np.flipud to match vamtoolbox's DLP projector (dlp/players.py) — the
            # bottom-origin pyglet path flips each frame; keep the saved video in the
            # same orientation as the real print (and as the live preview above).
            g = np.flipud(image_seq.images[idx])
            return np.repeat(g[:, :, None], 3, axis=2)   # grey -> (H, W, 3) RGB

        # Encode through the ffmpeg binary BUNDLED with imageio-ffmpeg.  This is
        # fully self-contained — no system HEVC / Media-Foundation extensions — so a
        # packaged/standalone build encodes identically on any machine.
        codec_map = {"h265": "libx265", "h264": "libx264", "mp4v": "mpeg4"}
        ff_codec = codec_map.get(codec, "libx265")

        # The projected pattern repeats every 360°.  If a whole number of frames makes
        # up exactly one rotation, encode ONE rotation and stream-copy-loop it to the
        # full duration — no re-encoding the identical frames dozens of times.
        fpr      = (60.0 * fps / abs(rpm)) if abs(rpm) > 1e-9 else 0.0   # frames/rotation (|rpm|; sign = direction via deg_per_frame)
        n_unique = int(round(fpr))
        n_loops  = int(round(total_frames / n_unique)) if n_unique > 0 else 0
        fast     = (n_unique >= 2 and n_loops >= 2 and abs(fpr - n_unique) < 1e-3)

        try:
            import imageio_ffmpeg, subprocess
            if fast:
                seg = save_path + ".seg.mp4"
                print(f"[VAM] Fast encode: 1 rotation = {n_unique} frames, stream-looped "
                      f"{n_loops}× ({ff_codec} via bundled ffmpeg, {rpm:.2f} rpm, "
                      f"~{n_unique * n_loops / fps / 60:.1f} min) — encodes {n_unique} frames "
                      f"instead of {total_frames}")
                writer = imageio_ffmpeg.write_frames(
                    seg, (W, H), fps=fps, codec=ff_codec,
                    pix_fmt_in="rgb24", pix_fmt_out="yuv420p", macro_block_size=2, quality=6,
                )
                writer.send(None)
                for k in range(n_unique):
                    writer.send(np.ascontiguousarray(_frame(k), dtype=np.uint8).tobytes())
                writer.close()
                exe = imageio_ffmpeg.get_ffmpeg_exe()
                subprocess.run(
                    [exe, "-y", "-stream_loop", str(n_loops - 1), "-i", seg,
                     "-c", "copy", "-fflags", "+genpts", save_path],
                    check=True, capture_output=True)
                try:
                    if os.path.exists(seg):
                        os.remove(seg)
                except Exception:
                    pass
                print(f"[VAM] Video saved ({ff_codec}, 1 rotation × {n_loops} loops): {save_path}")
                return

            print(f"[VAM] Writing {total_frames} frames -> {save_path} "
                  f"({fps:.1f} fps, {ff_codec} via bundled ffmpeg, {rpm:.2f} rpm, {duration_s/60:.1f} min)")
            writer = imageio_ffmpeg.write_frames(
                save_path, (W, H), fps=fps, codec=ff_codec,
                pix_fmt_in="rgb24", pix_fmt_out="yuv420p",
                macro_block_size=2, quality=6,
            )
            writer.send(None)                              # initialise the encoder
            for k in range(total_frames):
                writer.send(np.ascontiguousarray(_frame(k), dtype=np.uint8).tobytes())
                if (k == 0) or ((k + 1) % 500 == 0) or (k + 1 == total_frames):
                    print(f"[VAM]   frame {k+1:5d}/{total_frames}")
            writer.close()
            print(f"[VAM] Video saved ({ff_codec}, bundled ffmpeg): {save_path}")
            return
        except Exception as e:
            import traceback; traceback.print_exc()
            print(f"[VAM] bundled-ffmpeg encode failed ({e}); falling back to OpenCV mp4v")

        # Fallback: OpenCV MPEG-4 (built in, no external codec)
        writer = cv2.VideoWriter(save_path, cv2.VideoWriter_fourcc(*'mp4v'), fps, (W, H))
        if not writer.isOpened():
            raise RuntimeError(f"cv2.VideoWriter failed to open '{save_path}'.")
        for k in range(total_frames):
            writer.write(cv2.cvtColor(_frame(k)[:, :, 0], cv2.COLOR_GRAY2BGR))
        writer.release()
        print(f"[VAM] Video saved (OpenCV mp4v fallback): {save_path}")