#!/usr/bin/env bash
# Build the macOS Tomo.app / .dmg (Apple Silicon).
#
# Assembles a self-contained, relocatable Python runtime under build/python that
# includes OUR Metal-capable vamtoolbox (installed non-editable so the source is
# copied in) + metalcompute, then runs electron-builder. The Metal acceleration
# ships inside the bundle.
#
# Prereqs: Node 20+ (brew install node), an internet connection for the first
# run (downloads a relocatable CPython + Electron), and a VAMToolbox checkout.
#
# Usage:  VAMTOOLBOX=/path/to/VAMToolbox ./build_mac.sh
set -euo pipefail

REPO="$(cd "$(dirname "$0")" && pwd)"
VAMTOOLBOX="${VAMTOOLBOX:-$HOME/Developer/VAMToolbox}"
PY_TAG="20260623"
PY_VER="3.13.14"
PY_URL="https://github.com/astral-sh/python-build-standalone/releases/download/${PY_TAG}/cpython-${PY_VER}%2B${PY_TAG}-aarch64-apple-darwin-install_only.tar.gz"

export PATH="/opt/homebrew/bin:$PATH"          # prefer brew node (system node may be old)
unset ELECTRON_RUN_AS_NODE || true
export CSC_IDENTITY_AUTO_DISCOVERY=false        # unsigned build (see BUILD_MAC.md)

echo "==> [1/4] relocatable CPython -> build/python"
mkdir -p "$REPO/build"
if [ ! -x "$REPO/build/python/bin/python3" ]; then
  curl -sL "$PY_URL" -o "$REPO/build/py.tar.gz"
  ( cd "$REPO/build" && rm -rf python && tar -xzf py.tar.gz && rm py.tar.gz )
fi
PY="$REPO/build/python/bin/python3"

echo "==> [2/4] install backend deps + OUR vamtoolbox (Metal) into the runtime"
"$PY" -m pip install -q --upgrade pip
"$PY" -m pip install -q "$VAMTOOLBOX"           # non-editable -> copies Metal source in
"$PY" -m pip install -q flask flask-cors opencv-python psutil joblib imageio-ffmpeg \
    "metalcompute==0.2.9" dill matplotlib pyglet trimesh scikit-image Pillow numpy-stl \
    PyOpenGL lib3mf pyvista tqdm vedo scipy
# confirm Metal is present in the bundle-to-be
"$PY" -c "import vamtoolbox.util.hardware as h; assert h.detect_system()['metal'], 'Metal missing!'; print('   metal: OK')"

echo "==> [3/4] slim the runtime"
find "$REPO/build/python" -type d -name __pycache__ -prune -exec rm -rf {} + 2>/dev/null || true
find "$REPO/build/python" -type d -name tests -path "*/site-packages/*" -prune -exec rm -rf {} + 2>/dev/null || true
rm -rf "$REPO/build/python/lib/python${PY_VER%.*}/site-packages/pip" \
       "$REPO/build/python/lib/python${PY_VER%.*}/site-packages/setuptools" 2>/dev/null || true

echo "==> [4/4] vite build + electron-builder (dmg)"
( cd "$REPO/UIMain/Front_End" && npm run dist )
echo "==> done: $REPO/build/dist-app/*.dmg"
ls -lh "$REPO"/build/dist-app/*.dmg 2>/dev/null || true
