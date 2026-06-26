"""Minimal i18n helper for the Python launcher.

Defaults to Japanese. Supports a small set of languages used by the launcher UI.
"""

from __future__ import annotations

import os
from typing import Callable

# Display language codes supported by the launcher.
LANGUAGE_JA = "ja"
LANGUAGE_EN = "en"
DEFAULT_LANGUAGE = LANGUAGE_JA

# Translation table. Callable values accept keyword arguments.
TEXTS: dict[str, dict[str, str | Callable[..., str]]] = {
    LANGUAGE_JA: {
        "latestVersionReleased": lambda version: f"最新版 {version} が利用可能です",
        "updateDownload": "詳細を見る",
        "updateRemindLater": "後で通知",
        "languageJa": "日本語",
        "languageEn": "English",
        "openOnPc": "PCで開く",
        "engineSettings": "エンジン設定",
        "restartServer": "サーバー再起動",
        "showLogs": "ログ表示",
        "stopAndExit": "停止して終了",
        "statusStopped": "停止中",
        "statusRunning": "実行中",
        "statusStarting": "起動中...",
        "statusError": "エラー",
        "statusLogError": "ログエラー",
        "statusStopping": "停止中...",
        "restarting": "再起動中...",
        "settingsRunning": "設定実行中",
        "logViewerTitle": "ログビューアー",
        "serverLogTab": "サーバーログ",
        "wrapperLogTab": "ラッパーログ",
        "refresh": "更新",
        "logTruncated": "... (省略) ...",
        "logReadError": lambda error: f"ログ読み込みエラー: {error}",
        "customNetworkActive": "カスタムネットワーク有効",
        "networkInfo": lambda bind_address, auto_origins_enabled: (
            f"Binding: {bind_address}\n"
            f"Auto-Origins: {'有効' if auto_origins_enabled else '無効'}\n\n"
            "手動で設定したURLや\n"
            "プロキシを使用して\n"
            "他の端末からアクセスしてください。"
        ),
        "trayOpenShogiHome": "ShogiHomeを開く",
        "trayDashboard": "ダッシュボード",
        "traySettings": "設定",
        "trayExit": "終了",
    },
    LANGUAGE_EN: {
        "latestVersionReleased": lambda version: f"New version {version} is available",
        "updateDownload": "View details",
        "updateRemindLater": "Remind later",
        "languageJa": "日本語",
        "languageEn": "English",
        "openOnPc": "Open on PC",
        "engineSettings": "Engine Settings",
        "restartServer": "Restart Server",
        "showLogs": "Show Logs",
        "stopAndExit": "Stop & Exit",
        "statusStopped": "Stopped",
        "statusRunning": "Running",
        "statusStarting": "Starting...",
        "statusError": "Error",
        "statusLogError": "Log Error",
        "statusStopping": "Stopping...",
        "restarting": "Restarting...",
        "settingsRunning": "Settings Running",
        "logViewerTitle": "Log Viewer",
        "serverLogTab": "Server Log",
        "wrapperLogTab": "Wrapper Log",
        "refresh": "Refresh",
        "logTruncated": "... (truncated) ...",
        "logReadError": lambda error: f"Error reading log: {error}",
        "customNetworkActive": "Custom Network Active",
        "networkInfo": lambda bind_address, auto_origins_enabled: (
            f"Binding: {bind_address}\n"
            f"Auto-Origins: {'Enabled' if auto_origins_enabled else 'Disabled'}\n\n"
            "Please use your manually\n"
            "configured URL or proxy\n"
            "to access from other devices."
        ),
        "trayOpenShogiHome": "Open ShogiHome",
        "trayDashboard": "Dashboard",
        "traySettings": "Settings",
        "trayExit": "Exit",
    },
}


def detect_language() -> str:
    """Detect the display language for the launcher.

    Priority:
      1. SHOGIHOME_LAB_LANG environment variable
      2. Windows UI language (if running on Windows)
      3. Default Japanese
    """
    env_lang = os.environ.get("SHOGIHOME_LAB_LANG")
    if env_lang in TEXTS:
        return env_lang

    if os.name == "nt":
        try:
            import ctypes

            lang_id = ctypes.windll.kernel32.GetUserDefaultUILanguage()
            # Japanese LANGID is 0x0411.
            if lang_id == 0x0411:
                return LANGUAGE_JA
        except Exception:
            pass

    return DEFAULT_LANGUAGE


def text(key: str, lang: str | None = None, **kwargs: object) -> str:
    """Return a translated message.

    Args:
        key: The translation key.
        lang: Optional language code. Defaults to detected language.
        **kwargs: Keyword arguments for callable messages.

    Returns:
        The translated string, or the key itself if missing.
    """
    language = lang if lang in TEXTS else detect_language()
    message = TEXTS.get(language, TEXTS[DEFAULT_LANGUAGE]).get(key)
    if message is None:
        return key
    if callable(message):
        return message(**kwargs)
    return message
