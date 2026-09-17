"""The native shell's argument handling must work before any WebView is created."""

import os
import subprocess
from pathlib import Path

import pytest

pytestmark = pytest.mark.skipif(not os.environ.get("SHOGIHOME_GUI_EXE"), reason="requires a built Tauri shell")


def test_help_and_invalid_arguments_do_not_initialize_gui(tmp_path):
    executable = Path(os.environ["SHOGIHOME_GUI_EXE"]).resolve()
    env = {key: value for key, value in os.environ.items() if key not in ("DISPLAY", "WAYLAND_DISPLAY")}
    env["LC_ALL"] = "C.UTF-8"
    help_result = subprocess.run([str(executable), "--help"], cwd=tmp_path, env=env, capture_output=True, text=True, timeout=15)
    assert help_result.returncode == 0
    assert "--config-editor" in help_result.stdout
    assert "--no-tray" in help_result.stdout
    assert ("wrapper.exe" if os.name == "nt" else "wrapper --config-dir") in help_result.stdout
    for args in (["--config-dir", str(tmp_path)], ["--tray", "--no-tray"], ["--config-editor", "--tray"], ["--unknown"]):
        result = subprocess.run([str(executable), *args], cwd=tmp_path, env=env, capture_output=True, timeout=15)
        assert result.returncode == 2
    assert not (tmp_path / "engine-wrapper").exists()
