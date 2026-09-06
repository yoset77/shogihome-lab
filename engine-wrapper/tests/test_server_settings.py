import server_settings
from server_settings import SETTINGS, load_settings, save, validate


def _make_env_dirs(tmp_path):
    shogihome_dir = tmp_path / "shogihome"
    wrapper_dir = tmp_path / "wrapper"
    shogihome_dir.mkdir()
    wrapper_dir.mkdir()
    return shogihome_dir, wrapper_dir


class TestLoadSettings:
    def test_defaults_when_no_env_files(self, tmp_path):
        shogihome_dir, wrapper_dir = _make_env_dirs(tmp_path)
        values = load_settings(shogihome_dir, wrapper_dir)

        assert values["PORT"] == "8140"
        assert values["BIND_ADDRESS"] == "0.0.0.0"
        assert values["LISTEN_PORT"] == "4082"
        assert values["DISABLE_AUTO_ALLOWED_ORIGINS"] is False
        assert values["TRUST_PROXY"] is False
        assert values["KIFU_DIR"] == ""
        assert values["ANALYSIS_DB_MIN_DEPTH"] == "10"

    def test_reads_existing_values(self, tmp_path):
        shogihome_dir, wrapper_dir = _make_env_dirs(tmp_path)
        (shogihome_dir / ".env").write_text(
            "PORT=9000\n# TRUST_PROXY=true\nKIFU_DIR=C:/kifu\nREMOTE_ENGINE_PORT=5000\n",
            encoding="utf-8",
        )
        (wrapper_dir / ".env").write_text("LISTEN_PORT=5000\n", encoding="utf-8")

        values = load_settings(shogihome_dir, wrapper_dir)
        assert values["PORT"] == "9000"
        assert values["TRUST_PROXY"] is False  # commented out
        assert values["KIFU_DIR"] == "C:/kifu"
        assert values["LISTEN_PORT"] == "5000"

    def test_all_setting_ids_unique(self):
        ids = [s.id for s in SETTINGS]
        assert len(ids) == len(set(ids))


class TestValidate:
    def test_defaults_are_valid(self, tmp_path):
        shogihome_dir, wrapper_dir = _make_env_dirs(tmp_path)
        assert validate(load_settings(shogihome_dir, wrapper_dir)) == {}

    def test_invalid_int(self):
        errors = validate({"PORT": "abc", "LISTEN_PORT": "4082", "ANALYSIS_DB_MIN_DEPTH": "10"})
        assert errors == {"PORT": "invalid_int"}

    def test_empty_int_is_invalid(self):
        errors = validate({"PORT": ""})
        assert errors == {"PORT": "invalid_int"}

    def test_out_of_range(self):
        errors = validate({"PORT": "70000", "ANALYSIS_DB_MIN_DEPTH": "200"})
        assert errors == {"PORT": "out_of_range", "ANALYSIS_DB_MIN_DEPTH": "out_of_range"}

    def test_protection_timeout_matches_server_config_range(self):
        # server/src/config.ts allows 1..3600 for ENGINE_CONNECTION_PROTECTION_TIMEOUT
        assert validate({"ENGINE_CONNECTION_PROTECTION_TIMEOUT": "0"}) == {"ENGINE_CONNECTION_PROTECTION_TIMEOUT": "out_of_range"}
        assert validate({"ENGINE_CONNECTION_PROTECTION_TIMEOUT": "3601"}) == {"ENGINE_CONNECTION_PROTECTION_TIMEOUT": "out_of_range"}
        assert validate({"ENGINE_CONNECTION_PROTECTION_TIMEOUT": "300"}) == {}

    def test_invalid_choice(self):
        errors = validate({"BIND_ADDRESS": "1.2.3.4"})
        assert errors == {"BIND_ADDRESS": "invalid_choice"}

    def test_invalid_origin(self):
        errors = validate({"ALLOWED_ORIGINS": "http://ok.example.com,not-a-url"})
        assert errors == {"ALLOWED_ORIGINS": "invalid_origin"}

    def test_valid_origins(self):
        errors = validate({"ALLOWED_ORIGINS": "http://localhost:8140,https://host.tailnet.ts.net"})
        assert errors == {}

    def test_empty_origins_allowed(self):
        errors = validate({"ALLOWED_ORIGINS": ""})
        assert errors == {}

    def test_invalid_fetch_domain(self):
        errors = validate({"ALLOWED_FETCH_DOMAINS": "example.com,not a domain!"})
        assert errors == {"ALLOWED_FETCH_DOMAINS": "invalid_domain"}

    def test_valid_fetch_domains(self):
        errors = validate({"ALLOWED_FETCH_DOMAINS": "sunfish-shogi.github.io,live4.computer-shogi.org,wdoor.c.u-tokyo.ac.jp"})
        assert errors == {}

    def test_fetch_domains_sections(self):
        section_by_id = {s.id: s.section for s in SETTINGS}
        assert section_by_id["ALLOWED_FETCH_DOMAINS"] == "security"
        # The former "advanced" items are merged into the kifu section
        assert "advanced" not in server_settings.SECTION_ORDER
        assert section_by_id["ONTHEFLY_THRESHOLD_MB"] == "kifu"
        assert section_by_id["SBK_ONTHEFLY_THRESHOLD_MB"] == "kifu"


