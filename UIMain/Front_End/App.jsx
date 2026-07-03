import { useState, useRef, useEffect, useMemo } from "react";
import * as THREE from "three";
import StlViewer from "./StlViewer";
import VoxelViewer from "./VoxelViewer";
import MeshViewer from "./MeshViewer";
import tomoLogo from "./tomoLogo.png";   // black line art — invert(1) to render white on the dark UI

// Dev build talks to the dev backend (:5274); the packaged build to :5174. This keeps
// a running installed Tomo and a dev build from fighting over one port. Kept in sync
// with electron/main.cjs (BACKEND_PORT) and the backend's TOMO_BACKEND_PORT.
const API = `http://localhost:${import.meta.env.DEV ? 5274 : 5174}/api`;

// ── Design Palette ────────────────────────────────────────────────────────
const C = {
  bg: "#16161f", bgS: "#1c1c28", bgT: "#262636",
  border: "#33334a", text: "#f0f0f6", muted: "#b6b6d0", hint: "#7a7a92",
  blue: "#4a9eef", green: "#5fc23a", red: "#e24b4a",
};
const AX = { x: "#e24b4a", y: "#5fc23a", z: "#4a9eef" };

// Vials (radius/height in mm) — selectable/editable like materials & projectors.
const DEFAULT_VIALS = [
  { id: "std100", name: "Standard — Ø100 × 100 mm", radius: 50, height: 100 },
  { id: "small", name: "Small — Ø20 × 50 mm", radius: 10, height: 50 },
  { id: "medium", name: "Medium — Ø40 × 80 mm", radius: 20, height: 80 },
  { id: "large", name: "Large — Ø100 × 150 mm", radius: 50, height: 150 },
];
// Projector presets set the voxel pitch; "Custom" reveals a number input.
// A projector = pixel dimensions (W×H, oriented for the vial: H is the tall vial axis) +
// pixel pitch (µm). Pitch drives the print/voxel resolution; W×H drives the output video.
const DEFAULT_PROJECTORS = [
  { id: "opencal2", name: "OpenCAL V2", pxW: 1080, pxH: 1920, pitchUm: 79.7, telecentric: true, throwRatio: 1.5 },
];

// ── Core UI Primitives ────────────────────────────────────────────────────
function Card({ children, style }) { return <div style={{ background: C.bgS, border: `1px solid ${C.border}`, borderRadius: 6, padding: "10px 12px", ...style }}>{children}</div>; }
function Lbl({ children }) { return <p style={{ fontSize: 11, color: C.muted, margin: "0 0 4px", fontWeight: 700, letterSpacing: ".06em", textTransform: "uppercase" }}>{children}</p>; }
function Btn({ children, onClick, disabled, variant = "default", style }) {
  const v = { default: { background: "#262638", color: C.text, border: `1px solid #3a3a52` }, primary: { background: C.blue, color: "#fff", border: "none" }, success: { background: C.green, color: "#fff", border: "none" }, danger: { background: C.red, color: "#fff", border: "none" } };
  return <button onClick={onClick} disabled={disabled} style={{ padding: "6px 14px", borderRadius: 4, fontSize: 12, fontWeight: 600, cursor: disabled ? "not-allowed" : "pointer", opacity: disabled ? 0.4 : 1, transition: "opacity .15s", ...v[variant], ...style }}>{children}</button>;
}
function Pill({ label, value }) { return <div style={{ background: C.bgT, borderRadius: 4, padding: "5px 9px", display: "flex", flexDirection: "column", gap: 1 }}><span style={{ fontSize: 11, color: C.muted }}>{label}</span><span style={{ fontSize: 12, fontWeight: 700, color: C.text }}>{value}</span></div>; }
function Bar({ pct }) { return <div style={{ height: 3, background: C.bgT, borderRadius: 2, overflow: "hidden", marginTop: 5 }}><div style={{ width: `${pct}%`, height: "100%", background: C.blue, transition: "width .3s" }} /></div>; }
function Slider({ label, min, max, step, value, onChange, unit = "" }) { return <div><div style={{ display: "flex", justifyContent: "space-between", marginBottom: 3 }}><Lbl>{label}</Lbl><span style={{ fontSize: 11, fontWeight: 700, color: C.text }}>{value}{unit}</span></div><input type="range" min={min} max={max} step={step} value={value} onChange={e => onChange(parseFloat(e.target.value))} style={{ width: "100%" }} /></div>; }
function NumInput({ value, onChange, style, step = "any" }) {
  // `text` is non-null only while the user is editing, so the field can be empty
  // or partial ("", "12.", "-") without snapping back to the committed value.
  const [text, setText] = useState(null);
  const display = text != null ? text : (isNaN(value) ? "" : String(value));
  return <input type="text" inputMode="decimal" value={display}
    onFocus={e => e.target.select()}                        // select all so typing (incl. a leading "-") replaces cleanly
    onChange={e => {
      const s = e.target.value;
      if (s !== "" && !/^-?\d*\.?\d*$/.test(s)) return;     // ignore non-numeric keystrokes
      setText(s);
      const v = parseFloat(s);
      if (s !== "" && !isNaN(v)) onChange(v);               // push only valid numbers; empty/partial leaves the value untouched so you can clear & retype
    }}
    onBlur={() => setText(null)}                            // stop overriding -> snap back to the committed (clamped) value
    style={{ width: "100%", background: "#16161f", color: C.text, border: `1px solid ${C.border}`, borderRadius: 4, padding: "3px 6px", fontSize: 11, fontFamily: "monospace", outline: "none", ...style }} />;
}
// Text-based numeric input that allows a leading "-" and partial decimals while typing
// (type=number swallows the "-").  Used where negatives are valid, e.g. reverse rotation.
function SignedNumInput({ value, onChange, style }) {
  const [txt, setTxt] = useState("");
  const focused = useRef(false);
  useEffect(() => { if (!focused.current) setTxt(isNaN(value) ? "" : String(value)); }, [value]);
  return <input type="text" inputMode="decimal" value={txt}
    onFocus={e => { focused.current = true; e.target.select(); }}
    onChange={e => { const t = e.target.value; if (t === "" || t === "-" || /^-?\d*\.?\d*$/.test(t)) { setTxt(t); const v = parseFloat(t); if (!isNaN(v)) onChange(v); } }}
    onBlur={() => { focused.current = false; const v = parseFloat(txt); onChange(isNaN(v) ? 0 : v); setTxt(isNaN(v) ? "" : String(v)); }}
    style={{ width: "100%", background: "#16161f", color: C.text, border: `1px solid ${C.border}`, borderRadius: 4, padding: "3px 6px", fontSize: 11, fontFamily: "monospace", outline: "none", ...style }} />;
}
function InfoBtn({ open, onClick }) { return <button onClick={onClick} title="What's this?" style={{ width: 16, height: 16, borderRadius: "50%", border: `1px solid ${open ? C.blue : C.muted}`, background: open ? `${C.blue}22` : "transparent", color: open ? C.blue : C.muted, fontSize: 11, fontWeight: 700, cursor: "pointer", lineHeight: 1, padding: 0 }}>i</button>; }
// Convergence graph (dose error vs iteration) — the vamtoolbox optimization plot, drawn live.
function LossChart({ data }) {
  if (!data || data.length < 2) return null;
  const W = 250, H = 96, pad = 5;
  const ys = data.map(d => d[1]);
  const lo = Math.min(...ys), hi = Math.max(...ys), rng = (hi - lo) || 1;
  const n = data.length;
  const pts = data.map((d, i) => `${(pad + (i / (n - 1)) * (W - 2 * pad)).toFixed(1)},${(pad + (1 - (d[1] - lo) / rng) * (H - 2 * pad)).toFixed(1)}`).join(" ");
  return (
    <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" style={{ display: "block", width: "100%", height: H }}>
      <rect x="0.5" y="0.5" width={W - 1} height={H - 1} fill="#0c0c16" stroke="#2a2a3c" />
      <polyline points={pts} fill="none" stroke="#3a90e6" strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}
// vamtoolbox dose-distribution plot: in-part (blue) vs out-of-part (red) dose, with the
// gel threshold (dashed). Good = the two humps separate cleanly across the threshold.
function DoseHistogram({ dose }) {
  if (!dose || !dose.in_hist || !dose.out_hist) return null;
  const W = 260, H = 112, pad = 6, base = H - pad - 12;
  const n = dose.in_hist.length;
  const lg = v => Math.log10(v + 1);                       // log-frequency axis (like vamtoolbox)
  const mxl = lg(Math.max(...dose.in_hist, ...dose.out_hist) || 1) || 1;
  const bw = (W - 2 * pad) / n;
  const bar = (v, i, color, k) => { const h = v > 0 ? (lg(v) / mxl) * (base - pad) : 0; return <rect key={k + i} x={pad + i * bw} y={base - h} width={Math.max(1, bw - 0.4)} height={h} fill={color} />; };
  const thrX = dose.threshold != null ? pad + dose.threshold * (W - 2 * pad) : null;
  return (
    <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" style={{ display: "block", width: "100%", height: H }}>
      <rect x="0.5" y="0.5" width={W - 1} height={H - 1} fill="#0c0c16" stroke="#2a2a3c" />
      {dose.out_hist.map((v, i) => bar(v, i, "#e05555aa", "o"))}
      {dose.in_hist.map((v, i) => bar(v, i, "#3a90e6bb", "i"))}
      {thrX != null && <line x1={thrX} y1={pad} x2={thrX} y2={base} stroke="#fff" strokeWidth="1" strokeDasharray="3 2" />}
      <text x={pad + 2} y={H - 2} fill="#aeaecb" fontSize="8">0</text>
      <text x={W - pad - 26} y={H - 2} fill="#aeaecb" fontSize="8">1.0 dose</text>
    </svg>
  );
}
function Toggle({ value, onChange, label, disabled, hint }) { return <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: disabled ? "not-allowed" : "pointer", userSelect: "none", opacity: disabled ? 0.45 : 1 }}><div onClick={() => !disabled && onChange(!value)} style={{ width: 30, height: 17, borderRadius: 9, position: "relative", background: value ? C.blue : C.bgT, border: `1px solid ${C.border}`, flexShrink: 0 }}><div style={{ position: "absolute", top: 2, left: value ? 13 : 2, width: 11, height: 11, borderRadius: "50%", background: "#fff" }} /></div><span style={{ fontSize: 12, color: C.text }}>{label}{hint ? <span style={{ color: C.muted, fontSize: 11 }}> {hint}</span> : null}</span></label>; }

