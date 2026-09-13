"""Black-box wrapper contract tests (Phase 0).

Same scenarios run against each wrapper implementation via WRAPPER_CMD:
  WRAPPER_CMD=python  - Python wrapper only
  WRAPPER_CMD=node    - Node wrapper only
  WRAPPER_CMD=all     - both (default)
  WRAPPER_CMD=rust    - reserved for Phase 1 (skips until implemented)

Isolation: wrapper sources are copied into a temp config dir so the real
engine-wrapper/engines.json is never touched. The fake engine is launched
through a small shell script so no exec-bit assumptions leak into the repo.
"""

import hashlib
import hmac
import json
import os
import shutil
import socket
import stat
import subprocess
import sys
import time
from pathlib import Path

import pytest

WRAPPER_DIR = Path(__file__).resolve().parent.parent
FIXTURE_ENGINE = Path(__file__).resolve().parent / "fixtures" / "fake_usi_engine.py"

IMPLEMENTATIONS = os.environ.get("WRAPPER_CMD", "all").split(",")
if "all" in IMPLEMENTATIONS:
    SELECTED = ["python", "node"]
else:
    SELECTED = [i.strip() for i in IMPLEMENTATIONS if i.strip()]

TOKEN = "contract-test-token"


def _free_port():
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def _wait_port(port, timeout=10.0):
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            with socket.create_connection(("127.0.0.1", port), timeout=0.5):
                return True
        except OSError:
            time.sleep(0.05)
    raise TimeoutError(f"wrapper did not listen on {port}")


def _write_fake_engine_launcher(tmp: Path) -> Path:
    launcher = tmp / "fake-engine"
    launcher.write_text(f'#!/bin/sh\nexec "{sys.executable}" "{FIXTURE_ENGINE}"\n', encoding="utf-8")
    launcher.chmod(launcher.stat().st_mode | stat.S_IEXEC)
    return launcher


def _write_engines_json(tmp: Path, engine_path: Path):
    engines = [
        {
            "id": "test-engine",
            "name": "Fake Engine",
            "path": str(engine_path),
            "type": ["game", "research"],
            "options": {"Threads": 4, "USI_Ponder": True},
        }
    ]
    (tmp / "engines.json").write_text(json.dumps(engines), encoding="utf-8")


