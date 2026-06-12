// Electron main process — wraps the Tomo React app in a standalone desktop window
// and manages the Python (Flask) backend lifecycle.
//
//   npm run app        -> vite dev server + electron window (dev)
//   npm run electron   -> electron only (expects vite already running)
//
// In dev the window loads the Vite dev server (http://localhost:5173). When the app
// is built (npm run build) the window loads the static dist/ instead.
const { app, BrowserWindow } = require("electron");
const { spawn } = require("child_process");
const path = require("path");
const http = require("http");
const fs = require("fs");

// Front_End/electron/main.cjs  ->  repo root is three levels up
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");

// In a packaged build the self-contained Python runtime + backend ship under
// resources/ (electron-builder extraResources); in dev we use the repo .venv + src.
let PY_EXE, BACKEND_DIR, SERVER, PY_SITE;
if (app.isPackaged) {
  const RES = process.resourcesPath;
  PY_EXE = path.join(RES, "python", "python.exe");
  BACKEND_DIR = path.join(RES, "backend");
  SERVER = path.join(BACKEND_DIR, "server.py");
  PY_SITE = path.join(RES, "python", "Lib", "site-packages");   // vamtoolbox lives here
} else {
  PY_EXE = path.join(REPO_ROOT, ".venv", "Scripts", "python.exe");
  BACKEND_DIR = path.join(REPO_ROOT, "UIMain", "Python_Backend");
  SERVER = path.join(BACKEND_DIR, "server.py");
  PY_SITE = REPO_ROOT;
}

const DEV_URL = process.env.VITE_DEV_SERVER_URL || "http://localhost:5173";
// Dev and packaged builds use DIFFERENT backend ports so a running installed Tomo
// (always :5174) never collides with a dev build (always :5274) on the same machine.
const BACKEND_PORT = app.isPackaged ? 5174 : 5274;
const BACKEND_PING = `http://localhost:${BACKEND_PORT}/api/poll`;
const DIST_INDEX = path.join(__dirname, "..", "dist", "index.html");

let backendProc = null;
let mainWindow = null;

// Single instance: a second launch must NOT spawn a competing backend on :5174
// (that race is what left the app stuck on the loading screen). Focus the existing
// window instead.
const gotTheLock = app.requestSingleInstanceLock();
app.on("second-instance", () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
});

function pingBackend() {
  return new Promise((resolve) => {
    const req = http.get(BACKEND_PING, () => resolve(true));
    req.on("error", () => resolve(false));
    req.setTimeout(1000, () => { req.destroy(); resolve(false); });
  });
}

function dbg(m) {                       // portable log in the per-user app data dir
  try { fs.appendFileSync(path.join(app.getPath("userData"), "tomo-main.log"),
    `[${new Date().toISOString()}] ${m}\n`); } catch (_) { /* ignore */ }
}
process.on("uncaughtException", (e) => dbg("UNCAUGHT: " + (e && e.stack || e)));

function startBackend() {
  dbg(`isPackaged=${app.isPackaged} resourcesPath=${process.resourcesPath}`);
  dbg(`PY_EXE=${PY_EXE} exists=${fs.existsSync(PY_EXE)}`);
  dbg(`SERVER=${SERVER} exists=${fs.existsSync(SERVER)} cwd=${BACKEND_DIR} PY_SITE=${PY_SITE}`);
  console.log("[electron] launching Python backend:", PY_EXE);
  try {
    backendProc = spawn(PY_EXE, [SERVER], {
      cwd: BACKEND_DIR,
      env: { ...process.env, PYTHONPATH: PY_SITE, PYTHONUNBUFFERED: "1", TOMO_BACKEND_PORT: String(BACKEND_PORT) },
    });
  } catch (e) { dbg("spawn THREW: " + e.message); return; }
  backendProc.on("error", (e) => dbg("backend proc ERROR: " + e.message));
  backendProc.stdout.on("data", (d) => { process.stdout.write("[backend] " + d); dbg("[out] " + d.toString().trim()); });
  backendProc.stderr.on("data", (d) => { process.stderr.write("[backend] " + d); dbg("[err] " + d.toString().trim()); });
  backendProc.on("exit", (code) => { console.log("[electron] backend exited:", code); dbg("backend exited: " + code); });
}

async function waitForBackend(tries = 60) {
  for (let i = 0; i < tries; i++) {
    if (await pingBackend()) return true;
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    title: "",
    backgroundColor: "#16161f",
    autoHideMenuBar: true,
    // Hide the OS title bar (and its app icon) entirely — the in-app top bar acts as
    // the title bar.  Keep the native min/max/close as an overlay (top-right).
    titleBarStyle: "hidden",
    titleBarOverlay: { color: "#1c1c28", symbolColor: "#cfd6e6", height: 48 },
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });
  mainWindow.on("page-title-updated", (e) => e.preventDefault());

  if (app.isPackaged) {
    mainWindow.loadFile(DIST_INDEX);             // packaged: built static app
  } else {
    mainWindow.loadURL(DEV_URL);                 // dev: live Vite server (hot reload)
  }
  mainWindow.on("closed", () => { mainWindow = null; });
}

app.whenReady().then(async () => {
  if (!gotTheLock) { app.quit(); return; }   // second instance — bail before spawning anything
  dbg("app ready");
  createWindow();                    // show the window IMMEDIATELY (no ~20-30s blank wait)
  dbg("window created");
  if (await pingBackend()) {
    dbg(`reusing existing backend on :${BACKEND_PORT}`);
    console.log(`[electron] reusing backend already running on :${BACKEND_PORT}`);
  } else {
    dbg("no backend; starting it");
    startBackend();
    const ok = await waitForBackend();
    dbg("waitForBackend -> " + ok);
  }
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

function shutdown() {
  if (backendProc) {
    const pid = backendProc.pid;
    try {
      if (process.platform === "win32" && pid) {
        // backendProc.kill() leaves the Python process (and its workers) alive on
        // Windows, holding :5174 — so the NEXT launch can't bind and hangs. Kill the
        // whole tree forcefully.
        require("child_process").execSync(`taskkill /pid ${pid} /T /F`, { stdio: "ignore" });
      } else {
        backendProc.kill();
      }
    } catch (_) { try { backendProc.kill(); } catch (__) { /* ignore */ } }
    backendProc = null;
  }
}
app.on("window-all-closed", () => {
  shutdown();
  if (process.platform !== "darwin") app.quit();
});
app.on("before-quit", shutdown);