function Section({ title, step, done, disabled, children }) {
  return <div style={{ background: disabled ? "#0c0c16" : C.bg, border: `1px solid ${done ? C.green + "55" : C.border}`, borderRadius: 7, padding: "11px 12px", opacity: disabled ? 0.5 : 1, pointerEvents: disabled ? "none" : "auto", transition: "opacity .2s" }}>
    <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 9 }}>
      <span style={{ width: 18, height: 18, borderRadius: "50%", background: done ? C.green : C.bgT, color: done ? "#fff" : C.muted, fontSize: 11, fontWeight: 800, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>{done ? "✓" : step}</span>
      <span style={{ fontSize: 12, fontWeight: 700, color: "#fff", textTransform: "uppercase", letterSpacing: ".05em" }}>{title}</span>
    </div>
    {children}
  </div>;
}
function Progress({ pct, label }) {
  return <div style={{ marginTop: 10 }}>
    <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
      <span style={{ fontSize: 11, color: C.muted }}>{label}</span>
      <span style={{ fontSize: 11, fontWeight: 700, color: C.blue }}>{Math.round(pct)}%</span>
    </div>
    <div style={{ height: 6, background: C.bgT, borderRadius: 3, overflow: "hidden" }}>
      <div style={{ width: `${pct}%`, height: "100%", background: C.blue, transition: "width .3s" }} />
    </div>
  </div>;
}
function Indeterminate({ label }) {
  return <div style={{ marginTop: 10 }}>
    <span style={{ fontSize: 11, color: C.muted }}>{label}</span>
    <div style={{ height: 6, background: C.bgT, borderRadius: 3, overflow: "hidden", marginTop: 4, position: "relative" }}>
      <div style={{ position: "absolute", width: "40%", height: "100%", background: C.blue, borderRadius: 3, animation: "tomoslide 1.1s ease-in-out infinite" }} />
    </div>
  </div>;
}

export default function App() {
  const [tab, setTab] = useState(0);
  const [models, setModels] = useState([]);
  const [activeIdx, setActiveIdx] = useState(-1);
  const [isImporting, setIsImporting] = useState(false);

  const [xform, setXform] = useState({ tx: 0, ty: 0, tz: 0, rx: 0, ry: 0, rz: 0, sx: 1, sy: 1, sz: 1, changeOrigin: "gizmo" });
  const viewerRef = useRef(null);
  const voxCancelRef = useRef(false);
  const [activeTool, setActiveTool] = useState("none");

  const [resolution, setResolution] = useState(0.0797);  // OpenCAL V2 default (79.7 µm) — EFFECTIVE pitch
  const [basePitch, setBasePitch] = useState(0.0797);    // projector native pitch (scale 1.0 reference)
  const [voxScale, setVoxScale] = useState(1.0);       // resolution scale (<1 = coarser/faster); pitch = base/scale
  const [voxMeshRes, setVoxMeshRes] = useState(0.0797);  // pitch the DISPLAYED voxel mesh was built at (stable while the slider moves)
  const [fullResMesh, setFullResMesh] = useState(false);  // render the voxel preview at full resolution (slow for big grids)
  const [meshInfo, setMeshInfo] = useState(null);         // {display_dim, full_grid, step}
  const [voxStatus, setVoxStatus] = useState("idle");
  const [voxPct, setVoxPct] = useState(0);
  const [voxInfo, setVoxInfo] = useState(null);
  const [voxelData, setVoxelData] = useState(null);
  const [voxError, setVoxError] = useState("");
  const [voxProgress, setVoxProgress] = useState(0);   // 0..1 time-based estimate
  const [voxStage, setVoxStage] = useState("");
  const [voxGrid, setVoxGrid] = useState(null);        // [nx,ny,nz]
  const [voxEta, setVoxEta] = useState(0);             // seconds remaining (est)
  const [voxNote, setVoxNote] = useState("");          // grid-cap notice

  const [nIter, setNIter] = useState(5);
  const [dH, setDH] = useState(0.9);   // in-target dose (gel point)
  const [dL, setDL] = useState(0.3);   // out-of-target max dose
  const [learningRate, setLearningRate] = useState(0.005);   // BCLP gradient step
  const [bclpEps, setBclpEps] = useState(0.1);               // BCLP band tolerance ±eps
  const [bclpWeight, setBclpWeight] = useState(1.0);         // BCLP Lp weighting
  const [sliceStatus, setSliceStatus] = useState("idle");
  const [slicePct, setSlicePct] = useState(0);
  const [sliceInfo, setSliceInfo] = useState(null);
  const [cudaEnabled, setCudaEnabled] = useState(false);  // CPU sparse projector by default (matches stress tests); CUDA = faster opt-in

  // Optimizer features (routed through vamtoolbox.pipeline)
  const [method, setMethod] = useState("OSMO");       // "OSMO" | "BCLP"
  const [absorption, setAbsorption] = useState(false);
  const [diffusion, setDiffusion] = useState(false);
  const [slab, setSlab] = useState("auto");           // "auto" | "off"

  // Materials: named bundles of optics/chemistry that drive the run — refractive
  // index (vial correction), absorption, diffusion.  Choose one, edit it, add new.
  const [materials, setMaterials] = useState([
    { id: "default", name: "OpenCAL resin", index: 1.51, absorption: false, absorptionCoeff: 0.207, diffusion: false, diffusionCoeff: 1.1816e-4 },
  ]);
  const [materialId, setMaterialId] = useState("default");
  const activeMaterial = materials.find(m => m.id === materialId) || materials[0];
  const [materialModal, setMaterialModal] = useState(false);  // "add material" popup
  const [materialDraft, setMaterialDraft] = useState(null);   // new/edit-material form values
  const [editingMaterialId, setEditingMaterialId] = useState(null);  // null = add, else editing
  const [saveSinogram, setSaveSinogram] = useState(false);    // also save .npy on Save run (off by default)
  const [meshData, setMeshData] = useState(null);     // marching-cubes surface mesh
  const [meshGen, setMeshGen] = useState(0);          // bumps each new mesh -> forces a fresh viewer mount

  // Video output settings
  const [videoRpm, setVideoRpm] = useState(9);        // vial rotation speed (print parameter)
  const [videoDurMin, setVideoDurMin] = useState(5);  // total video / print length
  const [videoCodec, setVideoCodec] = useState("h265");
  const [framesPerDeg, setFramesPerDeg] = useState(1);  // 1 frame per degree (advanced, in Settings)
  const videoFps = Math.max(1, Math.round(framesPerDeg * 6 * Math.abs(videoRpm)));  // |rpm| = speed; sign = direction

  // progress + estimates (PreForm-style feedback)
  const [sliceProgress, setSliceProgress] = useState(0);   // 0..1 during optimize
  const [sliceStage, setSliceStage] = useState("");        // "iter 3/8", "encoding video"...
  const [lossHistory, setLossHistory] = useState([]);      // [[iter, loss],...] convergence graph (verbose)
  const [verboseStamp, setVerboseStamp] = useState(0);     // bumps to refresh the BCLP verbose figure
  const [verboseFrameOk, setVerboseFrameOk] = useState(false);  // a verbose figure frame exists
  const [estimate, setEstimate] = useState(null);          // { pretty, seconds } optimize ETA

  // Fetch the optimize ETA whenever the grid is ready or the settings change
  // The window now opens before the backend is ready (so it appears instantly), so
  // keep polling /api/hardware until it answers — then probe the machine + default to
  // the GPU.  backendReady drives a "starting" overlay while we wait.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      for (let i = 0; i < 180 && !cancelled; i++) {
        try {
          const d = await fetch(`${API}/hardware`).then(r => r.json());
          if (d.status === "ok") {
            if (!cancelled) { setHwInfo(d); if (d.cuda) setCudaEnabled(true); setBackendReady(true); }
            return;
          }
        } catch (e) { /* backend not up yet */ }
        await new Promise(r => setTimeout(r, 1000));
      }
    })();
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (voxStatus !== "done") { setEstimate(null); return; }
    let cancelled = false;
    fetch(`${API}/estimate?n_iter=${nIter}&cuda=${cudaEnabled}&method=${method}`)
      .then(r => r.json())
      .then(d => { if (!cancelled && d.status === "ok") setEstimate(d); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [voxStatus, nIter, cudaEnabled, method]);

  // Video playback state
  const [videoStamp, setVideoStamp] = useState(Date.now());
  const [previewInfo, setPreviewInfo]   = useState(null);  // { frame_count, fps }
  const [showVialFrame, setShowVialFrame] = useState(false);  // Preview overlay: vial bore outline mapped onto the projection (off by default)
  const [zOffsetOn, setZOffsetOn] = useState(false);   // vertical (Z) projection offset control — off by default
  const [zOffsetMm, setZOffsetMm] = useState(0);       // vertical offset of the projection, mm
  const [zOffsetLoading, setZOffsetLoading] = useState(false);   // overlay shown only when a regen is slow (>2s)
  const zOffsetTimer = useRef(null);
  const [previewFrame, setPreviewFrame] = useState(0);
  const [videoIntensity, setVideoIntensity] = useState(1);   // display + saved brightness scale
  const [videoZoom, setVideoZoom] = useState(1);             // preview zoom
  const [videoPan, setVideoPan] = useState({ x: 0, y: 0 });  // preview pan (when zoomed)
  const panDrag = useRef(null);
  const previewIntervalRef = useRef(null);

  // Start/restart the frame-cycling player whenever previewInfo changes
  useEffect(() => {
    if (previewIntervalRef.current) clearInterval(previewIntervalRef.current);
    if (!previewInfo) return;
    const ms = 1000 / previewInfo.fps;
    previewIntervalRef.current = setInterval(() => {
      setPreviewFrame(f => (f + 1) % previewInfo.frame_count);
    }, ms);
    return () => clearInterval(previewIntervalRef.current);
  }, [previewInfo]);

  const [matrices, setMatrices] = useState({});
  const [cylinder, setCylinder] = useState({ radius: 10, height: 50 });   // default = Small vial
  const [showVial, setShowVial] = useState(true);      // show/hide the reference grid + vial outline
  const [fanBeam, setFanBeam] = useState(true);    // vial-curvature refraction correction — ON by default
  const [vial, setVial] = useState("small");           // selected vial id (default = Small)
  const [vials, setVials] = useState(DEFAULT_VIALS);   // {id,name,radius,height}
  const [vialModal, setVialModal] = useState(false);
  const [vialDraft, setVialDraft] = useState(null);
  const [editingVialId, setEditingVialId] = useState(null);
  const activeVial = vials.find(v => v.id === vial) || vials[0];
  const [projector, setProjector] = useState("opencal2");      // selected projector id
  const [projectors, setProjectors] = useState(DEFAULT_PROJECTORS);   // {id,name,pxW,pxH,pitchUm}
  const [projectorModal, setProjectorModal] = useState(false);
  const [projectorDraft, setProjectorDraft] = useState(null);
  const [editingProjectorId, setEditingProjectorId] = useState(null);
  const activeProjector = projectors.find(p => p.id === projector) || projectors[0];
  const [scaleLock, setScaleLock] = useState(true);   // uniform scale lock
  const [dragOver, setDragOver] = useState(false);    // STL drag-and-drop hover
  const [infoOpen, setInfoOpen] = useState("");       // which info popover is open
  const [settingsOpen, setSettingsOpen] = useState(false);  // top-bar Settings dropdown
  const [materialsOpen, setMaterialsOpen] = useState(false); // top-bar Materials dropdown
  const settingsRef = useRef(null);
  const materialsRef = useRef(null);
  useEffect(() => {                                          // click outside collapses the dropdowns
    if (!settingsOpen && !materialsOpen) return;
    const onDown = (e) => {
      if (settingsOpen && settingsRef.current && !settingsRef.current.contains(e.target)) setSettingsOpen(false);
      if (materialsOpen && materialsRef.current && !materialsRef.current.contains(e.target)) setMaterialsOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [settingsOpen, materialsOpen]);
  const [verboseOpt, setVerboseOpt] = useState(false);      // live per-iteration error/dose output
  const [hwInfo, setHwInfo] = useState(null);               // {cuda, gpu, cpu_cores, ram_gb}
  const [backendReady, setBackendReady] = useState(false);  // backend (Python) up + answering
  const [autoScaleSuggest, setAutoScaleSuggest] = useState(true);  // suggest a coarser scale on big grids
  const [savingRun, setSavingRun] = useState(false);        // bundling video + sinogram + params

  // ── Persist GUI settings (materials, projectors, optimizer/video options) across
  //    sessions via localStorage, so new materials/edits stay saved. ──
  const settingsLoaded = useRef(false);
  function applySettings(s) {
    if (!s) return;
    if (Array.isArray(s.materials) && s.materials.length) setMaterials(s.materials);
    if (s.materialId) setMaterialId(s.materialId);
    if (Array.isArray(s.projectors) && s.projectors.length) setProjectors(s.projectors);
    if (Array.isArray(s.vials) && s.vials.length) setVials(s.vials);
    if (s.vial) setVial(s.vial);
    if (s.cylinder) setCylinder(s.cylinder);
    if (typeof s.showVial === "boolean") setShowVial(s.showVial);
    if (typeof s.showVialFrame === "boolean") setShowVialFrame(s.showVialFrame);
    if (s.projector) setProjector(s.projector);
    if (s.basePitch != null) setBasePitch(s.basePitch);
    if (s.resolution != null) setResolution(s.resolution);
    if (s.videoRpm != null) setVideoRpm(s.videoRpm);
    if (s.videoDurMin != null) setVideoDurMin(s.videoDurMin);
    if (s.framesPerDeg != null) setFramesPerDeg(s.framesPerDeg);
    if (s.videoCodec) setVideoCodec(s.videoCodec);
    // saveSinogram intentionally NOT restored — the .tomo save is a per-run choice, off by default
    if (s.method) setMethod(s.method);
    if (s.nIter != null) setNIter(s.nIter);
    if (s.dH != null) setDH(s.dH);
    if (s.dL != null) setDL(s.dL);
    if (s.learningRate != null) setLearningRate(s.learningRate);
    if (s.bclpEps != null) setBclpEps(s.bclpEps);
    if (s.bclpWeight != null) setBclpWeight(s.bclpWeight);
    if (s.absorption != null) setAbsorption(s.absorption);
    if (s.diffusion != null) setDiffusion(s.diffusion);
    if (s.slab) setSlab(s.slab);
    if (s.fanBeam != null) setFanBeam(s.fanBeam);
    if (s.autoScaleSuggest != null) setAutoScaleSuggest(s.autoScaleSuggest);
    if (s.verboseOpt != null) setVerboseOpt(s.verboseOpt);
  }
  function collectSettings() {
    return { materials, materialId, projectors, projector, vials, vial, cylinder, showVial, showVialFrame, basePitch, resolution,
      videoRpm, videoDurMin, framesPerDeg, videoCodec,
      method, nIter, dH, dL, learningRate, bclpEps, bclpWeight,
      absorption, diffusion, slab, fanBeam, autoScaleSuggest, verboseOpt };
  }
  useEffect(() => {
    try { applySettings(JSON.parse(localStorage.getItem("tomo_settings") || "null")); }
    catch (e) { console.warn("settings load failed", e); }
    settingsLoaded.current = true;
  }, []);
  useEffect(() => {
    if (!settingsLoaded.current) return;
    try { localStorage.setItem("tomo_settings", JSON.stringify(collectSettings())); } catch (e) { /* quota/private */ }
  }, [materials, materialId, projectors, projector, vials, vial, cylinder, showVial, showVialFrame, basePitch, resolution, videoRpm, videoDurMin, framesPerDeg, videoCodec, method, nIter, dH, dL, learningRate, bclpEps, bclpWeight, absorption, diffusion, slab, fanBeam, autoScaleSuggest, verboseOpt]);
  const RESIN_RI = activeMaterial?.index || 1.51;  // resin refractive index (from the active material)
  // Usable print radius: refraction at the curved vial wall limits reach to ~vial_radius / n
  const printRadius = fanBeam ? cylinder.radius / RESIN_RI : cylinder.radius;
  // Part volume as a % of the printable cylinder (radius=printRadius, full height).
  // fill_pct is occupied/grid; the z height cancels, leaving an area ratio.
  const printableFillPct = (voxInfo && voxInfo.fill_pct != null && printRadius > 0 && voxMeshRes > 0)
    ? ((voxInfo.fill_pct / 100) * voxInfo.x * voxInfo.y) / (Math.PI * Math.pow(printRadius / voxMeshRes, 2)) * 100
    : null;
  const step = tab;                                 // wizard step (0..4); reuse tab state
  const setStep = setTab;
  const activeModel = models[activeIdx] || null;

  const realDims = activeModel && activeModel.native_bounds ? {
    x: (activeModel.native_bounds.x_mm * xform.sx).toFixed(2),
    y: (activeModel.native_bounds.y_mm * xform.sy).toFixed(2),
    z: (activeModel.native_bounds.z_mm * xform.sz).toFixed(2),
  } : null;

  const changeTool = (t) => { setActiveTool(t); viewerRef.current?.setTool(t); };
  const resetTransform = () => { viewerRef.current?.resetTransform(); };

  const handleGizmoChange = (t) => {
    if (activeModel) {
      setXform({ ...t, changeOrigin: "gizmo" });
      setMatrices(prev => ({ ...prev, [activeModel.id]: t.matrix }));
    }
  };

  const handleInputChange = (field, value) => {
    setXform(prev => {
      const next = { ...prev, [field]: value, changeOrigin: "input" };
      const m = new THREE.Matrix4();
      m.compose(
        new THREE.Vector3(next.tx, next.ty, next.tz),
        new THREE.Quaternion().setFromEuler(new THREE.Euler(
          THREE.MathUtils.degToRad(next.rx),
          THREE.MathUtils.degToRad(next.ry),
          THREE.MathUtils.degToRad(next.rz)
        )),
        new THREE.Vector3(next.sx, next.sy, next.sz)
      );
      if (activeModel) {
        setMatrices(prevMat => ({ ...prevMat, [activeModel.id]: [...m.elements] }));
      }
      return next;
    });
  };

  // Re-center the active model in the vial (zero its translation, keep rotation/scale)
  const autoCenter = () => {
    if (!activeModel) return;
    setXform(prev => {
      const next = { ...prev, tx: 0, ty: 0, tz: 0, changeOrigin: "input" };
      const m = new THREE.Matrix4();
      m.compose(
        new THREE.Vector3(0, 0, 0),
        new THREE.Quaternion().setFromEuler(new THREE.Euler(
          THREE.MathUtils.degToRad(next.rx), THREE.MathUtils.degToRad(next.ry), THREE.MathUtils.degToRad(next.rz))),
        new THREE.Vector3(next.sx, next.sy, next.sz));
      setMatrices(pm => ({ ...pm, [activeModel.id]: [...m.elements] }));
      return next;
    });
  };

  const selectVial = (id) => {
    setVial(id);
    const v = vials.find(x => x.id === id);
    if (v) setCylinder({ radius: v.radius, height: v.height });
  };
  const openAddVial = () => {
    setEditingVialId(null);
    setVialDraft({ name: `Vial ${vials.length + 1}`, radius: 25, height: 80 });
    setVialModal(true);
  };
  const openEditVial = () => {
    if (!activeVial) return;
    setEditingVialId(activeVial.id);
    setVialDraft({ ...activeVial });
    setVialModal(true);
  };
  const createVial = () => {
    const d = vialDraft;
    if (!d || !d.name.trim()) return;
    if (editingVialId) {
      setVials(vs => vs.map(v => (v.id === editingVialId ? { ...v, ...d } : v)));
      if (vial === editingVialId) setCylinder({ radius: d.radius, height: d.height });
    } else {
      const id = "vial_" + Date.now();
      setVials(vs => [...vs, { id, ...d }]);
      setVial(id);
      setCylinder({ radius: d.radius, height: d.height });
    }
    setVialModal(false);
  };
  const selectProjector = (id) => {
    setProjector(id);
    const p = projectors.find(v => v.id === id);
    if (p && p.pitchUm != null) { const r = p.pitchUm / 1000; setBasePitch(r); setVoxScale(1); setResolution(r); }
  };
  const openAddProjector = () => {
    setEditingProjectorId(null);
    setProjectorDraft({ name: `Projector ${projectors.length + 1}`, pxW: 1080, pxH: 1920, pitchUm: 90, telecentric: true, throwRatio: 1.5 });
    setProjectorModal(true);
  };
  const openEditProjector = () => {
    if (!activeProjector) return;
    setEditingProjectorId(activeProjector.id);
    setProjectorDraft({ ...activeProjector });
    setProjectorModal(true);
  };
  const createProjector = () => {
    const d = projectorDraft;
    if (!d || !d.name.trim()) return;
    if (editingProjectorId) {
      setProjectors(ps => ps.map(p => (p.id === editingProjectorId ? { ...p, ...d } : p)));
      if (projector === editingProjectorId && d.pitchUm) { const r = d.pitchUm / 1000; setBasePitch(r); setVoxScale(1); setResolution(r); }
    } else {
      const id = "proj_" + Date.now();
      setProjectors(ps => [...ps, { id, ...d }]);
      setProjector(id);
      const r = d.pitchUm / 1000; setBasePitch(r); setVoxScale(1); setResolution(r);
    }
    setProjectorModal(false);
  };
  // -- materials --
  const selectMaterial = (id) => {
    setMaterialId(id);
    const m = materials.find(x => x.id === id);
    if (m) { setAbsorption(!!m.absorption); setDiffusion(!!m.diffusion); }   // index applies via activeMaterial
  };
  const openAddMaterial = () => {
    setEditingMaterialId(null);
    setMaterialDraft({ name: `Material ${materials.length + 1}`, index: 1.51, absorption: false, absorptionCoeff: 0.33, diffusion: false, diffusionCoeff: 1e-4 });
    setMaterialModal(true);
  };
  const openEditMaterial = () => {
    if (!activeMaterial) return;
    setEditingMaterialId(activeMaterial.id);
    setMaterialDraft({ ...activeMaterial });
    setMaterialModal(true);
  };
  const createMaterial = () => {
    const d = materialDraft;
    if (!d || !d.name.trim()) return;
    if (editingMaterialId) {                                   // editing an existing material
      setMaterials(ms => ms.map(m => (m.id === editingMaterialId ? { ...m, ...d } : m)));
    } else {                                                   // new material
      const id = "mat_" + Date.now();
      setMaterials(ms => [...ms, { id, ...d }]);
      setMaterialId(id);
    }
    setAbsorption(!!d.absorption); setDiffusion(!!d.diffusion);
    setMaterialModal(false);
  };
  // Resolution scale: pitch = basePitch / scale (scale<1 -> coarser/faster).
  const setScale = (s) => {
    const sc = Math.max(0.1, Math.min(1, s));
    setVoxScale(sc);
    setResolution(basePitch / sc);
  };
  const setCustomBase = (v) => {
    const b = Math.max(0.01, v);
    setBasePitch(b);
    setResolution(b / voxScale);
  };

  // Scale input writer — honours the uniform-scale lock (sets all axes together)
  const setScaleAxis = (axis, val) => {
    if (!activeModel) return;
    setXform(prev => {
      const next = { ...prev, changeOrigin: "input" };
      if (scaleLock) { next.sx = val; next.sy = val; next.sz = val; }
      else { next[axis] = val; }
      const m = new THREE.Matrix4();
      m.compose(
        new THREE.Vector3(next.tx, next.ty, next.tz),
        new THREE.Quaternion().setFromEuler(new THREE.Euler(
          THREE.MathUtils.degToRad(next.rx), THREE.MathUtils.degToRad(next.ry), THREE.MathUtils.degToRad(next.rz))),
        new THREE.Vector3(next.sx, next.sy, next.sz));
      setMatrices(pm => ({ ...pm, [activeModel.id]: [...m.elements] }));
      return next;
    });
  };

  // True footprint of the active model in the viewer's world frame.  The viewer
  // is Y-up with the vial axis along Y (geometry has rotateX(-90°) baked in), so
  // the vial cross-section is the X–Z plane.  Returns the max radius from the
  // vial axis and the Y (height) extent, sampled from the actual mesh vertices.
  function computeFootprint(xf) {
    const verts = activeModel?.vertices;
    if (!verts || verts.length < 3) return null;
    const m = new THREE.Matrix4().compose(
      new THREE.Vector3(xf.tx, xf.ty, xf.tz),
      new THREE.Quaternion().setFromEuler(new THREE.Euler(
        THREE.MathUtils.degToRad(xf.rx), THREE.MathUtils.degToRad(xf.ry), THREE.MathUtils.degToRad(xf.rz))),
      new THREE.Vector3(xf.sx, xf.sy, xf.sz));
    m.multiply(new THREE.Matrix4().makeRotationX(-Math.PI / 2));
    const nV = verts.length / 3;
    const stride = Math.max(1, Math.floor(nV / 6000));   // sample for speed
    const v = new THREE.Vector3();
    let maxR = 0, xMin = Infinity, xMax = -Infinity, zMin = Infinity, zMax = -Infinity, yMin = Infinity, yMax = -Infinity;
    for (let i = 0; i < nV; i += stride) {
      v.set(verts[i * 3], verts[i * 3 + 1], verts[i * 3 + 2]).applyMatrix4(m);
      const r = Math.hypot(v.x, v.z);
      if (r > maxR) maxR = r;
      if (v.x < xMin) xMin = v.x; if (v.x > xMax) xMax = v.x;
      if (v.z < zMin) zMin = v.z; if (v.z > zMax) zMax = v.z;
      if (v.y < yMin) yMin = v.y;
      if (v.y > yMax) yMax = v.y;
    }
    // radius = circumscribed (for the circular print-boundary checks); the X/Z box
    // (cross-section) drives the voxel grid, which is sized to the XY diagonal.
    return { radius: maxR, xMin, xMax, zMin, zMax, yMin, yMax, height: yMax - yMin };
  }

  // Auto-center + uniform auto-scale to the largest fit inside the printable
  // window (print-boundary radius in X–Z, vial height in Y), at 95% so a small
  // nudge afterward doesn't immediately read as out-of-bounds.
  const autoScale = () => {
    if (!activeModel?.vertices) return;
    const fp = computeFootprint({ tx: 0, ty: 0, tz: 0, rx: xform.rx, ry: xform.ry, rz: xform.rz, sx: 1, sy: 1, sz: 1 });
    if (!fp) return;
    const sXY = fp.radius > 0 ? printRadius / fp.radius : 1;
    const sZ = fp.height > 0 ? cylinder.height / fp.height : 1;
    const s = Math.max(0.001, Math.min(sXY, sZ) * 0.95);
    setXform(prev => {
      const next = { ...prev, tx: 0, ty: 0, tz: 0, sx: s, sy: s, sz: s, changeOrigin: "input" };
      const m = new THREE.Matrix4();
      m.compose(new THREE.Vector3(0, 0, 0),
        new THREE.Quaternion().setFromEuler(new THREE.Euler(
          THREE.MathUtils.degToRad(next.rx), THREE.MathUtils.degToRad(next.ry), THREE.MathUtils.degToRad(next.rz))),
        new THREE.Vector3(s, s, s));
      setMatrices(pm => ({ ...pm, [activeModel.id]: [...m.elements] }));
      return next;
    });
  };

  // Slicer-style keyboard shortcuts for the transform tools
  useEffect(() => {
    const onKey = (e) => {
      const tag = e.target.tagName;
      if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA") return;
      const k = e.key.toLowerCase();
      if (k === "w") changeTool("translate");
      else if (k === "e") changeTool("rotate");
      else if (k === "r") changeTool("scale");
      else if (k === "q") changeTool("none");
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  function applyLoaded(data) {
    const newModel = { id: data.model_id, filename: data.filename, vertices: data.vertices, normals: data.normals, native_bounds: data.native_bounds };
    setModels(prev => { const next = [...prev, newModel]; setActiveIdx(next.length - 1); return next; });
    setMatrices(prev => ({ ...prev, [data.model_id]: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] }));
    setVoxStatus("idle"); setVoxInfo(null); setVoxelData(null); setMeshData(null);
    setSliceStatus("idle"); setSliceInfo(null);
    setStep(prev => (prev < 1 ? 1 : prev));
  }

  async function openFile() {
    if (isImporting) return;
    setIsImporting(true);
    try {
      const data = await fetch(`${API}/open_stl_dialog`, { method: "POST" }).then(r => r.json());
      if (data.status === "ok") {
        if (Array.isArray(data.models)) data.models.forEach(applyLoaded);   // multi-select
        else applyLoaded(data);
      }
    } catch (e) { console.error(e); } finally { setIsImporting(false); }
  }

  async function removeActiveModel() {
    const m = models[activeIdx];
    if (!m) return;
    try { await fetch(`${API}/remove_model`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ model_id: m.id }) }); } catch (e) { /* noop */ }
    setMatrices(prev => { const n = { ...prev }; delete n[m.id]; return n; });
    setModels(prev => {
      const next = prev.filter(x => x.id !== m.id);
      setActiveIdx(next.length ? Math.min(activeIdx, next.length - 1) : -1);
      return next;
    });
  }

  async function loadStlPath(path) {
    if (isImporting) return;
    setIsImporting(true);
    try {
      const data = await fetch(`${API}/load_stl`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path }) }).then(r => r.json());
      if (data.status === "ok") applyLoaded(data);
    } catch (e) { console.error(e); } finally { setIsImporting(false); }
  }

  const onDrop = (e) => {
    e.preventDefault(); setDragOver(false);
    if (!(step === 1 && !hasModel)) return;   // only on the Model step, before a model is loaded
    const f = e.dataTransfer.files && e.dataTransfer.files[0];
    if (f && f.path && /\.(stl|3mf)$/i.test(f.name)) loadStlPath(f.path);
  };

  async function startVoxelize() {
    voxCancelRef.current = false;
    setVoxMeshRes(resolution);   // the displayed mesh will be at this pitch; stays fixed while the slider moves
    setVoxStatus("running"); setVoxPct(0); setVoxInfo(null); setVoxelData(null); setMeshData(null); setVoxError("");
    setVoxProgress(0); setVoxStage("Voxelizing"); setVoxGrid(null); setVoxEta(0); setVoxNote("");
    setSliceStatus("idle"); setSliceInfo(null);
    try {
      const liveMatrices = viewerRef.current?.getAllMatrices?.() ?? matrices;
      setMatrices(prev => ({ ...prev, ...liveMatrices }));

      const d = await fetch(`${API}/start_voxelize`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ resolution: resolution, matrices: liveMatrices }),
      }).then(r => r.json());
      if (voxCancelRef.current) return;
      if (d.status === "started") {
        setVoxGrid(d.grid || null);
        if (d.res_bumped) setVoxNote(`Grid capped: using ${(d.eff_res * 1000).toFixed(0)} µm instead of ${(d.requested_res * 1000).toFixed(0)} µm to keep the grid at ${d.grid ? d.grid.join("×") : ""} (the part is large for this pitch).`);
        pollVoxelize();
      } else if (d.status === "ok") {           // legacy synchronous path
        setVoxStatus("done"); setVoxInfo(d.voxel_info); setTimeout(fetchVoxelData, 0);
      } else if (d.status === "busy") {
        // A previous (cancelled) voxelize can't be interrupted mid-op, so it's still
        // finishing.  Wait for it to exit, then start FRESH with the current settings
        // (don't track the old job — that's what looked like it "resumed").
        setVoxStage("Finishing previous voxelize…"); setVoxProgress(0); setVoxGrid(null);
        let fails = 0;
        const iv = setInterval(async () => {
          if (voxCancelRef.current) { clearInterval(iv); return; }
          try {
            const p = await fetch(`${API}/poll`).then(r => r.json());
            fails = 0;
            if (!p.vox_running) { clearInterval(iv); startVoxelize(); }   // free now — restart with new settings
          } catch { if (++fails >= 4) { clearInterval(iv); setVoxStatus("error"); setVoxError("Lost connection to backend"); } }
        }, 500);
      } else { setVoxStatus("error"); setVoxError(d.message || `Voxelize failed (${d.status || "unknown"})`); }
    } catch (e) { if (!voxCancelRef.current) { setVoxStatus("error"); setVoxError(String(e)); } }
  }

  function pollVoxelize() {
    let fails = 0;   // tolerate transient poll failures (e.g. a wifi/network-stack blip) — only give up after several in a row
    const iv = setInterval(async () => {
      if (voxCancelRef.current) { clearInterval(iv); return; }
      try {
        const d = await fetch(`${API}/poll`).then(r => r.json());
        fails = 0;
        // Voxelize fills the first 85% of the bar; the preview-mesh build fills 85–100%.
        setVoxProgress((d.vox_progress || 0) * 0.85);
        setVoxStage(d.vox_stage || "Voxelizing");
        setVoxEta((d.vox_eta_s || 0) + (voxEstimate?.meshSecs || 0));   // include the mesh build
        if (d.vox_grid) setVoxGrid(d.vox_grid);
        if (d.vox_error) { clearInterval(iv); setVoxStatus("error"); setVoxError(d.vox_error); }
        else if (d.vox_done) {
          // Voxelize done — keep the overlay up and animate the mesh-build phase so
          // there's no "stuck at 100% for 30 s" gap before the preview appears.
          clearInterval(iv); setVoxInfo(d.voxel_info);
          runMeshingPhase(d.voxel_info);
        }
      } catch { if (++fails >= 4) { clearInterval(iv); setVoxStatus("error"); setVoxError("Lost connection to backend"); } }
    }, 400);
  }

  function runMeshingPhase(info) {
    // The preview mesh (marching-cubes + serialize) is a separate ~10–30 s step after
    // voxelize.  Animate the bar 85→100% over its estimate so it isn't "stuck".
    const n = info ? info.x * info.y * info.z : 1e8;
    const meshEst = Math.max(3, Math.min(n, 120e6) / 4e6);
    setVoxStage("Building preview mesh…");
    setVoxProgress(0.85);
    const t0 = Date.now();
    const mi = setInterval(() => {
      const f = 1 - Math.exp(-(Date.now() - t0) / 1000 / meshEst);   // asymptotic — approaches 100% smoothly
      setVoxProgress(0.85 + 0.145 * f);
      setVoxEta(Math.max(0, meshEst - (Date.now() - t0) / 1000));
    }, 200);
    fetchVoxelData().finally(() => { clearInterval(mi); setVoxProgress(1); });
  }

  function cancelVoxelize() {
    voxCancelRef.current = true;
    fetch(`${API}/cancel_voxelize`, { method: "POST" }).catch(() => {});
    setVoxStatus("idle"); setVoxError("");
  }

  async function fetchVoxelData(full = fullResMesh) {
    // The Optimize view shows a smooth marching-cubes surface mesh of the voxelized
    // target (from /api/mesh_preview).  full=1 → no decimation (true full resolution).
    try {
      const res = await fetch(`${API}/mesh_preview?t=${Date.now()}&full=${full ? 1 : 0}`);
      const d = await res.json();
      if (d.status === "ok") {
        if (d.too_large) {                 // full-res mesh would be too heavy — fall back
          setVoxNote(`Full-resolution mesh is too large to display (${(d.n_faces / 1e6).toFixed(1)} M triangles). Showing the adaptive preview instead.`);
          setFullResMesh(false);
          await fetchVoxelData(false);
          return;
        }
        setMeshData({ vertices: d.vertices, normals: d.normals, indices: d.indices });
        setMeshInfo({ display_dim: d.display_dim, full_grid: d.full_grid, step: d.step });
        setMeshGen(g => g + 1);   // force the viewer to rebuild with the new mesh
      }
    } catch (e) { console.error(e); }
    finally { setVoxStatus("done"); }   // drop the loading screen only once the mesh is ready
  }

  function toggleFullRes(v) {
    setFullResMesh(v);
    if (meshData && voxStatus === "done") {   // re-render the current voxel grid at the new detail
      setVoxStatus("running"); setVoxProgress(1);
      setVoxStage(v ? "Rendering full-resolution preview…" : "Rendering preview…");
      fetchVoxelData(v);
    }
  }

  async function startSlice() {
    setSliceStatus("running"); setSlicePct(0); setSliceInfo(null);
    setSliceProgress(0); setSliceStage("starting"); setLossHistory([]); setVerboseFrameOk(false);
    try {
      const res = await fetch(`${API}/start_slice`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ n_iter: nIter, d_h: dH, d_l: dL, filter: "hamming", cuda: cudaEnabled,
                               learning_rate: learningRate, eps: bclpEps, weight: bclpWeight,
                               method, absorption, diffusion: diffusion && method === "BCLP", slab, verbose: verboseOpt,
                               vial_radius_mm: cylinder.radius,
                               resin_ri: activeMaterial.index, diffusion_coeff: activeMaterial.diffusionCoeff,
                               absorption_coeff: activeMaterial.absorptionCoeff,
                               vial_correction: fanBeam,
                               proj_px_w: activeProjector.pxW, proj_px_h: activeProjector.pxH,
                               proj_width: activeProjector.pxW * activeProjector.pitchUm / 1000,
                               telecentric: activeProjector.telecentric !== false,
                               throw_ratio: activeProjector.throwRatio,
                               video_fps: videoFps, video_rpm: videoRpm,
                               video_duration_s: videoDurMin * 60, video_codec: videoCodec }),
      });
      const d = await res.json();
      if (d.status === "started" || d.status === "ok") pollSlice();
      else if (d.status === "busy") { setSliceStatus("idle"); setSliceStage("Previous run still finishing — try again in a moment."); }
      else setSliceStatus("error");
    } catch { setSliceStatus("error"); }
  }

  async function cancelSlice() {
    // Tell the backend to stop, then let the running pollSlice loop flip us to idle once
    // the worker thread has ACTUALLY stopped — so a rerun isn't rejected as busy.
    setSliceStatus("cancelling"); setSliceStage("Cancelling…");
    try { await fetch(`${API}/cancel_slice`, { method: "POST" }); } catch (e) { /* noop */ }
  }

  function pollSlice() {
    let fails = 0;   // tolerate transient poll failures (e.g. a wifi/network-stack blip) before giving up
    const iv = setInterval(async () => {
      try {
        const d = await fetch(`${API}/poll`).then(r => r.json());
        fails = 0;
        setSliceProgress(d.slice_progress || 0);
        setSliceStage(d.slice_stage || "");
        if (Array.isArray(d.slice_loss) && d.slice_loss.length) setLossHistory(d.slice_loss);
        if (verboseOpt) setVerboseStamp(Date.now());   // refresh the BCLP verbose figure
        if (d.slice_done) {
          clearInterval(iv);
          setSliceStatus("done");
          setSliceInfo(d.slice_info);
          setVideoStamp(Date.now());
          try {
            const info = await fetch(`${API}/preview_info`).then(r => r.json());
            if (info.status === "ok") {
              setPreviewFrame(0);
              setPreviewInfo({ frame_count: info.frame_count, fps: info.fps });
            }
          } catch (e) { console.error("preview_info fetch failed", e); }
          setStep(4);   // auto-advance to the Output page when optimization finishes
        }
        else if (d.slice_error) { clearInterval(iv); setSliceStatus("error"); }
        else if (!d.slice_running) { clearInterval(iv); setSliceStatus("idle"); setSliceStage(""); setSliceProgress(0); }  // cancelled / stopped
      } catch { if (++fails >= 4) { clearInterval(iv); setSliceStatus("error"); } }
    }, 400);
  }

  async function handleDownloadMp4() {
    setSavingRun(true);   // the full video is encoded on demand here, so show progress
    try {
      const res = await fetch(`${API}/download_mp4`, { method: "POST" });
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url; a.download = "Tomo_Output.mp4"; a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      console.error("Download failed:", e);
    } finally {
      setSavingRun(false);
    }
  }

  function startNewPart() {
    fetch(`${API}/reset`, { method: "POST" }).catch(() => {});
    setModels([]); setActiveIdx(-1); setMatrices({});
    setVoxStatus("idle"); setVoxInfo(null); setVoxelData(null); setMeshData(null); setVoxError("");
    setSliceStatus("idle"); setSliceInfo(null); setPreviewInfo(null);
    setXform({ tx: 0, ty: 0, tz: 0, rx: 0, ry: 0, rz: 0, sx: 1, sy: 1, sz: 1, changeOrigin: "gizmo" });
    setVoxScale(1.0); setActiveTool("none"); setStep(0);
  }

  async function handleDownloadRun() {
    // ONE native Save dialog (for the .mp4 location); the backend writes the .json
    // (and optionally the .npy sinogram) beside it with the same base name.  Default
    // name = the loaded STL's name + rotation rate.
    setSavingRun(true);
    const stlName = ((models[activeIdx] || models[0])?.filename || "Tomo_run")
      .replace(/\.stl$/i, "").replace(/[^\w.\-]+/g, "_");
    const base = `${stlName}_${videoRpm}rpm`;
    try {
      const res = await fetch(`${API}/save_run`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ default_name: base, save_sinogram: saveSinogram, video_intensity: videoIntensity,
                               video_rpm: videoRpm, video_fps: videoFps, video_duration_s: videoDurMin * 60,
                               gui_settings: collectSettings() }),   // embedded in the .tomo for reload
      });
      const d = await res.json();
      if (d.status === "error") alert("Save failed: " + (d.message || "unknown error"));
    } catch (e) { console.error("save run failed", e); }
    setSavingRun(false);
  }

  async function handleExportVoxels(field) {
    // field: "target" (binary voxel grid, lossless round-trip) or "dose" (optimized
    // dose field, for inspection).  One native Save dialog, backend writes the .3mf.
    const stlName = ((models[activeIdx] || models[0])?.filename || "Tomo")
      .replace(/\.(stl|3mf)$/i, "").replace(/[^\w.\-]+/g, "_");
    try {
      const res = await fetch(`${API}/export_voxels_3mf`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ field, default_name: stlName }),
      });
      const d = await res.json();
      if (d.status === "cancelled") return;
      if (d.status !== "ok") { alert("3MF export failed: " + (d.message || "unknown error")); return; }
      console.log("exported 3MF:", d.saved, d.shape);
    } catch (e) { console.error("export voxels failed", e); alert("3MF export failed"); }
  }

  async function handleLoadRun() {
    try {
      const res = await fetch(`${API}/load_run`, { method: "POST" });
      const d = await res.json();
      if (d.status === "cancelled") return;
      if (d.status !== "ok") { alert("Load failed: " + (d.message || "unknown error")); return; }
      if (d.gui_settings) applySettings(d.gui_settings);          // restore the whole GUI state
      setSliceInfo({ angles: 0, frames: 0, dose: d.dose });
      setSliceStatus("done");
      setVideoStamp(Date.now());
      try {
        const info = await fetch(`${API}/preview_info`).then(r => r.json());
        if (info.status === "ok") { setPreviewFrame(0); setPreviewInfo({ frame_count: info.frame_count, fps: info.fps }); }
      } catch (e) { /* noop */ }
      setStep(4);                                                 // jump to the Output page
    } catch (e) { console.error("load run failed", e); alert("Load failed"); }
  }

  async function handleExportLog() {
    try {
      const res = await fetch(`${API}/export_log`, { method: "POST" });
      if (!res.ok) return;
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      const d = new Date(), p = n => String(n).padStart(2, "0");
      const ts = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
      a.href = url; a.download = `${ts}-tomolog.log`; a.click();   // e.g. 20260609-153720-tomolog.log
      URL.revokeObjectURL(url);
    } catch (e) { console.error("export log failed", e); }
  }

  async function handleSaveVerbose() {
    try {
      const res = await fetch(`${API}/download_verbose`, { method: "POST" });
      if (!res.ok) { alert("No verbose figure to save — run an optimize with Verbose enabled."); return; }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url; a.download = "Tomo_convergence.png"; a.click();
      URL.revokeObjectURL(url);
    } catch (e) { console.error("save verbose failed", e); }
  }

  // Vertical (Z) projection offset: update the value live, debounce the backend
  // regenerate (which rebuilds the preview frames + the eventual saved video).
  function applyZOffset(mm) {
    setZOffsetMm(mm);
    if (zOffsetTimer.current) clearTimeout(zOffsetTimer.current);
    zOffsetTimer.current = setTimeout(async () => {
      // Show a loading overlay ONLY if the regenerate is slow (>2s) — quick moves don't flash it.
      const slow = setTimeout(() => setZOffsetLoading(true), 2000);
      try {
        const r = await fetch(`${API}/update_video_config`, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ v_offset_mm: mm }),
        });
        if (r.ok) setVideoStamp(Date.now());   // frames regenerated — refresh the preview
      } catch (e) { console.error("z-offset update failed", e); }
      finally { clearTimeout(slow); setZOffsetLoading(false); }
    }, 250);
  }

  function handleExportSettings() {
    const blob = new Blob([JSON.stringify(collectSettings(), null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = "tomo_settings.json"; a.click();
    URL.revokeObjectURL(url);
  }
  function handleImportSettings(e) {
    const f = e.target.files && e.target.files[0];
    if (!f) return;
    const r = new FileReader();
    r.onload = () => { try { applySettings(JSON.parse(r.result)); } catch (err) { alert("Invalid settings file"); } };
    r.readAsText(f);
    e.target.value = "";
  }

  useEffect(() => {
    if (activeModel && viewerRef.current) viewerRef.current.requestSyncForId(activeModel.id);
  }, [activeIdx]);

  const hasModel = models.length > 0;
  const LP = 300;
  const TOOLS = [["none", "Select"], ["translate", "Move"], ["rotate", "Rotate"], ["scale", "Scale"]];
  const selInput = { width: "100%", background: "#16161f", color: C.text, border: `1px solid ${C.border}`, padding: 6, borderRadius: 4, fontSize: 12 };
  const infoPop = { fontSize: 11, color: C.muted, marginTop: 6, lineHeight: 1.5, background: C.bgT, padding: 8, borderRadius: 5 };
  const infoTog = (k) => () => setInfoOpen(infoOpen === k ? "" : k);   // toggle an info popover
  const STEPS = ["Vial", "Model", "Voxelize", "Optimize", "Output"];
  let maxStep = 1;
  if (hasModel) maxStep = 2;
  if (voxStatus === "done") maxStep = 3;
  if (sliceStatus === "done") maxStep = 4;
  const canAdvance = (step + 1) <= maxStep;

  const loading = isImporting || voxStatus === "running";
  const loadingLabel = voxStatus === "running" ? "Voxelizing…" : "Loading model…";
  // True out-of-bounds from the actual mesh footprint (recomputed only when the
  // active model or its transform changes).
  const footprint = useMemo(() => computeFootprint(xform), [activeModel, xform]);
  const outOfBounds = !!footprint && (
    footprint.radius > printRadius + 0.5 ||
    footprint.yMax > cylinder.height / 2 + 0.5 ||
    footprint.yMin < -cylinder.height / 2 - 0.5
  );
  const fmtT = (s) => (s < 1 ? "<1s" : s < 60 ? `${Math.ceil(s)}s` : `${(s / 60).toFixed(1)} min`);
  // Pre-click voxelize estimate: origin-centred grid ~2·footprint radius (XY) ×
  // height (Z) at the chosen pitch; rate calibrated end-to-end (~9 M vox/s).
  const voxEstimate = useMemo(() => {
    if (!footprint || resolution <= 0) return null;
    // Match the slicer: XY grid = floor(diagonal/pitch) + 2*round(offset/pitch) + 1.
    const Lx = footprint.xMax - footprint.xMin, Lz = footprint.zMax - footprint.zMin;
    const diag = Math.hypot(Lx, Lz);
    const off = Math.max(Math.abs((footprint.xMin + footprint.xMax) / 2), Math.abs((footprint.zMin + footprint.zMax) / 2));
    const xy = Math.floor(diag / resolution) + 2 * Math.round(off / resolution) + 1;
    const z = Math.round(footprint.height / resolution);
    const voxels = xy * xy * z;
    // Calibrated piecewise model: ~42 M vox/s, with a memory cliff (~4.2 M vox/s)
    // past ~1.2 B voxels where multi-GB transient copies thrash RAM.
    // Linear ~90 M vox/s on this GPU (a 2.81 B-voxel grid measured ~30 s). The old
    // memory-cliff term is obsolete now that the TargetGeometry float64-meshgrid balloon
    // is fixed. Mesh build runs on the decimated grid (<=120 M voxels), so it's quick.
    const voxSecs = Math.max(2.0, 1.5 + voxels / 120e6);   // ~120 M vox/s warmed + GL warm-up
    const meshSecs = Math.max(2, Math.min(voxels, 120e6) / 30e6);   // marching-cubes on the decimated grid
    return { voxels, dim: [xy, xy, z], secs: voxSecs + meshSecs, voxSecs, meshSecs };
  }, [footprint, resolution]);

  // Suggest a coarser pitch when the grid is large — voxels scale as pitch⁻³, so a
  // small linear down-scale is a big speed win (voxelize AND optimize).  Targets a
  // grid comfortably under the ~1.2 B memory cliff.
  const voxSuggest = useMemo(() => {
    const cuda = cudaEnabled && !!hwInfo?.cuda;
    const ramGb = hwInfo?.ram_gb || 16;
    // The voxelize's transient copies use ~20 bytes/voxel; a grid fits if it stays
    // well under available RAM.  Calibrated so ~2.3 B fits on 67 GB (it does), but a
    // 16–32 GB machine is flagged much sooner.  Also factor optimize speed.
    const ramThreshold = ramGb * 0.035e9;
    const optThreshold = cuda ? 4.0e9 : 0.8e9;
    const threshold = Math.min(ramThreshold, optThreshold);
    const TARGET = Math.min(ramGb * 0.02e9, cuda ? 2.0e9 : 0.5e9);
    if (!autoScaleSuggest || !voxEstimate || voxEstimate.voxels <= threshold) return null;
    const scale = Math.cbrt(TARGET / voxEstimate.voxels);     // linear scale (<1)
    const newPitch = resolution / scale;                      // coarser pitch (mm)
    const newSecs = Math.max(2.0, 1.5 + TARGET / 120e6);   // ~120 M vox/s warmed + GL warm-up
    const ramBound = voxEstimate.voxels > ramThreshold;
    return { scale, newPitch, newVox: TARGET, newSecs, speedup: voxEstimate.secs / newSecs, cuda, ramBound };
  }, [voxEstimate, resolution, hwInfo, autoScaleSuggest, cudaEnabled]);

  return (
    <div style={{ height: "100vh", background: C.bg, color: C.text, fontFamily: "system-ui,sans-serif", display: "flex", overflow: "hidden", flexDirection: "column", position: "relative" }}>
      <style>{`@keyframes tomoslide{0%{left:-40%}100%{left:100%}}@keyframes tomospin{to{transform:rotate(360deg)}}`}</style>

      {!backendReady && (
        <div style={{ position: "absolute", inset: 0, zIndex: 100, background: C.bg, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 18 }}>
          <img src={tomoLogo} alt="" style={{ height: 110, filter: "invert(1)", opacity: 0.95 }} />
          <div style={{ fontSize: 22, fontWeight: 800, color: "#fff", letterSpacing: ".06em" }}>Tomo</div>
          <div style={{ width: 34, height: 34, border: `3px solid ${C.border}`, borderTopColor: C.blue, borderRadius: "50%", animation: "tomospin 0.8s linear infinite" }} />
          <div style={{ fontSize: 12, color: C.muted }}>Starting engine… (first launch can take ~20–30 s)</div>
        </div>
      )}

      {materialModal && materialDraft && (
        <div style={{ position: "absolute", inset: 0, zIndex: 200, background: "rgba(0,0,0,0.6)", display: "flex", alignItems: "center", justifyContent: "center" }} onClick={() => setMaterialModal(false)}>
          <div onClick={e => e.stopPropagation()} style={{ width: 340, background: C.bgS, border: `1px solid ${C.border}`, borderRadius: 10, padding: 20, boxShadow: "0 16px 48px rgba(0,0,0,0.6)" }}>
            <div style={{ fontSize: 15, fontWeight: 800, color: "#fff", marginBottom: 14 }}>{editingMaterialId ? "Edit material" : "New material"}</div>
            <Lbl>Name</Lbl>
            <input value={materialDraft.name} onChange={e => setMaterialDraft(d => ({ ...d, name: e.target.value }))} autoFocus style={{ width: "100%", background: "#16161f", color: C.text, border: `1px solid ${C.border}`, borderRadius: 4, padding: "5px 8px", fontSize: 12, boxSizing: "border-box", marginBottom: 10 }} />
            <Lbl>Refractive index (n)</Lbl>
            <NumInput step={0.01} value={materialDraft.index} onChange={v => setMaterialDraft(d => ({ ...d, index: Math.max(1, v) }))} />
            <div style={{ display: "flex", gap: 8, alignItems: "flex-end", marginTop: 12 }}>
              <div style={{ flex: 1, paddingBottom: 2 }}><Toggle value={!!materialDraft.absorption} onChange={v => setMaterialDraft(d => ({ ...d, absorption: v }))} label="Absorption" /></div>
              <div style={{ width: 110 }}><Lbl>μ (cm⁻¹)</Lbl><NumInput step={0.01} value={materialDraft.absorptionCoeff} onChange={v => setMaterialDraft(d => ({ ...d, absorptionCoeff: Math.max(0, v) }))} /></div>
            </div>
            <div style={{ display: "flex", gap: 8, alignItems: "flex-end", marginTop: 10 }}>
              <div style={{ flex: 1, paddingBottom: 2 }}><Toggle value={!!materialDraft.diffusion} onChange={v => setMaterialDraft(d => ({ ...d, diffusion: v }))} label="Diffusion" /></div>
              <div style={{ width: 110 }}><Lbl>coeff mm²/s</Lbl><NumInput step={0.0001} value={materialDraft.diffusionCoeff} onChange={v => setMaterialDraft(d => ({ ...d, diffusionCoeff: Math.max(0, v) }))} /></div>
            </div>
            <div style={{ display: "flex", gap: 8, marginTop: 18 }}>
              <Btn onClick={() => setMaterialModal(false)} style={{ flex: 1 }}>Cancel</Btn>
              <Btn variant="primary" onClick={createMaterial} style={{ flex: 1 }}>{editingMaterialId ? "Save changes" : "Create material"}</Btn>
            </div>
          </div>
        </div>
      )}

      {projectorModal && projectorDraft && (
        <div style={{ position: "absolute", inset: 0, zIndex: 200, background: "rgba(0,0,0,0.6)", display: "flex", alignItems: "center", justifyContent: "center" }} onClick={() => setProjectorModal(false)}>
          <div onClick={e => e.stopPropagation()} style={{ width: 340, background: C.bgS, border: `1px solid ${C.border}`, borderRadius: 10, padding: 20, boxShadow: "0 16px 48px rgba(0,0,0,0.6)" }}>
            <div style={{ fontSize: 15, fontWeight: 800, color: "#fff", marginBottom: 14 }}>{editingProjectorId ? "Edit projector" : "New projector"}</div>
            <Lbl>Name</Lbl>
            <input value={projectorDraft.name} onChange={e => setProjectorDraft(d => ({ ...d, name: e.target.value }))} autoFocus style={{ width: "100%", background: "#16161f", color: C.text, border: `1px solid ${C.border}`, borderRadius: 4, padding: "5px 8px", fontSize: 12, boxSizing: "border-box", marginBottom: 10 }} />
            <div style={{ display: "flex", gap: 8 }}>
              <div style={{ flex: 1 }}><Lbl>Width (px)</Lbl><NumInput step={1} value={projectorDraft.pxW} onChange={v => setProjectorDraft(d => ({ ...d, pxW: Math.max(1, Math.round(v)) }))} /></div>
              <div style={{ flex: 1 }}><Lbl>Height (px)</Lbl><NumInput step={1} value={projectorDraft.pxH} onChange={v => setProjectorDraft(d => ({ ...d, pxH: Math.max(1, Math.round(v)) }))} /></div>
            </div>
            <div style={{ marginTop: 10 }}><Lbl>Pixel pitch (µm)</Lbl><NumInput step={1} value={projectorDraft.pitchUm} onChange={v => setProjectorDraft(d => ({ ...d, pitchUm: Math.max(1, v) }))} /></div>
            <div style={{ display: "flex", gap: 8, alignItems: "flex-end", marginTop: 12 }}>
              <div style={{ flex: 1, paddingBottom: 2 }}><Toggle value={projectorDraft.telecentric !== false} onChange={v => setProjectorDraft(d => ({ ...d, telecentric: v }))} label="Telecentric (collimated)" /></div>
              {projectorDraft.telecentric === false &&
                <div style={{ width: 110 }}><Lbl>Throw ratio</Lbl><NumInput step={0.1} value={projectorDraft.throwRatio} onChange={v => setProjectorDraft(d => ({ ...d, throwRatio: Math.max(0.1, v) }))} /></div>}
            </div>
            <div style={{ fontSize: 11, color: C.muted, marginTop: 8, lineHeight: 1.5 }}>
              Build area: <b style={{ color: C.text }}>{(projectorDraft.pxW * projectorDraft.pitchUm / 1000).toFixed(1)} × {(projectorDraft.pxH * projectorDraft.pitchUm / 1000).toFixed(1)} mm</b>. Height is the tall vial axis; pitch sets the print resolution. {projectorDraft.telecentric === false ? "A finite throw ratio models a diverging projector in the vial-correction rebin." : "Telecentric = collimated parallel rays (throw ratio ∞)."}
            </div>
            <div style={{ display: "flex", gap: 8, marginTop: 18 }}>
              <Btn onClick={() => setProjectorModal(false)} style={{ flex: 1 }}>Cancel</Btn>
              <Btn variant="primary" onClick={createProjector} style={{ flex: 1 }}>{editingProjectorId ? "Save changes" : "Create projector"}</Btn>
            </div>
          </div>
        </div>
      )}

      {vialModal && vialDraft && (
        <div style={{ position: "absolute", inset: 0, zIndex: 200, background: "rgba(0,0,0,0.6)", display: "flex", alignItems: "center", justifyContent: "center" }} onClick={() => setVialModal(false)}>
          <div onClick={e => e.stopPropagation()} style={{ width: 340, background: C.bgS, border: `1px solid ${C.border}`, borderRadius: 10, padding: 20, boxShadow: "0 16px 48px rgba(0,0,0,0.6)" }}>
            <div style={{ fontSize: 15, fontWeight: 800, color: "#fff", marginBottom: 14 }}>{editingVialId ? "Edit vial" : "New vial"}</div>
            <Lbl>Name</Lbl>
            <input value={vialDraft.name} onChange={e => setVialDraft(d => ({ ...d, name: e.target.value }))} autoFocus style={{ width: "100%", background: "#16161f", color: C.text, border: `1px solid ${C.border}`, borderRadius: 4, padding: "5px 8px", fontSize: 12, boxSizing: "border-box", marginBottom: 10 }} />
            <div style={{ display: "flex", gap: 8 }}>
              <div style={{ flex: 1 }}><Lbl>Diameter (mm)</Lbl><NumInput value={vialDraft.radius * 2} onChange={v => setVialDraft(d => ({ ...d, radius: Math.max(0.1, v / 2) }))} /></div>
              <div style={{ flex: 1 }}><Lbl>Height (mm)</Lbl><NumInput value={vialDraft.height} onChange={v => setVialDraft(d => ({ ...d, height: Math.max(1, v) }))} /></div>
            </div>
            <div style={{ fontSize: 11, color: C.muted, marginTop: 8, lineHeight: 1.5 }}>
              Inner vial bore the part must fit inside. Inner radius <b style={{ color: C.text }}>{(vialDraft.radius).toFixed(1)} mm</b>.
            </div>
            <div style={{ display: "flex", gap: 8, marginTop: 18 }}>
              <Btn onClick={() => setVialModal(false)} style={{ flex: 1 }}>Cancel</Btn>
              <Btn variant="primary" onClick={createVial} style={{ flex: 1 }}>{editingVialId ? "Save changes" : "Create vial"}</Btn>
            </div>
          </div>
        </div>
      )}

      <div style={{ display: "flex", alignItems: "center", height: 48, padding: "0 150px 0 16px", background: C.bgS, borderBottom: `1px solid ${C.border}`, flexShrink: 0, position: "relative", zIndex: 30, WebkitAppRegion: "drag" }}>
        <img src={tomoLogo} alt="" style={{ height: 30, marginRight: 9, filter: "invert(1)" }} />
        <span style={{ fontWeight: 800, fontSize: 15, color: "#fff" }}>Tomo</span>
        {hasModel
          ? <Btn variant="primary" onClick={startNewPart} style={{ marginLeft: 16, WebkitAppRegion: "no-drag" }}>↺ Start New Part</Btn>
          : <span style={{ fontSize: 11, color: C.muted, marginLeft: 10 }}>Computed Axial Lithography</span>}
        <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 14 }}>
          {activeModel && <span style={{ fontSize: 12, color: C.text, maxWidth: 240, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{activeModel.filename}</span>}
          <button onClick={handleLoadRun} title="Load a saved .tomo run (sinogram + settings)" style={{ background: "#5b34b8", border: "none", color: "#fff", fontSize: 12, fontWeight: 700, padding: "6px 12px", borderRadius: 2, cursor: "pointer", WebkitAppRegion: "no-drag" }}>↧ Load run</button>
          <div ref={materialsRef} style={{ position: "relative" }}>
            <button onClick={() => { setMaterialsOpen(o => !o); setSettingsOpen(false); }} style={{ background: materialsOpen ? "#7a4dd6" : "#5b34b8", border: "none", color: "#fff", fontSize: 12, fontWeight: 700, padding: "6px 12px", borderRadius: 2, cursor: "pointer", WebkitAppRegion: "no-drag" }}>⬢ Materials ▾</button>
            {materialsOpen && (
              <div style={{ position: "absolute", top: 34, right: 0, width: 290, background: C.bgS, border: `1px solid ${C.border}`, borderRadius: 7, padding: 12, boxShadow: "0 10px 28px rgba(0,0,0,0.55)", zIndex: 40, WebkitAppRegion: "no-drag" }}>
                <div style={{ fontSize: 11, fontWeight: 700, color: "#fff", marginBottom: 10, textTransform: "uppercase", letterSpacing: ".05em" }}>Materials</div>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                  <Lbl>Material</Lbl>
                  <span style={{ fontSize: 11, fontWeight: 700, color: C.blue, cursor: "pointer" }}>
                    <span onClick={openEditMaterial}>✎ Edit</span>　<span onClick={openAddMaterial}>+ Add new</span>
                  </span>
                </div>
                <select value={materialId} onChange={e => selectMaterial(e.target.value)} style={{ ...selInput, marginTop: 4 }}>
                  {materials.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}
                </select>
                <div style={{ fontSize: 11, color: C.muted, marginTop: 7, lineHeight: 1.6 }}>
                  n = <b style={{ color: C.text }}>{activeMaterial.index}</b> · absorption <b style={{ color: C.text }}>{activeMaterial.absorption ? `on (μ=${activeMaterial.absorptionCoeff} cm⁻¹)` : "off"}</b> · diffusion <b style={{ color: C.text }}>{activeMaterial.diffusion ? `on (${activeMaterial.diffusionCoeff} mm²/s)` : "off"}</b>
                </div>
              </div>
            )}
          </div>
          <div ref={settingsRef} style={{ position: "relative" }}>
            <button onClick={() => { setSettingsOpen(o => !o); setMaterialsOpen(false); }} style={{ background: settingsOpen ? "#7a4dd6" : "#5b34b8", border: "none", color: "#fff", fontSize: 12, fontWeight: 700, padding: "6px 12px", borderRadius: 2, cursor: "pointer", WebkitAppRegion: "no-drag" }}>⚙ Settings ▾</button>
            {settingsOpen && (
              <div style={{ position: "absolute", top: 34, right: 0, width: 290, background: C.bgS, border: `1px solid ${C.border}`, borderRadius: 7, padding: 12, boxShadow: "0 10px 28px rgba(0,0,0,0.55)", zIndex: 40, WebkitAppRegion: "no-drag", maxHeight: "78vh", overflowY: "auto" }}>
                <div style={{ fontSize: 11, fontWeight: 700, color: "#fff", marginBottom: 10, textTransform: "uppercase", letterSpacing: ".05em" }}>Settings</div>

                <div style={{ display: "flex", alignItems: "center", gap: 6, borderBottom: `1px solid ${C.border}`, paddingBottom: 10, marginBottom: 10 }}>
                  <Toggle value={cudaEnabled && !!hwInfo?.cuda} onChange={setCudaEnabled} disabled={!hwInfo?.cuda} hint={!hwInfo?.cuda ? "(no GPU)" : ""} label="Use GPU (CUDA)" />
                  <span style={{ marginLeft: "auto" }}><InfoBtn open={infoOpen === "s_gpu"} onClick={infoTog("s_gpu")} /></span>
                </div>
                {infoOpen === "s_gpu" && <div style={infoPop}>{hwInfo ? (hwInfo.cuda ? `${hwInfo.gpu || "CUDA GPU"} — on by default (much faster). Turn off to force the CPU projector.` : "CPU-only machine — the GPU projector is unavailable.") : "Detecting GPU…"}</div>}

                <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  <Toggle value={verboseOpt} onChange={setVerboseOpt} label="Verbose optimization output" />
                  <span style={{ marginLeft: "auto" }}><InfoBtn open={infoOpen === "s_verbose"} onClick={infoTog("s_verbose")} /></span>
                </div>
                {infoOpen === "s_verbose" && <div style={infoPop}>Stream live per-iteration dose error and in-part / out-of-part dose to the optimize panel and the debug log (like VAMToolbox's console).</div>}

                <div style={{ borderTop: `1px solid ${C.border}`, marginTop: 10, paddingTop: 10 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                    <Toggle value={autoScaleSuggest} onChange={setAutoScaleSuggest} label="Auto-scale suggestions" />
                    <span style={{ marginLeft: "auto" }}><InfoBtn open={infoOpen === "s_auto"} onClick={infoTog("s_auto")} /></span>
                  </div>
                  {infoOpen === "s_auto" && <div style={infoPop}>Suggest a coarser resolution when a part would be slow. {hwInfo ? (hwInfo.cuda ? `${hwInfo.gpu || "CUDA GPU"} detected — only very large grids are flagged.` : "CPU-only — flagged sooner, since the optimize is much slower.") : ""}</div>}
                  <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 10, borderTop: `1px solid ${C.border}`, paddingTop: 10 }}>
                    <Toggle value={saveSinogram} onChange={setSaveSinogram} label="Also save reloadable project (.tomo)" />
                    <span style={{ marginLeft: "auto" }}><InfoBtn open={infoOpen === "s_tomo"} onClick={infoTog("s_tomo")} /></span>
                  </div>
                  {infoOpen === "s_tomo" && <div style={infoPop}>Save run always writes the .mp4 + .json. Enable this to also save a single reloadable .tomo project (sinogram + reconstruction + all settings) you can re-open later (large).</div>}
                </div>

                <div style={{ borderTop: `1px solid ${C.border}`, marginTop: 10, paddingTop: 10 }}>
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 6 }}><Lbl>Video frames per degree</Lbl><InfoBtn open={infoOpen === "s_fpd"} onClick={infoTog("s_fpd")} /></div>
                    <div style={{ width: 70 }}><NumInput step={1} value={framesPerDeg} onChange={v => setFramesPerDeg(Math.max(1, Math.round(v)))} /></div>
                  </div>
                  {infoOpen === "s_fpd" && <div style={infoPop}>Output sampling. 1 = one projected pattern per degree (default). Playback rate is derived: {framesPerDeg} × 6 × {videoRpm} rpm = {videoFps} fps.</div>}
                </div>

                <div style={{ borderTop: `1px solid ${C.border}`, marginTop: 10, paddingTop: 10 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 6 }}><Lbl>All custom settings</Lbl><InfoBtn open={infoOpen === "s_io"} onClick={infoTog("s_io")} /></div>
                  <div style={{ display: "flex", gap: 8, marginTop: 5 }}>
                    <Btn onClick={handleExportSettings} style={{ flex: 1 }}>⤓ Export</Btn>
                    <label style={{ flex: 1 }}>
                      <Btn onClick={() => document.getElementById("tomo-import-settings").click()} style={{ width: "100%" }}>⤒ Import</Btn>
                      <input id="tomo-import-settings" type="file" accept="application/json,.json" onChange={handleImportSettings} style={{ display: "none" }} />
                    </label>
                  </div>
                  {infoOpen === "s_io" && <div style={infoPop}>Export/import everything you can customize — materials, projectors, vials, and all options — as tomo_settings.json. Settings also auto-save in the app between sessions.</div>}
                </div>

                <div style={{ borderTop: `1px solid ${C.border}`, marginTop: 10, paddingTop: 10 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                    <Btn onClick={handleExportLog} style={{ flex: 1 }}>⤓ Export log</Btn>
                    <InfoBtn open={infoOpen === "s_log"} onClick={infoTog("s_log")} />
                  </div>
                  {infoOpen === "s_log" && <div style={infoPop}>Combines every debug log and the optimize-time data into one Tomo_logs.txt — you choose where to save it.</div>}
                </div>

                <div style={{ borderTop: `1px solid ${C.border}`, marginTop: 10, paddingTop: 8, fontSize: 11, color: C.muted, lineHeight: 1.5 }}>
                  {hwInfo && <div style={{ marginBottom: 6 }}>Machine: <span style={{ color: C.text }}>{hwInfo.cuda ? (hwInfo.gpu || "CUDA GPU") : "CPU only"} · {hwInfo.cpu_cores} cores · {hwInfo.ram_gb} GB</span></div>}
                  Debug logs → <span style={{ color: C.text, fontFamily: "monospace" }}>logs/</span> (last 3 kept) · optimize data accumulates in <span style={{ color: C.text, fontFamily: "monospace" }}>optimize_times.csv</span>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>

      <div onDragOver={(e) => { e.preventDefault(); if (step === 1 && !hasModel && !dragOver) setDragOver(true); }}
           onDragLeave={(e) => { if (e.currentTarget === e.target) setDragOver(false); }} onDrop={onDrop}
           onDragStart={(e) => e.preventDefault()}
           style={{ flex: 1, display: "flex", overflow: "hidden", minHeight: 0 }}>
        {/* Left tool rail — transform tools, only on the Model step */}
        {step === 1 && hasModel && (
          <div style={{ width: 56, flexShrink: 0, background: C.bgS, borderRight: `1px solid ${C.border}`, display: "flex", flexDirection: "column", alignItems: "center", paddingTop: 10, gap: 6 }}>
            {TOOLS.map(([id, label]) => (
              <button key={id} title={label} onClick={() => changeTool(id)}
                style={{ width: 42, height: 42, borderRadius: 7, fontSize: 11, fontWeight: 700, cursor: "pointer",
                         border: `1px solid ${activeTool === id ? C.blue : C.border}`, background: activeTool === id ? `${C.blue}33` : "#1c1c2a",
                         color: activeTool === id ? C.blue : C.text }}>{label}</button>
            ))}
            <button title="Reset transform" onClick={resetTransform} style={{ width: 42, height: 42, marginTop: 4, borderRadius: 7, fontSize: 16, cursor: "pointer", border: `1px solid ${C.border}`, background: "#1c1c2a", color: C.text }}>↺</button>
          </div>
        )}

        {/* Center: persistent build-volume viewport */}
        <div style={{ flex: 1, minWidth: 0, position: "relative", background: C.bg }}>
          {meshData && step >= 2 ? (
            <MeshViewer key={meshGen} vertices={meshData.vertices} normals={meshData.normals} indices={meshData.indices} cylinder={cylinder} resolution={voxMeshRes} printRadius={printRadius} showVial={showVial} />
          ) : (
            <StlViewer ref={viewerRef} models={models} activeIdx={activeIdx} onActiveSelect={setActiveIdx} showGizmo={step === 1 && hasModel && activeTool !== "none"} onTransformChange={handleGizmoChange} matrices={matrices} xform={xform} cylinder={cylinder} printRadius={printRadius} showVial={showVial} />
          )}


          {!hasModel && step >= 1 && !loading && (
            <div style={{ position: "absolute", top: 16, left: "50%", transform: "translateX(-50%)", fontSize: 12, color: C.text, background: `${C.bgS}ee`, padding: "8px 16px", borderRadius: 6, border: `1px solid ${C.border}` }}>
              Add or drag-and-drop an STL or 3MF into the vial
            </div>
          )}
          {outOfBounds && step <= 1 && !loading && (
            <div style={{ position: "absolute", top: 16, left: "50%", transform: "translateX(-50%)", fontSize: 12, fontWeight: 600, color: "#fff", background: `${C.red}ee`, padding: "8px 16px", borderRadius: 6 }}>
              ⚠ Model extends beyond the {fanBeam ? "vial-corrected print" : "vial"} boundary
            </div>
          )}

          {meshData && step >= 2 && meshInfo && meshInfo.step > 1 && voxStatus !== "running" && !loading && (
            <div style={{ position: "absolute", top: 16, left: "50%", transform: "translateX(-50%)", fontSize: 12, fontWeight: 700, color: "#1a1200", background: "#f0b84aee", padding: "8px 16px", borderRadius: 6, boxShadow: "0 4px 16px rgba(0,0,0,0.45)", zIndex: 5 }}>
              ⚠ PREVIEW AT ¹⁄{meshInfo.step} RESOLUTION{meshInfo.display_dim ? ` (${meshInfo.display_dim.join("×")})` : ""} — the full grid is what gets optimized &amp; printed
            </div>
          )}

          <div style={{ position: "absolute", left: 12, bottom: 12, display: "flex", flexDirection: "column", gap: 6, alignItems: "flex-start" }}>
            <div onMouseDown={e => e.stopPropagation()} style={{ background: `${C.bgS}ee`, padding: "5px 9px", borderRadius: 5, border: `1px solid ${C.border}`, WebkitAppRegion: "no-drag" }}>
              <Toggle value={showVial} onChange={setShowVial} label="Grid & vial outline" />
            </div>
            <div style={{ fontSize: 11, color: C.text, background: `${C.bgS}ee`, padding: "5px 9px", borderRadius: 5, border: `1px solid ${C.border}` }}>
              Vial Ø{(cylinder.radius * 2).toFixed(0)} × {cylinder.height.toFixed(0)} mm{fanBeam ? `  ·  print Ø${(printRadius * 2).toFixed(0)} mm` : ""}{voxInfo ? `  ·  ${voxInfo.x}×${voxInfo.y}×${voxInfo.z} vox (full grid)` : ""}{printableFillPct != null ? `  ·  ${printableFillPct.toFixed(0)}% of printable volume` : ""}
            </div>
            {meshData && step >= 2 && meshInfo && (
              <div style={{ fontSize: 11, color: C.text, background: `${C.bgS}ee`, padding: "5px 9px", borderRadius: 5, border: `1px solid ${C.border}` }}>
                preview {meshInfo.display_dim ? meshInfo.display_dim.join("×") : "?"}{(meshInfo.step > 1) ? ` (¹⁄${meshInfo.step} of full grid)` : " · full resolution"}
              </div>
            )}
          </div>

          {(loading || sliceStatus === "running" || sliceStatus === "cancelling" || voxStatus === "running") && (
            <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", background: "rgba(6,6,14,0.55)", backdropFilter: "blur(3px)", zIndex: 10 }}>
              <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 14, background: C.bgS, border: `1px solid ${C.border}`, padding: "24px 30px", borderRadius: 10, minWidth: 300 }}>
                {(sliceStatus === "running" || sliceStatus === "cancelling") ? (<>
                  <div style={{ fontSize: 14, fontWeight: 700, color: "#fff" }}>Optimizing print</div>
                  <div style={{ width: "100%" }}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 8, marginBottom: 5 }}>
                      <span style={{ fontSize: 11, color: C.text, flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={sliceStage}>{sliceStage || "Preparing…"}</span>
                      <span style={{ fontSize: 11, fontWeight: 700, color: C.blue, flexShrink: 0 }}>{Math.round(sliceProgress * 100)}%</span>
                    </div>
                    <div style={{ height: 8, background: C.bgT, borderRadius: 4, overflow: "hidden" }}>
                      <div style={{ width: `${sliceProgress * 100}%`, height: "100%", background: C.blue, transition: "width .3s" }} />
                    </div>
                  </div>
                  {verboseOpt && (
                    <img src={`${API}/verbose_frame?t=${verboseStamp}`} alt="" onLoad={() => setVerboseFrameOk(true)} onError={() => setVerboseFrameOk(false)}
                      style={{ display: verboseFrameOk ? "block" : "none", width: 760, maxWidth: "84vw", borderRadius: 6, border: `1px solid ${C.border}` }} />
                  )}
                  {verboseOpt && !verboseFrameOk && lossHistory.length >= 2 && (
                    <div style={{ marginTop: 2, width: "100%" }}>
                      <div style={{ fontSize: 11, color: C.muted, marginBottom: 4 }}>Convergence · dose error {lossHistory[lossHistory.length - 1][1].toFixed(4)} (iter {lossHistory[lossHistory.length - 1][0]})</div>
                      <LossChart data={lossHistory} />
                    </div>
                  )}
                  {sliceStatus === "cancelling"
                    ? <div style={{ width: "100%", textAlign: "center", fontSize: 12, color: C.muted, padding: "9px 0" }}>Cancelling… (stops at the current iteration)</div>
                    : <Btn variant="danger" onClick={cancelSlice} style={{ width: "100%" }}>Cancel</Btn>}
                </>) : voxStatus === "running" ? (<>
                  <div style={{ fontSize: 14, fontWeight: 700, color: "#fff" }}>Voxelizing</div>
                  <div style={{ width: "100%" }}>
                    <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 5 }}>
                      <span style={{ fontSize: 11, color: C.text }}>{voxProgress >= 1 ? (voxStage || "Finishing…") : (voxGrid ? `${voxGrid.join("×")} grid` : "Building grid…")}</span>
                      <span style={{ fontSize: 11, fontWeight: 700, color: C.blue }}>{Math.round(voxProgress * 100)}%</span>
                    </div>
                    <div style={{ height: 8, background: C.bgT, borderRadius: 4, overflow: "hidden" }}>
                      <div style={{ width: `${voxProgress * 100}%`, height: "100%", background: C.blue, transition: "width .3s" }} />
                    </div>
                    <div style={{ fontSize: 11, color: C.muted, marginTop: 5, textAlign: "center" }}>
                      {voxProgress >= 1 ? "almost there…" : (voxEta > 0.5 ? `~${voxEta < 60 ? Math.ceil(voxEta) + " s" : (voxEta / 60).toFixed(1) + " min"} left (est.)` : "finishing…")}
                    </div>
                  </div>
                  {voxNote && <div style={{ fontSize: 11, color: "#e0b050", lineHeight: 1.4, textAlign: "center" }}>{voxNote}</div>}
                  <Btn variant="danger" onClick={cancelVoxelize} style={{ width: "100%" }}>Cancel</Btn>
                </>) : (<>
                  <div style={{ width: 30, height: 30, border: `3px solid ${C.border}`, borderTopColor: C.blue, borderRadius: "50%", animation: "tomospin 0.8s linear infinite" }} />
                  <div style={{ fontSize: 13, fontWeight: 600, color: C.text }}>{loadingLabel}</div>
                </>)}
              </div>
            </div>
          )}
          {dragOver && (
            <div style={{ position: "absolute", inset: 0, border: `2px dashed ${C.blue}`, background: `${C.blue}14`, display: "flex", alignItems: "center", justifyContent: "center", zIndex: 11, pointerEvents: "none" }}>
              <div style={{ fontSize: 15, fontWeight: 700, color: C.blue }}>Drop STL / 3MF to load</div>
            </div>
          )}
        </div>

        {/* Right: stepped workflow panel (one step at a time) */}
        <div style={{ width: LP, flexShrink: 0, background: C.bgS, borderLeft: `1px solid ${C.border}`, display: "flex", flexDirection: "column" }}>
          <div style={{ display: "flex", alignItems: "center", padding: "8px 8px", borderBottom: `1px solid ${C.border}`, flexShrink: 0 }}>
            {STEPS.map((s, i) => {
              const reachable = i <= maxStep;
              return <button key={s} onClick={() => reachable && setStep(i)} disabled={!reachable}
                style={{ flex: 1, padding: "5px 2px", border: "none", borderRadius: 4, background: i === step ? `${C.blue}22` : "transparent", color: i === step ? C.blue : i < step ? C.green : reachable ? C.muted : C.hint, fontSize: 11, fontWeight: 700, cursor: reachable ? "pointer" : "default" }}>{i + 1}·{s}</button>;
            })}
          </div>

          <div style={{ flex: 1, overflowY: "auto", padding: 14, display: "flex", flexDirection: "column", gap: 12 }}>
            {step === 0 && (<>
              <div style={{ fontSize: 13, fontWeight: 700, color: "#fff" }}>Vial / Build Volume</div>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                <Lbl>Vial size</Lbl>
                <span style={{ fontSize: 11, fontWeight: 700, color: C.blue, cursor: "pointer" }}>
                  <span onClick={openEditVial}>✎ Edit</span>　<span onClick={openAddVial}>+ Add new</span>
                </span>
              </div>
              <select value={vial} onChange={e => selectVial(e.target.value)} style={selInput}>
                {vials.map(v => <option key={v.id} value={v.id}>{v.name}</option>)}
              </select>
              <div style={{ fontSize: 11, color: C.muted, marginTop: -2 }}>
                Ø{(activeVial.radius * 2).toFixed(0)} × {activeVial.height.toFixed(0)} mm inner
              </div>
              <div style={{ borderTop: `1px solid ${C.border}`, paddingTop: 10 }}>
                <Toggle value={fanBeam} onChange={setFanBeam} label="Vial correction" />
                <div style={{ fontSize: 11, color: C.muted, marginTop: 7, lineHeight: 1.55 }}>
                  {fanBeam
                    ? `Refraction at the vial wall shrinks the printable region to the green inner cylinder — usable radius ≈ ${printRadius.toFixed(1)} mm (Ø${(printRadius * 2).toFixed(0)} mm). Keep the part inside it.`
                    : "Assumes an index-matched vial (no wall refraction); the whole vial is printable."}
                </div>
              </div>
            </>)}

            {step === 1 && (<>
              <div style={{ fontSize: 13, fontWeight: 700, color: "#fff" }}>Model</div>
              {!hasModel ? (
                <Btn variant="primary" onClick={openFile} disabled={isImporting} style={{ width: "100%" }}>{isImporting ? "Loading…" : "+ Add model(s)"}</Btn>
              ) : (<>
                {models.length > 1 && (
                  <select value={activeIdx} onChange={e => setActiveIdx(parseInt(e.target.value))} style={selInput}>
                    {models.map((m, i) => <option key={m.id} value={i}>{i + 1}. {m.filename}</option>)}
                  </select>
                )}
                <div style={{ display: "flex", gap: 8 }}>
                  <Btn variant="primary" onClick={openFile} disabled={isImporting} style={{ flex: 1 }}>{isImporting ? "Loading…" : "+ Add model(s)"}</Btn>
                  <Btn variant="danger" onClick={removeActiveModel} style={{ flex: 1 }}>Remove</Btn>
                </div>
                <div style={{ fontSize: 11, color: C.muted, lineHeight: 1.5 }}>
                  {models.length > 1 ? <><b style={{ color: C.text }}>{models.length} STLs</b> — placed separately, voxelized into <b style={{ color: C.text }}>one combined print</b> (even if not touching). Pick one above to move it. · </> : null}Tools: <b style={{ color: C.text }}>W</b> move · <b style={{ color: C.text }}>E</b> rotate · <b style={{ color: C.text }}>R</b> scale</div>
                <div><Lbl>Position (mm)</Lbl><div style={{ display: "flex", gap: 4 }}>
                  <NumInput step={1} value={xform.tx} onChange={v => handleInputChange("tx", v)} style={{ borderLeft: `2px solid ${AX.x}` }} />
                  <NumInput step={1} value={xform.ty} onChange={v => handleInputChange("ty", v)} style={{ borderLeft: `2px solid ${AX.y}` }} />
                  <NumInput step={1} value={xform.tz} onChange={v => handleInputChange("tz", v)} style={{ borderLeft: `2px solid ${AX.z}` }} />
                </div></div>
                <div><Lbl>Rotation (°)</Lbl><div style={{ display: "flex", gap: 4 }}>
                  <NumInput step={1} value={xform.rx} onChange={v => handleInputChange("rx", v)} style={{ borderLeft: `2px solid ${AX.x}` }} />
                  <NumInput step={1} value={xform.ry} onChange={v => handleInputChange("ry", v)} style={{ borderLeft: `2px solid ${AX.y}` }} />
                  <NumInput step={1} value={xform.rz} onChange={v => handleInputChange("rz", v)} style={{ borderLeft: `2px solid ${AX.z}` }} />
                </div></div>
                <div>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
                    <Lbl>Scale</Lbl>
                    <label style={{ display: "flex", alignItems: "center", gap: 5, cursor: "pointer", fontSize: 11, fontWeight: 700, color: scaleLock ? C.blue : C.muted }}>
                      <input type="checkbox" checked={scaleLock} onChange={e => setScaleLock(e.target.checked)} /> uniform
                    </label>
                  </div>
                  <div style={{ display: "flex", gap: 4 }}>
                    <NumInput step={0.1} value={xform.sx} onChange={v => setScaleAxis("sx", v)} style={{ borderLeft: `2px solid ${AX.x}` }} />
                    <NumInput step={0.1} value={xform.sy} onChange={v => setScaleAxis("sy", v)} style={{ borderLeft: `2px solid ${AX.y}` }} />
                    <NumInput step={0.1} value={xform.sz} onChange={v => setScaleAxis("sz", v)} style={{ borderLeft: `2px solid ${AX.z}` }} />
                  </div>
                </div>
                {realDims && <div style={{ fontSize: 11, fontFamily: "monospace", color: C.muted }}>Size: {realDims.x} × {realDims.y} × {realDims.z} mm</div>}
                <div style={{ display: "flex", gap: 6 }}>
                  <Btn onClick={autoScale} style={{ flex: 1 }}>⤢ Auto-scale</Btn>
                  <Btn onClick={autoCenter} style={{ flex: 1 }}>⊕ Center</Btn>
                  <Btn onClick={resetTransform} style={{ flex: 1 }}>↺ Reset</Btn>
                </div>
              </>)}
            </>)}

            {step === 2 && (<>
              <div style={{ fontSize: 13, fontWeight: 700, color: "#fff" }}>Voxelize</div>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                <Lbl>Projector</Lbl>
                <span style={{ fontSize: 11, fontWeight: 700, color: C.blue, cursor: "pointer" }}>
                  <span onClick={openEditProjector}>✎ Edit</span>　<span onClick={openAddProjector}>+ Add new</span>
                </span>
              </div>
              <select value={projector} onChange={e => selectProjector(e.target.value)} style={selInput}>
                {projectors.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
              <div style={{ fontSize: 11, color: C.muted, marginTop: -2 }}>
                {activeProjector.pxW}×{activeProjector.pxH} px · {activeProjector.pitchUm} µm/px · {(activeProjector.pxW * activeProjector.pitchUm / 1000).toFixed(0)}×{(activeProjector.pxH * activeProjector.pitchUm / 1000).toFixed(0)} mm · {activeProjector.telecentric === false ? `throw ${activeProjector.throwRatio}` : "telecentric"}
              </div>

              <div>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 3 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                    <Lbl>Resolution scale</Lbl>
                    <InfoBtn open={infoOpen === "scale"} onClick={infoTog("scale")} />
                  </div>
                  <span style={{ fontSize: 11, fontWeight: 700, color: voxScale < 0.999 ? C.blue : C.text }}>{voxScale.toFixed(2)}×</span>
                </div>
                <input type="range" min={0.2} max={1} step={0.01} value={voxScale} onChange={e => setScale(parseFloat(e.target.value))} style={{ width: "100%" }} />
                <div style={{ fontSize: 11, color: C.muted }}>
                  {(resolution * 1000).toFixed(0)} µm effective ({(basePitch * 1000).toFixed(0)} µm full){voxScale < 0.999 ? ` · ~${Math.round(1 / (voxScale ** 3))}× fewer voxels` : " · full resolution"}
                </div>
                {infoOpen === "scale" && <div style={infoPop}>Voxelizes the part at a <b style={{ color: C.text }}>coarser pitch</b> to trade detail for <b style={{ color: C.text }}>speed and memory</b>. 1.0× = the projector's full resolution. Lower (e.g. 0.5×) makes the voxel pitch larger, so there are ~1/scale³ fewer voxels → much faster optimize and far less RAM, at the cost of fine-feature sharpness. Use it to preview big parts or fit billion-voxel jobs in memory; print at 1.0× for final quality.</div>}
              </div>

              {voxEstimate && (
                <div style={{ fontSize: 11, color: C.muted }}>
                  Est. grid ~{voxEstimate.dim.join("×")} ({(voxEstimate.voxels / 1e6).toFixed(0)} M vox) · ~{fmtT(voxEstimate.secs)}
                </div>
              )}
              {voxSuggest && (
                <div style={{ background: `${C.blue}1a`, border: `1px solid ${C.blue}66`, borderRadius: 6, padding: 9 }}>
                  <div style={{ fontSize: 11, fontWeight: 700, color: C.blue, marginBottom: 4 }}>⚡ Large grid — suggested scale</div>
                  <div style={{ fontSize: 11, color: C.muted, lineHeight: 1.5 }}>
                    At {(resolution * 1000).toFixed(0)} µm this is {(voxEstimate.voxels / 1e9).toFixed(2)} B voxels (~{fmtT(voxEstimate.secs)} to voxelize, plus a slow optimize). Down-scaling to <b style={{ color: C.text }}>{(voxSuggest.newPitch * 1000).toFixed(0)} µm</b> ({voxSuggest.scale.toFixed(2)}×) gives ~{(voxSuggest.newVox / 1e6).toFixed(0)} M voxels (~{fmtT(voxSuggest.newSecs)}) — roughly <b style={{ color: C.text }}>{voxSuggest.speedup.toFixed(0)}× faster</b>, voxelize and optimize.
                  </div>
                  <Btn onClick={() => setScale(voxScale * voxSuggest.scale)} style={{ width: "100%", marginTop: 7 }}>Apply → {(voxSuggest.newPitch * 1000).toFixed(0)} µm</Btn>
                </div>
              )}
              <Btn variant="primary" onClick={startVoxelize} disabled={!hasModel || voxStatus === "running"} style={{ width: "100%" }}>
                {voxStatus === "running" ? "Voxelizing…" : voxStatus === "done" ? "↺ Re-voxelize" : "Voxelize"}
              </Btn>
              {voxStatus === "running" && <Indeterminate label="Building voxel grid…" />}
              {voxStatus === "done" && voxInfo && <div style={{ fontSize: 11, color: C.green }}>✓ {voxInfo.x}×{voxInfo.y}×{voxInfo.z} · {voxInfo.fill_pct?.toFixed(1)}% fill</div>}
              {voxStatus === "done" && (
                <Btn onClick={() => handleExportVoxels("target")} style={{ width: "100%", marginTop: 6 }}>⤓ Export target → 3MF</Btn>
              )}
              {voxStatus === "error" && <div style={{ fontSize: 11, color: C.red }}>✗ {voxError}</div>}
            </>)}

            {step === 3 && (<>
              <div style={{ fontSize: 13, fontWeight: 700, color: "#fff" }}>Optimize</div>

              <div>
                <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  <Lbl>Optimizer</Lbl>
                  <InfoBtn open={infoOpen === "opt"} onClick={() => setInfoOpen(infoOpen === "opt" ? "" : "opt")} />
                </div>
                <select value={method} onChange={e => { const m = e.target.value; setMethod(m); if (m !== "BCLP") setDiffusion(false); }} style={selInput}>
                  <option value="OSMO">OSMO</option>
                  <option value="BCLP">BCLP (grey / diffusion)</option>
                </select>
                {infoOpen === "opt" && <div style={{ fontSize: 11, color: C.muted, marginTop: 6, lineHeight: 1.5, background: C.bgT, padding: 8, borderRadius: 5 }}>
                  <b style={{ color: C.text }}>OSMO</b> — fast threshold optimizer for solid (binary) parts.<br />
                  <b style={{ color: C.text }}>BCLP</b> — handles grey/continuous targets; required for diffusion correction (~1.4× slower).
                </div>}
              </div>

              <div>
                <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 3 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                    <Lbl>Iterations</Lbl>
                    <InfoBtn open={infoOpen === "iter"} onClick={infoTog("iter")} />
                  </div>
                  <input type="number" min={1} value={nIter}
                    onChange={e => { const v = parseInt(e.target.value); if (!isNaN(v) && v >= 1) setNIter(v); }}
                    style={{ width: 58, background: "#16161f", color: C.text, border: `1px solid ${C.border}`, borderRadius: 4, padding: "3px 6px", fontSize: 12, fontWeight: 700, fontFamily: "monospace", outline: "none", textAlign: "right" }} />
                </div>
                <input type="range" min={1} max={50} step={1} value={Math.min(nIter, 50)} onChange={e => setNIter(parseInt(e.target.value))} style={{ width: "100%" }} />
                {infoOpen === "iter" && <div style={infoPop}>Number of optimization passes. More iterations sharpen the dose contrast (in-part vs out-of-part) at the cost of time; gains taper off — 5–15 is typical. The slider goes to 50; type in the box to go higher.</div>}
              </div>


              <div>
                <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 4 }}>
                  <Lbl>Dose thresholds</Lbl>
                  <InfoBtn open={infoOpen === "dose"} onClick={infoTog("dose")} />
                </div>
                <div style={{ display: "flex", gap: 8 }}>
                  <div style={{ flex: 1 }}><Lbl>d_l (out-target)</Lbl><NumInput step={0.05} value={dL} onChange={setDL} /></div>
                  <div style={{ flex: 1 }}><Lbl>d_h (in-target)</Lbl><NumInput step={0.05} value={dH} onChange={setDH} /></div>
                </div>
                <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
                  <div style={{ flex: 1 }}><Lbl>learning rate</Lbl><NumInput step={0.001} value={learningRate} onChange={v => setLearningRate(Math.max(0, v))} /></div>
                  {method === "BCLP" && <>
                    <div style={{ flex: 1 }}><Lbl>eps (band ±)</Lbl><NumInput step={0.01} value={bclpEps} onChange={v => setBclpEps(Math.max(0, v))} /></div>
                    <div style={{ flex: 1 }}><Lbl>weight</Lbl><NumInput step={0.1} value={bclpWeight} onChange={v => setBclpWeight(Math.max(0, v))} /></div>
                  </>}
                </div>
                {infoOpen === "dose" && <div style={infoPop}>Normalized dose targets (0–1). <b style={{ color: C.text }}>d_h</b> = minimum dose to reach INSIDE the part (gel point); <b style={{ color: C.text }}>d_l</b> = maximum dose allowed OUTSIDE it. A wider d_h–d_l gap is more robust but harder to hit — the "process window" on the Output page shows whether it was achieved.{method === "BCLP" ? " BCLP also takes a gradient learning rate, a band tolerance ±eps around target, and an Lp weight." : ""}</div>}
              </div>

              <div>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <span style={{ fontSize: 11, color: C.muted }}>Absorption: <b style={{ color: C.text }}>{activeMaterial.absorption ? `on · μ=${activeMaterial.absorptionCoeff} cm⁻¹` : "off"}</b> <span style={{ opacity: 0.7 }}>(in {activeMaterial.name})</span></span>
                  <button onClick={() => { setMaterialsOpen(true); setSettingsOpen(false); }} style={{ marginLeft: "auto", background: "#5b34b8", border: "none", color: "#fff", fontSize: 11, fontWeight: 700, padding: "3px 9px", borderRadius: 4, cursor: "pointer" }}>Open material</button>
                  <button onClick={openEditMaterial} style={{ background: "#7a4dd6", border: "none", color: "#fff", fontSize: 11, fontWeight: 700, padding: "3px 9px", borderRadius: 4, cursor: "pointer" }}>Edit material</button>
                </div>
              </div>
              <div>
                <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  <span style={{ fontSize: 11, color: C.muted }}>Diffusion: <b style={{ color: C.text }}>{activeMaterial.diffusion ? `on · ${activeMaterial.diffusionCoeff} mm²/s` : "off"}</b> <span style={{ opacity: 0.7 }}>(in {activeMaterial.name})</span>{activeMaterial.diffusion && method !== "BCLP" ? <span style={{ color: "#d68a00" }}> · needs BCLP</span> : null}</span>
                  <InfoBtn open={infoOpen === "diff"} onClick={infoTog("diff")} />
                </div>
                {infoOpen === "diff" && <div style={infoPop}>Pre-deconvolves the target (Richardson-Lucy) to counter dose spread from resin diffusion + optical blur, so fine features cure at the same time as bulk and aren't under-cured (Orth et al. 2023). Set this in the material editor; BCLP only (it needs the grey-scale target).</div>}
              </div>

              <div>
                <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  <Lbl>Memory</Lbl>
                  <InfoBtn open={infoOpen === "mem"} onClick={() => setInfoOpen(infoOpen === "mem" ? "" : "mem")} />
                </div>
                <select value={slab} onChange={e => setSlab(e.target.value)} style={selInput}>
                  <option value="auto">Auto (z-slab to fit RAM)</option>
                  <option value="off">Off (full volume)</option>
                </select>
                {infoOpen === "mem" && <div style={{ fontSize: 11, color: C.muted, marginTop: 6, lineHeight: 1.5, background: C.bgT, padding: 8, borderRadius: 5 }}>
                  <b style={{ color: C.text }}>Auto</b> — splits the volume into horizontal slabs sized to fit your RAM (needed for large / high-res parts).<br />
                  <b style={{ color: C.text }}>Off</b> — optimizes the whole volume at once (faster when it fits in memory).
                </div>}
              </div>


              {estimate && (
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <span style={{ fontSize: 11, color: C.muted }}>Estimated optimize time</span>
                  <span style={{ fontSize: 13, fontWeight: 700, color: C.text }}>{estimate.pretty}</span>
                </div>
              )}
              <Btn variant="primary" onClick={startSlice} disabled={voxStatus !== "done" || sliceStatus === "running" || sliceStatus === "cancelling"} style={{ width: "100%" }}>
                {sliceStatus === "running" ? "Optimizing…" : sliceStatus === "cancelling" ? "Cancelling…" : sliceStatus === "done" ? "↺ Re-optimize" : "Optimize"}
              </Btn>
              {sliceStatus === "error" && <div style={{ fontSize: 11, color: C.red }}>✗ Optimization failed</div>}
            </>)}

            {step === 4 && (<>
              <div style={{ fontSize: 13, fontWeight: 700, color: "#fff" }}>Video output</div>
              <div>
                <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 4 }}>
                  <Lbl>Vial RPM (rotation rate)</Lbl>
                  <InfoBtn open={infoOpen === "rpm"} onClick={infoTog("rpm")} />
                </div>
                <SignedNumInput value={videoRpm} onChange={setVideoRpm} />
                {infoOpen === "rpm" && <div style={infoPop}>Vial rotation speed during the print. One frame per degree, so this also sets the playback rate: <b style={{ color: C.text }}>{videoRpm} rpm → {videoFps} fps</b>. Negative = reverse direction.</div>}
              </div>
              <div style={{ fontSize: 11, color: C.muted, lineHeight: 1.5 }}>
                {framesPerDeg} frame/deg → <b style={{ color: C.text }}>{videoFps} fps</b> at {videoRpm} rpm. Set the video length next to <b style={{ color: C.text }}>Save run</b>. One rotation is encoded once and looped — fast.
              </div>
            </>)}
          </div>

          <div style={{ display: "flex", gap: 8, padding: 12, borderTop: `1px solid ${C.border}`, flexShrink: 0 }}>
            <Btn onClick={() => setStep(Math.max(0, step - 1))} disabled={step === 0} style={{ flex: 1 }}>← Back</Btn>
            {step < 4 && <Btn variant="primary" onClick={() => setStep(step + 1)} disabled={!canAdvance} style={{ flex: 1 }}>Next →</Btn>}
          </div>
        </div>
      </div>

      {/* Full-screen Output page */}
      {step === 4 && (
        <div style={{ position: "absolute", left: 0, right: 0, top: 48, bottom: 0, background: "#101019", display: "flex", flexDirection: "column", zIndex: 20 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "10px 16px", borderBottom: `1px solid ${C.border}`, flexShrink: 0 }}>
            <Btn onClick={() => setStep(3)}>← Back to Optimize</Btn>
            <div style={{ fontSize: 14, fontWeight: 700, color: "#fff" }}>Print Output</div>
            <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 10 }}>
              {previewInfo && <span style={{ fontSize: 11, color: C.muted }}>preview · one rotation, looped · {previewInfo.frame_count} frames</span>}
              <div style={{ display: "flex", alignItems: "center", gap: 6, background: C.bgS, border: `1px solid ${C.border}`, borderRadius: 6, padding: "4px 10px" }}>
                <span style={{ fontSize: 11, color: C.muted }}>Video length</span>
                <input type="number" min="0.1" step="0.5" value={videoDurMin}
                  onChange={e => { const v = parseFloat(e.target.value); if (!isNaN(v) && v > 0) setVideoDurMin(v); }}
                  style={{ width: 64, background: "#16161f", color: C.text, border: `1px solid ${C.border}`, borderRadius: 4, padding: "5px 7px", fontSize: 14, fontWeight: 700, fontFamily: "monospace", outline: "none", textAlign: "right" }} />
                <span style={{ fontSize: 11, color: C.muted }}>min</span>
              </div>
              <Btn onClick={() => handleExportVoxels("dose")} disabled={sliceStatus !== "done"} title="Export the optimized dose field as a volumetric 3MF (image3d) for inspection">⤓ Dose → 3MF</Btn>
              <Btn variant="success" onClick={handleDownloadRun} disabled={!previewInfo || savingRun}>{savingRun ? "Encoding + saving…" : "Save run"}</Btn>
            </div>
          </div>
          <div style={{ flex: 1, minHeight: 0, display: "flex", overflow: "hidden" }}>
            <div style={{ flex: 1, minWidth: 0, position: "relative", display: "flex", alignItems: "center", justifyContent: "center", padding: 20, overflow: "hidden" }}
              onWheel={previewInfo ? (e => { setVideoZoom(z => Math.min(8, Math.max(1, +(z * (e.deltaY < 0 ? 1.12 : 1 / 1.12)).toFixed(3)))); }) : undefined}
              onMouseDown={e => {
                if (e.button !== 0 || videoZoom <= 1) return;            // left-drag only, only when zoomed in
                const start = { x: e.clientX, y: e.clientY, px: videoPan.x, py: videoPan.y };
                const move = ev => setVideoPan({ x: start.px + (ev.clientX - start.x), y: start.py + (ev.clientY - start.y) });
                const up = () => { window.removeEventListener("mousemove", move); window.removeEventListener("mouseup", up); };
                window.addEventListener("mousemove", move); window.addEventListener("mouseup", up);   // window-level so it never gets stuck
              }}>
              {zOffsetLoading && (
                <div style={{ position: "absolute", inset: 0, zIndex: 6, display: "flex", alignItems: "center", justifyContent: "center",
                  background: "rgba(10,10,16,0.55)", pointerEvents: "none" }}>
                  <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 9 }}>
                    <div style={{ width: 28, height: 28, border: `3px solid ${C.border}`, borderTopColor: C.blue, borderRadius: "50%", animation: "tomospin 0.8s linear infinite" }} />
                    <span style={{ fontSize: 12, color: C.text }}>Updating projection…</span>
                  </div>
                </div>
              )}
              {previewInfo ? (
                // Wrapper carries the projector-frame border + zoom/pan; the IMG carries
                // the brightness filter.  A filter on the child can't tint the parent's
                // border, so Intensity no longer brightens the dotted frame.  NOTE: the
                // dotted border is a GUI-only guide — it is NOT part of the exported video.
                // Size the frame to the projector's real aspect (pxW:pxH, e.g. 1080:1920),
                // capped to the container. Using aspectRatio (not a shrink-wrapped image)
                // keeps the box constrained by a definite-size ancestor, so the dotted
                // border stays tight to the video and the vial overlay % map correctly.
                <div style={{ position: "relative", aspectRatio: `${activeProjector.pxW} / ${activeProjector.pxH}`,
                    maxWidth: "100%", maxHeight: "100%",
                    transform: `translate(${videoPan.x}px, ${videoPan.y}px) scale(${videoZoom})`, transformOrigin: "center",
                    border: "1px dotted #8a8a96", boxSizing: "border-box",   // projector frame extent — tight around the video
                    cursor: videoZoom > 1 ? "grab" : "default" }}>
                  <img src={`${API}/preview_frame/${previewFrame}?t=${videoStamp}`} alt="print preview" draggable={false}
                    style={{ width: "100%", height: "100%", objectFit: "contain", display: "block",
                      filter: `brightness(${videoIntensity})` }} />
                  {showVialFrame && (() => {
                    // Map the vial bore onto the projection frame.  The frame spans
                    // pxW*pitch (mm) wide × pxH*pitch (mm) tall (same mm/px on both axes),
                    // so the bore is (Ø / fovW) of the width and (height / fovH) of the height.
                    const fovW = activeProjector.pxW * activeProjector.pitchUm / 1000;
                    const fovH = activeProjector.pxH * activeProjector.pitchUm / 1000;
                    const w = fovW > 0 ? (cylinder.radius * 2) / fovW : 0;
                    const h = fovH > 0 ? cylinder.height / fovH : 0;
                    return <div style={{ position: "absolute", left: "50%", top: "50%", transform: "translate(-50%, -50%)",
                      width: `${w * 100}%`, height: `${h * 100}%`, border: "1.5px dashed #38bdf8",
                      boxShadow: "0 0 0 1px rgba(0,0,0,0.55)", pointerEvents: "none", boxSizing: "border-box" }}>
                      <span style={{ position: "absolute", top: -15, left: 0, fontSize: 10, fontWeight: 600, color: "#7dd3fc", whiteSpace: "nowrap", textShadow: "0 1px 2px #000" }}>
                        vial Ø{(cylinder.radius * 2).toFixed(0)} × {cylinder.height.toFixed(0)} mm
                      </span>
                    </div>;
                  })()}
                </div>
              ) : <span style={{ color: C.muted, fontSize: 13 }}>No preview yet — run Optimize first.</span>}
              {previewInfo && (
                <div onMouseDown={e => e.stopPropagation()} onWheel={e => e.stopPropagation()}
                  style={{ position: "absolute", bottom: 14, left: 14, display: "flex", flexDirection: "column", gap: 8,
                    background: `${C.bgS}f2`, border: `1px solid ${C.border}`, borderRadius: 8, padding: "8px 11px",
                    boxShadow: "0 6px 20px rgba(0,0,0,0.45)" }}>
                  <Toggle value={showVialFrame} onChange={setShowVialFrame} label="Vial outline" />
                  <Toggle value={zOffsetOn} onChange={(v) => { setZOffsetOn(v); if (!v) applyZOffset(0); }} label="Z offset" />
                  {zOffsetOn && (
                    <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
                      <input type="range" min={-80} max={80} step={0.5} value={zOffsetMm}
                        onChange={e => applyZOffset(parseFloat(e.target.value))} style={{ width: 120 }} />
                      <SignedNumInput value={zOffsetMm} onChange={applyZOffset} style={{ width: 52, padding: "2px 4px" }} />
                      <span style={{ fontSize: 11, color: C.muted }}>mm</span>
                    </div>
                  )}
                </div>
              )}
              {previewInfo && (() => { const zb = { width: 20, height: 20, borderRadius: 4, border: `1px solid ${C.border}`, background: C.bgT, color: C.text, cursor: "pointer", fontSize: 13, lineHeight: 1, padding: 0 }; return (
                <div onMouseDown={e => e.stopPropagation()} onWheel={e => e.stopPropagation()} style={{ position: "absolute", bottom: 14, left: "50%", transform: "translateX(-50%)", display: "flex", alignItems: "center", gap: 9, background: `${C.bgS}f2`, border: `1px solid ${C.border}`, borderRadius: 8, padding: "7px 12px", boxShadow: "0 6px 20px rgba(0,0,0,0.45)" }}>
                  <span style={{ fontSize: 11, color: C.muted }}>Intensity</span>
                  <input type="range" min="0.2" max="15" step="0.05" value={videoIntensity} onChange={e => setVideoIntensity(parseFloat(e.target.value))} style={{ width: 84 }} />
                  <input type="number" min="0" step="0.05" value={videoIntensity}
                    onChange={e => { const v = parseFloat(e.target.value); if (!isNaN(v) && v >= 0) setVideoIntensity(v); }}
                    style={{ width: 50, background: "#16161f", color: C.text, border: `1px solid ${C.border}`, borderRadius: 4, padding: "2px 4px", fontSize: 11, fontFamily: "monospace", outline: "none" }} />
                  <span style={{ fontSize: 11, color: C.muted }}>×</span>
                  <span style={{ fontSize: 11, color: C.muted, marginLeft: 6 }}>Zoom</span>
                  <button onClick={() => setVideoZoom(z => Math.max(1, +(z - 0.25).toFixed(2)))} style={zb}>−</button>
                  <span style={{ fontSize: 11, color: C.text, width: 26, textAlign: "center" }}>{videoZoom.toFixed(1)}×</span>
                  <button onClick={() => setVideoZoom(z => Math.min(8, +(z + 0.25).toFixed(2)))} style={zb}>+</button>
                  <button onClick={() => { setVideoZoom(1); setVideoPan({ x: 0, y: 0 }); setVideoIntensity(1); }} style={{ ...zb, width: "auto", padding: "0 8px", fontSize: 11 }}>reset</button>
                </div>
              ); })()}
            </div>
            {sliceInfo?.dose && (
              <div style={{ width: 270, flexShrink: 0, borderLeft: `1px solid ${C.border}`, padding: 16, overflowY: "auto", background: C.bgS }}>
                <div style={{ fontSize: 13, fontWeight: 700, color: "#fff", marginBottom: 12 }}>Print Quality</div>
                <div style={{ background: sliceInfo.dose.window > 0 ? C.green + "22" : "#2f7fe0c0", border: `1px solid ${sliceInfo.dose.window > 0 ? C.green + "66" : "#3a90e6aa"}`, borderRadius: 6, padding: 10, marginBottom: 12 }}>
                  <div style={{ fontSize: 11, color: sliceInfo.dose.window > 0 ? C.muted : "#dce8ff" }}>Process window</div>
                  <div style={{ fontSize: 22, fontWeight: 800, color: sliceInfo.dose.window > 0 ? C.green : "#fff" }}>{sliceInfo.dose.window >= 0 ? "+" : ""}{sliceInfo.dose.window.toFixed(2)}</div>
                  <div style={{ fontSize: 11, color: sliceInfo.dose.window > 0 ? C.muted : "#eaf1ff", lineHeight: 1.4 }}>{sliceInfo.dose.window > 0 ? "A single dose threshold cures the part cleanly." : "Dose overlap — some stray cure is unavoidable; try more iterations or widen d_h–d_l."}</div>
                </div>
                {sliceInfo.dose.in_hist && (
                  <div style={{ marginBottom: 12 }}>
                    <div style={{ fontSize: 11, color: C.muted, marginBottom: 4 }}>Dose distribution · <span style={{ color: "#3a90e6" }}>■</span> in-part <span style={{ color: "#e05555" }}>■</span> out-of-part · ┊ gel threshold</div>
                    <DoseHistogram dose={sliceInfo.dose} />
                    <div style={{ fontSize: 11, color: C.muted, marginTop: 3, lineHeight: 1.4 }}>The dotted line is the <b style={{ color: C.text }}>gel-dose threshold (d_l)</b> — resin that receives more dose than this cures. Good: the blue (in-part) hump sits to its <b style={{ color: C.text }}>right</b> and the red (out-of-part) hump to its <b style={{ color: C.text }}>left</b>, with a clean gap. Overlap → stray curing.</div>
                  </div>
                )}
                <div style={{ marginBottom: 12 }}>
                  <div style={{ fontSize: 11, color: C.muted, marginBottom: 4 }}>Reconstruction (predicted dose · mid-slice)</div>
                  <img src={`${API}/recon_slice?t=${videoStamp}`} alt="reconstruction" style={{ width: "100%", borderRadius: 4, border: `1px solid ${C.border}` }} onError={e => { e.target.style.display = "none"; }} />
                </div>
                {verboseOpt && verboseFrameOk && (
                  <div style={{ marginBottom: 12 }}>
                    <div style={{ fontSize: 11, color: C.muted, marginBottom: 4 }}>Optimization convergence (verbose)</div>
                    <img src={`${API}/verbose_frame?t=${verboseStamp}`} alt="optimization convergence" title="Click to open full size"
                      style={{ width: "100%", borderRadius: 4, border: `1px solid ${C.border}`, cursor: "zoom-in" }}
                      onLoad={() => setVerboseFrameOk(true)}
                      onClick={() => window.open(`${API}/verbose_frame?t=${verboseStamp}`, "_blank")}
                      onError={() => setVerboseFrameOk(false)} />
                    <Btn onClick={handleSaveVerbose} style={{ width: "100%", marginTop: 6 }}>⤓ Save image</Btn>
                  </div>
                )}
                {[
                  ["Final dose error", sliceInfo.dose.dose_error != null ? Number(sliceInfo.dose.dose_error).toFixed(4) : "—", C.text, "pqerr", "The optimizer's final loss — how far the predicted dose is from the in/out targets. Lower is better. Good: small and trended down each iteration. Bad: stuck high or rising (add iterations / adjust d_h–d_l)."],
                  ["Voxel error", `${sliceInfo.dose.ver_pct.toFixed(2)}%`, sliceInfo.dose.ver_pct > 10 ? "#f0b84a" : sliceInfo.dose.ver_pct < 1 ? C.green : C.text, "pqver", "Share of voxels on the wrong side of the gel threshold — in-part under-cured (missing features) OR out-of-part over-cured (stray curing). Good: low. Above 10% (yellow) is a significant amount of wrong-dosed material."],
                  ["In-part min dose", sliceInfo.dose.in_min.toFixed(2), C.text, "pqin", "Lowest dose anywhere INSIDE the part (0–1). Good: ≥ your d_h (e.g. 0.9) so the whole part reaches the gel point. Bad: well below d_h → under-cured spots / holes."],
                  ["Out-part max dose", sliceInfo.dose.out_max.toFixed(2), C.text, "pqout", "Highest dose just OUTSIDE the part. Good: ≤ your d_l (e.g. 0.3) so nothing strays. Bad: above d_l → over-cure / blobs around the part."],
                  ["In-part under-cured", `${sliceInfo.dose.in_under_pct.toFixed(2)}%`, C.text, "pqund", "% of in-part voxels below the gel dose. Good: ~0%. Bad: a few % → weak spots / holes in the print."],
                  ["Out-part over-cured", `${sliceInfo.dose.out_over_pct.toFixed(2)}%`, C.text, "pqovr", "% of out-part voxels above the gel dose. Good: ~0%. Bad: a few % → extra cured material around the part."],
                ].map(([label, value, color, key, info]) => (
                  <div key={label} style={{ borderBottom: `1px solid ${C.border}` }}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "6px 0" }}>
                      <span style={{ fontSize: 11, color: C.muted, display: "flex", alignItems: "center", gap: 5 }}>{label}<InfoBtn open={infoOpen === key} onClick={infoTog(key)} /></span>
                      <span style={{ fontSize: 12, fontWeight: 700, color }}>{value}</span>
                    </div>
                    {infoOpen === key && <div style={{ ...infoPop, marginBottom: 8 }}>{info}</div>}
                  </div>
                ))}
                <div style={{ fontSize: 11, color: C.muted, marginTop: 10, lineHeight: 1.45 }}>Dose normalized to peak. In-part voxels should reach the gel dose; out-of-part (inside the vial) should stay below it.</div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}