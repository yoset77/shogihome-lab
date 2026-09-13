import json
import shutil
import subprocess
from pathlib import Path

import pytest

from common import get_pc_url_config, get_python_exe, get_resource_dir, is_bundled, load_env_value, upsert_env_values


def test_is_bundled(tmp_path, monkeypatch):
    # tmp_path/
    #   shogihome/
    #     shogihome-server.exe
    #     dist/server/server.js
    #   wrapper/
    #     python/
    wrapper_dir = tmp_path / "wrapper"
    wrapper_dir.mkdir()
    shogihome_dir = tmp_path / "shogihome"
    shogihome_dir.mkdir()
    shogihome_exe = shogihome_dir / "shogihome-server.exe"
    server_entry = shogihome_dir / "dist" / "server" / "server.js"

    monkeypatch.setattr("common.BASE_DIR", wrapper_dir)

    # python ディレクトリがない場合は False
    assert is_bundled() is False

    # python ディレクトリがあっても、shogihome-server.exe がない場合は False
    (wrapper_dir / "python").mkdir()
    assert is_bundled() is False

    # shogihome-server.exe があっても、server.js がない場合は False
    shogihome_exe.touch()
    assert is_bundled() is False

    # 必要なファイルがすべて揃えば True
    server_entry.parent.mkdir(parents=True)
    server_entry.touch()
    assert is_bundled() is True


def test_get_python_exe(tmp_path, monkeypatch):
    wrapper_dir = tmp_path / "wrapper"
    wrapper_dir.mkdir()
    monkeypatch.setattr("common.BASE_DIR", wrapper_dir)

    # 同梱の pythonw.exe がない場合は sys.executable を返す
    import sys

    assert get_python_exe() == Path(sys.executable)

    # 同梱の pythonw.exe がある場合はそれを返す
    python_dir = wrapper_dir / "python"
    python_dir.mkdir()
    pythonw = python_dir / "pythonw.exe"
    pythonw.touch()
    assert get_python_exe() == pythonw


def test_get_resource_dir():
    # 新しいロジックでは、CWD やファイルの有無に関わらず
    # 常に実行ファイル/スクリプトの親ディレクトリを返す
    resource_dir = get_resource_dir()
    assert resource_dir.exists()
    # 開発環境では common.py があるディレクトリ（engine-wrapper ルート）を指すはず
    assert (resource_dir / "common.py").exists()


def test_load_env_value(tmp_path):
    env_file = tmp_path / ".env"
    env_file.write_text(
        """PORT=8140
NAME=ShogiHome
EMPTY=
INVALID=abc""",
        encoding="utf-8",
    )

    # 正常系: 数値
    assert load_env_value(env_file, "PORT", 0) == 8140

    # 正常系: 文字列
    assert load_env_value(env_file, "NAME", "Default") == "ShogiHome"

    # 異常系: 存在しないキー
    assert load_env_value(env_file, "UNKNOWN", 123) == 123

    # 異常系: 空文字（数値期待）
    assert load_env_value(env_file, "EMPTY", 500) == 500

    # 異常系: 型不一致（数値期待に文字列）
    assert load_env_value(env_file, "INVALID", 999) == 999


def test_load_env_value_no_file(tmp_path):
    non_existent = tmp_path / "not_found.env"
    assert load_env_value(non_existent, "PORT", 1234) == 1234


def test_upsert_env_values_preserves_comments(tmp_path):
    env_file = tmp_path / ".env"
    env_file.write_text(
        """# Web server port
PORT=8140
# Remote engine setting
# REMOTE_ENGINE_PORT=4082
CUSTOM_LINE=keep-me
""",
        encoding="utf-8",
    )

    upsert_env_values(env_file, {"PORT": "9000", "REMOTE_ENGINE_PORT": "5000"})

    content = env_file.read_text(encoding="utf-8")
    lines = content.splitlines()

    assert lines[0] == "# Web server port"
    assert lines[1] == "PORT=9000"
    assert lines[2] == "# Remote engine setting"
    # Commented-out entry is re-enabled
    assert lines[3] == "REMOTE_ENGINE_PORT=5000"
    assert lines[4] == "CUSTOM_LINE=keep-me"

    assert load_env_value(env_file, "PORT", 0) == 9000
    assert load_env_value(env_file, "REMOTE_ENGINE_PORT", 0) == 5000


def test_upsert_env_values_appends_missing_keys(tmp_path):
    env_file = tmp_path / ".env"
    env_file.write_text("PORT=8140\n", encoding="utf-8")

    upsert_env_values(env_file, {"KIFU_DIR": "C:/kifu", "TRUST_PROXY": "true"})

    content = env_file.read_text(encoding="utf-8")
    assert "PORT=8140" in content
    assert "KIFU_DIR=C:/kifu" in content
    assert "TRUST_PROXY=true" in content
    # Values are appended after existing content (with a newline separator)
    assert content.endswith("TRUST_PROXY=true\n")


