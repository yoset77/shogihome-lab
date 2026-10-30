"""Opt-in native WebKitGTK regressions. Run under Xvfb + a private D-Bus session.

Requires tauri-driver 2.0.5, WebKitWebDriver, openbox, xdotool, xclip, wmctrl,
system Python with AT-SPI bindings, and a built shell.
Only the Python standard library and pytest are used by the WebDriver client.

The standalone-editor matrix intentionally mirrors
test_launcher_gui.py: only the driver layer (tauri-driver + xdotool here,
CDP + Win32 there) is OS-specific.
"""

import http.client
import json
import os
import shutil
import signal
import socket
import subprocess
import sys
import time
from contextlib import contextmanager
from pathlib import Path
from urllib.parse import urlsplit

import pytest

pytestmark = pytest.mark.skipif(
    sys.platform != "linux" or not os.environ.get("SHOGIHOME_GUI_EXE"),
    reason="requires Linux GUI dependencies and SHOGIHOME_GUI_EXE",
)


def wait_until(check, description, timeout=20):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        value = check()
        if value:
            return value
        time.sleep(0.05)
    raise AssertionError(f"Timed out: {description}")


def free_ports(count):
    sockets = [socket.socket() for _ in range(count)]
    try:
        for sock in sockets:
            sock.bind(("127.0.0.1", 0))
        return [sock.getsockname()[1] for sock in sockets]
    finally:
        for sock in sockets:
            sock.close()


def process_alive(pid):
    # A dead child can briefly remain a zombie before its owner reaps it.
    try:
        return Path(f"/proc/{pid}/stat").read_text().rsplit(") ", 1)[1][0] != "Z"
    except (FileNotFoundError, ProcessLookupError):
        return False


def owned_processes(root):
    """Find even orphaned services/probes by their private test working directory."""
    root = root.resolve()
    processes = []
    for directory in Path("/proc").iterdir():
        if not directory.name.isdigit():
            continue
        try:
            if not (directory / "cwd").resolve(strict=True).is_relative_to(root):
                continue
            fields = (directory / "stat").read_text().rsplit(") ", 1)[1].split()
            if fields[0] == "Z":
                continue
            processes.append({
                "pid": int(directory.name),
                "ppid": int(fields[1]),
                "start_time": fields[19],
                "command": (directory / "cmdline").read_bytes().replace(b"\0", b" ").decode(errors="replace"),
            })
        except (OSError, ValueError):
            continue
    return processes


def signal_owned_process(process, signum):
    # Do not signal a reused PID, including after a service has exited normally.
    try:
        fields = Path(f"/proc/{process['pid']}/stat").read_text().rsplit(") ", 1)[1].split()
        if fields[19] == process["start_time"]:
            if int(fields[2]) == process["pid"]:
                # App/driver/service session leaders also own helpers that may
                # have changed working directory outside the portable tree.
                os.killpg(process["pid"], signum)
            else:
                os.kill(process["pid"], signum)
    except ProcessLookupError:
        pass
    except FileNotFoundError:
        pass


def cleanup_processes(root, timeout=3):
    """Fallback only: lifecycle assertions run before this cleanup, not after it."""
    deadline = time.monotonic() + timeout
    signalled = set()
    while True:
        processes = owned_processes(root)
        if not processes:
            return
        for process in processes:
            identity = (process["pid"], process["start_time"])
            if identity not in signalled:
                signal_owned_process(process, signal.SIGTERM)
                signalled.add(identity)
        if time.monotonic() >= deadline:
            break
        time.sleep(0.05)
    for process in owned_processes(root):
        signal_owned_process(process, signal.SIGKILL)


def stop_process(process):
    if process is None:
        return
    if process.poll() is None:
        process.terminate()
    try:
        process.wait(timeout=3)
    except subprocess.TimeoutExpired:
        process.kill()
        process.wait(timeout=3)


class GuiTransportError(RuntimeError):
    pass