def _start_wrapper(impl: str, tmp: Path, port: int, token: str | None):
    log_path = tmp / "engine.log"
    if log_path.exists():
        log_path.unlink()
    env = {
        **os.environ,
        "BIND_ADDRESS": "127.0.0.1",
        "LISTEN_PORT": str(port),
        "FAKE_ENGINE_LOG": str(log_path),
    }
    if token is None:
        env.pop("WRAPPER_ACCESS_TOKEN", None)
    else:
        env["WRAPPER_ACCESS_TOKEN"] = token

    if impl == "python":
        for name in ("engine_wrapper.py", "common.py"):
            shutil.copy2(WRAPPER_DIR / name, tmp / name)
        cmd = [sys.executable, str(tmp / "engine_wrapper.py")]
    elif impl == "node":
        for name in ("engine-wrapper.mjs", "shutdown-coordinator.mjs"):
            shutil.copy2(WRAPPER_DIR / name, tmp / name)
        cmd = ["node", str(tmp / "engine-wrapper.mjs")]
    elif impl == "rust":
        pytest.skip("Rust wrapper not implemented yet (Phase 1)")
    else:
        raise ValueError(f"unknown wrapper impl: {impl}")
    proc = subprocess.Popen(
        cmd,
        cwd=str(tmp),
        env=env,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    return proc, log_path


@pytest.fixture(params=SELECTED)
def wrapper(request, tmp_path):
    impl = request.param
    port = _free_port()
    token = TOKEN if request.node.get_closest_marker("auth") else None
    # Auth tests manage their own token; default tests run unauthenticated.
    launcher = _write_fake_engine_launcher(tmp_path)
    _write_engines_json(tmp_path, launcher)
    proc, log_path = _start_wrapper(impl, tmp_path, port, token)
    try:
        _wait_port(port)
        yield {"impl": impl, "port": port, "log": log_path}
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            proc.kill()
            proc.wait(timeout=10)


def _connect(port, timeout=5.0):
    sock = socket.create_connection(("127.0.0.1", port), timeout=timeout)
    sock.settimeout(timeout)
    return sock


def _readline(f, timeout_msg="timed out waiting for line"):
    line = f.readline()
    assert line != "", timeout_msg
    return line


def _run_and_wait_usiok(port):
    """Connect, run the engine, pipeline usi, return (sock, file)."""
    sock = _connect(port)
    f = sock.makefile("r", encoding="utf-8", newline="\n")
    sock.sendall(b"run test-engine\nusi\n")
    lines = []
    deadline = time.time() + 10
    while time.time() < deadline:
        line = f.readline()
        assert line != "", "expected usiok before EOF"
        lines.append(line.strip())
        if line.strip() == "usiok":
            return sock, f
    raise TimeoutError(f"no usiok in: {lines}")


def test_list_returns_json_and_closes(wrapper):
    sock = _connect(wrapper["port"])
    f = sock.makefile("r", encoding="utf-8", newline="\n")
    sock.sendall(b"list\n")
    line = _readline(f, "no list response")
    engines = json.loads(line)
    assert any(e["id"] == "test-engine" for e in engines)
    # Server parses discovery on EOF: wrapper must close after the JSON line.
    rest = f.read()
    assert rest == "", f"expected EOF after list, got {rest!r}"
    sock.close()


def test_run_with_pipelined_usi(wrapper):
    sock, f = _run_and_wait_usiok(wrapper["port"])
    sock.sendall(b"isready\n")
    line = _readline(f, "no readyok")
    assert line.strip() == "readyok"
    sock.close()


def test_options_injected_once_before_first_isready(wrapper):
    log = wrapper["log"]
    sock, f = _run_and_wait_usiok(wrapper["port"])
    sock.sendall(b"isready\n")
    assert _readline(f, "no readyok").strip() == "readyok"
    # Second isready must not re-apply options (runtime override precedence).
    sock.sendall(b"isready\n")
    assert _readline(f, "no second readyok").strip() == "readyok"
    sock.close()
    time.sleep(0.5)
    logged = log.read_text(encoding="utf-8").splitlines() if log.exists() else []
    assert "setoption name Threads value 4" in logged
    assert "setoption name USI_Ponder value true" in logged
    assert logged.count("setoption name Threads value 4") == 1
    first_option = min(logged.index("setoption name Threads value 4"), logged.index("setoption name USI_Ponder value true"))
    assert first_option > logged.index("usi")
    assert first_option < logged.index("isready")


def test_unknown_engine_returns_wrapper_error(wrapper):
    sock = _connect(wrapper["port"])
    f = sock.makefile("r", encoding="utf-8", newline="\n")
    sock.sendall(b"run no-such-engine\n")
    line = _readline(f, "no error for unknown engine")
    assert line.startswith("WRAPPER_ERROR:")
    sock.close()


@pytest.mark.auth
def test_auth_wrong_token_rejected(tmp_path):
    # Runs once per selected impl via explicit loop.
    for impl_name in SELECTED:
        if impl_name == "rust":
            continue
        port = _free_port()
        subdir = tmp_path / f"fail-{impl_name}"
        subdir.mkdir(parents=True, exist_ok=True)
        launcher = _write_fake_engine_launcher(subdir)
        _write_engines_json(subdir, launcher)
        proc, log_path = _start_wrapper(impl_name, subdir, port, TOKEN)
        try:
            _wait_port(port)
            sock = _connect(port)
            f = sock.makefile("r", encoding="utf-8", newline="\n")
            challenge = _readline(f, "no auth challenge").strip()
            assert challenge.startswith("auth_cram_sha256 ")
            # Wrong digest plus a pipelined run: must still fail closed.
            sock.sendall(b"auth 00\nrun test-engine\n")
            line = _readline(f, "no auth failure").strip()
            assert line.startswith("WRAPPER_ERROR:")
            # Connection must be closed; no engine output may follow.
            assert f.read() == ""
            sock.close()
            assert not log_path.exists() or "usi" not in log_path.read_text(encoding="utf-8").splitlines()
        finally:
            proc.terminate()
            try:
                proc.wait(timeout=10)
            except subprocess.TimeoutExpired:
                proc.kill()
                proc.wait(timeout=10)


@pytest.mark.auth
def test_auth_correct_token_allows_list(tmp_path):
    for impl_name in SELECTED:
        if impl_name == "rust":
            continue
        port = _free_port()
        subdir = tmp_path / f"ok-{impl_name}"
        subdir.mkdir(parents=True, exist_ok=True)
        launcher = _write_fake_engine_launcher(subdir)
        _write_engines_json(subdir, launcher)
        proc, _ = _start_wrapper(impl_name, subdir, port, TOKEN)
        try:
            _wait_port(port)
            sock = _connect(port)
            f = sock.makefile("r", encoding="utf-8", newline="\n")
            challenge = _readline(f, "no auth challenge").strip()
            nonce = challenge.split(" ", 1)[1]
            digest = hmac.new(TOKEN.encode(), nonce.encode(), hashlib.sha256).hexdigest()
            sock.sendall(f"auth {digest}\n".encode())
            assert _readline(f, "no auth_ok").strip() == "auth_ok"
            sock.sendall(b"list\n")
            engines = json.loads(_readline(f, "no list after auth"))
            assert any(e["id"] == "test-engine" for e in engines)
            assert f.read() == ""
            sock.close()
        finally:
            proc.terminate()
            try:
                proc.wait(timeout=10)
            except subprocess.TimeoutExpired:
                proc.kill()
                proc.wait(timeout=10)


def test_client_fin_stops_engine(wrapper):
    sock, f = _run_and_wait_usiok(wrapper["port"])
    # Abrupt close = ordinary server stopEngine path (socket.end, no quit first).
    sock.close()
    try:
        f.close()
    except Exception:
        pass
    deadline = time.time() + 12
    while time.time() < deadline:
        if wrapper["log"].exists() and "quit" in wrapper["log"].read_text(encoding="utf-8").splitlines():
            return
        time.sleep(0.2)
    logged = wrapper["log"].read_text(encoding="utf-8") if wrapper["log"].exists() else "<no log>"
    raise AssertionError(f"engine never received quit after FIN. log:\n{logged}")


def test_cp932_engine_output_arrives_as_utf8(wrapper):
    sock, f = _run_and_wait_usiok(wrapper["port"])
    sock.sendall(b"test_cp932\n")
    lines = []
    deadline = time.time() + 10
    while time.time() < deadline:
        line = f.readline()
        assert line != "", "expected cp932-converted output before EOF"
        lines.append(line.strip())
        if line.strip() == "test_cp932_ok":
            break
    assert "info string こんにちは" in lines, f"missing converted line in {lines}"
    sock.close()
