"""Tests for the launcher update checker."""

from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone
from unittest.mock import MagicMock, patch

import pytest
from packaging.version import Version

from update_checker import (
    UpdateCache,
    UpdateInfo,
    _parse_version,
    fetch_latest_release,
    load_current_version,
)


def test_parse_version():
    assert _parse_version("v1.2.3") == Version("1.2.3")
    assert _parse_version("1.2.3") == Version("1.2.3")
    assert _parse_version("1.17.0-alpha.0") == Version("1.17.0a0")
    assert _parse_version("invalid") is None


def test_load_current_version(tmp_path):
    version_file = tmp_path / "VERSION"
    version_file.write_text("1.2.3\n", encoding="utf-8")
    assert load_current_version(version_file) == "1.2.3"
    assert load_current_version(tmp_path / "missing") is None

    version_file.write_text("   \n", encoding="utf-8")
    assert load_current_version(version_file) is None


def _mock_response(payload):
    """Return a mock object that can be used as a urlopen context manager."""
    mock = MagicMock()
    mock.read.return_value = json.dumps(payload).encode("utf-8")
    mock.__enter__ = MagicMock(return_value=mock)
    mock.__exit__ = MagicMock(return_value=False)
    return mock


def test_fetch_latest_release_returns_newer_stable():
    releases = [
        {"tag_name": "v1.0.0", "draft": False, "prerelease": False, "html_url": "https://example.com/1.0.0"},
        {"tag_name": "v1.2.0", "draft": False, "prerelease": False, "html_url": "https://example.com/1.2.0"},
        {"tag_name": "v1.1.0", "draft": False, "prerelease": False, "html_url": "https://example.com/1.1.0"},
    ]
    with patch("urllib.request.urlopen", return_value=_mock_response(releases)):
        result = fetch_latest_release("1.0.0")

    assert isinstance(result, UpdateInfo)
    assert result.tag == "v1.2.0"
    assert result.version == "1.2.0"
    assert result.url == "https://example.com/1.2.0"


def test_fetch_latest_release_ignores_draft_and_prerelease_for_stable():
    releases = [
        {"tag_name": "v1.2.0-beta", "draft": False, "prerelease": True, "html_url": "https://example.com/beta"},
        {"tag_name": "v1.1.0", "draft": False, "prerelease": False, "html_url": "https://example.com/1.1.0"},
    ]
    with patch("urllib.request.urlopen", return_value=_mock_response(releases)):
        result = fetch_latest_release("1.0.0")

    assert result is not None
    assert result.tag == "v1.1.0"


def test_fetch_latest_release_includes_prerelease_when_current_is_prerelease():
    releases = [
        {"tag_name": "v1.2.0-beta.2", "draft": False, "prerelease": True, "html_url": "https://example.com/b2"},
        {"tag_name": "v1.1.0", "draft": False, "prerelease": False, "html_url": "https://example.com/1.1.0"},
    ]
    with patch("urllib.request.urlopen", return_value=_mock_response(releases)):
        result = fetch_latest_release("1.2.0-beta.1")

    assert result is not None
    assert result.tag == "v1.2.0-beta.2"


def test_fetch_latest_release_no_update():
    releases = [
        {"tag_name": "v1.0.0", "draft": False, "prerelease": False, "html_url": "https://example.com/1.0.0"},
    ]
    with patch("urllib.request.urlopen", return_value=_mock_response(releases)):
        result = fetch_latest_release("1.0.0")

    assert result is None


def test_fetch_latest_release_invalid_current_version():
    result = fetch_latest_release("not-a-version")
    assert result is None


def test_fetch_latest_release_network_error_raises():
    with patch("urllib.request.urlopen", side_effect=OSError("network down")):
        with pytest.raises(OSError):
            fetch_latest_release("1.0.0")


def test_update_cache_load_save(tmp_path):
    cache_path = tmp_path / "cache.json"
    cache = UpdateCache()
    now = datetime(2026, 1, 1, 12, 0, 0, tzinfo=timezone.utc)
    cache.snooze("1.2.0", days=7, now=now)
    cache.ui_language = "en"
    cache.save(cache_path)

    loaded = UpdateCache.load(cache_path)
    assert loaded.is_snoozed("1.2.0", now=now + timedelta(days=1))
    assert loaded.ui_language == "en"


def test_update_cache_load_corrupt_returns_empty(tmp_path):
    cache_path = tmp_path / "cache.json"
    cache_path.write_text("not json", encoding="utf-8")
    loaded = UpdateCache.load(cache_path)
    assert loaded.snoozed_version is None
    assert loaded.ui_language is None


def test_update_cache_snooze_expires():
    cache = UpdateCache()
    now = datetime(2026, 1, 1, 12, 0, 0, tzinfo=timezone.utc)
    cache.snooze("1.2.0", days=7, now=now)
    assert cache.is_snoozed("1.2.0", now=now + timedelta(days=1))
    assert not cache.is_snoozed("1.2.0", now=now + timedelta(days=8))


def test_update_cache_newer_version_breaks_snooze():
    cache = UpdateCache()
    now = datetime(2026, 1, 1, 12, 0, 0, tzinfo=timezone.utc)
    cache.snooze("1.2.0", days=7, now=now)
    # A newer release than the snoozed one should still be notified.
    assert not cache.is_snoozed("1.3.0", now=now + timedelta(days=1))
