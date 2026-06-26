"""Update notification logic for the bundled launcher.

Fetches the latest release from GitHub and compares it with the bundled version.
"""

from __future__ import annotations

import json
import urllib.error
import urllib.request
from dataclasses import asdict, dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path

from packaging.version import InvalidVersion, Version

DEFAULT_REPO_OWNER = "yoset77"
DEFAULT_REPO_NAME = "shogihome-lab"
_GITHUB_API_URL = "https://api.github.com/repos/{owner}/{repo}/releases"


@dataclass(frozen=True)
class UpdateInfo:
    """Information about a newer release."""

    version: str
    tag: str
    url: str


@dataclass
class UpdateCache:
    """On-disk cache for update notification state."""

    snoozed_version: str | None = None
    snoozed_until: str | None = None
    ui_language: str | None = None

    @classmethod
    def load(cls, path: Path) -> "UpdateCache":
        """Load cache from disk, returning an empty cache if missing or corrupt."""
        if not path.exists():
            return cls()
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
            return cls(
                snoozed_version=data.get("snoozed_version"),
                snoozed_until=data.get("snoozed_until"),
                ui_language=data.get("ui_language"),
            )
        except Exception:
            return cls()

    def save(self, path: Path) -> None:
        """Persist cache to disk."""
        path.write_text(json.dumps(asdict(self), ensure_ascii=False), encoding="utf-8")

    def is_snoozed(self, version: str, now: datetime | None = None) -> bool:
        """Return True if the given version should be suppressed right now.

        A newer version than the snoozed one always breaks the snooze.
        """
        if not self.snoozed_version or not self.snoozed_until:
            return False

        parsed_snoozed = _parse_version(self.snoozed_version)
        parsed_version = _parse_version(version)
        if parsed_snoozed is None or parsed_version is None:
            return False

        # A newer release than the snoozed one should be notified.
        if parsed_version > parsed_snoozed:
            return False

        now = now if now is not None else datetime.now(timezone.utc)
        try:
            until = datetime.fromisoformat(self.snoozed_until)
        except ValueError:
            return False

        return now < until

    def snooze(self, version: str, days: int = 7, now: datetime | None = None) -> None:
        """Suppress notifications for the given version for the specified days."""
        now = now if now is not None else datetime.now(timezone.utc)
        until = now + timedelta(days=days)
        self.snoozed_version = version
        self.snoozed_until = until.isoformat()


def load_current_version(version_path: Path) -> str | None:
    """Read the bundled version from a VERSION file."""
    if not version_path.exists():
        return None
    try:
        version = version_path.read_text(encoding="utf-8").strip()
        return version if version else None
    except Exception:
        return None


def _parse_version(version_str: str) -> Version | None:
    """Parse a version string, tolerating a leading 'v'."""
    cleaned = version_str.lstrip("v")
    try:
        return Version(cleaned)
    except InvalidVersion:
        return None


def _build_request(url: str, current_version: str) -> urllib.request.Request:
    """Build a GitHub API request with a proper User-Agent header."""
    return urllib.request.Request(
        url,
        headers={
            "User-Agent": f"ShogiHomeLab/{current_version}",
            "Accept": "application/vnd.github+json",
        },
    )


def fetch_latest_release(
    current_version: str,
    repo_owner: str = DEFAULT_REPO_OWNER,
    repo_name: str = DEFAULT_REPO_NAME,
    timeout: float = 5.0,
) -> UpdateInfo | None:
    """Query GitHub releases and return the newest release newer than current_version.

    If the current version is a pre-release, pre-releases are included in the
    search. Draft releases are always ignored.

    Raises:
        urllib.error.URLError: On network or HTTP errors.
        json.JSONDecodeError: On invalid response bodies.
    """
    current = _parse_version(current_version)
    if current is None:
        return None

    include_prerelease = current.is_prerelease
    url = _GITHUB_API_URL.format(owner=repo_owner, repo=repo_name)
    request = _build_request(f"{url}?per_page=20", current_version)

    with urllib.request.urlopen(request, timeout=timeout) as response:
        data = json.loads(response.read().decode("utf-8"))

    if not isinstance(data, list):
        return None

    best_version = current
    best_info: UpdateInfo | None = None

    for release in data:
        if not isinstance(release, dict):
            continue
        if release.get("draft"):
            continue
        if not include_prerelease and release.get("prerelease"):
            continue

        tag = release.get("tag_name")
        if not tag or not isinstance(tag, str):
            continue

        version = _parse_version(tag)
        if version is None:
            continue

        if version > best_version:
            best_version = version
            html_url = release.get("html_url")
            best_info = UpdateInfo(
                version=str(version),
                tag=tag,
                url=html_url if isinstance(html_url, str) else "",
            )

    return best_info
