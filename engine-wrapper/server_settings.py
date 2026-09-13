"""Schema and persistence for server settings edited from the launcher UI.

Each setting maps a single UI value to one or more keys in the two .env files:
- shogihome/.env (server)
- engine-wrapper/.env (wrapper)

Linked settings (e.g. LISTEN_PORT / REMOTE_ENGINE_PORT) write multiple keys
with the same value so they can never get out of sync.
"""

from __future__ import annotations

import re
import secrets
from dataclasses import dataclass
from pathlib import Path

from common import load_env_value, upsert_env_values

SERVER_ENV = "server"
WRAPPER_ENV = "wrapper"

TYPE_INT = "int"
TYPE_BOOL = "bool"
TYPE_TEXT = "text"
TYPE_CHOICE = "choice"
TYPE_LIST = "list"

SECTION_BASIC = "basic"
SECTION_ENGINE = "engine"
SECTION_SECURITY = "security"
SECTION_KIFU = "kifu"

_ORIGIN_RE = re.compile(r"^https?://[^,\s]+$")
_DOMAIN_RE = re.compile(r"^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$")


@dataclass(frozen=True)
class Setting:
    """A single user-facing setting and its .env representation."""

    id: str
    keys: tuple[tuple[str, str], ...]
    type: str
    default: object
    section: str
    min_value: int | None = None
    max_value: int | None = None
    choices: tuple[str, ...] = ()
    # For TYPE_LIST: regex each item must match, and the error code to report.
    item_pattern: re.Pattern | None = None
    item_error: str = ""


SETTINGS: tuple[Setting, ...] = (
    # --- Basic ---
    Setting("PORT", (("PORT", SERVER_ENV),), TYPE_INT, 8140, SECTION_BASIC, 1, 65535),
    Setting(
        "BIND_ADDRESS",
        (("BIND_ADDRESS", SERVER_ENV),),
        TYPE_CHOICE,
        "0.0.0.0",
        SECTION_BASIC,
        choices=("0.0.0.0", "127.0.0.1"),
    ),
    Setting(
        "ENGINE_CONNECTION_PROTECTION_TIMEOUT",
        (("ENGINE_CONNECTION_PROTECTION_TIMEOUT", SERVER_ENV),),
        TYPE_INT,
        60,
        SECTION_BASIC,
        1,
        3600,
    ),
    # --- Remote engine ---
    Setting(
        "LISTEN_PORT",
        (("LISTEN_PORT", WRAPPER_ENV), ("REMOTE_ENGINE_PORT", SERVER_ENV)),
        TYPE_INT,
        4082,
        SECTION_ENGINE,
        1,
        65535,
    ),
    # --- Security ---
    Setting(
        "ALLOWED_ORIGINS",
        (("ALLOWED_ORIGINS", SERVER_ENV),),
        TYPE_LIST,
        "",
        SECTION_SECURITY,
        item_pattern=_ORIGIN_RE,
        item_error="invalid_origin",
    ),
    Setting(
        "DISABLE_AUTO_ALLOWED_ORIGINS",
        (("DISABLE_AUTO_ALLOWED_ORIGINS", SERVER_ENV),),
        TYPE_BOOL,
        False,
        SECTION_SECURITY,
    ),
    Setting("TRUST_PROXY", (("TRUST_PROXY", SERVER_ENV),), TYPE_BOOL, False, SECTION_SECURITY),
    Setting(
        "WRAPPER_ACCESS_TOKEN",
        (("WRAPPER_ACCESS_TOKEN", WRAPPER_ENV), ("WRAPPER_ACCESS_TOKEN", SERVER_ENV)),
        TYPE_TEXT,
        "",
        SECTION_SECURITY,
    ),
    Setting(
        "ALLOWED_FETCH_DOMAINS",
        (("ALLOWED_FETCH_DOMAINS", SERVER_ENV),),
        TYPE_LIST,
        "sunfish-shogi.github.io,live4.computer-shogi.org,www.computer-shogi.org,wdoor.c.u-tokyo.ac.jp",
        SECTION_SECURITY,
        item_pattern=_DOMAIN_RE,
        item_error="invalid_domain",
    ),
    # --- Kifu / Book / DB ---
    Setting("KIFU_DIR", (("KIFU_DIR", SERVER_ENV),), TYPE_TEXT, "", SECTION_KIFU),
    Setting("KIFU_DIR_USE_POLLING", (("KIFU_DIR_USE_POLLING", SERVER_ENV),), TYPE_BOOL, False, SECTION_KIFU),
    Setting("ANALYSIS_DB_MIN_DEPTH", (("ANALYSIS_DB_MIN_DEPTH", SERVER_ENV),), TYPE_INT, 10, SECTION_KIFU, 0, 100),
    Setting("ONTHEFLY_THRESHOLD_MB", (("ONTHEFLY_THRESHOLD_MB", SERVER_ENV),), TYPE_INT, 128, SECTION_KIFU, 1, 100000),
    Setting(
        "SBK_ONTHEFLY_THRESHOLD_MB",
        (("SBK_ONTHEFLY_THRESHOLD_MB", SERVER_ENV),),
        TYPE_INT,
        32,
        SECTION_KIFU,
        1,
        100000,
    ),
)

