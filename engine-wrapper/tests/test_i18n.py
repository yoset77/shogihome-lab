"""Tests for the launcher i18n helper."""

from __future__ import annotations

import i18n


def test_text_ja():
    assert i18n.text("updateDownload", lang="ja") == "詳細を見る"


def test_text_en():
    assert i18n.text("updateDownload", lang="en") == "View details"


def test_text_callable():
    assert i18n.text("latestVersionReleased", lang="ja", version="v1.2.3") == "最新版 v1.2.3 が利用可能です"
    assert i18n.text("latestVersionReleased", lang="en", version="v1.2.3") == "New version v1.2.3 is available"


def test_text_callable_log_read_error():
    assert i18n.text("logReadError", lang="ja", error="boom") == "ログ読み込みエラー: boom"
    assert i18n.text("logReadError", lang="en", error="boom") == "Error reading log: boom"


def test_text_default_language_is_ja(monkeypatch):
    monkeypatch.delenv("SHOGIHOME_LAB_LANG", raising=False)
    # detect_language falls back to Japanese by default.
    assert i18n.text("updateDownload") == "詳細を見る"


def test_env_override(monkeypatch):
    monkeypatch.setenv("SHOGIHOME_LAB_LANG", "en")
    assert i18n.text("updateDownload") == "View details"


def test_text_main_ui_keys():
    assert i18n.text("openOnPc", lang="ja") == "PCで開く"
    assert i18n.text("openOnPc", lang="en") == "Open on PC"
    assert i18n.text("engineSettings", lang="ja") == "エンジン設定"
    assert i18n.text("stopAndExit", lang="ja") == "停止して終了"
    assert i18n.text("statusRunning", lang="ja") == "実行中"


def test_text_network_info():
    ja = i18n.text("networkInfo", lang="ja", bind_address="127.0.0.1", auto_origins_enabled=True)
    assert "127.0.0.1" in ja
    assert "有効" in ja
    en = i18n.text("networkInfo", lang="en", bind_address="0.0.0.0", auto_origins_enabled=False)
    assert "Disabled" in en


def test_text_missing_key_returns_key():
    assert i18n.text("nonExistentKey", lang="ja") == "nonExistentKey"