class Gui:
    def __init__(self, endpoint, root):
        self.endpoint = endpoint
        self.root = root
        self.session = ""
        self.connection = None

    def log(self, message):
        with (self.root / "webdriver.log").open("a", encoding="utf-8") as output:
            output.write(f"{time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())} {message}\n")

    def close(self):
        if self.connection:
            self.connection.close()
            self.connection = None

    def request(self, method, path, body=None, *, read_only=False, timeout=5):
        data = json.dumps(body).encode() if body is not None else None
        # urllib forces Connection: close. Keep a drained HTTP connection instead
        # of racing native-driver connection teardown on every WebDriver command.
        attempts = 2 if method == "GET" or read_only else 1
        for attempt in range(attempts):
            started = time.monotonic()
            self.log(f"-> {method} {path} attempt={attempt + 1}")
            try:
                if self.connection is None:
                    endpoint = urlsplit(self.endpoint)
                    assert endpoint.scheme == "http" and endpoint.hostname == "127.0.0.1", self.endpoint
                    self.connection = http.client.HTTPConnection(endpoint.hostname, endpoint.port, timeout=timeout)
                self.connection.timeout = timeout
                if self.connection.sock:
                    self.connection.sock.settimeout(timeout)
                self.connection.request(method, path, data, {"Content-Type": "application/json"})
                response = self.connection.getresponse()
                body_bytes = response.read()
                self.log(f"<- {method} {path} status={response.status} elapsed={time.monotonic() - started:.3f}s")
                assert 200 <= response.status < 300, body_bytes.decode(errors="replace")
                result = json.loads(body_bytes)["value"]
                assert not isinstance(result, dict) or "error" not in result, result
                return result
            except (OSError, http.client.HTTPException) as error:
                self.log(f"!! {method} {path} elapsed={time.monotonic() - started:.3f}s {type(error).__name__}: {error}")
                self.close()
                retryable = isinstance(error, (ConnectionError, http.client.RemoteDisconnected, http.client.IncompleteRead))
                if attempt + 1 == attempts or not retryable:
                    raise GuiTransportError(f"{method} {path} failed after {attempt + 1} attempt(s): {error}") from error

    def execute(self, script, *args, read_only=False):
        return self.request("POST", f"/session/{self.session}/execute/sync", {"script": script, "args": args}, read_only=read_only)

    def invoke(self, command, payload=None):
        self.log(f"IPC {command}")
        result = self.request(
            "POST",
            f"/session/{self.session}/execute/async",
            {
                "script": "const done=arguments[arguments.length-1]; "
                "window.__TAURI_INTERNALS__.invoke(arguments[0],arguments[1])"
                ".then(value=>done({value}),error=>done({failure:String(error)}));",
                "args": [command, payload or {}],
            },
            read_only=command in ("get_status", "editor_load"),
            timeout=30,
        )
        assert "failure" not in result, result
        return result.get("value")

    def handles(self):
        return self.request("GET", f"/session/{self.session}/window/handles")

    def switch(self, handle):
        self.request("POST", f"/session/{self.session}/window", {"handle": handle})

    def native_window(self, title):
        return wait_until(lambda: self.native_window_id(title), title)

    def native_window_id(self, title):
        pid = (self.root / "app.pid").read_text()
        result = subprocess.run(
            ["xdotool", "search", "--all", "--onlyvisible", "--pid", pid, "--name", f"^{title}$"],
            capture_output=True,
            text=True,
            timeout=5,
        )
        return result.stdout.splitlines()[0] if result.returncode == 0 else None

    def native_close(self, title):
        window = self.native_window(title)
        # EWMH close follows the title-bar path without depending on which
        # window WebKit automation gives keyboard focus to.
        subprocess.run(["wmctrl", "-ic", hex(int(window))], check=True, timeout=5)

    def assert_exited(self):
        file = self.root / "app.exit"
        wait_until(file.exists, "clean application exit")
        assert file.read_text() == "0"


