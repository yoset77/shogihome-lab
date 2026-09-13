# Phase 1 — Rust Wrapper (`shogihome-wrapper`)

Standalone TCP relay replacing `engine_wrapper.py` / `engine-wrapper.mjs`.
Old implementations are untouched; the Rust binary runs side by side via
`--config-dir` and the same `BIND_ADDRESS` / `LISTEN_PORT` /
`WRAPPER_ACCESS_TOKEN` environment.

## 1. Layout

```text
engine-wrapper/
├── Cargo.toml              # workspace (members: wrapper; excludes rust-poc)
├── Cargo.lock
└── wrapper/
    ├── Cargo.toml          # bin shogihome-wrapper, version 1.20.0 (matches pyproject)
    └── src/
        ├── main.rs         # CLI/env, listener, JoinSet sessions, SIGINT/SIGTERM + 10s deadline
        ├── relay.rs        # auth → command → list/run → single-loop relay → cleanup
        ├── process.rs      # spawn (POSIX setsid groups, Windows .bat via cmd + CREATE_NO_WINDOW)
        ├── config.rs       # per-request engines.json reload, Value-preserving entries, option format
        ├── encoding.rs     # per-line UTF-8 → CP932 fallback → UTF-8 forward
        └── auth.rs         # CRAM-SHA256, strict 64-hex digest, constant-time compare
```

Dependencies: `tokio`, `encoding_rs`, `hmac`, `sha2`, `subtle`, `rand`,
`serde_json` (preserve_order), `libc` (unix only).

## 2. Decisions (relative to `phase-0-compat.md`)

- Relay runs in one task with a single stdin/socket write owner: no output
  interleave, no cancelled-task output loss; terminal engine output is
  drained after `wait()` before closing.
- Engine stdin stays open through the relay loop so cleanup delivers `quit`
  first (closing stdin early let engines exit on EOF without seeing `quit` —
  caught by contract test C7).
- After the leader is reaped, cleanup sweeps the process group (SIGKILL) so
  backgrounded grandchildren cannot leak on normal exits either — matches
  Node's engine-close group kill.
- Null/composite option values are skipped with a warning (not stringified).
- Client→engine lines are trimmed and re-emitted as UTF-8 with `\n`
  (Node behavior); CR/LF-bearing option names/values are rejected.

## 3. Verification (Linux)

- `cargo test`: 11 unit tests (encoding, HMAC known-vector `token`/`abc`
  cross-checked against Python hashlib, options, config);
  `cargo clippy --all-targets` clean; `cargo fmt --check` clean.
- Contract suite (`WRAPPER_CMD=rust`, also wired into default `all`):
  list+EOF, pipelined run+usi, once-only option injection, unknown engine,
  auth fail-closed / success, FIN stops engine, CP932→UTF-8 — 8/8 pass.
- Real server E2E (server.ts + Rust wrapper + fake engine, auth disabled):
  engine list, `usiok`/`readyok`, state ready, `engine is ready`,
  `stop_engine` → stopped; engine log shows
  `usi → setoption name Threads value 4 → isready … quit`.
- Stray reaping: quit-ignoring shell engine with backgrounded `sleep 300`
  leaves no survivors after FIN.
- Full `uv run pytest` (162), `ruff check`, `ruff format --check`,
  `npm run test:node` all pass.

## 4. Not yet covered (Windows / later phases)

- Windows `.bat`/`.cmd` shell spawn, `CREATE_NO_WINDOW`, and
  `taskkill /T /F` paths are implemented but compiled out on Linux —
  needs a Windows run of the contract suite.
- `taskkill /T` cannot resolve a tree from a dead PID, so post-exit stray
  sweep is best-effort on Windows; full containment needs the Phase 2
  launcher Job Object design (`phase-0-poc.md` §3).
- Fragmented (1-byte) handshakes, concurrent sessions under load, and
  `quit`-ignoring native engines are covered by design but not yet by
  automated tests; exact malformed-byte fixtures remain per
  `phase-0-compat.md` §8.
