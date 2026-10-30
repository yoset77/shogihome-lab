"""Fast regressions for the native GUI test driver's synchronization."""

import http.client
import json
import os
import signal
import subprocess
import sys
from types import SimpleNamespace

import pytest

import launcher_linux_picker
import test_launcher_gui as windows_gui
import test_launcher_linux_gui as linux_gui


class PickerClient:
    def __init__(self, root, result):
        self.root = root
        self.result = result
        self.scripts = []
        (root / "app.pid").write_text("456")

    def execute(self, script, *, read_only=False):
        self.scripts.append(script)
        if "editor_browse" in script:
            return True
        assert read_only
        return self.result

    def native_window(self, title):
        assert title == "Choose engine executable"
        return "123"

    def native_window_id(self, title):
        assert title == "Choose engine executable"
        return None


def picker_commands(monkeypatch, path, selections=None):
    commands = []
    selected = iter(selections or [str(path)])

    def run(args, **kwargs):
        commands.append((args, kwargs))
        if args[:2] == ["xdotool", "getactivewindow"]:
            return SimpleNamespace(stdout="123\n")
        if args == ["xclip", "-selection", "primary", "-o"]:
            return SimpleNamespace(returncode=0, stdout=next(selected))

    monkeypatch.setattr(linux_gui.subprocess, "run", run)
    return commands


def test_picker_pastes_unicode_path_and_reports_result(monkeypatch, tmp_path):
    path = tmp_path / "設定 directory/engine"
    commands = picker_commands(monkeypatch, path)
    client = PickerClient(tmp_path, {"state": "resolved", "value": str(path)})

    assert linux_gui.select_engine_file(client, path) == path
    assert (["xclip", "-selection", "clipboard", "-i"], {"input": str(path), "text": True, "check": True, "timeout": 5, "cwd": tmp_path}) in commands
    assert commands[-1][0][0] == "/usr/bin/python3"
    assert commands[-1][0][-2:] == ["456", "Choose engine executable"]
    assert commands[-1][0][1].endswith("launcher_linux_picker.py")
    assert not any("Return" in args for args, _ in commands)
    assert not any(args[:2] == ["xdotool", "type"] for args, _ in commands)


def test_picker_waits_until_paste_reaches_location_entry(monkeypatch, tmp_path):
    path = tmp_path / "engine"
    commands = picker_commands(monkeypatch, path, ["old directory", str(path)])
    client = PickerClient(tmp_path, {"state": "resolved", "value": str(path)})

    assert linux_gui.select_engine_file(client, path) == path
    actions = [args for args, _ in commands]
    primary = ["xclip", "-selection", "primary", "-o"]
    assert actions.count(primary) == 2
    assert actions[-2] == primary
    assert sum("editor_browse" in script for script in client.scripts) == 1


def test_picker_surfaces_native_dialog_failure(monkeypatch, tmp_path):
    path = tmp_path / "engine"
    picker_commands(monkeypatch, path)
    client = PickerClient(tmp_path, {"state": "rejected", "error": "dialog unavailable"})

    with pytest.raises(AssertionError, match="dialog unavailable"):
        linux_gui.select_engine_file(client, path)


def test_picker_accessibility_targets_open_button_in_owned_dialog():
    def node(name, role=None, children=(), pid=None):
        return SimpleNamespace(
            get_name=lambda: name, get_role=lambda: role, get_process_id=lambda: pid,
            get_child_count=lambda: len(children), get_child_at_index=lambda index: children[index],
        )

    title = "Choose engine executable"
    button = node("Open", "button")
    owned = node("app", pid=456, children=[node(title, children=[node("Open", "label"), node("Cancel", "button"), button])])
    other = node("other app", pid=789, children=[node(title, children=[node("Open", "button")])])
    desktop = node("desktop", children=[other, owned])

    assert launcher_linux_picker.find_open_button(desktop, 456, title, "button") is button
    assert launcher_linux_picker.find_open_button(desktop, 999, title, "button") is None


class Page:
    def __init__(self, url, destination=None):
        self.url = url
        self.destination = destination or url
        self.events = []

    def wait_for_url(self, matches, *, timeout):
        assert timeout > 0
        self.url = self.destination
        assert matches(self.url)
        self.events.append("navigation")

    def locator(self, selector):
        self.events.append(selector)
        return self

    def wait_for(self, *, state, timeout):
        assert state == "visible" and timeout > 0
        self.events.append("visible")

    def set_default_timeout(self, timeout):
        assert timeout == 15000


@pytest.mark.parametrize("document,selector", [("index.html", "#restartBtn"), ("editor.html", "#addEngineBtn")])
def test_cdp_page_created_after_connect_pumps_playwright_events(monkeypatch, document, selector):
    page = Page("about:blank", f"http://tauri.localhost/{document}")
    context = SimpleNamespace(pages=[])

    def wait_for_event(event, *, timeout):
        assert event == "page" and timeout > 0
        context.pages.append(page)
        return page

    context.wait_for_event = wait_for_event
    monkeypatch.setattr(windows_gui.time, "sleep", lambda _: pytest.fail("must not block the Playwright dispatcher"))

    assert windows_gui._wait_for_page(context, document, selector) is page
    assert page.events == ["navigation", selector, "visible"]


