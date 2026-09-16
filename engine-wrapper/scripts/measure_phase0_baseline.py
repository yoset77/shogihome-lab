#!/usr/bin/env python3
"""Phase 0 baseline: sizes, versions, wrapper cold-start time-to-listen.

Stdlib only. Measures the current (Python/Node) implementation on this
machine so the Rust rewrite has something concrete to compare against.
Memory numbers are whole-process RSS snapshots of the just-started wrapper,
not a full idle-tree profile (see docs/rust-rewrite.md).
"""

import json
import os
import socket
import subprocess
import sys
import tempfile
import time
from pathlib import Path

WRAPPER_DIR = Path(__file__).resolve().parent.parent
REPO_ROOT = WRAPPER_DIR.parent


def dir_size(path: Path) -> int:
    total = 0
    for p in path.rglob("*"):
        try:
            if p.is_file() and not p.is_symlink():
                total += p.stat().st_size
        except OSError:
            pass
    return total


def file_size(path: Path) -> int:
    try:
        return path.stat().st_size
    except OSError:
        return 0


def rss_kb(pid: int) -> int | None:
    try:
        with open(f"/proc/{pid}/status", encoding="utf-8") as f:
            for line in f:
                if line.startswith("VmRSS:"):
                    return int(line.split()[1])
    except OSError:
        pass
    return None


def free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def wait_port(port: int, timeout: float = 15.0) -> float:
    """Return seconds from call until the port accepts a connection."""
    start = time.monotonic()
    while time.monotonic() - start < timeout:
        try:
            with socket.create_connection(("127.0.0.1", port), timeout=0.5):
                return time.monotonic() - start
        except OSError:
            time.sleep(0.05)
    raise TimeoutError(f"nothing listened on {port}")


def measure_wrapper(impl: str) -> dict:
    port = free_port()
    env = {**os.environ, "BIND_ADDRESS": "127.0.0.1", "LISTEN_PORT": str(port)}
    env.pop("WRAPPER_ACCESS_TOKEN", None)
    with tempfile.TemporaryDirectory() as tmp:
        tmpdir = Path(tmp)
        if impl == "python":
            import shutil

            for name in ("engine_wrapper.py", "common.py"):
                shutil.copy2(WRAPPER_DIR / name, tmpdir / name)
            (tmpdir / "engines.json").write_text("[]", encoding="utf-8")
            cmd = [sys.executable, str(tmpdir / "engine_wrapper.py")]
        elif impl == "node":
            import shutil

            for name in ("engine-wrapper.mjs", "shutdown-coordinator.mjs"):
                shutil.copy2(WRAPPER_DIR / name, tmpdir / name)
            (tmpdir / "engines.json").write_text("[]", encoding="utf-8")
            cmd = ["node", str(tmpdir / "engine-wrapper.mjs")]
        elif impl == "rust":
            binary = WRAPPER_DIR / "target" / "release" / "shogihome-wrapper"
            if not binary.exists():
                raise FileNotFoundError("release binary missing: run `cargo build --release -p shogihome-engine-wrapper` first")
            (tmpdir / "engines.json").write_text("[]", encoding="utf-8")
            cmd = [str(binary), "--config-dir", str(tmpdir)]
        else:
            raise ValueError(f"unknown impl: {impl}")
        start = time.monotonic()
        proc = subprocess.Popen(cmd, cwd=str(tmpdir), env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        try:
            ready_in = wait_port(port)
            wall = time.monotonic() - start
            time.sleep(0.5)  # let RSS settle past import/startup spike
            return {
                "impl": impl,
                "time_to_listen_s": round(ready_in, 3),
                "wall_spawn_to_ready_s": round(wall, 3),
                "rss_kb": rss_kb(proc.pid),
            }
        finally:
            proc.terminate()
            try:
                proc.wait(timeout=10)
            except subprocess.TimeoutExpired:
                proc.kill()
                proc.wait(timeout=10)


def main() -> None:
    pyproject_version = (WRAPPER_DIR / "pyproject.toml").read_text(encoding="utf-8")
    package_json = json.loads((WRAPPER_DIR / "package.json").read_text(encoding="utf-8"))
    shogihome_pkg = json.loads((REPO_ROOT / "shogihome" / "package.json").read_text(encoding="utf-8"))

    result = {
        "versions": {
            "python_wrapper_pyproject": next(
                line.split("=", 1)[1].strip().strip('"') for line in pyproject_version.splitlines() if line.startswith("version")
            ),
            "node_wrapper_package_json": package_json.get("version"),
            "shogihome_package_json": shogihome_pkg.get("version"),
            "node_runtime": subprocess.run(["node", "--version"], capture_output=True, text=True).stdout.strip(),
            "python_runtime": sys.version.split()[0],
        },
        "sizes": {
            "engine_wrapper_py_sources_bytes": sum(
                file_size(WRAPPER_DIR / n)
                for n in (
                    "engine_wrapper.py",
                    "engine-wrapper.mjs",
                    "shutdown-coordinator.mjs",
                    "launcher.py",
                    "config_editor.py",
                    "config_editor.html",
                    "common.py",
                    "server_settings.py",
                    "update_checker.py",
                    "i18n.py",
                )
            ),
            "engine_wrapper_dir_bytes": dir_size(WRAPPER_DIR),
            "shogihome_dist_bytes": dir_size(REPO_ROOT / "shogihome" / "dist") if (REPO_ROOT / "shogihome" / "dist").exists() else None,
        },
        "startup": {},
        "notes": [
            "time_to_listen measured spawn->TCP-accept on loopback, empty engines.json, this machine only.",
            "rss_kb is VmRSS of the wrapper process alone, 0.5s after ready; engines/WebView/Node-server not included.",
        ],
    }
    for impl in ("python", "node", "rust"):
        try:
            result["startup"][impl] = measure_wrapper(impl)
        except Exception as e:  # noqa: BLE001 - baseline must report, not crash
            result["startup"][impl] = {"impl": impl, "error": str(e)}

    print(json.dumps(result, indent=2, ensure_ascii=False))


if __name__ == "__main__":
    main()
