from common import get_pc_url_config, get_resource_dir, is_frozen, load_env_value


def test_is_frozen():
    # 通常のテスト実行時は False になるはず
    assert is_frozen() is False


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