class TestSave:
    def test_save_writes_both_files(self, tmp_path):
        shogihome_dir, wrapper_dir = _make_env_dirs(tmp_path)
        values = {
            "PORT": "9000",
            "BIND_ADDRESS": "127.0.0.1",
            "ENGINE_CONNECTION_PROTECTION_TIMEOUT": "300",
            "LISTEN_PORT": "5000",
            "ALLOWED_ORIGINS": "http://localhost:9000",
            "DISABLE_AUTO_ALLOWED_ORIGINS": True,
            "TRUST_PROXY": True,
            "WRAPPER_ACCESS_TOKEN": "secret-token",
            "ALLOWED_FETCH_DOMAINS": "example.com",
            "KIFU_DIR": "C:/kifu",
            "KIFU_DIR_USE_POLLING": False,
            "ANALYSIS_DB_MIN_DEPTH": "20",
            "ONTHEFLY_THRESHOLD_MB": "128",
            "SBK_ONTHEFLY_THRESHOLD_MB": "32",
        }

        save(values, shogihome_dir, wrapper_dir)

        server_env = (shogihome_dir / ".env").read_text(encoding="utf-8")
        wrapper_env = (wrapper_dir / ".env").read_text(encoding="utf-8")

        # Server .env
        assert "PORT=9000" in server_env
        assert "BIND_ADDRESS=127.0.0.1" in server_env
        assert "REMOTE_ENGINE_PORT=5000" in server_env
        assert "DISABLE_AUTO_ALLOWED_ORIGINS=true" in server_env
        assert "TRUST_PROXY=true" in server_env
        assert "WRAPPER_ACCESS_TOKEN=secret-token" in server_env
        assert "ALLOWED_FETCH_DOMAINS=example.com" in server_env
        assert "KIFU_DIR=C:/kifu" in server_env
        assert "KIFU_DIR_USE_POLLING=false" in server_env
        assert "ANALYSIS_DB_MIN_DEPTH=20" in server_env

        # Wrapper .env (linked keys are synchronized)
        assert "LISTEN_PORT=5000" in wrapper_env
        assert "WRAPPER_ACCESS_TOKEN=secret-token" in wrapper_env

    def test_save_preserves_comments_and_unknown_lines(self, tmp_path):
        shogihome_dir, wrapper_dir = _make_env_dirs(tmp_path)
        (shogihome_dir / ".env").write_text(
            "# User comment\nPORT=8140\nCUSTOM_LINE=keep\n",
            encoding="utf-8",
        )

        save(
            {
                "PORT": "9000",
                "BIND_ADDRESS": "0.0.0.0",
                "ENGINE_CONNECTION_PROTECTION_TIMEOUT": "60",
                "LISTEN_PORT": "4082",
                "ALLOWED_ORIGINS": "",
                "DISABLE_AUTO_ALLOWED_ORIGINS": False,
                "TRUST_PROXY": False,
                "WRAPPER_ACCESS_TOKEN": "",
                "ALLOWED_FETCH_DOMAINS": "example.com",
                "KIFU_DIR": "",
                "KIFU_DIR_USE_POLLING": False,
                "ANALYSIS_DB_MIN_DEPTH": "10",
                "ONTHEFLY_THRESHOLD_MB": "128",
                "SBK_ONTHEFLY_THRESHOLD_MB": "32",
            },
            shogihome_dir,
            wrapper_dir,
        )

        content = (shogihome_dir / ".env").read_text(encoding="utf-8")
        assert "# User comment" in content
        assert "PORT=9000" in content
        assert "CUSTOM_LINE=keep" in content

    def test_save_rejects_invalid_values(self, tmp_path):
        shogihome_dir, wrapper_dir = _make_env_dirs(tmp_path)
        values = {s.id: s.default for s in SETTINGS}
        values["PORT"] = "not-a-number"

        try:
            save(values, shogihome_dir, wrapper_dir)
            raised = False
        except ValueError:
            raised = True
        assert raised
        assert not (shogihome_dir / ".env").exists()


def test_generate_token():
    token1 = server_settings.generate_token()
    token2 = server_settings.generate_token()
    assert token1 != token2
    assert len(token1) >= 20
    assert " " not in token1