@contextmanager
def gui(root, args):
    executable = root / "ShogiHomeLab"
    shutil.copy2(Path(os.environ["SHOGIHOME_GUI_EXE"]).resolve(), executable)
    bootstrap = root / "bootstrap"
    bootstrap.write_text(
        f"#!{sys.executable}\nimport pathlib,subprocess,sys\n"
        f"p=subprocess.Popen({[str(executable), *args]!r},start_new_session=True)\n"
        f"pathlib.Path({str(root / 'app.pid')!r}).write_text(str(p.pid))\n"
        "print(f'GUI app started: pid={p.pid}',flush=True)\n"
        "code=p.wait()\n"
        f"pathlib.Path({str(root / 'app.exit')!r}).write_text(str(code))\n"
        "print(f'GUI app exited: pid={p.pid} code={code}',flush=True)\n"
        "sys.exit(code)\n",
        encoding="utf-8",
    )
    bootstrap.chmod(0o755)
    cwd = root / "unrelated-cwd"
    cwd.mkdir()
    port, native_port = free_ports(2)
    command = ["tauri-driver", "--port", str(port), "--native-port", str(native_port)]
    env = {
        **os.environ,
        "LC_ALL": "C.UTF-8",
        "GDK_BACKEND": "x11",
        "XDG_CONFIG_HOME": str(root / "xdg-config"),
        "XDG_CACHE_HOME": str(root / "xdg-cache"),
        "XDG_DATA_HOME": str(root / "xdg-data"),
    }
    with (root / "gui.log").open("w") as log:
        wm = None
        driver = None
        client = Gui(f"http://127.0.0.1:{port}", root)
        client.log(f"command={command}")
        try:
            wm = subprocess.Popen(["openbox"], cwd=cwd, env=env, stdout=log, stderr=log)
            driver = subprocess.Popen(command, cwd=cwd, env=env, stdout=log, stderr=log, start_new_session=True)

            def window_manager_ready():
                if wm.poll() is not None:
                    raise AssertionError(f"openbox exited with {wm.returncode}")
                result = subprocess.run(["wmctrl", "-m"], capture_output=True, text=True, timeout=5)
                return result.returncode == 0 and "Openbox" in result.stdout

            wait_until(window_manager_ready, "Openbox startup")

            def ready():
                if driver.poll() is not None:
                    raise AssertionError(f"WebDriver exited with {driver.returncode}")
                try:
                    return client.request("GET", "/status").get("ready") is True
                except GuiTransportError:
                    return False

            wait_until(ready, "WebDriver startup")
            session = client.request(
                "POST",
                "/session",
                {
                    "capabilities": {
                        "alwaysMatch": {
                            "browserName": "wry",
                            "tauri:options": {"application": str(bootstrap)},
                        }
                    }
                },
                timeout=30,
            )
            client.session = session["sessionId"]

            def ipc_ready():
                try:
                    return client.execute("return !!window.__TAURI_INTERNALS__", read_only=True)
                except (GuiTransportError, AssertionError):
                    return False

            wait_until(ipc_ready, "IPC ready")
            yield client
        except Exception:
            if shutil.which("scrot"):
                try:
                    subprocess.run(["scrot", str(root / "failure.png")], timeout=5)
                except subprocess.TimeoutExpired:
                    pass
            pid_file = root / "app.pid"
            exit_file = root / "app.exit"
            print(
                f"GUI processes: driver={driver.poll() if driver else 'missing'}, "
                f"openbox={wm.poll() if wm else 'missing'}, "
                f"app_pid={pid_file.read_text() if pid_file.exists() else 'missing'}, "
                f"app_exit={exit_file.read_text() if exit_file.exists() else 'pending'}",
                flush=True,
            )
            print(json.dumps(owned_processes(root), indent=2), flush=True)
            print("\n".join((root / "gui.log").read_text().splitlines()[-80:]), flush=True)
            print("\n".join((root / "webdriver.log").read_text().splitlines()[-40:]), flush=True)
            raise
        finally:
            client.close()
            (root / "processes-before-cleanup.json").write_text(json.dumps(owned_processes(root), indent=2))
            cleanup_processes(root)
            # Openbox may chdir to HOME; retain and reap its explicit handle too.
            for process in (driver, wm):
                stop_process(process)
            (root / "processes-after-cleanup.json").write_text(json.dumps(owned_processes(root), indent=2))


def slow_engine(config):
    # No extension, spaces, Japanese, and a helper that inherits the pipes.
    path = config / "slow エンジン"
    path.write_text(
        f"#!{sys.executable}\nimport os,pathlib,subprocess,sys\n"
        "p=subprocess.Popen([sys.executable,'-c','import time;time.sleep(60)'])\n"
        "pathlib.Path('probe.pid').write_text(str(os.getpid()))\n"
        "pathlib.Path('helper.pid').write_text(str(p.pid))\n"
        "for line in sys.stdin:\n"
        " if line.strip()=='quit':\n"
        "  pathlib.Path('got-quit').write_text('yes')\n"
        "  break\n",
        encoding="utf-8",
    )
    path.chmod(0o755)
    return path


