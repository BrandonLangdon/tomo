const BASE = "http://localhost:5174/api";

/**
 * Open a native file-dialog and return mesh data from the backend.
 * Returns: { status, filename, vertices, normals }
 */
export async function openFile() {
  return fetch(`${BASE}/open_stl_dialog`, { method: "POST" }).then(r => r.json());
}

/**
 * Start voxelisation on the backend.
 * @param {number} resolution  mm per voxel (e.g. 0.5 – 2.0)
 * @param {object} matrices    map of model_id → flat 16-element column-major matrix array
 */
export async function voxelize({ resolution = 1.0, matrices = {} } = {}) {
  return fetch(`${BASE}/start_voxelize`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ resolution, matrices }),
  }).then(r => r.json());
}

/**
 * Start VAM sinogram optimisation.
 * @param {object} opts
 * @param {number} opts.n_iter   number of iterations (1 – 20)
 * @param {number} opts.d_h      high-dose threshold (0 – 1)
 * @param {number} opts.d_l      low-dose threshold  (0 – 1)
 * @param {string} opts.filter   filter
 * @param {boolean} opts.cuda    CUDA acceleration for forward/back-projection
 */
export async function slice({
  n_iter = 5, d_h = 0.6, d_l = 0.5, filter = "hamming", cuda = false,
  method = "OSMO", absorption = false, diffusion = false, slab = "auto", low_memory = false,
} = {}) {
  return fetch(`${BASE}/start_slice`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ n_iter, d_h, d_l, filter, cuda,
                           method, absorption, diffusion, slab, low_memory }),
  }).then(r => r.json());
}

/**
 * Fetch the marching-cubes surface mesh of the voxelized target.
 * Returns { status, vertices, normals } — same shape as openFile's mesh data.
 */
export async function meshPreview() {
  return fetch(`${BASE}/mesh_preview?t=${Date.now()}`).then(r => r.json());
}

/**
 * Poll job status.
 * Returns:
 *   voxelize_pct, voxelize_done, voxelize_error, voxel_info
 *   slice_pct,    slice_done,    slice_error,    slice_info, frames
 */
export async function poll() {
  return fetch(`${BASE}/poll`).then(r => r.json());
}

/**
 * Trigger server-side MP4 render and download it as a Blob.
 */
export async function downloadMp4() {
  const res = await fetch(`${BASE}/download_mp4`, { method: "POST" });
  if (!res.ok) throw new Error("MP4 export failed");
  return res.blob();
}
