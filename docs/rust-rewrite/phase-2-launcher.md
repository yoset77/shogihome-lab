# Phase 2 — Launcher Backend (`shogihome-launcher`)

UI-agnostic Rust library: supervision, service management, settings,
migration, logs, update checks. The Tauri command/window layer binds to it
in Phase 3; the UI never spawns processes or writes config directly.

## 1. Modules (`engine-wrapper/launcher/src/`)

| Module | Responsibility |
|---|---|
| `supervisor.rs` | Serialized lifecycle (`Stopped/Starting/Running/Stopping/Failed/Quitting`) with generations, per-service status, partial-start failure tracking, stale-completion rejection |
| `controller.rs` | Serialized start/stop/restart/migration, short-lived status snapshot locks, startup rollback and background crash detection; blocking operations run outside Tauri's event loop |
| `service.rs` | Portable service plans, separately decoded server/wrapper environments, shared spawn/readiness configuration, log-file output and port+alive readiness |
| `process.rs` | Retained POSIX process group / Windows Job Object ownership, leader-only wait and cleanup after normal leader exit |
| `env_codec.rs` | BOM/UTF-8/CP932 decode, dotenv parse, cross-parser value formatting with round-trip verification, comment-preserving atomic upsert with dedup, smart merge |
| `settings.rs` | `server_settings.py` schema port (14 settings), load with linked-mismatch report, same validation codes, atomic two-file save with rollback |
| `migration.rs` | Old-root resolution (ZIP nesting tolerant), preview plan, staged data copy, atomic engines.json, env merges, resumable completion record |
| `logs.rs` | One-generation rotation, 1 MiB viewer cap |
| `update.rs` | `packaging`-subset version compare (legacy `1.17.0a0` == `1.17.0-alpha.0`), release selection with prerelease-channel rule, snooze cache (ISO-8601 legacy tolerant), 5s GitHub fetch via ureq |

## 2. Deliberate fixes over the old code

- Boolean settings with `False` defaults read `"true"` correctly (bool
  checked before int in `env_codec::load_env_value`).
- Linked settings (`LISTEN_PORT`/`REMOTE_ENGINE_PORT`, tokens) save
  atomically with first-file rollback; existing mismatches are reported
  instead of hidden.
- POSIX tree stop uses process groups (old code signalled only the root).
- Migration records completion, so a failed run resumes instead of never
  offering again; data copy is staged (`data.tmp` + rename).
- The dashboard awaits migration before starting services. Incomplete records
  keep migration available even after `data` has been published; startup is
  rejected while a migration is pending. Migration and service transitions
  share the controller's operation lock. The editor window is created lazily
  so it cannot cache pre-migration registry contents.
- Service `.env` values override inherited environment values independently
  for server and wrapper, including their distinct bind addresses. Readiness
  checks use the same configuration snapshot as child creation.
- Update IPC uses the bundled-version/cache entry point, including persisted
  snooze rules. PC and LAN/QR URLs are separate; loopback and strict modes
  do not expose a LAN QR code.
- Upsert dedups later active duplicates and prefers active over commented
  definitions (matches current `common.py`, pinned by ported tests).

## 3. Verification (Linux)

- `cargo test -p shogihome-launcher`: 31 unit + 1 integration test.
- `tests/env_parity.rs` formats 9 special values and reads them back
  through the real `node:util parseEnv` and python-dotenv — all identical.
- `cargo clippy --all-targets` clean, `cargo fmt --check` clean.

## 4. Not in this phase

- Tauri commands, windows, tray, and the Vanilla TS UI (Phase 3).
- Windows execution of service spawn/stop and `.env` paths with drive
  letters beyond the parity-tested values.
- Graceful (non-kill) service shutdown — a separate integration contract;
  current behavior stays force-stop, matching the old launcher.
- Live GitHub fetch test (network); selection/cache logic is tested with
  injected payloads.
