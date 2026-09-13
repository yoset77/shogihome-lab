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

    crates = data["crates"]
    lines = [f"## {args.section}", ""]
    for entry in data["overview"]:
        names = sorted(f"{crates[i]['package']['name']} {crates[i]['package']['version']}" for i in entry["indices"])
        lines.append(f"### {entry['id']} ({entry['count']} crates)")
        lines.extend(f"- {name}" for name in names)
        lines.append("")
        lines.append(entry["text"].rstrip())
        lines.append("")

    out = Path(args.append)
    out.parent.mkdir(parents=True, exist_ok=True)
    mode = "a" if out.exists() else "w"
    with out.open(mode, encoding="utf-8") as f:
        f.write("\n".join(lines))
    print(f"wrote {out} ({len(crates)} crates)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