@pytest.mark.parametrize("existing", ["", "KIFU_DIR=old\n"])
@pytest.mark.parametrize(
    "value",
    [
        "C:/Shogi #1/kifu",
        r"C:\new\棋譜 #1\records",
        "abc#def",
        " leading and trailing spaces ",
        "C:/O'Brien #1/kifu",
        'token"with#quote',
        r"\\server\share\kifu",
        "'quoted'",
        "",
    ],
)
@pytest.mark.parametrize("parser", ["python", "node"])
def test_upsert_env_values_round_trip_special_characters(tmp_path, existing, value, parser):
    env_file = tmp_path / ".env"
    env_file.write_text(existing, encoding="utf-8")

    upsert_env_values(env_file, {"KIFU_DIR": value})

    if parser == "python":
        assert load_env_value(env_file, "KIFU_DIR", None) == value
    else:
        node = shutil.which("node")
        if node is None:
            pytest.skip("Node.js is required to verify server .env parsing")
        result = subprocess.run(
            [
                node,
                "-e",
                "const fs = require('node:fs');"
                "const {parseEnv} = require('node:util');"
                "console.log(JSON.stringify(parseEnv(fs.readFileSync(0, 'utf8'))));",
            ],
            input=env_file.read_text(encoding="utf-8"),
            text=True,
            capture_output=True,
            check=True,
        )
        assert json.loads(result.stdout)["KIFU_DIR"] == value


@pytest.mark.parametrize("active", ["PORT=9000", "export PORT=9000"])
def test_upsert_env_values_prefers_active_definition(tmp_path, active):
    env_file = tmp_path / ".env"
    env_file.write_text(f"# PORT=8140\n{active}\nPORT=9001\n# PORT=8000\nCUSTOM=keep\n", encoding="utf-8")

    upsert_env_values(env_file, {"PORT": "9999"})

    assert load_env_value(env_file, "PORT", 0) == 9999
    assert env_file.read_text(encoding="utf-8") == "# PORT=8140\nPORT=9999\n# PORT=8000\nCUSTOM=keep\n"


def test_upsert_env_values_rejects_incompatible_quoting_before_writing(tmp_path):
    env_file = tmp_path / ".env"
    original = "PORT=8140\nWRAPPER_ACCESS_TOKEN=old\n"
    env_file.write_text(original, encoding="utf-8")

    # Neither quote delimiter can enclose this value in both parsers.
    with pytest.raises(ValueError, match="WRAPPER_ACCESS_TOKEN"):
        upsert_env_values(env_file, {"PORT": "9000", "WRAPPER_ACCESS_TOKEN": "both'\"#quotes"})

    assert env_file.read_text(encoding="utf-8") == original
    assert not env_file.with_name(".env.tmp").exists()


def test_upsert_env_values_no_trailing_newline(tmp_path):
    env_file = tmp_path / ".env"
    env_file.write_text("PORT=8140", encoding="utf-8")

    upsert_env_values(env_file, {"BIND_ADDRESS": "127.0.0.1"})

    content = env_file.read_text(encoding="utf-8")
    # A newline is inserted before appended keys
    assert content == "PORT=8140\nBIND_ADDRESS=127.0.0.1\n"


def test_upsert_env_values_creates_file(tmp_path):
    env_file = tmp_path / ".env"
    upsert_env_values(env_file, {"PORT": "8140"})

    assert env_file.exists()
    assert env_file.read_text(encoding="utf-8") == "PORT=8140\n"


def test_upsert_env_values_no_updates(tmp_path):
    env_file = tmp_path / ".env"
    upsert_env_values(env_file, {})
    assert not env_file.exists()


def test_upsert_env_values_rejects_newlines(tmp_path):
    env_file = tmp_path / ".env"
    env_file.write_text("PORT=8140\n", encoding="utf-8")

    import pytest

    with pytest.raises(ValueError):
        upsert_env_values(env_file, {"KIFU_DIR": "line1\nline2"})

    # File must be untouched
    assert env_file.read_text(encoding="utf-8") == "PORT=8140\n"


def test_upsert_env_values_cp932(tmp_path):
    env_file = tmp_path / ".env"
    env_file.write_text("PORT=8140\nNOTE=将棋", encoding="cp932")

    upsert_env_values(env_file, {"PORT": "9000"})

    # Result is normalized to UTF-8 and the comment text survives
    content = env_file.read_text(encoding="utf-8")
    assert "PORT=9000" in content
    assert "NOTE=将棋" in content


def test_upsert_env_values_empty_value(tmp_path):
    env_file = tmp_path / ".env"
    env_file.write_text("PORT=8140\nALLOWED_ORIGINS=old\n", encoding="utf-8")

    upsert_env_values(env_file, {"ALLOWED_ORIGINS": ""})

    content = env_file.read_text(encoding="utf-8")
    assert "ALLOWED_ORIGINS=" in content
    assert load_env_value(env_file, "ALLOWED_ORIGINS", "default") == ""


