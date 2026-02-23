import os
import socket
import subprocess
import sys
from pathlib import Path

from dotenv import dotenv_values


def get_resource_dir():
    """自分が存在するディレクトリ（engine-wrapper）を返す"""
    return Path(__file__).resolve().parent


# 各スクリプトからの相対パスの起点となるディレクトリ
BASE_DIR = get_resource_dir()


def get_python_exe():
    """同梱されている python.exe または現在のインタープリタのパスを返す"""
    # 同梱環境では root/python/pythonw.exe に配置される想定
    # (GUIアプリ用には pythonw.exe を優先)
    root_dir = BASE_DIR.parent
    # Check for python/ directory (Release structure) or project root (Dev structure)
    bundled_python_dir = root_dir / "python"

    pythonw = bundled_python_dir / "pythonw.exe"
    python = bundled_python_dir / "python.exe"

    if pythonw.exists():
        return pythonw
    if python.exists():
        return python

    return Path(sys.executable)


def is_bundled():
    """同梱環境（配布用パッケージ）として動いているか判定"""
    return (BASE_DIR.parent / "python").exists()


def load_env_value(env_path, key, default):
    """指定した.envファイルから値を読み込む。数値の場合はキャストを試みる"""
    if env_path.exists():
        try:
            config = dotenv_values(env_path)
            if key in config:
                val = config[key]
                if isinstance(default, int):
                    try:
                        return int(val)
                    except ValueError:
                        return default
                return val
        except Exception:
            pass
    return default


def get_local_ip():
    """Determine the local LAN IP address."""
    try:
        # Connect to a public DNS server to determine the most likely LAN IP
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
            s.connect(("8.8.8.8", 80))
            return s.getsockname()[0]
    except Exception:
        return "127.0.0.1"


def is_port_open(port, host="127.0.0.1", timeout=0.5):
    """Check if a TCP port is open on the specified host."""
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            s.settimeout(timeout)
            return s.connect_ex((host, port)) == 0
    except Exception:
        return False


def get_pc_url_config(bind_address, server_port, disable_auto_origins, allowed_origins, local_ip):
    """
    Determine the best PC_URL and whether access should be allowed based on configuration.
    Returns: (pc_url: str, is_allowed: bool)
    """
    # Step 1: Define possible local endpoints based on BIND_ADDRESS
    if bind_address == "0.0.0.0":
        local_endpoints = [
            f"http://127.0.0.1:{server_port}",
            f"http://localhost:{server_port}",
            f"http://{local_ip}:{server_port}",
        ]
    elif bind_address == "127.0.0.1":
        local_endpoints = [
            f"http://127.0.0.1:{server_port}",
            f"http://localhost:{server_port}",
        ]
    else:
        # Specific IP binding
        local_endpoints = [f"http://{bind_address}:{server_port}"]

    candidate_pc_url = local_endpoints[0]

    if not disable_auto_origins:
        # Default mode: Everything in local_endpoints is automatically allowed by server.ts
        return candidate_pc_url, True
    elif allowed_origins:
        # Strict mode: Check intersection of local_endpoints and ALLOWED_ORIGINS
        # Normalize origins (remove trailing slashes) to match browser 'Origin' header format
        normalized_allowed = [o.rstrip("/") for o in allowed_origins]
        allowed_local_endpoints = [e for e in local_endpoints if e.rstrip("/") in normalized_allowed]

        if allowed_local_endpoints:
            return allowed_local_endpoints[0], True
        else:
            # No local endpoint is explicitly allowed.
            # However, the user might be using a proxy domain or a custom hostname.
            # We'll allow clicking with the first allowed origin as a best-effort.
            return allowed_origins[0], True
    else:
        # Strict mode and no origins defined -> Nothing will work
        return candidate_pc_url, False


def kill_proc_tree(pid):
    """Windows環境でプロセスツリー全体を強制終了する。Unix系ではSIGKILLを送信"""
    if os.name == "nt":
        startupinfo = subprocess.STARTUPINFO()
        startupinfo.dwFlags |= subprocess.STARTF_USESHOWWINDOW
        try:
            subprocess.run(
                ["taskkill", "/F", "/T", "/PID", str(pid)],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                startupinfo=startupinfo,
            )
        except Exception:
            pass
    else:
        try:
            import signal

            os.kill(pid, signal.SIGKILL)
        except Exception:
            pass
