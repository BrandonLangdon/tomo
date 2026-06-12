import { useEffect, useRef } from "react";
import * as THREE from "three";
import { makeAxisGizmo } from "./axisGizmo";

/**
 * Renders the marching-cubes SURFACE MESH of the voxelized target (smooth surface
 * instead of raw voxel cubes).  `vertices`/`normals` are flat float arrays from the
 * backend /api/mesh_preview (centred, in full-grid voxel units).  Keeps the same
 * orbit controls and reference print-cylinder as the old voxel viewer.
 */
export default function MeshViewer({ vertices, normals, indices, cylinder, resolution = 1.0, printRadius, showVial = true }) {
  const mountRef = useRef(null);
  const sceneRef = useRef(null);
  const showVialRef = useRef(showVial);

  // Toggle the reference grid + vial outline WITHOUT rebuilding the scene (which would
  // reset the camera) — flip visibility on the tagged objects.
  useEffect(() => {
    showVialRef.current = showVial;
    const s = sceneRef.current;
    if (s) s.traverse(o => { if (o.userData.isVialRef) o.visible = showVial; });
  }, [showVial]);

  useEffect(() => {
    const el = mountRef.current;
    if (!el || !vertices || vertices.length === 0) return;

    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));   // cap: hi-DPI full ratio makes huge buffers that thrash/flicker on resize
    renderer.setSize(el.clientWidth, el.clientHeight);
    el.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    sceneRef.current = scene;
    scene.background = new THREE.Color(0xd6dff7);  // 455 nm blue, lightened further toward white
    const gizmo = makeAxisGizmo();

    const camera = new THREE.PerspectiveCamera(45, el.clientWidth / el.clientHeight, 0.1, 50000);

    // Soft, even lighting — strong top-down key + ambient base + an up-light so the
    // undersides/shadowed faces of the voxel mesh aren't black (matches the model viewer).
    scene.add(new THREE.HemisphereLight(0xffffff, 0xb8c6de, 1.4));    // brighter sky+ground
    scene.add(new THREE.AmbientLight(0xffffff, 0.55));               // strong base fill — no dark faces
    const key = new THREE.DirectionalLight(0xffffff, 1.7);
    key.position.set(40, 800, 120);           // strong, nearly straight top-down
    scene.add(key);
    const fill = new THREE.DirectionalLight(0xeaf2ff, 0.55);
    fill.position.set(-220, 180, -120);       // side fill (from above)
    scene.add(fill);
    const under = new THREE.DirectionalLight(0xeaf0ff, 0.55);
    under.position.set(60, -400, -160);       // up-light from below to lift the shadows
    scene.add(under);

    // ── Surface mesh ──────────────────────────────────────────────────
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute(vertices, 3));
    if (indices && indices.length) {                 // indexed mesh (lighter, higher detail)
      geo.setIndex(new THREE.Uint32BufferAttribute(indices, 1));
    }
    if (normals && normals.length === vertices.length) {
      geo.setAttribute("normal", new THREE.Float32BufferAttribute(normals, 3));
    } else {
      geo.computeVertexNormals();
    }
    const mat = new THREE.MeshStandardMaterial({
      color: 0x3a90e6, roughness: 0.55, metalness: 0.1, side: THREE.DoubleSide,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.rotation.x = -Math.PI / 2;          // match voxel-viewer orientation (Z-up)
    scene.add(mesh);

    // Fit the camera to the mesh extent
    geo.computeBoundingSphere();
    const fitR = (geo.boundingSphere?.radius || 100);

    // ── Reference print cylinder ──────────────────────────────────────
    if (cylinder && cylinder.radius > 0 && cylinder.height > 0) {
      const r = cylinder.radius / resolution;
      const h = cylinder.height / resolution;
      const vis = showVialRef.current;
      const addVial = (obj) => { obj.userData.isVialRef = true; obj.visible = vis; scene.add(obj); };
      const cylMat = new THREE.MeshStandardMaterial({
        color: 0x4a78b0, transparent: true, opacity: 0.05,
        side: THREE.DoubleSide, depthWrite: false,
      });
      addVial(new THREE.Mesh(new THREE.CylinderGeometry(r, r, h, 64, 1, true), cylMat));
      const edgeGeo = new THREE.EdgesGeometry(new THREE.CylinderGeometry(r, r, h, 64, 1, false));
      const edgeMat = new THREE.LineBasicMaterial({ color: 0x4a9eef, transparent: true, opacity: 0.6 });
      addVial(new THREE.LineSegments(edgeGeo, edgeMat));

      // Faint ground grid at the vial floor (even fainter than the vial)
      const grid = new THREE.GridHelper(Math.max(r * 2.4, 40), 24, 0x2e527c, 0x2e527c);
      grid.position.y = -h / 2;
      grid.material.transparent = true; grid.material.opacity = 0.18;
      addVial(grid);

      // Usable print boundary (fan-beam) — green inner cylinder
      const pr = (printRadius || cylinder.radius) / resolution;
      if (pr < r - 0.01) {
        addVial(new THREE.LineSegments(
          new THREE.EdgesGeometry(new THREE.CylinderGeometry(pr, pr, h, 64, 1, false)),
          new THREE.LineBasicMaterial({ color: 0x2e7d18, transparent: true, opacity: 0.6 })));
      }
    }

    // ── Orbit camera ──────────────────────────────────────────────────
    let orbitRadius = Math.max(fitR, cylinder ? cylinder.height / resolution : 0) * 2.1 || 270;
    let orbitTheta = Math.PI / 4;
    let orbitPhi = Math.PI / 3;
    const orbitTarget = new THREE.Vector3(0, 0, 0);

    function applyOrbit() {
      const sp = Math.sin(orbitPhi), cp = Math.cos(orbitPhi);
      camera.position.set(
        orbitTarget.x + orbitRadius * sp * Math.sin(orbitTheta),
        orbitTarget.y + orbitRadius * cp,
        orbitTarget.z + orbitRadius * sp * Math.cos(orbitTheta)
      );
      camera.lookAt(orbitTarget);
    }
    applyOrbit();

    let orbiting = false, panning = false, lastX = 0, lastY = 0;
    function onMouseDown(e) {
      lastX = e.clientX; lastY = e.clientY;
      if (e.button === 0 || e.button === 2) orbiting = true;
      if (e.button === 1) panning = true;
    }
    function onMouseMove(e) {
      const dx = e.clientX - lastX, dy = e.clientY - lastY;
      lastX = e.clientX; lastY = e.clientY;
      if (orbiting) {
        orbitTheta -= dx * 0.006;
        orbitPhi = Math.max(0.05, Math.min(Math.PI - 0.05, orbitPhi - dy * 0.006));
        applyOrbit();
      }
      if (panning) {
        const right = new THREE.Vector3().setFromMatrixColumn(camera.matrix, 0);
        const up = new THREE.Vector3().setFromMatrixColumn(camera.matrix, 1);
        const spd = orbitRadius * 0.001;
        orbitTarget.addScaledVector(right, -dx * spd).addScaledVector(up, dy * spd);
        applyOrbit();
      }
    }
    function onMouseUp() { orbiting = false; panning = false; }
    function onWheel(e) {
      orbitRadius = Math.max(1, orbitRadius * (1 + e.deltaY * 0.001));
      applyOrbit(); e.preventDefault();
    }
    el.addEventListener("mousedown", onMouseDown);
    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
    el.addEventListener("wheel", onWheel, { passive: false });
    el.addEventListener("contextmenu", e => e.preventDefault());

    let raf;
    // Coalesce resize: ResizeObserver fires many times during a window drag; applying
    // setSize on every tick reallocates the GL buffer repeatedly -> red/flicker. Instead
    // flag it and resize ONCE per frame, right before rendering (buffer never shown mid-realloc).
    let needsResize = true;
    function animate() {
      raf = requestAnimationFrame(animate);
      if (needsResize) {
        needsResize = false;
        const w = el.clientWidth, h = el.clientHeight;
        if (w && h) { camera.aspect = w / h; camera.updateProjectionMatrix(); renderer.setSize(w, h); }
      }
      renderer.render(scene, camera);
      gizmo.render(renderer, camera, orbitTarget, el);
    }
    animate();

    const ro = new ResizeObserver(() => { needsResize = true; });
    ro.observe(el);

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      el.removeEventListener("mousedown", onMouseDown);
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
      el.removeEventListener("wheel", onWheel);
      geo.dispose(); mat.dispose(); gizmo.dispose(); renderer.dispose();
      el.innerHTML = "";
    };
  }, [vertices, normals, cylinder, resolution]);

  return <div ref={mountRef} style={{ width: "100%", height: "100%" }} />;
}
