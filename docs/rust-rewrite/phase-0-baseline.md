# Phase 0 — Baseline and Distribution Inventory

Measured 2026-09-14 on Linux (dev machine, not a Windows release build).
Rerun: `uv run python engine-wrapper/scripts/measure_phase0_baseline.py`.
Windows release numbers must be measured separately on the release artifact.

## 1. Versions (found)

| Source | Version |
|---|---|
| `engine-wrapper/pyproject.toml` | 1.20.0 |
| `shogihome/package.json` | 1.20.0 |
| `engine-wrapper/package.json` (Node wrapper) | 1.5.0 (stale, do not inherit) |

Release tag → `engine-wrapper/VERSION` is derived independently in
`release.yml:75-80`; no tag↔package equality check exists. Phase 4 must add
one version authority covering Cargo, Tauri, npm, and the tag.

## 2. Sizes (this machine)

| Item | Bytes |
|---|---|
| 10 wrapper/launcher/editor sources (py/mjs/html) | 174,651 (~0.17MB source text) |
| `engine-wrapper/` dir total | 171,539,848 (~164MB, includes `.venv*`, `__pycache__`, `logs` — dev only, not release payload) |
| `shogihome/dist/` (built output present in this checkout) | 229,441,228 (~219MB) |

The `engine-wrapper/` dir number is **not** the release payload. Release
payload sizing must happen on the assembled ZIP (see §4). The full size
comparison (Rust vs current) is only meaningful on Windows release artifacts
with identical Node runtime, assets, and compression.

## 3. Wrapper cold start, this machine (empty engines.json, loopback)

| Impl | Time to listen | Wrapper RSS alone (0.5s after ready) |
|---|---|---|
| Python (`engine_wrapper.py`, venv 3.13) | 0.052s | ~25MB |
| Node (`engine-wrapper.mjs`, Node v26) | 0.051s | ~55MB |

Scope notes:

- This is dev-interpreter startup on Linux, not embedded-Python or release
  startup on Windows. The launcher + service-ready path (Tk/dashboard,
  server DB/index work, port checks) is an order of magnitude above these
  numbers and is the quantity the "<100ms" claim must be scoped against.
- RSS is the wrapper process only. Launcher GUI, Node server, Vision/ONNX,
  WebView2, and external engines are separate consumers and must be reported
  separately in Phase 4.
- Takeaway for the plan: wrapper-listen startup is already tens of ms here;
  the rewrite's startup win is in removing the embedded-Python/Tk/.NET chain
  for the launcher, not in making an already-fast listener faster.

## 4. Release inventory (must survive the Tauri migration)

From `.github/workflows/release.yml:92-126` and build scripts:

- `ShogiHomeLab.exe` (C# shim, to be replaced) + `icon.png` + `README.txt`
- `shogihome/`: renamed plain-Node `shogihome-server.exe` (NOT a SEA),
  `dist/server/server.js`, `dist/server/node-worker/`, ONNX/WASM + models,
  `docs/webapp` (frontend, puzzle manifest, PWA, licenses), `.env` seed
- `engine-wrapper/`: embedded Python dir, `launcher.py`,
  `engine_wrapper.py`, `config_editor.py`, `config_editor.html`, `common.py`,
  `i18n.py`, `update_checker.py`, `VERSION`, `engines.json` seed, `.env`
  seed, `licenses/`
- Known gap found in Phase 0: `server_settings.py` is imported by
  `launcher.py:18-32` but missing from the copy allowlist
  (`release.yml:110-113`). Phase 4 artifact validation must boot the
  assembled package without repo files to catch this class of defect.

Tauri replacement must still ship: Node runtime + server bundle + Vision
assets + webapp + both `.env` seeds + engine defaults + editor UI + full
license set (project, Rust/Tauri native deps, launcher npm deps, retained
server/browser deps, exact Node runtime, models/icons). `cargo-about` (or
equivalent) covers only the Rust side; the npm and model/icon pipelines stay.