SECTION_ORDER = (SECTION_BASIC, SECTION_ENGINE, SECTION_SECURITY, SECTION_KIFU)


def _env_paths(shogihome_dir, wrapper_dir):
    return {SERVER_ENV: Path(shogihome_dir) / ".env", WRAPPER_ENV: Path(wrapper_dir) / ".env"}


def load_settings(shogihome_dir, wrapper_dir) -> dict[str, object]:
    """Load current setting values from the .env files."""
    paths = _env_paths(shogihome_dir, wrapper_dir)
    values: dict[str, object] = {}
    for setting in SETTINGS:
        key, kind = setting.keys[0]
        # Read booleans as text: bool defaults also satisfy isinstance(default, int).
        default = str(setting.default) if setting.type == TYPE_BOOL else setting.default
        raw = load_env_value(paths[kind], key, default)
        if setting.type == TYPE_BOOL:
            values[setting.id] = str(raw).strip().lower() == "true"
        else:
            values[setting.id] = "" if raw is None else str(raw)
    return values


def validate(values) -> dict[str, str]:
    """Validate a values mapping (as collected from the UI).

    Returns a mapping of setting id -> error code for invalid entries.
    Error codes: "invalid_int", "out_of_range", "invalid_choice",
    "invalid_origin", "invalid_domain".
    """
    errors: dict[str, str] = {}
    for setting in SETTINGS:
        value = values.get(setting.id, setting.default)
        if setting.type == TYPE_INT:
            try:
                num = int(str(value).strip())
            except (ValueError, TypeError, AttributeError):
                errors[setting.id] = "invalid_int"
                continue
            if setting.min_value is not None and num < setting.min_value:
                errors[setting.id] = "out_of_range"
            elif setting.max_value is not None and num > setting.max_value:
                errors[setting.id] = "out_of_range"
        elif setting.type == TYPE_CHOICE:
            if value not in setting.choices:
                errors[setting.id] = "invalid_choice"
        elif setting.type == TYPE_LIST:
            for item in str(value).split(","):
                item = item.strip()
                if item and setting.item_pattern and not setting.item_pattern.match(item):
                    errors[setting.id] = setting.item_error
                    break
    return errors


def save(values, shogihome_dir, wrapper_dir) -> None:
    """Validate and write settings to the .env files."""
    errors = validate(values)
    if errors:
        raise ValueError(f"Invalid settings: {', '.join(errors)}")

    paths = _env_paths(shogihome_dir, wrapper_dir)
    updates: dict[str, dict[str, str]] = {SERVER_ENV: {}, WRAPPER_ENV: {}}
    for setting in SETTINGS:
        value = values[setting.id]
        if setting.type == TYPE_BOOL:
            formatted = "true" if value in (True, "true", "True") else "false"
        elif setting.type == TYPE_INT:
            formatted = str(int(str(value).strip()))
        else:
            formatted = str(value)
        for key, kind in setting.keys:
            updates[kind][key] = formatted

    for kind, env_updates in updates.items():
        if env_updates:
            upsert_env_values(paths[kind], env_updates)


def generate_token() -> str:
    """Generate a random access token suitable for WRAPPER_ACCESS_TOKEN."""
    return secrets.token_urlsafe(24)
