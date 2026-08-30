# Agent Guidelines for ShogiHome Lab

ShogiHome Lab consists of a Vue frontend, a Node.js middle server, and Python/Node.js engine wrappers.
See [ARCHITECTURE.md](ARCHITECTURE.md) for the system map and module ownership. Detailed subsystem documents are under `docs/architecture/`.

## Development Commands

Run commands from the indicated directory.

### Web Server & Frontend (`shogihome/`)

- Start: `npm run server:start`
- Build: `npm run build`
- Lint and type-check: `npm run lint`
- Test: `npm run test`

### Engine Wrapper (`engine-wrapper/`)

- Start: `uv run engine_wrapper.py`
- Lint: `uv run ruff check .`
- Format: `uv run ruff format .`
- Test: `uv run pytest`

## Project Rules

- Use the Composition API with `<script setup>` for new Vue components.
- Write concise code comments in English.
- Add or update tests for behavior changes. For bug fixes, add a regression test that reproduces the problem before applying the fix.
- Keep complex state and business logic out of UI components and in the appropriate store or domain module.
- Preserve the enforced boundaries between `src/renderer/`, `src/common/`, `src/node/`, and `src/server/`.
- Keep the USI state machine in `src/server/engine/session.ts`. Engine wrappers should remain process/TCP bridges and must not own session state.
- At WebSocket, TCP, USI, SFEN, and file-system boundaries, use the existing decoders and validators rather than bypassing them.
- Put user-visible messages in `src/common/i18n/` resources instead of hardcoding them.
- Update `ARCHITECTURE.md` and the relevant `docs/architecture/` document when changing architecture, protocols, or module responsibilities.

## Version Control

- When creating a commit, use a prefix such as `feat:`, `fix:`, `docs:`, `style:`, `refactor:`, `test:`, or `chore:`.
- Keep the versions in `shogihome/package.json` and `engine-wrapper/pyproject.toml` synchronized.
