# Agent Guidelines for ShogiHome Lab

ShogiHome Lab consists of a Vue frontend, a Node.js middle server, a Rust engine wrapper, and a Tauri launcher.
See [ARCHITECTURE.md](ARCHITECTURE.md) for the system map and module ownership. Detailed subsystem documents are under `docs/architecture/`.

## Development Commands

Run commands from the indicated directory.

### Web Server & Frontend (`shogihome/`)

- Start: `npm run server:start`
- Build: `npm run build`
- Lint and type-check: `npm run lint`
- Test: `npm run test`

### Engine Wrapper (`engine-wrapper/`)

- Start (Rust): `cargo run -p shogihome-engine-wrapper -- --config-dir .`
- Lint: `cargo clippy --all-targets`
- Format: `cargo fmt --check`
- Test: `cargo test` (server configuration and saved-value round-trip tests require Node.js; Unix editor-lock tests require Python 3)
- Contract tests (Rust wrapper): `python -m pytest tests/test_wrapper_contract.py` (requires `pip install pytest`)
- GUI/CLI/runtime tests: `python -m pytest tests/test_launcher_gui.py tests/test_launcher_cli.py tests/test_server_runtime.py` (requires `pip install pytest playwright` and `SHOGIHOME_GUI_EXE`)

## Project Rules

- Use the Composition API with `<script setup>` for new Vue components.
- Write concise code comments in English.
- Verify changes with checks appropriate to their scope and risk; add or update tests when they provide meaningful coverage of changed behavior.
- Keep complex state and business logic out of UI components and in the appropriate store or domain module.
- Preserve the enforced boundaries between `src/renderer/`, `src/common/`, `src/node/`, and `src/server/`.
- Keep the USI state machine in `src/server/engine/session.ts`. Engine wrappers should remain process/TCP bridges and must not own session state.
- At WebSocket, TCP, USI, SFEN, and file-system boundaries, use the existing decoders and validators rather than bypassing them.
- Put user-visible messages in `src/common/i18n/` resources instead of hardcoding them.

## Documentation Rules

- Keep `ARCHITECTURE.md` limited to system structure, ownership, dependency/trust boundaries, and cross-module invariants.
- Use `docs/architecture/` for subsystem design, lifecycle, and key contracts; omit exhaustive specifications evident from code and tests.
- Use `docs/features/` only for non-obvious rationale, trade-offs, non-goals, and decision criteria. Do not create a document when no such explanation is needed.
- Link to code and tests instead of duplicating implementation details, schemas, defaults, limits, or verification reports.
- Update only the documentation layers whose design or intent changed. Avoid duplicating detailed content across documents.

## Version Control

- When creating a commit, use a prefix such as `feat:`, `fix:`, `docs:`, `style:`, `refactor:`, `test:`, or `chore:`.
- Keep the versions in `shogihome/package.json`, `engine-wrapper/Cargo.toml`, `engine-wrapper/launcher-app/package.json`, and `engine-wrapper/launcher-app/src-tauri/tauri.conf.json` synchronized (checked by `engine-wrapper/scripts/check_versions.py`).
