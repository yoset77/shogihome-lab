"""Black-box wrapper contract tests against the Rust wrapper.

The legacy Python/Node implementations were removed, so every scenario runs
against the same binary (built with cargo if missing).

Isolation: the temp config dir holds engines.json/.env only, so the real
engine-wrapper/engines.json is never touched. The fake engine is the
`fake_usi_engine` cargo example, referenced by absolute path.
"""

import hashlib
import hmac
import json
import os
import socket
import subprocess
import time
from pathlib import Path

import pytest

WRAPPER_DIR = Path(__file__).resolve().parent.parent

_RUST_BINARY = None
_FAKE_ENGINE = None


def _rust_binary():
    """Path to the built Rust wrapper, building it once on demand."""
    global _RUST_BINARY
    if _RUST_BINARY is None:
        target = WRAPPER_DIR / "target" / "debug" / ("shogihome-wrapper.exe" if os.name == "nt" else "shogihome-wrapper")
        if not target.exists():
            subprocess.run(["cargo", "build"], cwd=str(WRAPPER_DIR), check=True, timeout=600)
        _RUST_BINARY = target
    return _RUST_BINARY


def _fake_engine_path():
    """Path to the built fake USI engine example, building it once on demand."""
    global _FAKE_ENGINE
    if _FAKE_ENGINE is None:
        subprocess.run(
            ["cargo", "build", "--example", "fake_usi_engine", "-p", "shogihome-engine-wrapper"],
            cwd=str(WRAPPER_DIR),
            check=True,
            timeout=600,
        )
        target = (
            WRAPPER_DIR / "target" / "debug" / "examples" / ("fake_usi_engine.exe" if os.name == "nt" else "fake_usi_engine")
        )
        assert target.exists(), f"fake engine example did not build: {target}"
        _FAKE_ENGINE = target
    return _FAKE_ENGINE


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


def _start_wrapper(tmp: Path, port: int, token: str | None):
    env = {
        **os.environ,
        "BIND_ADDRESS": "127.0.0.1",
        "LISTEN_PORT": str(port),
        "FAKE_ENGINE_LOG": str(tmp / "engine.log"),
    }
    if token is None:
        env.pop("WRAPPER_ACCESS_TOKEN", None)
    else:
        env["WRAPPER_ACCESS_TOKEN"] = token

    cmd = [str(_rust_binary()), "--config-dir", str(tmp)]
    proc = subprocess.Popen(
        cmd,
        cwd=str(tmp),
        env=env,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    return proc


@pytest.fixture
def wrapper(tmp_path):
    port = _free_port()
    # Default tests run unauthenticated; auth tests start their own wrapper.
    _write_engines_json(tmp_path, _fake_engine_path())
    proc = _start_wrapper(tmp_path, port, None)
    try:
        _wait_port(port)
        yield {"port": port, "log": tmp_path / "engine.log"}
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


def test_auth_wrong_token_rejected(tmp_path):
    port = _free_port()
    _write_engines_json(tmp_path, _fake_engine_path())
    proc = _start_wrapper(tmp_path, port, TOKEN)
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
        log_path = tmp_path / "engine.log"
        assert not log_path.exists() or "usi" not in log_path.read_text(encoding="utf-8").splitlines()
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            proc.kill()
            proc.wait(timeout=10)


def test_auth_correct_token_allows_list(tmp_path):
    port = _free_port()
    _write_engines_json(tmp_path, _fake_engine_path())
    proc = _start_wrapper(tmp_path, port, TOKEN)
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


def test_rust_dotenv_supplies_listen_port_when_env_absent(tmp_path):
    port = _free_port()
    _write_engines_json(tmp_path, _fake_engine_path())
    (tmp_path / ".env").write_text(f"LISTEN_PORT={port}\n", encoding="utf-8")
    env = {**os.environ, "BIND_ADDRESS": "127.0.0.1", "FAKE_ENGINE_LOG": str(tmp_path / "engine.log")}
    env.pop("LISTEN_PORT", None)
    env.pop("WRAPPER_ACCESS_TOKEN", None)
    proc = subprocess.Popen(
        [str(_rust_binary()), "--config-dir", str(tmp_path)],
        cwd=str(tmp_path),
        env=env,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    try:
        _wait_port(port)
        sock = _connect(port)
        f = sock.makefile("r", encoding="utf-8", newline="\n")
        sock.sendall(b"list\n")
        engines = json.loads(_readline(f, "no list response"))
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


def test_rust_parent_exit_cleans_inherited_pipes_and_flushes_final_line(wrapper):
    sock, f = _run_and_wait_usiok(wrapper["port"])
    helper_pid = None
    try:
        sock.sendall(b"test_background_exit\n")
        helper_pid = int(_readline(f).split()[-1])
        sock.settimeout(3)
        assert f.read() == "bestmove resign\n"
    finally:
        # Also releases the inherited pipes when testing the broken version.
        if helper_pid is not None:
            try:
                os.kill(helper_pid, 15)
            except OSError:
                pass
        f.close()
        sock.close()
