import io
import os
import shutil
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
    # 同梱環境では engine-wrapper/python/pythonw.exe に配置される想定
    # (GUIアプリ用には pythonw.exe を優先)
    # Check for python/ directory (Release structure)
    bundled_python_dir = BASE_DIR / "python"

    pythonw = bundled_python_dir / "pythonw.exe"
    python = bundled_python_dir / "python.exe"

    if pythonw.exists():
        return pythonw
    if python.exists():
        return python

    return Path(sys.executable)


def is_bundled():
    """同梱環境（配布用パッケージ）として動いているか判定"""
    # python ディレクトリが存在し、かつ shogihome-server.exe が所定の位置にある場合のみ同梱環境とみなす
    # (開発環境で配布用バイナリ構築スクリプトを実行した際などの誤判定を防止)
    shogihome_exe = BASE_DIR.parent / "shogihome" / "shogihome-server.exe"
    return (BASE_DIR / "python").exists() and shogihome_exe.exists()


def load_env_value(env_path, key, default):
    """指定した.envファイルから値を読み込む。数値の場合はキャストを試みる"""
    if env_path.exists():
        try:
            # 複数の文字コードを試行して読み込む (UTF-8, Shift-JISなど)
            content = None
            for enc in ["utf-8-sig", "utf-8", "cp932"]:
                try:
                    with open(env_path, "r", encoding=enc) as f:
                        content = f.read()
                    break
                except (UnicodeDecodeError, LookupError):
                    continue

            if content is None:
                # 最終手段としてエラー置換で読み込む
                with open(env_path, "r", encoding="utf-8", errors="replace") as f:
                    content = f.read()

            config = dotenv_values(stream=io.StringIO(content))
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


def smart_merge_env(old_env_path, new_env_path, dest_env_path):
    """
    古い.envのユーザー設定値を、新しい.envにマージして保存する。
    コメントや新しい変数のデフォルト値は保持する。
    """
    if not old_env_path.exists():
        if new_env_path.exists() and new_env_path != dest_env_path:
            shutil.copy2(new_env_path, dest_env_path)
        return

    # 古い.envからユーザー設定値を抽出 (load_env_valueと同様の堅牢な読み込み)
    content = None
    for enc in ["utf-8-sig", "utf-8", "cp932"]:
        try:
            with open(old_env_path, "r", encoding=enc) as f:
                content = f.read()
            break
        except (UnicodeDecodeError, LookupError):
            continue

    if content is None:
        with open(old_env_path, "r", encoding="utf-8", errors="replace") as f:
            content = f.read()

    old_config = dotenv_values(stream=io.StringIO(content))

    if not new_env_path.exists():
        if old_env_path != dest_env_path:
            # 古いものをそのままコピーする場合も文字コードを正規化して保存
            with open(dest_env_path, "w", encoding="utf-8") as f:
                f.write(content)
        return

    # 新しい.envをテキストとして読み込み、行単位で置換する
    merged_lines = []
    # new_env_path は配布物（自分が持っているもの）なので UTF-8 固定で良い
    with open(new_env_path, "r", encoding="utf-8") as f:
        for line in f:
            stripped = line.strip()
            # コメントや空行はそのまま
            if not stripped or stripped.startswith("#"):
                merged_lines.append(line)
                continue

            # キー=値 の形式ならパース
            if "=" in line:
                key, _ = line.split("=", 1)
                key = key.strip()
                # 古い設定値が存在すれば、それで上書き
                if key in old_config:
                    merged_lines.append(f"{key}={old_config[key]}\n")
                else:
                    merged_lines.append(line)
            else:
                merged_lines.append(line)

    # 保存 (常に UTF-8)
    with open(dest_env_path, "w", encoding="utf-8") as f:
        f.writelines(merged_lines)


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
