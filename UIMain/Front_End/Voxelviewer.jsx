import { useEffect, useRef } from "react";
import * as THREE from "three";

export default function VoxelViewer({ shape, data, cylinder, resolution = 1.0 }) {
  const mountRef = useRef(null);

  useEffect(() => {
    const el = mountRef.current;
    if (!el || !shape || !data || data.length === 0) return;

    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(window.devicePixelRatio);
    renderer.setSize(el.clientWidth, el.clientHeight);
    el.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x0a0a14);

    const camera = new THREE.PerspectiveCamera(45, el.clientWidth / el.clientHeight, 0.1, 50000);
    camera.position.set(300, 300, 300);
    camera.lookAt(0, 0, 0);

    scene.add(new THREE.AmbientLight(0x506070, 1.3));
    const sun = new THREE.DirectionalLight(0xffffff, 1.5);
    sun.position.set(200, 400, 200);
    scene.add(sun);

    // Python passes [nx, ny, nz] naturally
    const [nx, ny, nz] = shape;
    const boxGeo = new THREE.BoxGeometry(0.95, 0.95, 0.95);
    const boxMat = new THREE.MeshStandardMaterial({ color: 0x85b3eb, roughness: 0.6, metalness: 0.1 });
    
    let fillCount = 0;
    for (let i = 0; i < data.length; i++) {
      if (data[i] > 0) fillCount++;
    }

    if (fillCount > 0) {
      const instMesh = new THREE.InstancedMesh(boxGeo, boxMat, fillCount);
      const dummy = new THREE.Object3D();
      let idx = 0;

      const cx = nx / 2;
      const cy = ny / 2;
      const cz = nz / 2;

      // Loop iterates exactly matching Python's C-Order flattening
      for (let x = 0; x < nx; x++) {
        for (let y = 0; y < ny; y++) {
          for (let z = 0; z < nz; z++) {
            const flatIdx = x * (ny * nz) + y * nz + z;
            if (flatIdx >= data.length) break;

            if (data[flatIdx] > 0) {
              dummy.position.set(x - cx, y - cy, z - cz);
              dummy.updateMatrix();
              instMesh.setMatrixAt(idx, dummy.matrix);
              idx++;
            }
          }
        }
      }
      
      instMesh.rotation.x = -Math.PI / 2;
      scene.add(instMesh);
    }

    // ── Reference cylinder ────────────────────────────────────────────
    if (cylinder && cylinder.radius > 0 && cylinder.height > 0) {
      const r = cylinder.radius / resolution;
      const h = cylinder.height / resolution;
      const cylGeo = new THREE.CylinderGeometry(r, r, h, 64, 1, true);
      const cylMat = new THREE.MeshStandardMaterial({
        color: 0x88ccff, transparent: true, opacity: 0.15,
        side: THREE.DoubleSide, depthWrite: false,
      });
      const cylMesh = new THREE.Mesh(cylGeo, cylMat);
      // CylinderGeometry is Y-axis aligned; after the -π/2 X-rotation on the
      // voxel cloud the scene Y-axis maps to world Z-up, so the cylinder
      // naturally stands upright without any extra rotation.
      scene.add(cylMesh);

      const edgeGeo = new THREE.EdgesGeometry(new THREE.CylinderGeometry(r, r, h, 64, 1, false));
      const edgeMat = new THREE.LineBasicMaterial({ color: 0x88ccff, transparent: true, opacity: 0.4 });
      scene.add(new THREE.LineSegments(edgeGeo, edgeMat));
    }

    let orbitTheta = Math.atan2(300, 300);
    let orbitPhi = Math.acos(300 / camera.position.length());
    let orbitRadius = camera.position.length();
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
        orbitPhi = Math.max(0.05, Math.min(Math.PI - 0.05, orbitPhi + dy * 0.006));
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
      orbitRadius = Math.max(10, orbitRadius * (1 + e.deltaY * 0.001)); 
      applyOrbit(); 
      e.preventDefault(); 
    }

    el.addEventListener("mousedown", onMouseDown);
    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
    el.addEventListener("wheel", onWheel, { passive: false });
    el.addEventListener("contextmenu", e => e.preventDefault());

    let raf;
    function animate() {
      raf = requestAnimationFrame(animate);
      renderer.render(scene, camera);
    }
    animate();

    const ro = new ResizeObserver(() => {
      if (!el.clientWidth || !el.clientHeight) return;
      camera.aspect = el.clientWidth / el.clientHeight;
      camera.updateProjectionMatrix();
      renderer.setSize(el.clientWidth, el.clientHeight);
    });
    ro.observe(el);

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      el.removeEventListener("mousedown", onMouseDown); 
      window.removeEventListener("mousemove", onMouseMove); 
      window.removeEventListener("mouseup", onMouseUp); 
      el.removeEventListener("wheel", onWheel);
      boxGeo.dispose();
      boxMat.dispose();
      renderer.dispose();
      el.innerHTML = "";
    };
  }, [shape, data, cylinder, resolution]);

  return <div ref={mountRef} style={{ width: "100%", height: "100%" }} />;
}