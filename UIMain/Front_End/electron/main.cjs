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
// Python runtime layout differs by OS: Windows uses python.exe + Lib\site-packages
// and a Scripts\ venv dir; macOS/Linux use bin/python(3) + lib/pythonX.Y/site-packages.
const IS_WIN = process.platform === "win32";
// Bundled-runtime Python version (macOS/Linux packaged build) — must match the
// runtime produced by the packaging step; only used when app.isPackaged.
const PY_VER = process.env.TOMO_PY_VER || "3.13";
let PY_EXE, BACKEND_DIR, SERVER, PY_SITE;
if (app.isPackaged) {
  const RES = process.resourcesPath;
  PY_EXE = IS_WIN
    ? path.join(RES, "python", "python.exe")
    : path.join(RES, "python", "bin", "python3");
  BACKEND_DIR = path.join(RES, "backend");
  SERVER = path.join(BACKEND_DIR, "server.py");
  PY_SITE = IS_WIN                                               // vamtoolbox lives here
    ? path.join(RES, "python", "Lib", "site-packages")
    : path.join(RES, "python", "lib", `python${PY_VER}`, "site-packages");
} else {
  PY_EXE = IS_WIN
    ? path.join(REPO_ROOT, ".venv", "Scripts", "python.exe")
    : path.join(REPO_ROOT, ".venv", "bin", "python");
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

// Make sure a backend is up (reuse if one is already answering, else spawn +
// wait).  Used both on first launch and when the window is re-opened from the
// Dock on macOS — the reopened window shows the startup screen and polls the
// backend, so if it isn't running the app would hang there forever.
async function ensureBackend() {
  if (await pingBackend()) {
    dbg(`reusing existing backend on :${BACKEND_PORT}`);
    console.log(`[electron] reusing backend already running on :${BACKEND_PORT}`);
    return;
  }
  dbg("no backend; starting it");
  startBackend();
  const ok = await waitForBackend();
  dbg("waitForBackend -> " + ok);
}

app.whenReady().then(async () => {
  if (!gotTheLock) { app.quit(); return; }   // second instance — bail before spawning anything
  dbg("app ready");
  createWindow();                    // show the window IMMEDIATELY (no ~20-30s blank wait)
  dbg("window created");
  await ensureBackend();
  // macOS: clicking the Dock icon after the window was closed re-creates it.
  // The backend may have been torn down, so ensure it's back before the fresh
  // startup screen starts polling (otherwise it hangs on "starting…").
  app.on("activate", async () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      dbg("activate: re-creating window");
      createWindow();
      await ensureBackend();
    }
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
  // macOS: closing the window does NOT quit the app (it stays in the Dock), so
  // keep the backend alive for an instant, working reopen. Tearing it down here
  // is what left a reopened app stuck on the startup screen (the new window
  // polled a backend that had been killed). The backend is freed on real quit
  // via before-quit -> shutdown().  Other platforms quit here, so tear down now.
  if (process.platform !== "darwin") {
    shutdown();
    app.quit();
  }
});
app.on("before-quit", shutdown);
