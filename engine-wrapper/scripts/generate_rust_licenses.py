#!/usr/bin/env python3
"""Render RUST-THIRD-PARTY-NOTICES.txt from `cargo about` JSON output.

`cargo about generate` doubles as the license gate: it fails when a crate
uses a license outside engine-wrapper/about.toml `accepted`. This script
only formats the JSON it produces (stdlib only).

Usage (run from the repo root; --config is resolved against your working
directory, not --manifest-dir):
    python engine-wrapper/scripts/generate_rust_licenses.py \
        --manifest-dir engine-wrapper/launcher-app/src-tauri \
        --config engine-wrapper/about.toml --append licenses/RUST-THIRD-PARTY-NOTICES.txt
"""

import argparse
import json
import subprocess
import sys
import tempfile
from pathlib import Path


def _crate_name_version(node) -> str:
    """Extract "name version" from a cargo-about crate node.

    `data["crates"][i]["package"]` and `data["licenses"][i]["used_by"][j]["crate"]`
    are the same `krates::cm::Package` type, but the former is wrapped in
    `{"package": ...}` while the latter is serialized directly under `"crate"`.
    """
    pkg = node.get("package", node) if isinstance(node, dict) else node
    if isinstance(pkg, dict) and "crate" in pkg and isinstance(pkg["crate"], dict):
        pkg = pkg["crate"]
    name = pkg.get("name", "?") if isinstance(pkg, dict) else "?"
    version = pkg.get("version", "?") if isinstance(pkg, dict) else "?"
    return f"{name} {version}"


def render_section(section: str, data: dict) -> tuple[str, int]:
    """Render one `## section` block from `cargo about generate --format json`.

    Each entry of `data["licenses"]` is a distinct license *text* (texts may
    differ by copyright holder even for the same SPDX id) with its own
    `used_by[].crate` list. `data["overview"]` must not be used here: its
    `indices` point into `licenses`, not `crates`, and its `text` is only the
    first body of that SPDX id.
    """
    licenses = data["licenses"]
    lines = [f"## {section}", ""]
    for entry in licenses:
        names = sorted(_crate_name_version(u) for u in entry.get("used_by", []))
        count = len(entry.get("used_by", []))
        lines.append(f"### {entry['id']} ({count} crates)")
        lines.extend(f"- {name}" for name in names)
        lines.append("")
        lines.append(entry["text"].rstrip())
        lines.append("")
    return "\n".join(lines), len(data.get("crates", []))


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", default="about.toml")
    parser.add_argument("--manifest-dir", default=".", help="Crate root whose Cargo.lock should be audited")
    parser.add_argument("--section", default="Rust workspace")
    parser.add_argument("--append", required=True)
    args = parser.parse_args()

    # `cargo about` runs with cwd=manifest_dir below, so a relative --config
    # would resolve against the manifest dir instead of the caller's CWD.
    # Resolve it up front so callers can pass repo-root-relative paths.
    config = str(Path(args.config).resolve())

    with tempfile.NamedTemporaryFile(suffix=".json", delete=False) as tmp:
        tmp_path = tmp.name
    try:
        subprocess.run(
            ["cargo", "about", "generate", "--config", config, "--format", "json", "-o", tmp_path],
            cwd=args.manifest_dir,
            check=True,
        )
        data = json.loads(Path(tmp_path).read_text(encoding="utf-8"))
    finally:
        Path(tmp_path).unlink(missing_ok=True)

    text, crate_count = render_section(args.section, data)

    out = Path(args.append)
    out.parent.mkdir(parents=True, exist_ok=True)
    mode = "a" if out.exists() else "w"
    with out.open(mode, encoding="utf-8") as f:
        f.write(text)
    print(f"wrote {out} ({crate_count} crates)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