@pytest.mark.parametrize("url", ["http://tauri.localhost/", "http://tauri.localhost/index.html"])
def test_cdp_page_selected_by_document_not_list_position(url):
    page = Page(url)
    context = SimpleNamespace(pages=[Page("http://tauri.localhost/logs.html"), page])

    assert windows_gui._wait_for_page(context, "index.html", "#restartBtn") is page


def test_cdp_existing_blank_page_waits_for_navigation():
    page = Page("about:blank", "http://tauri.localhost/editor.html")
    context = SimpleNamespace(pages=[page])

    assert windows_gui._wait_for_page(context, "editor.html", "#addEngineBtn") is page


def test_cdp_timeout_reports_endpoint_and_connection_error(monkeypatch):
    import urllib.request

    def refused(*args, **kwargs):
        raise ConnectionRefusedError("connection refused")

    monkeypatch.setattr(urllib.request, "urlopen", refused)
    with pytest.raises(AssertionError, match=r"127\.0\.0\.1:45678.*connection refused"):
        windows_gui._wait_cdp_ready(45678, timeout=0.01)


class Connection:
    def __init__(self, responses):
        self.responses = iter(responses)
        self.sock = None
        self.requests = []
        self.closed = False
        self.reads = 0

    def request(self, method, path, body, headers):
        self.requests.append((method, path, json.loads(body) if body else None))

    def getresponse(self):
        response = next(self.responses)
        if isinstance(response, Exception):
            raise response
        return SimpleNamespace(status=response[0], read=lambda: self.read(response[1]))

    def read(self, body):
        self.reads += 1
        return json.dumps({"value": body}).encode()

    def close(self):
        self.closed = True


def connections(monkeypatch, *instances):
    pending = iter(instances)
    created = []

    def connect(host, port, *, timeout):
        assert (host, port) == ("127.0.0.1", 4444)
        assert timeout > 0
        instance = next(pending)
        created.append(instance)
        return instance

    monkeypatch.setattr(linux_gui.http.client, "HTTPConnection", connect)
    return created


def test_webdriver_reuses_connection_and_drains_each_response(monkeypatch, tmp_path):
    connection = Connection([(200, {"ready": True}), (200, ["main"])])
    created = connections(monkeypatch, connection)
    client = linux_gui.Gui("http://127.0.0.1:4444", tmp_path)
    client.session = "session"

    assert client.request("GET", "/status") == {"ready": True}
    assert client.handles() == ["main"]
    assert created == [connection]
    assert connection.reads == 2
    client.close()
    assert connection.closed


@pytest.mark.parametrize("method,read_only", [("GET", False), ("POST", True)])
def test_webdriver_read_only_reset_reconnects_once(monkeypatch, tmp_path, method, read_only):
    first = Connection([http.client.RemoteDisconnected("native connection reset")])
    second = Connection([(200, True)])
    created = connections(monkeypatch, first, second)
    client = linux_gui.Gui("http://127.0.0.1:4444", tmp_path)

    assert client.request(method, "/read", read_only=read_only) is True
    assert created == [first, second]
    assert first.closed
    log = (tmp_path / "webdriver.log").read_text()
    assert "RemoteDisconnected" in log and "attempt=2" in log and "elapsed=" in log
    client.close()


@pytest.mark.parametrize("command", ["restart_services", "editor_save", "editor_probe"])
def test_webdriver_never_replays_mutating_ipc_after_reset(monkeypatch, tmp_path, command):
    connection = Connection([http.client.RemoteDisconnected("response lost after execution")])
    created = connections(monkeypatch, connection)
    client = linux_gui.Gui("http://127.0.0.1:4444", tmp_path)
    client.session = "session"

    with pytest.raises(linux_gui.GuiTransportError, match="POST /session/session/execute/async.*1 attempt"):
        client.invoke(command)
    assert created == [connection]
    assert len(connection.requests) == 1
    assert connection.requests[0][2]["args"][0] == command


def test_webdriver_read_retry_is_bounded(monkeypatch, tmp_path):
    first = Connection([ConnectionResetError("reset")])
    second = Connection([ConnectionResetError("reset again")])
    created = connections(monkeypatch, first, second)
    client = linux_gui.Gui("http://127.0.0.1:4444", tmp_path)

    with pytest.raises(linux_gui.GuiTransportError, match="GET /status.*2 attempt"):
        client.request("GET", "/status")
    assert created == [first, second]
    assert first.closed and second.closed


def test_webdriver_does_not_retry_timeouts(monkeypatch, tmp_path):
    connection = Connection([TimeoutError("native driver stalled")])
    created = connections(monkeypatch, connection)
    client = linux_gui.Gui("http://127.0.0.1:4444", tmp_path)

    with pytest.raises(linux_gui.GuiTransportError, match="GET /status.*1 attempt"):
        client.request("GET", "/status")
    assert created == [connection]