def test_upsert_env_values_is_atomic(tmp_path):
    env_file = tmp_path / ".env"
    env_file.write_text("PORT=8140\n", encoding="utf-8")

    upsert_env_values(env_file, {"PORT": "9000"})

    # The temporary file must not be left behind and the original stays valid
    assert not (tmp_path / ".env.tmp").exists()
    assert env_file.read_text(encoding="utf-8") == "PORT=9000\n"


def test_smart_merge_env(tmp_path):
    from common import smart_merge_env

    old_env = tmp_path / "old.env"
    new_env = tmp_path / "new.env"
    dest_env = tmp_path / "dest.env"

    old_env.write_text(
        """# Old Settings
PORT=8080
CUSTOM_KEY=abc
# Overwritten soon
LISTEN_PORT=3000
""",
        encoding="utf-8",
    )

    new_env.write_text(
        """# New Default Settings
PORT=9090
# Port for engine wrapper
LISTEN_PORT=4082

# [NEW] Timeout
TIMEOUT=5000
""",
        encoding="utf-8",
    )

    smart_merge_env(old_env, new_env, dest_env)

    dest_content = dest_env.read_text(encoding="utf-8")
    lines = dest_content.splitlines()

    assert lines[0] == "# New Default Settings"
    assert lines[1] == "PORT=8080"  # Overwritten by old
    assert lines[2] == "# Port for engine wrapper"
    assert lines[3] == "LISTEN_PORT=3000"  # Overwritten by old
    assert lines[4] == ""
    assert lines[5] == "# [NEW] Timeout"
    assert lines[6] == "TIMEOUT=5000"  # Kept new default


def test_smart_merge_env_missing_old(tmp_path):
    from common import smart_merge_env

    old_env = tmp_path / "missing.env"
    new_env = tmp_path / "new.env"
    dest_env = tmp_path / "dest.env"

    new_env.write_text("PORT=9090", encoding="utf-8")

    smart_merge_env(old_env, new_env, dest_env)
    assert dest_env.read_text(encoding="utf-8") == "PORT=9090"


def test_smart_merge_env_missing_new(tmp_path):
    from common import smart_merge_env

    old_env = tmp_path / "old.env"
    new_env = tmp_path / "missing.env"
    dest_env = tmp_path / "dest.env"

    old_env.write_text("PORT=8080", encoding="utf-8")

    smart_merge_env(old_env, new_env, dest_env)
    assert dest_env.read_text(encoding="utf-8") == "PORT=8080"


def test_smart_merge_env_cp932(tmp_path):
    from common import smart_merge_env

    old_env = tmp_path / "old_cp932.env"
    new_env = tmp_path / "new_utf8.env"
    dest_env = tmp_path / "dest.env"

    # Write old env with CP932 (Shift-JIS)
    # Use a key that will exist in the new env
    old_env.write_text("PORT=8080\nAPP_NAME=将棋ホーム", encoding="cp932")

    # New default is UTF-8
    new_env.write_text("PORT=9090\nAPP_NAME=ShogiHome\nVERSION=2.0", encoding="utf-8")

    smart_merge_env(old_env, new_env, dest_env)

    # Result should be UTF-8 and correctly merged
    dest_content = dest_env.read_text(encoding="utf-8")
    assert "PORT=8080" in dest_content
    assert "APP_NAME=将棋ホーム" in dest_content
    assert "VERSION=2.0" in dest_content


_IP = "192.168.1.10"
_PORT = 8140


class TestGetPcUrlConfig:
    def test_default_mode(self):
        url, ok = get_pc_url_config("0.0.0.0", _PORT, False, [], _IP)
        assert ok is True
        assert url == f"http://127.0.0.1:{_PORT}"

    def test_localhost_only(self):
        url, ok = get_pc_url_config("127.0.0.1", _PORT, False, [], _IP)
        assert ok is True
        assert "127.0.0.1" in url

    def test_specific_bind(self):
        url, ok = get_pc_url_config(_IP, _PORT, False, [], _IP)
        assert ok is True
        assert url == f"http://{_IP}:{_PORT}"

    def test_strict_no_origins(self):
        url, ok = get_pc_url_config("0.0.0.0", _PORT, True, [], _IP)
        assert ok is False

    def test_strict_localhost_in_origins(self):
        origins = [f"http://127.0.0.1:{_PORT}"]
        url, ok = get_pc_url_config("0.0.0.0", _PORT, True, origins, _IP)
        assert ok is True
        assert url == f"http://127.0.0.1:{_PORT}"

    def test_strict_external_only(self):
        origins = ["https://hostname.tailnet.ts.net"]
        url, ok = get_pc_url_config("0.0.0.0", _PORT, True, origins, _IP)
        assert url == "https://hostname.tailnet.ts.net"
        assert ok is True  # best-effort
