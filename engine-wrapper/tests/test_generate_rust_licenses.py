"""Regression test for generate_rust_licenses.py.

cargo-about 0.9.2 `overview[].indices` point into `licenses`, not `crates`,
and `overview[].text` is only the first body of that SPDX id. The renderer
must therefore enumerate `data["licenses"]` with each `used_by[].crate`.
"""

import importlib.util
import sys
from pathlib import Path

SCRIPT = Path(__file__).resolve().parent.parent / "scripts" / "generate_rust_licenses.py"


def _load():
    spec = importlib.util.spec_from_file_location("generate_rust_licenses", SCRIPT)
    module = importlib.util.module_from_spec(spec)
    sys.modules["generate_rust_licenses"] = module
    spec.loader.exec_module(module)
    return module


def _sample_data():
    # licenses sorted by id (as cargo-about emits): Apache first, then the two
    # distinct MIT bodies. overview indices therefore refer to licenses order.
    return {
        "crates": [
            {"package": {"name": "aaa", "version": "1.0.0"}, "license": "MIT"},
            {"package": {"name": "bbb", "version": "2.0.0"}, "license": "MIT"},
            {"package": {"name": "ccc", "version": "3.0.0"}, "license": "Apache-2.0"},
        ],
        "overview": [
            {
                "id": "Apache-2.0",
                "name": "Apache License 2.0",
                "count": 1,
                "indices": [0],
                "text": "APACHE BODY",
            },
            {
                "id": "MIT",
                "name": "MIT License",
                "count": 2,
                "indices": [1, 2],
                "text": "MIT BODY A (Copyright Holder A)",
            },
        ],
        "licenses": [
            {
                "id": "Apache-2.0",
                "name": "Apache License 2.0",
                "text": "APACHE BODY",
                "used_by": [{"crate": {"name": "ccc", "version": "3.0.0"}}],
            },
            {
                "id": "MIT",
                "name": "MIT License",
                "text": "MIT BODY A (Copyright Holder A)",
                "used_by": [{"crate": {"name": "aaa", "version": "1.0.0"}}],
            },
            {
                "id": "MIT",
                "name": "MIT License",
                "text": "MIT BODY B (Copyright Holder B)",
                "used_by": [{"crate": {"name": "bbb", "version": "2.0.0"}}],
            },
        ],
    }


def test_same_spdx_id_keeps_both_bodies_with_correct_crates():
    mod = _load()
    text, count = mod.render_section("Rust workspace", _sample_data())
    assert count == 3
    # Both distinct MIT bodies must be present (overview only keeps the first).
    assert "MIT BODY A (Copyright Holder A)" in text
    assert "MIT BODY B (Copyright Holder B)" in text
    assert "APACHE BODY" in text
    # Each body must be paired with exactly its own crate(s).
    sections = text.split("### ")
    mit_a = next(s for s in sections if "MIT BODY A" in s)
    mit_b = next(s for s in sections if "MIT BODY B" in s)
    apache = next(s for s in sections if "APACHE BODY" in s)
    assert "- aaa 1.0.0" in mit_a and "- bbb 2.0.0" not in mit_a
    assert "- bbb 2.0.0" in mit_b and "- aaa 1.0.0" not in mit_b
    assert "- ccc 3.0.0" in apache
    # The old overview-based rendering would map MIT indices [1, 2] into
    # crates[1..2] = bbb + ccc and drop MIT BODY B entirely.
    assert "MIT BODY B" not in mit_a