def test_webdriver_does_not_retry_protocol_errors(monkeypatch, tmp_path):
    connection = Connection([(500, {"error": "invalid session id", "message": "session gone"})])
    created = connections(monkeypatch, connection)
    client = linux_gui.Gui("http://127.0.0.1:4444", tmp_path)

    with pytest.raises(AssertionError, match="session gone"):
        client.request("GET", "/status")
    assert created == [connection]
    client.close()


@pytest.mark.skipif(sys.platform != "linux", reason="requires /proc")
def test_cleanup_finds_orphaned_helpers_without_touching_unrelated_processes(tmp_path):
    helper_pid = tmp_path / "helper.pid"
    outside = subprocess.Popen([sys.executable, "-c", "import time;time.sleep(30)"], cwd=tmp_path.parent)
    try:
        subprocess.run(
            [sys.executable, "-c", "import pathlib,subprocess,sys; "
             "p=subprocess.Popen([sys.executable,'-c','import time;time.sleep(30)'],start_new_session=True); "
             "pathlib.Path('helper.pid').write_text(str(p.pid))"],
            cwd=tmp_path, check=True, timeout=5,
        )
        pid = int(helper_pid.read_text())
        owned = linux_gui.owned_processes(tmp_path)
        assert pid in [process["pid"] for process in owned]
        assert outside.pid not in [process["pid"] for process in owned]

        linux_gui.cleanup_processes(tmp_path)
        linux_gui.wait_until(lambda: not linux_gui.process_alive(pid), "orphaned helper exit", timeout=5)
        assert outside.poll() is None
    finally:
        linux_gui.cleanup_processes(tmp_path, timeout=0)
        outside.kill()
        outside.wait(timeout=5)


@pytest.mark.skipif(sys.platform != "linux", reason="requires /proc")
def test_cleanup_signals_owned_groups_even_when_helper_changes_cwd(tmp_path):
    pid_file = tmp_path / "helper.pid"
    owner = subprocess.Popen(
        [sys.executable, "-c", "import pathlib,subprocess,sys,time; "
         f"p=subprocess.Popen([sys.executable,'-c','import time;time.sleep(30)'],cwd={str(tmp_path.parent)!r}); "
         "pathlib.Path('helper.pid').write_text(str(p.pid)); time.sleep(30)"],
        cwd=tmp_path, start_new_session=True,
    )
    try:
        linux_gui.wait_until(pid_file.exists, "helper startup", timeout=5)
        pid = int(pid_file.read_text())
        assert pid not in [process["pid"] for process in linux_gui.owned_processes(tmp_path)]

        linux_gui.cleanup_processes(tmp_path)
        owner.wait(timeout=5)
        linux_gui.wait_until(lambda: not linux_gui.process_alive(pid), "owned group exit", timeout=5)
    finally:
        try:
            os.killpg(owner.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        owner.wait(timeout=5)


@pytest.mark.skipif(sys.platform != "linux", reason="requires /proc")
def test_cleanup_reaps_explicit_process_handle_after_chdir(tmp_path):
    process = subprocess.Popen([sys.executable, "-c", "import time;time.sleep(30)"], cwd=tmp_path.parent)
    try:
        assert process.pid not in [item["pid"] for item in linux_gui.owned_processes(tmp_path)]
        linux_gui.stop_process(process)
        assert process.returncode == -signal.SIGTERM
    finally:
        if process.poll() is None:
            process.kill()
        process.wait(timeout=5)


@pytest.mark.skipif(sys.platform != "linux", reason="requires /proc")
def test_cleanup_escalates_when_owned_process_ignores_sigterm(tmp_path):
    ready = tmp_path / "ready"
    process = subprocess.Popen(
        [sys.executable, "-c", "import pathlib,signal,time; "
         "signal.signal(signal.SIGTERM,signal.SIG_IGN); pathlib.Path('ready').touch(); time.sleep(30)"],
        cwd=tmp_path, start_new_session=True,
    )
    try:
        linux_gui.wait_until(ready.exists, "SIGTERM handler startup", timeout=5)
        linux_gui.cleanup_processes(tmp_path, timeout=0.05)
        assert process.wait(timeout=5) == -signal.SIGKILL
    finally:
        if process.poll() is None:
            process.kill()
        process.wait(timeout=5)


@pytest.mark.skipif(sys.platform != "linux", reason="requires /proc")
def test_cleanup_does_not_signal_a_reused_pid(monkeypatch):
    signals = []
    monkeypatch.setattr(linux_gui.os, "kill", lambda *args: signals.append(args))
    monkeypatch.setattr(linux_gui.os, "killpg", lambda *args: signals.append(args))

    linux_gui.signal_owned_process({"pid": os.getpid(), "start_time": "not-the-original-process"}, signal.SIGKILL)
    assert not signals
