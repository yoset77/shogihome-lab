from unittest.mock import AsyncMock

import pytest

from config_editor import parse_usi_option_line
from engine_wrapper import apply_engine_options


@pytest.mark.asyncio
async def test_apply_engine_options():
    from unittest.mock import MagicMock

    mock_stdin = AsyncMock()
    # write は同期関数のため、AsyncMock ではなく MagicMock を使用する
    mock_stdin.write = MagicMock()
    options = {"USI_Ponder": True, "Threads": 4, "MultiPV": "2"}

    await apply_engine_options(mock_stdin, options)

    # 呼び出し内容の検証
    calls = [call[0][0].decode() for call in mock_stdin.write.call_args_list]
    assert "setoption name USI_Ponder value true\n" in calls
    assert "setoption name Threads value 4\n" in calls
    assert "setoption name MultiPV value 2\n" in calls


def test_parse_usi_option_line_spin():
    line = "option name Threads type spin default 1 min 1 max 128"
    name, opt = parse_usi_option_line(line)
    assert name == "Threads"
    assert opt["type"] == "spin"
    assert opt["default"] == 1
    assert opt["min"] == 1
    assert opt["max"] == 128


def test_parse_usi_option_line_check():
    line = "option name USI_Ponder type check default false"
    name, opt = parse_usi_option_line(line)
    assert name == "USI_Ponder"
    assert opt["type"] == "check"
    assert opt["default"] is False


def test_parse_usi_option_line_combo():
    line = "option name Style type combo default Normal var Normal var Active var Passive"
    name, opt = parse_usi_option_line(line)
    assert name == "Style"
    assert opt["type"] == "combo"
    assert opt["default"] == "Normal"
    assert opt["vars"] == ["Normal", "Active", "Passive"]


def test_parse_usi_option_line_string():
    line = "option name BookFile type string default public.bin"
    name, opt = parse_usi_option_line(line)
    assert name == "BookFile"
    assert opt["type"] == "string"
    assert opt["default"] == "public.bin"


def test_parse_usi_option_line_button():
    line = "option name Clear_Cache type button"
    name, opt = parse_usi_option_line(line)
    assert name == "Clear_Cache"
    assert opt["type"] == "button"


def test_parse_usi_option_line_multiword_name():
    line = "option name Best Book Move type button"
    name, opt = parse_usi_option_line(line)
    assert name == "Best Book Move"
    assert opt["type"] == "button"


def test_parse_usi_option_line_multiword_combo_var():
    line = "option name Opening type combo default Normal var Move Count Based var Time Based"
    name, opt = parse_usi_option_line(line)
    assert name == "Opening"
    assert opt["type"] == "combo"
    assert opt["default"] == "Normal"
    assert "Move Count Based" in opt["vars"]
    assert "Time Based" in opt["vars"]


def test_parse_usi_option_line_invalid():
    assert parse_usi_option_line("invalid line") == (None, None)
    assert parse_usi_option_line("option name OnlyName") == (None, None)
