import json

from config_editor import Api


def _api_with_tmp_engines_json(tmp_path, monkeypatch):
    """Return (Api, path) where the engines.json path points into tmp_path."""
    api = Api()
    path = tmp_path / "engines.json"
    monkeypatch.setattr("config_editor.ENGINES_JSON_PATH", path)
    return api, path


def test_api_save_valid_data(tmp_path, monkeypatch):
    api, path = _api_with_tmp_engines_json(tmp_path, monkeypatch)
    valid_data = [
        {
            "id": "test-engine",
            "name": "Test Engine",
            "path": "path/to/engine",
            "type": ["game", "research"],
            "options": {"MultiPV": 1},
        }
    ]

    result = api.save(valid_data)

    assert result == {"status": "ok"}
    written = json.loads(path.read_text(encoding="utf-8"))
    assert written == valid_data
    # The temporary file must not be left behind
    assert not (tmp_path / "engines.json.tmp").exists()


def test_api_save_backward_compatibility(tmp_path, monkeypatch):
    api, path = _api_with_tmp_engines_json(tmp_path, monkeypatch)
    # String type 'both' should be converted to list ['game', 'research', 'mate']
    input_data = [{"id": "test-engine", "name": "Test Engine", "path": "path/to/engine", "type": "both"}]

    result = api.save(input_data)

    assert result == {"status": "ok"}
    written = json.loads(path.read_text(encoding="utf-8"))
    assert written[0]["type"] == ["game", "research", "mate"]


def test_api_save_is_atomic(tmp_path, monkeypatch):
    api, path = _api_with_tmp_engines_json(tmp_path, monkeypatch)
    path.write_text('[{"id": "old", "name": "Old", "path": "old"}]', encoding="utf-8")

    result = api.save([{"id": "new", "name": "New", "path": "new"}])

    assert result == {"status": "ok"}
    written = json.loads(path.read_text(encoding="utf-8"))
    assert written[0]["id"] == "new"
    assert not (tmp_path / "engines.json.tmp").exists()


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
    # 'both' as a list element is invalid (it should be converted if it was a string, but here it's in a list)
    invalid_data = [{"id": "id", "name": "Name", "path": "path", "type": ["invalid"]}]
    result = api.save(invalid_data)
    assert "error" in result
    assert "Invalid type 'invalid'" in result["error"]


def test_api_save_invalid_type_both_in_list():
    api = Api()
    invalid_data = [{"id": "id", "name": "Name", "path": "path", "type": ["both"]}]
    result = api.save(invalid_data)
    assert "error" in result
    assert "Invalid type 'both'" in result["error"]


def test_api_save_invalid_options_type():
    api = Api()
    # 'options' must be a dict
    invalid_data = [{"id": "id", "name": "Name", "path": "path", "options": "not-a-dict"}]
    result = api.save(invalid_data)
    assert "error" in result
    assert "Field 'options' in entry 0 must be an object" in result["error"]
