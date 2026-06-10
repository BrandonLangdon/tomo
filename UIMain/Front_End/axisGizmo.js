import * as THREE from "three";

/**
 * Corner navigation gizmo: a small X/Y/Z axis triad (data frame, Z up) drawn in the
 * upper-right of the viewport.  It mirrors the main camera's orientation so it acts as
 * an orientation reference.  Call render() at the end of the host's animate loop.
 */
export function makeAxisGizmo() {
  const scene = new THREE.Scene();
  scene.add(new THREE.AmbientLight(0xffffff, 1.1));
  const dl = new THREE.DirectionalLight(0xffffff, 0.6);
  dl.position.set(1, 2, 1);
  scene.add(dl);

  const cam = new THREE.PerspectiveCamera(50, 1, 0.1, 100);

  // Group carries the same -90° X rotation the meshes use, so the data Z axis points
  // up in the view (matching the part) and is labelled "Z".
  const group = new THREE.Group();
  group.rotation.x = -Math.PI / 2;

  const textures = [];
  const defs = [
    [new THREE.Vector3(1, 0, 0), 0xe24b4a, "X"],
    [new THREE.Vector3(0, 1, 0), 0x5fc23a, "Y"],
    [new THREE.Vector3(0, 0, 1), 0x4a9eef, "Z"],
  ];
  for (const [dir, color, label] of defs) {
    group.add(new THREE.ArrowHelper(dir, new THREE.Vector3(), 1.0, color, 0.34, 0.22));
    const cv = document.createElement("canvas");
    cv.width = cv.height = 64;
    const ctx = cv.getContext("2d");
    ctx.fillStyle = "#" + color.toString(16).padStart(6, "0");
    ctx.font = "bold 48px sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(label, 32, 36);
    const tex = new THREE.CanvasTexture(cv);
    textures.push(tex);
    const spr = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false, transparent: true }));
    spr.position.copy(dir.clone().multiplyScalar(1.45));
    spr.scale.set(0.62, 0.62, 0.62);
    group.add(spr);
  }
  scene.add(group);

  const _dir = new THREE.Vector3();
  function render(renderer, mainCamera, target, el, size = 110, margin = 14) {
    const W = el.clientWidth, H = el.clientHeight;
    if (!W || !H) return;
    _dir.subVectors(mainCamera.position, target).normalize();
    cam.position.copy(_dir).multiplyScalar(4.6);   // far enough that arrows+labels never clip
    cam.up.copy(mainCamera.up);
    cam.lookAt(0, 0, 0);
    const x = W - size - margin, y = H - size - margin;   // upper-right (GL y is bottom-up)
    renderer.autoClear = false;
    renderer.setScissorTest(true);
    renderer.setViewport(x, y, size, size);
    renderer.setScissor(x, y, size, size);
    renderer.clearDepth();
    renderer.render(scene, cam);
    renderer.setScissorTest(false);
    renderer.setViewport(0, 0, W, H);
    renderer.setScissor(0, 0, W, H);
    renderer.autoClear = true;
  }
  function dispose() { textures.forEach(t => t.dispose()); }
  return { render, dispose };
}
