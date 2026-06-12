import { useEffect, useRef, useImperativeHandle, forwardRef } from "react";
import * as THREE from "three";
import { TransformControls } from "three/examples/jsm/controls/TransformControls.js";
import { makeAxisGizmo } from "./axisGizmo";

const StlViewer = forwardRef(function StlViewer({ models, activeIdx, onActiveSelect, showGizmo = false, onTransformChange, matrices, xform, cylinder, printRadius, showVial = true }, ref) {
  const mountRef = useRef(null);
  const sRef     = useRef({});
  const toolRef  = useRef("none");

  // Keep latest prop callbacks in refs so the stable [] init effect always
  // calls the current version without needing to be recreated.
  const onActiveSelectRef    = useRef(onActiveSelect);
  const onTransformChangeRef = useRef(onTransformChange);
  useEffect(() => { onActiveSelectRef.current    = onActiveSelect; },    [onActiveSelect]);
  useEffect(() => { onTransformChangeRef.current = onTransformChange; }, [onTransformChange]);

  const setToolMode = (t, targetMesh) => {
    toolRef.current = t;
    const { transformControls } = sRef.current;
    if (!transformControls) return;

    if (t === "none" || !targetMesh) {
      transformControls.detach();
    } else {
      transformControls.attach(targetMesh);
      if (t === "translate" || t === "scale") {
        transformControls.setMode(t);
        transformControls.setSpace("world"); 
      } else if (t === "rotate") {
        transformControls.setMode("rotate");
        transformControls.setSpace("local");
      }
    }
  };

  const extractTransformFromMesh = (targetMesh) => {
    if (!targetMesh) return null;
    targetMesh.updateMatrix();
    const p = targetMesh.position, r = targetMesh.rotation, s = targetMesh.scale;
    
    return {
      tx: +p.x.toFixed(4), ty: +p.y.toFixed(4), tz: +p.z.toFixed(4),
      rx: +THREE.MathUtils.radToDeg(r.x).toFixed(4), ry: +THREE.MathUtils.radToDeg(r.y).toFixed(4), rz: +THREE.MathUtils.radToDeg(r.z).toFixed(4),
      sx: +s.x.toFixed(4), sy: +s.y.toFixed(4), sz: +s.z.toFixed(4),
      matrix: [...targetMesh.matrix.elements]
    };
  };

  useImperativeHandle(ref, () => ({
    setTool(t) {
      const { meshesMap } = sRef.current;
      const activeModel = models[activeIdx];
      const targetMesh = activeModel ? meshesMap[activeModel.id] : null;
      setToolMode(t, targetMesh);
    },
    resetTransform() {
      const { transformControls } = sRef.current;
      if (transformControls && transformControls.object) {
        transformControls.object.position.set(0, 0, 0);
        transformControls.object.rotation.set(0, 0, 0);
        transformControls.object.scale.set(1, 1, 1);
        transformControls.object.updateMatrix();
        sRef.current.emitXform?.();
      }
    },
    requestSyncForId(modelId) {
      const { meshesMap } = sRef.current;
      const targetMesh = meshesMap[modelId];
      if (targetMesh) {
        const xf = extractTransformFromMesh(targetMesh);
        if (xf) onTransformChangeRef.current?.(xf);
      }
    },
    // Returns a snapshot of every mesh's current matrix keyed by modelId.
    // Call this before voxelizing to ensure matrices state is fully current
    // for all models, not just the active one.
    getAllMatrices() {
      const { meshesMap } = sRef.current;
      const result = {};
      Object.entries(meshesMap).forEach(([id, mesh]) => {
        mesh.updateMatrix();
        result[id] = [...mesh.matrix.elements];
      });
      return result;
    },
  }));

  useEffect(() => {
    const el = mountRef.current;
    if (!el) return;

    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));   // cap: hi-DPI full ratio makes huge buffers that thrash/flicker on resize
    renderer.setSize(el.clientWidth, el.clientHeight);
    el.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0xd6dff7);  // 455 nm blue, lightened further toward white
    const gizmo = makeAxisGizmo();

    const camera = new THREE.PerspectiveCamera(45, el.clientWidth / el.clientHeight, 0.1, 50000);
    // Frame the vial at ~2.1× its size (was a fixed, far 519).
    const fitR = Math.max(cylinder?.height || 100, (cylinder?.radius || 50) * 2) * 2.1;
    const d = fitR / Math.sqrt(3);
    camera.position.set(d, d, d);
    camera.lookAt(0, 0, 0);

    // Soft, even lighting — lit from ABOVE and BELOW so undersides aren't black.
    scene.add(new THREE.HemisphereLight(0xffffff, 0xaebed8, 1.15));   // brighter ground term
    scene.add(new THREE.AmbientLight(0xffffff, 0.35));                // base fill so no face is fully dark
    const sun = new THREE.DirectionalLight(0xffffff, 1.05);
    sun.position.set(120, 600, 220);          // key from above
    scene.add(sun);
    const fill = new THREE.DirectionalLight(0xdfe8ff, 0.4);
    fill.position.set(-220, 180, -120);       // side fill (from above)
    scene.add(fill);
    const under = new THREE.DirectionalLight(0xeaf0ff, 0.55);
    under.position.set(60, -400, -160);       // up-light from below to lift the shadows
    scene.add(under);

    const meshesContainer = new THREE.Group();
    scene.add(meshesContainer);

    let orbitRadius = camera.position.length();
    let orbitTheta = Math.atan2(camera.position.x, camera.position.z);
    let orbitPhi = Math.acos(camera.position.y / orbitRadius);
    const orbitTarget = new THREE.Vector3();
    function applyOrbit() {
      const sp = Math.sin(orbitPhi), cp = Math.cos(orbitPhi);
      camera.position.set(orbitTarget.x + orbitRadius * sp * Math.sin(orbitTheta), orbitTarget.y + orbitRadius * cp, orbitTarget.z + orbitRadius * sp * Math.cos(orbitTheta));
      camera.lookAt(orbitTarget);
    }

    let orbiting = false, panning = false, lastX = 0, lastY = 0;
    const transformControls = new TransformControls(camera, renderer.domElement);
    scene.add(transformControls.getHelper());
    // Reduce scale-gizmo sensitivity (step in 2% increments); fine control is via
    // the numeric Scale inputs.  Make the uniform-scale handle bigger/clearer.
    try { transformControls.setScaleSnap(0.02); } catch (e) { /* older three.js */ }
    try { transformControls.setSize(0.9); } catch (e) { /* noop */ }

    function emitXform() {
      const targetMesh = transformControls.object;
      if (!targetMesh) return;
      const xf = extractTransformFromMesh(targetMesh);
      if (xf) onTransformChangeRef.current?.(xf);
    }

    transformControls.addEventListener("dragging-changed", (e) => { if (!e.value) emitXform(); });
    transformControls.addEventListener("change", () => { if (transformControls.dragging) emitXform(); });

    const raycaster = new THREE.Raycaster();
    const mouse = new THREE.Vector2();

    function onMouseDown(e) {
      lastX = e.clientX; lastY = e.clientY;
      if (transformControls.pointerIsOver && showGizmo && toolRef.current !== "none") return;

      if (e.button === 0) {
        const rect = el.getBoundingClientRect();
        mouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
        mouse.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
        raycaster.setFromCamera(mouse, camera);
        
        const intersects = raycaster.intersectObjects(meshesContainer.children);
        if (intersects.length > 0) {
          const hitMesh = intersects[0].object;
          const matchedIdx = sRef.current.models?.findIndex(m => m.id === hitMesh.userData.modelId) ?? -1;
          
          if (matchedIdx !== -1) {
            onActiveSelectRef.current(matchedIdx);
            const nextTool = toolRef.current === "none" ? "translate" : toolRef.current;
            setTimeout(() => {
              setToolMode(nextTool, hitMesh);
              emitXform();
            }, 10);
            return;
          }
        }
      }

      if (e.button === 2) orbiting = true;
      if (e.button === 1) panning = true;
    }

    function onMouseMove(e) {
      const dx = e.clientX - lastX, dy = e.clientY - lastY;
      lastX = e.clientX; lastY = e.clientY;
      if (transformControls.dragging) return;
      if (orbiting) {
        orbitTheta -= dx * 0.006;
        orbitPhi = Math.max(0.05, Math.min(Math.PI - 0.05, orbitPhi - dy * 0.006));
        applyOrbit();
      }
      if (panning) {
        const right = new THREE.Vector3().setFromMatrixColumn(camera.matrix, 0), up = new THREE.Vector3().setFromMatrixColumn(camera.matrix, 1);
        const spd = orbitRadius * 0.001;
        orbitTarget.addScaledVector(right, -dx * spd).addScaledVector(up, dy * spd);
        applyOrbit();
      }
    }

    function onMouseUp() { orbiting = false; panning = false; }
    function onWheel(e) { orbitRadius = Math.max(10, orbitRadius * (1 + e.deltaY * 0.001)); applyOrbit(); e.preventDefault(); }

    el.addEventListener("mousedown", onMouseDown);
    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
    el.addEventListener("wheel", onWheel, { passive: false });
    el.addEventListener("contextmenu", e => e.preventDefault());

    sRef.current = { meshesContainer, transformControls, meshesMap: {}, emitXform, scene, cylMesh: null, models: [] };

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
      cancelAnimationFrame(raf); ro.disconnect();
      el.removeEventListener("mousedown", onMouseDown); window.removeEventListener("mousemove", onMouseMove); window.removeEventListener("mouseup", onMouseUp); el.removeEventListener("wheel", onWheel);
      transformControls.dispose(); gizmo.dispose(); renderer.dispose(); el.innerHTML = "";
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // MUST be []: scene/renderer setup is one-time. Adding models here
          // tears down the scene on every state change, resetting meshesMap to {}
          // and causing all meshes to snap back to their stored matrix positions.

  useEffect(() => {
    const { meshesContainer, transformControls, meshesMap } = sRef.current;
    if (!meshesContainer) return;

    // Keep stable init-effect closures up to date.
    sRef.current.models = models;

    const currentIds = models.map(m => m.id);
    Object.keys(meshesMap).forEach(id => {
      if (!currentIds.includes(id)) {
        meshesContainer.remove(meshesMap[id]);
        meshesMap[id].geometry.dispose();
        meshesMap[id].material.dispose();
        delete meshesMap[id];
      }
    });

    models.forEach(m => {
      if (!meshesMap[m.id]) {
        const geo = new THREE.BufferGeometry();
        geo.setAttribute("position", new THREE.Float32BufferAttribute(m.vertices, 3));
        geo.setAttribute("normal", new THREE.Float32BufferAttribute(m.normals, 3));
        
        geo.computeVertexNormals();
        geo.rotateX(-Math.PI / 2);

        const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ roughness: 0.4, metalness: 0.1, side: THREE.FrontSide }));
        mesh.userData.modelId = m.id;
        meshesContainer.add(mesh);
        meshesMap[m.id] = mesh;

        // Apply initial matrix layout on instantiation
        if (matrices[m.id]) {
          const m4 = new THREE.Matrix4().fromArray(matrices[m.id]);
          m4.decompose(mesh.position, mesh.quaternion, mesh.scale);
          mesh.updateMatrix();
        }
      }
    });

    const activeModel = models[activeIdx];
    const targetMesh = activeModel ? meshesMap[activeModel.id] : null;

    const helper = transformControls.getHelper?.() || transformControls;
    if (showGizmo && targetMesh && toolRef.current !== "none") {
      transformControls.attach(targetMesh);
      if (helper) helper.visible = true;
    } else {
      transformControls.detach();
      if (helper) helper.visible = false;   // ensure arrows vanish past the Model step
    }

    Object.values(meshesMap).forEach(mesh => {
      mesh.material.color.setHex(mesh.userData.modelId === activeModel?.id ? 0x3a90e6 : 0x8593a3);
    });

  }, [models, activeIdx, showGizmo]);

  // ── Cylinder sync: rebuild whenever cylinder dimensions change ────────────
  useEffect(() => {
    const { scene } = sRef.current;
    if (!scene) return;

    // Remove old cylinder meshes tagged with userData.isCylinder
    const toRemove = [];
    scene.traverse(obj => { if (obj.userData.isCylinder) toRemove.push(obj); });
    toRemove.forEach(obj => {
      scene.remove(obj);
      obj.geometry?.dispose();
      obj.material?.dispose();
    });

    if (showVial && cylinder && cylinder.radius > 0 && cylinder.height > 0) {
      const r = cylinder.radius;
      const h = cylinder.height;

      // Open cylinder wall
      const cylGeo = new THREE.CylinderGeometry(r, r, h, 64, 1, true);
      const cylMat = new THREE.MeshStandardMaterial({
        color: 0x4a78b0, transparent: true, opacity: 0.05,
        side: THREE.DoubleSide, depthWrite: false,
      });
      const cylMesh = new THREE.Mesh(cylGeo, cylMat);
      cylMesh.userData.isCylinder = true;
      // STL viewer is Y-up (geometry has -π/2 rotateX baked in),
      // so CylinderGeometry (Y-axis aligned) stands upright naturally.
      scene.add(cylMesh);

      // Faint wireframe rim edges (the vial is just a reference)
      const edgeGeo = new THREE.EdgesGeometry(new THREE.CylinderGeometry(r, r, h, 64, 1, false));
      const edgeMat = new THREE.LineBasicMaterial({ color: 0x4a9eef, transparent: true, opacity: 0.6 });
      const edgeMesh = new THREE.LineSegments(edgeGeo, edgeMat);
      edgeMesh.userData.isCylinder = true;
      scene.add(edgeMesh);

      // Faint ground grid at the vial floor (even fainter than the vial)
      const grid = new THREE.GridHelper(Math.max(r * 2.4, 40), 24, 0x2e527c, 0x2e527c);
      grid.position.y = -h / 2;
      grid.material.transparent = true; grid.material.opacity = 0.18;
      grid.userData.isCylinder = true;
      scene.add(grid);

      // Usable print boundary (smaller when fan-beam correction is on) — kept a bit
      // more visible than the vial since it's the meaningful limit.
      const pr = printRadius || r;
      if (pr < r - 0.01) {
        const pGeo = new THREE.CylinderGeometry(pr, pr, h, 64, 1, true);
        const pMat = new THREE.MeshStandardMaterial({ color: 0x2e7d18, transparent: true, opacity: 0.06, side: THREE.DoubleSide, depthWrite: false });
        const pMesh = new THREE.Mesh(pGeo, pMat); pMesh.userData.isCylinder = true; scene.add(pMesh);
        const pEdge = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.CylinderGeometry(pr, pr, h, 64, 1, false)), new THREE.LineBasicMaterial({ color: 0x2e7d18, transparent: true, opacity: 0.6 }));
        pEdge.userData.isCylinder = true; scene.add(pEdge);
      }
    }
  }, [cylinder, printRadius, showVial]);

  // Safe targeted sync: ONLY applies if the change came from the side-panel inputs
  useEffect(() => {
    if (!xform || xform.changeOrigin !== "input") return;
    
    const { meshesMap } = sRef.current;
    const activeModel = models[activeIdx];
    const targetMesh = activeModel ? meshesMap[activeModel.id] : null;
    if (!targetMesh) return;

    targetMesh.position.set(xform.tx, xform.ty, xform.tz);
    targetMesh.rotation.set(
      THREE.MathUtils.degToRad(xform.rx),
      THREE.MathUtils.degToRad(xform.ry),
      THREE.MathUtils.degToRad(xform.rz)
    );
    targetMesh.scale.set(xform.sx, xform.sy, xform.sz);
    targetMesh.updateMatrix();
  }, [xform, activeIdx, models]);

  return <div ref={mountRef} style={{ width: "100%", height: "100%" }} />;
});

export default StlViewer;