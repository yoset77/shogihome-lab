"""Exercise the real runtime assembler without rebuilding the web application."""

import json
import os
import shutil
import subprocess
from pathlib import Path

import pytest


def test_native_runtime_is_executable_from_an_unrelated_cwd(tmp_path):
    node = shutil.which("node")
    if not node:
        pytest.skip("Node.js is required to assemble the runtime")
    project = tmp_path / "portable 日本語"
    (project / "scripts").mkdir(parents=True)
    script = Path(__file__).resolve().parents[2] / "shogihome/scripts/build-server-runtime.mjs"
    shutil.copy2(script, project / "scripts/build-server-runtime.mjs")
    bundle = project / "dist/server"
    bundle.mkdir(parents=True)
    (bundle / "server.js").write_text("console.log(JSON.stringify({platform:process.platform, exe:process.execPath}));\n", encoding="utf-8")
    for asset in ("node-worker/worker.js", "ort-wasm/runtime.wasm", "models/fixture.onnx"):
        file = bundle / asset
        file.parent.mkdir(parents=True, exist_ok=True)
        file.write_bytes(b"fixture")
    unrelated = tmp_path / "unrelated"
    unrelated.mkdir()
    subprocess.run([node, str(project / "scripts/build-server-runtime.mjs")], cwd=unrelated, check=True, timeout=30)
    runtime = project / "dist/bin" / ("shogihome-server.exe" if os.name == "nt" else "shogihome-server")
    assert runtime.is_file()
    assert os.access(runtime, os.X_OK)
    result = subprocess.run(
        [str(runtime), str(runtime.parent / "dist/server/server.js")],
        cwd=unrelated,
        check=True,
        capture_output=True,
        text=True,
        # Node writes UTF-8 to pipes on every OS; the Windows console
        # codepage (e.g. cp1252) would mangle non-ASCII paths like 日本語.
        encoding="utf-8",
        timeout=15,
    )
    assert Path(json.loads(result.stdout)["exe"]).resolve() == runtime.resolve()
    for asset in ("node-worker/worker.js", "ort-wasm/runtime.wasm", "models/fixture.onnx"):
        assert (runtime.parent / "dist/server" / asset).read_bytes() == b"fixture"