def start_slow_probe(client, config):
    path = slow_engine(config)
    client.execute("window.__TAURI_INTERNALS__.invoke('editor_probe',{path:arguments[0]}).catch(()=>{}); return true;", path.name)
    wait_until(lambda: (config / "helper.pid").exists(), "probe helper startup")


def assert_probe_drained(config):
    assert (config / "got-quit").exists()
    for file in ("probe.pid", "helper.pid"):
        pid = int((config / file).read_text())
        wait_until(lambda pid=pid: not process_alive(pid), f"reap {file}")


def select_engine_file(client, engine):
    client.execute(
        "window.browseResult={state:'pending'}; "
        "window.__TAURI_INTERNALS__.invoke('editor_browse')"
        ".then(value=>window.browseResult={state:'resolved',value},"
        "error=>window.browseResult={state:'rejected',error:String(error)}); return true;"
    )
    picker = client.native_window("Choose engine executable")
    subprocess.run(["xdotool", "windowactivate", "--sync", picker], check=True, timeout=5)

    def focused():
        result = subprocess.run(["xdotool", "getactivewindow"], capture_output=True, text=True, check=True, timeout=5)
        return int(result.stdout.strip()) == int(picker)

    wait_until(focused, "file picker focus", timeout=5)
    subprocess.run(["xclip", "-selection", "clipboard", "-i"], input=str(engine), text=True, check=True, timeout=5, cwd=client.root)

    def location_entered():
        # PRIMARY reflects selected entry text, unlike CLIPBOARD, which already
        # contains our input. This verifies that GTK actually received the paste.
        for key in ("ctrl+l", "ctrl+a", "ctrl+v", "ctrl+a"):
            subprocess.run(["xdotool", "key", "--clearmodifiers", key], check=True, timeout=5)
        selected = subprocess.run(["xclip", "-selection", "primary", "-o"], capture_output=True, text=True, timeout=2)
        return selected.returncode == 0 and selected.stdout == str(engine)

    wait_until(location_entered, "file picker location entry", timeout=10)
    # RFD's Open button has no mnemonic. Use its native accessibility action,
    # not a guessed key sequence or Return's ambiguous path completion.
    subprocess.run(
        ["/usr/bin/python3", str(Path(__file__).with_name("launcher_linux_picker.py")),
         (client.root / "app.pid").read_text(), "Choose engine executable"],
        check=True, timeout=5,
    )

    def completed():
        result = client.execute("return window.browseResult", read_only=True)
        if result["state"] == "rejected":
            raise AssertionError(f"file picker failed: {result['error']}")
        return result if result["state"] == "resolved" else None

    result = wait_until(completed, "file selection", timeout=20)
    assert result["value"], f"file picker returned no file: {result}"
    wait_until(lambda: not client.native_window_id("Choose engine executable"), "file picker closed")
    return Path(result["value"])


@pytest.mark.parametrize("explicit_dir", [True, False])
def test_standalone_editor_save_probe_lock_and_native_close(tmp_path, explicit_dir):
    config = tmp_path / ("設定 directory" if explicit_dir else "engine-wrapper")
    config.mkdir()
    engines = [{"id": "marker", "name": "Marker", "path": "engine"}]
    (config / "engines.json").write_text(json.dumps(engines), encoding="utf-8")
    args = ["--config-editor"] + (["--config-dir", str(config)] if explicit_dir else [])
    with gui(tmp_path, args) as client:
        assert len(client.handles()) == 1
        assert client.invoke("editor_load")["engines"][0]["id"] == "marker"
        engines[0]["name"] = "保存"
        client.invoke("editor_save", {"engines": engines})
        assert json.loads((config / "engines.json").read_text())[0]["name"] == "保存"
        duplicate = subprocess.run([str(tmp_path / "ShogiHomeLab"), *args], capture_output=True, timeout=20)
        assert duplicate.returncode != 0
        # Exercise the real picker and select an extensionless executable.
        engine = config / "engine"
        engine.write_text(
            "#!/bin/sh\n"
            "while IFS= read -r line; do\n"
            'case "$line" in\n'
            "usi)\n"
            "printf 'option name Threads type spin default 1 min 1 max 128\\n'\n"
            "printf 'option name USI_Ponder type check default true\\n'\n"
            "printf 'usiok\\n'\n"
            ";;\n"
            "quit) exit 0 ;;\n"
            "esac\n"
            "done\n",
            encoding="utf-8",
        )
        engine.chmod(0o755)
        assert select_engine_file(client, engine) == engine
        assert client.invoke("editor_probe", {"path": engine.name})[1]["Threads"]["max"] == 128
        engine.chmod(0o644)
        with pytest.raises(AssertionError, match="Permission denied"):
            client.invoke("editor_probe", {"path": engine.name})
        start_slow_probe(client, config)
        client.native_close("ShogiHome Lab Config Editor")
        client.assert_exited()
        assert_probe_drained(config)
    assert not (tmp_path / "shogihome").exists()


