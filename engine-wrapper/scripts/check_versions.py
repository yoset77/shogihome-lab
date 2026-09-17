#!/usr/bin/env python3
"""Single version authority for the ShogiHome Lab release.

Compares every version source that the release artifact derives from and
fails on any mismatch. The sources below are the single version authority
(consumed by CI on every push and by the release workflow with `--tag`):

- shogihome/package.json                   (middle server + webapp)
- engine-wrapper/Cargo.toml                ([workspace.package] version)
- engine-wrapper/wrapper/Cargo.toml        (must be `version.workspace = true`)
- engine-wrapper/launcher/Cargo.toml       (must be `version.workspace = true`)
- engine-wrapper/launcher-app/package.json (launcher UI)
- engine-wrapper/launcher-app/src-tauri/tauri.conf.json (bundle version)

Usage:
    python engine-wrapper/scripts/check_versions.py [--tag v1.20.0]

With --tag, the tag (leading `v` stripped) must equal the same version.
Stdlib only so release CI can run it with system Python.
"""

import argparse
import json
import re
import sys
from pathlib import Path

try:
    import tomllib
except ModuleNotFoundError:  # Python < 3.11 fallback
    tomllib = None

REPO_ROOT = Path(__file__).resolve().parents[2]
WRAPPER_DIR = REPO_ROOT / "engine-wrapper"


def read_text(path: Path) -> str:
    return path.read_text(encoding="utf-8")


def toml_version(path: Path, dotted: str) -> str:
    """Read a dotted key (e.g. 'project.version') from a TOML file."""
    text = read_text(path)
    if tomllib is not None:
        data = tomllib.loads(text)
        node = data
        for part in dotted.split("."):
            node = node[part]
        if not isinstance(node, str):
            raise ValueError(f"{path}: {dotted} is not a string")
        return node
    match = re.search(
        rf"^{re.escape(dotted.split('.')[-1])}\s*=\s*[\"']([^\"']+)[\"']",
        text,
        re.MULTILINE,
    )
    if not match:
        raise ValueError(f"{path}: cannot find {dotted}")
    return match.group(1)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--tag", default=None, help="Release tag, e.g. v1.20.0")
    args = parser.parse_args()

    versions: dict[str, str] = {
        "shogihome/package.json": json.loads(read_text(REPO_ROOT / "shogihome" / "package.json"))["version"],
        "engine-wrapper/Cargo.toml [workspace.package]": toml_version(WRAPPER_DIR / "Cargo.toml", "workspace.package.version"),
        "launcher-app/package.json": json.loads(read_text(WRAPPER_DIR / "launcher-app" / "package.json"))["version"],
        "launcher-app/src-tauri/tauri.conf.json": json.loads(read_text(WRAPPER_DIR / "launcher-app" / "src-tauri" / "tauri.conf.json"))[
            "version"
        ],
    }
    if args.tag is not None:
        versions[f"tag {args.tag} (stripped 'v')"] = args.tag.lstrip("v").lstrip("V")

    # Crates must inherit the workspace version so they cannot drift.
    for crate in ("wrapper", "launcher"):
        cargo = read_text(WRAPPER_DIR / crate / "Cargo.toml")
        if "version.workspace = true" not in cargo:
            print(f"FAIL: engine-wrapper/{crate}/Cargo.toml does not use version.workspace")
            return 1

    distinct = sorted(set(versions.values()))
    for name, version in versions.items():
        print(f"{version:>12}  {name}")
    if len(distinct) != 1:
        print(f"FAIL: version mismatch: {distinct}")
        return 1
    print(f"OK: single version {distinct[0]}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
