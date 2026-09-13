"""Opt-in Windows regression against a real Tauri executable and WebView2."""

import os
import shutil
import socket
import subprocess
import sys
import time
from contextlib import ExitStack
from pathlib import Path

import pytest


def _wait_until(check, description, timeout=15):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        result = check()
        if result:
            return result
        time.sleep(0.05)
    raise AssertionError(f"Timed out waiting for {description}")


def _drive_gui(port, pid):
    # Run out of process: even a stuck CDP evaluate must have a hard deadline.
    import ctypes
    import urllib.error
    import urllib.request
    from ctypes import wintypes

    from playwright.sync_api import expect, sync_playwright

    user32 = ctypes.WinDLL("user32", use_last_error=True)
    callback_type = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)
    user32.EnumWindows.argtypes = [callback_type, wintypes.LPARAM]
    user32.GetWindowThreadProcessId.argtypes = [wintypes.HWND, ctypes.POINTER(wintypes.DWORD)]
    user32.GetWindowTextW.argtypes = [wintypes.HWND, wintypes.LPWSTR, ctypes.c_int]
    user32.GetClassNameW.argtypes = [wintypes.HWND, wintypes.LPWSTR, ctypes.c_int]
    user32.IsWindowVisible.argtypes = [wintypes.HWND]
    user32.PostMessageW.argtypes = [wintypes.HWND, wintypes.UINT, wintypes.WPARAM, wintypes.LPARAM]

    def native_window(title=None, class_name=None):
        matches = []

        @callback_type
        def visit(hwnd, _):
            owner = wintypes.DWORD()
            user32.GetWindowThreadProcessId(hwnd, ctypes.byref(owner))
            if owner.value == pid and user32.IsWindowVisible(hwnd):
                caption = ctypes.create_unicode_buffer(512)
                kind = ctypes.create_unicode_buffer(256)
                user32.GetWindowTextW(hwnd, caption, len(caption))
                user32.GetClassNameW(hwnd, kind, len(kind))
                if (title is None or caption.value == title) and (class_name is None or kind.value == class_name):
                    matches.append(hwnd)
            return True

        user32.EnumWindows(visit, 0)
        return matches[0] if matches else None

    def close_native(hwnd):
        # WM_CLOSE follows the native title-bar close path, not page.close().
        assert user32.PostMessageW(hwnd, 0x0010, 0, 0), ctypes.get_last_error()

    endpoint = f"http://127.0.0.1:{port}"
    last_probe = {"detail": "no attempt yet"}

    def cdp_ready():
        try:
            with urllib.request.urlopen(f"{endpoint}/json/version", timeout=1) as response:
                if response.status == 200:
                    return True
                last_probe["detail"] = f"HTTP {response.status}"
                return False
        except urllib.error.HTTPError as e:
            last_probe["detail"] = f"HTTP {e.code}"
            return False
        except (OSError, urllib.error.URLError) as e:
            last_probe["detail"] = f"{type(e).__name__}: {getattr(e, 'reason', e)}"
            return False

    def cdp_port_state():
        import select
        probe = socket.socket()
        try:
            probe.setblocking(False)
            if probe.connect_ex(("127.0.0.1", port)) == 0:
                return "open"
            # connect_ex is immediate; wait for the handshake to settle so
            # WSAEWOULDBLOCK-style "in progress" is not misread as closed.
            _, writable, _ = select.select([], [probe], [], 2.0)
            if not writable:
                return "filtered (no response)"
            err = probe.getsockopt(socket.SOL_SOCKET, socket.SO_ERROR)
            return "open" if err == 0 else f"closed (so_error={err})"
        finally:
            probe.close()

    def cdp_listener_info():
        """Who holds the CDP port, if anyone: netstat LISTENING + owner name."""
        import re
        import subprocess as _subprocess

        try:
            out = _subprocess.run(
                ["netstat", "-ano", "-p", "TCP"],
                capture_output=True,
                text=True,
                timeout=10,
            ).stdout
        except (OSError, _subprocess.SubprocessError):
            return "netstat unavailable"
        listeners = []
        procs = {}
        for line in out.splitlines():
            if "LISTENING" not in line or not re.search(rf":{port}(?!\d)", line):
                continue
            parts = line.split()
            listeners.append(" ".join(parts))
            pid = parts[-1] if parts else ""
            if pid.isdigit() and pid not in procs:
                try:
                    task = _subprocess.run(
                        ["tasklist", "/FI", f"PID eq {pid}", "/FO", "CSV", "/NH"],
                        capture_output=True,
                        text=True,
                        timeout=10,
                    ).stdout.strip()
                    procs[pid] = task.split('","')[0].strip('"') if task else "?"
                except (OSError, _subprocess.SubprocessError):
                    procs[pid] = "?"
        return f"netstat={listeners or 'none'} procs={procs or 'none'}"

    def edge_processes():
        """Is the WebView2 browser itself alive? PIDs correlate with netstat."""
        import subprocess as _subprocess

        try:
            out = _subprocess.run(
                ["tasklist", "/FI", "IMAGENAME eq msedgewebview2.exe", "/FO", "CSV", "/NH"],
                capture_output=True,
                text=True,
                timeout=10,
            ).stdout.strip()
        except (OSError, _subprocess.SubprocessError):
            return "tasklist unavailable"
        rows = [line.split('","') for line in out.splitlines() if line.strip().startswith('"')]
        pids = sorted(row[1].strip('"') for row in rows if len(row) > 1)
        return f"{len(pids)} edge procs pids={pids}" if pids else "none"

    def edge_command_lines():
        """Full Edge command lines: proves whether the debugging flag arrived."""
        import subprocess as _subprocess

        try:
            out = _subprocess.run(
                [
                    "powershell", "-NoProfile", "-NonInteractive", "-Command",
                    "Get-CimInstance Win32_Process -Filter \"Name = 'msedgewebview2.exe'\" "
                    "| Format-List ProcessId,CommandLine",
                ],
                capture_output=True,
                text=True,
                timeout=20,
            ).stdout.strip()
        except (OSError, _subprocess.SubprocessError):
            return "process query unavailable"
        return out[:3000] if out else "none"

    try:
        _wait_until(cdp_ready, "WebView2 debugging endpoint", timeout=30)
    except AssertionError:
        raise AssertionError(
            "Timed out waiting for WebView2 debugging endpoint "
            f"(last probe: {last_probe['detail']}; port {port}: {cdp_port_state()}; "
            f"listener: {cdp_listener_info()}; edge: {edge_processes()}; "
            f"cmdline: {edge_command_lines()})"
        )

    def launcher_state(page):
        status = page.evaluate("""() => Promise.race([
            window.__TAURI_INTERNALS__.invoke('get_status'),
            new Promise((_, reject) => setTimeout(() => reject(new Error('status IPC stalled')), 5000))
        ])""")
        return status["state"]

    with sync_playwright() as playwright:
        browser = playwright.chromium.connect_over_cdp(endpoint, timeout=15000)
        context = browser.contexts[0]
        main = _wait_until(lambda: context.pages and context.pages[0], "dashboard page")
        main.set_default_timeout(15000)
        expect(main.locator("#restartBtn")).to_be_enabled(timeout=30000)
        _wait_until(lambda: launcher_state(main) == "running", "service readiness", timeout=30)
        print("Dashboard ready", flush=True)

        for attempt in range(2):
            with context.expect_page(timeout=15000) as opened:
                main.locator("#editorBtn").click()
            editor = opened.value
            expect(editor.locator("#addEngineBtn")).to_be_visible(timeout=15000)
            print(f"Editor rendered (open {attempt + 1})", flush=True)
            if attempt == 0:
                editor.locator("#addEngineBtn").click()
                print("Opening file picker", flush=True)
                editor.locator("#browseBtn").click()
                dialog = _wait_until(lambda: native_window(class_name="#32770"), "file picker")
                # A synchronous blocking picker freezes this IPC until cancelled.
                assert launcher_state(main) == "running"
                close_native(dialog)
                _wait_until(lambda: not native_window(class_name="#32770"), "file picker cancellation")
                editor.locator("#cancelModalBtn").click()
                hwnd = _wait_until(lambda: native_window(title="ShogiHome Lab Config Editor"), "editor native window")
                with editor.expect_event("close", timeout=15000):
                    close_native(hwnd)
                print("File picker cancelled and editor closed", flush=True)

        # Exit with the reopened editor still present.
        main.locator("#exitBtn").click()
        print("Stop and exit requested", flush=True)


