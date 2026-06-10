"""
main.py — VVAM desktop entry point
===================================
Starts Flask in a background thread then opens the UI in a minimal
Edge/Chrome --app window (no tabs, no address bar).

Edge is guaranteed on Windows 10/11.  If it can't be found we fall back to
the default browser via webbrowser.open().

Edge process-reuse problem
--------------------------
When an existing Edge instance is already running, `msedge.exe --app=URL`
hands the request to that instance and the new process exits in < 1 second.
We detect this by checking proc.returncode shortly after launch — if it exited
fast we fall back to polling Flask until the server stops responding (i.e. the
user killed the app another way), which keeps main() alive.
"""

import os
import sys
import subprocess
import threading
import time
import signal
import multiprocessing

# ---------------------------------------------------------------------------
# Path setup (frozen vs dev)
# ---------------------------------------------------------------------------
if getattr(sys, "frozen", False):
    base_dir = getattr(sys, "_MEIPASS", os.path.dirname(sys.executable))
else:
    base_dir = os.path.dirname(os.path.abspath(__file__))

if base_dir not in sys.path:
    sys.path.insert(0, base_dir)

from server import app  # noqa: E402

HOST = "127.0.0.1"
PORT = 5174
URL  = f"http://{HOST}:{PORT}"


# ---------------------------------------------------------------------------
# Flask
# ---------------------------------------------------------------------------
def _run_flask():
    app.run(host=HOST, port=PORT, debug=False, use_reloader=False, threaded=True)


def _wait_for_server(timeout: float = 15.0) -> bool:
    import urllib.request
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            urllib.request.urlopen(URL, timeout=1)
            return True
        except Exception:
            time.sleep(0.1)
    return False


# ---------------------------------------------------------------------------
# Browser detection
# ---------------------------------------------------------------------------
def _find_browser():
    """Return exe path for Edge or Chrome, or None."""
    try:
        import winreg
        reg_keys = [
            (winreg.HKEY_LOCAL_MACHINE,
             r"SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\msedge.exe"),
            (winreg.HKEY_CURRENT_USER,
             r"SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\msedge.exe"),
            (winreg.HKEY_LOCAL_MACHINE,
             r"SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\chrome.exe"),
            (winreg.HKEY_CURRENT_USER,
             r"SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\chrome.exe"),
        ]
        for hive, subkey in reg_keys:
            try:
                with winreg.OpenKey(hive, subkey) as k:
                    path = winreg.QueryValue(k, None)
                    if path and os.path.isfile(path):
                        return path
            except OSError:
                pass
    except ImportError:
        pass

    fallbacks = [
        r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
        r"C:\Program Files\Microsoft\Edge\Application\msedge.exe",
        r"C:\Program Files\Google\Chrome\Application\chrome.exe",
        r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
    ]
    for p in fallbacks:
        if os.path.isfile(p):
            return p
    return None


# ---------------------------------------------------------------------------
# Keep-alive: poll Flask until it stops responding
# ---------------------------------------------------------------------------
def _wait_for_server_death():
    """Block until Flask stops responding (user closed the app externally)."""
    import urllib.request
    while True:
        time.sleep(3)
        try:
            urllib.request.urlopen(
                urllib.request.Request(URL, method="HEAD"), timeout=2
            )
        except Exception:
            break


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------
def main():
    flask_thread = threading.Thread(target=_run_flask, daemon=True)
    flask_thread.start()

    print(f"[VVAM] Starting Flask on {URL} …")
    if not _wait_for_server():
        print("[VVAM] ERROR: Flask did not start within 15 s")
        sys.exit(1)
    print("[VVAM] Flask ready")

    browser = _find_browser()

    if browser:
        # --app=URL  : minimal window, no tab strip, no omnibox
        # --no-first-run / --no-default-browser-check : suppress Edge startup dialogs
        # --disable-features=TranslateUI : suppress translate popup
        # Do NOT pass --disable-extensions: breaks app-mode on some Edge builds
        cmd = [
            browser,
            f"--app={URL}",
            "--no-first-run",
            "--no-default-browser-check",
            "--disable-features=TranslateUI",
            "--window-size=1400,900",
        ]
        print(f"[VVAM] Launching: {' '.join(cmd)}")
        flags = subprocess.CREATE_NO_WINDOW if sys.platform == "win32" else 0
        proc = subprocess.Popen(cmd, creationflags=flags)

        # Give the process 3 seconds to settle
        time.sleep(3)
        if proc.poll() is not None:
            # Process already exited — Edge reused an existing instance and
            # handed the URL to it.  The window IS open; we just can't track
            # it via this process.  Keep main() alive by polling Flask.
            print("[VVAM] Edge handed off to existing instance — keeping server alive")
            _wait_for_server_death()
        else:
            # We own the process — wait for the window to close
            try:
                proc.wait()
            except KeyboardInterrupt:
                proc.terminate()

    else:
        import webbrowser
        print(f"[VVAM] No Edge/Chrome found — opening default browser: {URL}")
        webbrowser.open(URL)
        _wait_for_server_death()

    print("[VVAM] Exiting")
    sys.exit(0)


if __name__ == "__main__":
    multiprocessing.freeze_support()
    main()    