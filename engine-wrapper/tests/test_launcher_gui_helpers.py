"""Fast regressions for the native GUI test driver's synchronization."""

from pathlib import Path
from types import SimpleNamespace

import pytest

import test_launcher_gui as windows_gui
import test_launcher_linux_gui as linux_gui


class PickerClient:
    def __init__(self, result):
        self.result = result
        self.scripts = []

    def execute(self, script):
        self.scripts.append(script)
        if "editor_browse" in script:
            return True
        return self.result

    def native_window(self, title):
        assert title == "Choose engine executable"
        return "123"


def test_picker_pastes_unicode_path_and_reports_result(monkeypatch):
    commands = []

    def run(args, **kwargs):
        commands.append((args, kwargs))
        if args[:2] == ["xdotool", "getactivewindow"]:
            return SimpleNamespace(stdout="123\n")

    monkeypatch.setattr(linux_gui.subprocess, "run", run)
    path = Path("/tmp/設定 directory/engine")
    client = PickerClient({"state": "resolved", "value": str(path)})

    assert linux_gui.select_engine_file(client, path) == path
    assert (["xclip", "-selection", "clipboard", "-i"], {"input": str(path), "text": True, "check": True, "timeout": 5}) in commands
    assert not any(args[:2] == ["xdotool", "type"] for args, _ in commands)


def test_picker_surfaces_native_dialog_failure(monkeypatch):
    monkeypatch.setattr(linux_gui.subprocess, "run", lambda *args, **kwargs: SimpleNamespace(stdout="123\n"))
    client = PickerClient({"state": "rejected", "error": "dialog unavailable"})

    with pytest.raises(AssertionError, match="dialog unavailable"):
        linux_gui.select_engine_file(client, Path("/tmp/engine"))


def test_cdp_timeout_reports_endpoint_and_connection_error(monkeypatch):
    import urllib.request

    def refused(*args, **kwargs):
        raise ConnectionRefusedError("connection refused")

    monkeypatch.setattr(urllib.request, "urlopen", refused)
    with pytest.raises(AssertionError, match=r"127\.0\.0\.1:45678.*connection refused"):
        windows_gui._wait_cdp_ready(45678, timeout=0.01)