@pytest.mark.skipif(
    sys.platform != "win32" or not os.environ.get("SHOGIHOME_GUI_EXE"),
    reason="requires Windows, WebView2, Playwright and SHOGIHOME_GUI_EXE",
)
def test_editor_open_browse_close_reopen_and_exit(tmp_path):
    root = Path(__file__).resolve().parents[1]
    launcher = Path(os.environ["SHOGIHOME_GUI_EXE"]).resolve()
    wrapper = Path(os.environ.get("SHOGIHOME_GUI_WRAPPER_EXE", root / "target/debug/shogihome-wrapper.exe")).resolve()
    node = shutil.which("node")
    assert launcher.is_file(), launcher
    assert wrapper.is_file(), wrapper
    assert node, "Node.js must be on PATH"

    # Isolate configuration, ports and WebView2 storage from the user's app.
    server = tmp_path / "shogihome"
    config = tmp_path / "engine-wrapper"
    (server / "data").mkdir(parents=True)
    (server / "dist/server").mkdir(parents=True)
    config.mkdir()
    executable = tmp_path / "ShogiHomeLab.exe"
    shutil.copy2(launcher, executable)
    shutil.copy2(wrapper, tmp_path / "wrapper.exe")
    shutil.copy2(node, server / "shogihome-server.exe")
    (server / "dist/server/server.js").write_text(
        "require('node:net').createServer(s => s.end()).listen(Number(process.env.PORT), '127.0.0.1');\n",
        encoding="utf-8",
    )
    (config / "engines.json").write_text("[]", encoding="utf-8")
    with ExitStack() as reservations:
        ports = []
        for _ in range(3):
            sock = reservations.enter_context(socket.socket())
            sock.bind(("127.0.0.1", 0))
            ports.append(sock.getsockname()[1])
        (server / ".env").write_text(f"BIND_ADDRESS=127.0.0.1\nPORT={ports[0]}\n", encoding="utf-8")
        (config / ".env").write_text(f"BIND_ADDRESS=127.0.0.1\nLISTEN_PORT={ports[1]}\nWRAPPER_ACCESS_TOKEN=\n", encoding="utf-8")
    env = {
        **os.environ,
        "WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS": f"--remote-debugging-port={ports[2]} --enable-logging=stderr",
        "WEBVIEW2_USER_DATA_FOLDER": str(tmp_path / "webview2"),
        "PYTHONIOENCODING": "utf-8",
    }
    with (tmp_path / "launcher.log").open("w", encoding="utf-8") as log:
        process = subprocess.Popen([str(executable)], cwd=tmp_path, env=env, stdout=log, stderr=log)
        try:
            driver_log = tmp_path / "gui-driver.log"
            with driver_log.open("w", encoding="utf-8") as output:
                driver = subprocess.Popen(
                    [sys.executable, str(Path(__file__).resolve()), str(ports[2]), str(process.pid)],
                    env=env,
                    stdout=output,
                    stderr=output,
                )
                try:
                    try:
                        driver.wait(timeout=120)
                    except subprocess.TimeoutExpired:
                        pytest.fail(
                            "GUI driver timed out:\n"
                            + driver_log.read_text(encoding="utf-8")
                            + f"\n[app] poll={process.poll()}"
                        )
                    assert driver.returncode == 0, (
                        driver_log.read_text(encoding="utf-8") + f"\n[app] poll={process.poll()}"
                    )
                finally:
                    if driver.poll() is None:
                        subprocess.run(["taskkill", "/PID", str(driver.pid), "/T", "/F"], capture_output=True, timeout=15)
                        driver.wait(timeout=15)
            assert process.wait(timeout=15) == 0
        finally:
            if process.poll() is None:
                subprocess.run(["taskkill", "/PID", str(process.pid), "/T", "/F"], capture_output=True, timeout=15)
                process.wait(timeout=15)


if __name__ == "__main__":
    _drive_gui(int(sys.argv[1]), int(sys.argv[2]))
