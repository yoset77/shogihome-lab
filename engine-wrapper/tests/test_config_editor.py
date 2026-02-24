from unittest.mock import mock_open, patch

from config_editor import Api


def test_api_save_valid_data():
    api = Api()
    valid_data = [{"id": "test-engine", "name": "Test Engine", "path": "path/to/engine", "type": "both", "options": {"MultiPV": 1}}]

    with patch("config_editor.ENGINES_JSON_PATH", "/fake/path/engines.json"):
        with patch("builtins.open", mock_open()) as mocked_file:
            result = api.save(valid_data)
            assert result == {"status": "ok"}
            # Check if json.dump was called correctly
            mocked_file.assert_called_once_with("/fake/path/engines.json", "w", encoding="utf-8")


def test_api_save_invalid_root_type():
    api = Api()
    invalid_data = {"id": "not-a-list"}
    result = api.save(invalid_data)
    assert "error" in result
    assert "Root must be a list" in result["error"]


def test_api_save_missing_required_fields():
    api = Api()
    # Missing 'path'
    invalid_data = [{"id": "engine1", "name": "Name"}]
    result = api.save(invalid_data)
    assert "error" in result
    assert "Missing required field 'path'" in result["error"]


def test_api_save_invalid_field_types():
    api = Api()
    # 'id' is not a string
    invalid_data = [{"id": 123, "name": "Name", "path": "path"}]
    result = api.save(invalid_data)
    assert "error" in result
    assert "Field 'id' in entry 0 must be a string" in result["error"]


def test_api_save_empty_id():
    api = Api()
    invalid_data = [{"id": "  ", "name": "Name", "path": "path"}]
    result = api.save(invalid_data)
    assert "error" in result
    assert "Engine ID in entry 0 cannot be empty" in result["error"]


def test_api_save_invalid_type_enum():
    api = Api()
    invalid_data = [{"id": "id", "name": "Name", "path": "path", "type": "invalid"}]
    result = api.save(invalid_data)
    assert "error" in result
    assert "Invalid type 'invalid'" in result["error"]


def test_api_save_invalid_options_type():
    api = Api()
    # 'options' must be a dict
    invalid_data = [{"id": "id", "name": "Name", "path": "path", "options": "not-a-dict"}]
    result = api.save(invalid_data)
    assert "error" in result
    assert "Field 'options' in entry 0 must be an object" in result["error"]