@pytest.mark.parametrize("args", [[], ["--no-tray"], ["--tray"]])
def test_launcher_restart_close_and_quit(tmp_path, args):
    server = tmp_path / "shogihome"
    config = tmp_path / "engine-wrapper"
    (server / "data").mkdir(parents=True)
    (server / "dist/server").mkdir(parents=True)
    config.mkdir()
    shutil.copy2(shutil.which("node"), server / "shogihome-server")
    wrapper = Path(os.environ.get("SHOGIHOME_GUI_WRAPPER_EXE", "target/debug/shogihome-wrapper")).resolve()
    shutil.copy2(wrapper, tmp_path / "wrapper")
    (server / "dist/server/server.js").write_text(
        "import fs from 'node:fs'; import net from 'node:net';\n"
        "fs.writeFileSync('server.pid',String(process.pid));\n"
        "net.createServer(s=>s.end()).listen(Number(process.env.PORT),'127.0.0.1');\n",
        encoding="utf-8",
    )
    server_port, wrapper_port = free_ports(2)
    (server / ".env").write_text(f"PORT={server_port}\nBIND_ADDRESS=127.0.0.1\n")
    (config / ".env").write_text(f"LISTEN_PORT={wrapper_port}\nBIND_ADDRESS=127.0.0.1\nWRAPPER_ACCESS_TOKEN=\n")
    (config / "engines.json").write_text("[]")
    with gui(tmp_path, args) as client:
        main = client.handles()[0]
        wait_until(lambda: client.invoke("get_status")["state"] == "running", "services ready")
        old_pid = int((server / "server.pid").read_text())
        client.invoke("restart_services")
        assert int((server / "server.pid").read_text()) != old_pid
        assert not process_alive(old_pid)
        for attempt in range(2):
            client.invoke("open_editor")
            handles = wait_until(lambda: client.handles() if len(client.handles()) == 2 else None, "editor window")
            client.switch(next(handle for handle in handles if handle != main))
            assert client.invoke("editor_load")["engines"] == []
            if attempt == 0:
                client.native_close("ShogiHome Lab Config Editor")
                wait_until(lambda: len(client.handles()) == 1, "embedded editor close")
            else:
                start_slow_probe(client, config)
            client.switch(main)
        client.native_close("ShogiHome Lab")
        if args == ["--tray"]:
            pid = (tmp_path / "app.pid").read_text()

            def hidden():
                result = subprocess.run(
                    ["xdotool", "search", "--all", "--onlyvisible", "--pid", pid, "--name", "^ShogiHome Lab$"],
                    capture_output=True,
                    timeout=5,
                )
                return result.returncode == 1

            wait_until(hidden, "hide to tray")
            assert process_alive(int(pid))
            assert process_alive(int((server / "server.pid").read_text()))
            # Send the same IPC used by Stop & Exit; do not await a response
            # from a WebView that is about to be destroyed.
            client.execute("setTimeout(()=>window.__TAURI_INTERNALS__.invoke('stop_and_exit'),50); return true;")
        client.assert_exited()
        assert_probe_drained(config)
        assert not process_alive(int((server / "server.pid").read_text()))
        for port in (server_port, wrapper_port):
            with socket.socket() as sock:
                assert sock.connect_ex(("127.0.0.1", port)) != 0
