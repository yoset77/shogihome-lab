"""Opt-in native WebKitGTK regressions. Run under Xvfb + a private D-Bus session.

Requires tauri-driver 2.0.5, WebKitWebDriver, openbox, xdotool, wmctrl and a built shell.
Only the Python standard library and pytest are used by the WebDriver client.
"""

import json
import os
import shutil
import signal
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.request
from contextlib import contextmanager
from pathlib import Path

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
    stat = Path(f"/proc/{pid}/stat")
    return stat.exists() and stat.read_text().split(") ", 1)[1][0] != "Z"


class Gui:
    def __init__(self, endpoint, root):
        self.endpoint = endpoint
        self.root = root
        self.session = ""

    def request(self, method, path, body=None):
        data = json.dumps(body).encode() if body is not None else None
        request = urllib.request.Request(self.endpoint + path, data=data, method=method, headers={"Content-Type": "application/json"})
        try:
            with urllib.request.urlopen(request, timeout=30) as response:
                result = json.load(response)["value"]
        except urllib.error.HTTPError as error:
            raise AssertionError(error.read().decode()) from error
        assert not isinstance(result, dict) or "error" not in result, result
        return result

    def execute(self, script, *args):
        return self.request("POST", f"/session/{self.session}/execute/sync", {"script": script, "args": args})

    def invoke(self, command, payload=None):
        result = self.request(
            "POST",
            f"/session/{self.session}/execute/async",
            {
                "script": "const done=arguments[arguments.length-1]; "
                "window.__TAURI_INTERNALS__.invoke(arguments[0],arguments[1])"
                ".then(value=>done({value}),error=>done({failure:String(error)}));",
                "args": [command, payload or {}],
            },
        )
        assert "failure" not in result, result
        return result.get("value")

    def handles(self):
        return self.request("GET", f"/session/{self.session}/window/handles")

    def switch(self, handle):
        self.request("POST", f"/session/{self.session}/window", {"handle": handle})

    def native_window(self, title):
        pid = (self.root / "app.pid").read_text()

        def lookup():
            result = subprocess.run(
                ["xdotool", "search", "--all", "--onlyvisible", "--pid", pid, "--name", f"^{title}$"],
                capture_output=True,
                text=True,
                timeout=5,
            )
            return result.stdout.splitlines()[0] if result.returncode == 0 else None

        return wait_until(lookup, title)

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
        f"p=subprocess.Popen({[str(executable), *args]!r})\n"
        f"pathlib.Path({str(root / 'app.pid')!r}).write_text(str(p.pid))\n"
        "code=p.wait()\n"
        f"pathlib.Path({str(root / 'app.exit')!r}).write_text(str(code))\n"
        "sys.exit(code)\n",
        encoding="utf-8",
    )
    bootstrap.chmod(0o755)
    cwd = root / "unrelated-cwd"
    cwd.mkdir()
    port, native_port = free_ports(2)
    env = {
        **os.environ,
        "LC_ALL": "C.UTF-8",
        "XDG_CONFIG_HOME": str(root / "xdg-config"),
        "XDG_CACHE_HOME": str(root / "xdg-cache"),
        "XDG_DATA_HOME": str(root / "xdg-data"),
    }
    with (root / "gui.log").open("w") as log:
        wm = subprocess.Popen(["openbox"], env=env, stdout=log, stderr=log)
        driver = subprocess.Popen(
            ["tauri-driver", "--port", str(port), "--native-port", str(native_port)],
            cwd=cwd,
            env=env,
            stdout=log,
            stderr=log,
            start_new_session=True,
        )
        client = Gui(f"http://127.0.0.1:{port}", root)
        try:

            def ready():
                try:
                    return client.request("GET", "/status")
                except (OSError, AssertionError):
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
            )
            client.session = session["sessionId"]
            wait_until(lambda: client.execute("return !!window.__TAURI_INTERNALS__"), "IPC ready")
            yield client
        except Exception:
            if shutil.which("scrot"):
                subprocess.run(["scrot", str(root / "failure.png")], timeout=5)
            print((root / "gui.log").read_text(), flush=True)
            raise
        finally:
            if (root / "app.pid").exists():
                pid = int((root / "app.pid").read_text())
                if process_alive(pid):
                    os.kill(pid, signal.SIGKILL)
            if driver.poll() is None:
                os.killpg(driver.pid, signal.SIGTERM)
            driver.wait(timeout=10)
            wm.terminate()
            wm.wait(timeout=10)


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
        shutil.copy2(Path(__file__).parent / "fixtures/probe_engine.py", engine)
        engine.chmod(0o755)
        client.execute("window.picked=null; window.__TAURI_INTERNALS__.invoke('editor_browse').then(p=>window.picked=p); return true;")
        picker = client.native_window("Choose engine executable")
        subprocess.run(["xdotool", "windowactivate", "--sync", picker], check=True, timeout=5)
        time.sleep(0.5)
        subprocess.run(["xdotool", "key", "--clearmodifiers", "ctrl+l"], check=True, timeout=5)
        subprocess.run(["xdotool", "type", "--clearmodifiers", "--", str(engine)], check=True, timeout=5)
        subprocess.run(["xdotool", "key", "Return"], check=True, timeout=5)
        # GTK may consume the first Return to accept path completion.
        time.sleep(0.3)
        if not client.execute("return window.picked"):
            subprocess.run(["xdotool", "key", "Return"], check=True, timeout=5)
        wait_until(lambda: client.execute("return window.picked"), "extensionless file selection")
        assert Path(client.execute("return window.picked")) == engine
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
