# Phase 0 — Test / Contract Mapping

What the existing suites actually cover, and what the new black-box contract
suite (`engine-wrapper/tests/test_wrapper_contract.py`) must cover before the
old implementations can be deleted.

## 1. Existing coverage (read, not assumed)

| Suite | Covers | Does not cover |
|---|---|---|
| `engine-wrapper/tests/test_wrapper.py` | `get_engine_list()` for missing / valid / invalid JSON | Reload timing, metadata preservation, relative-path base, duplicate IDs, unknown fields |
| `engine-wrapper/tests/test_encoding.py` | `pipe_stream()` UTF-8 and CP932 happy paths | Exact malformed-byte output, split multibyte reads, mixed encodings, BOM/CRLF, unterminated final line, stdout/stderr parity |
| `engine-wrapper/tests/test_logic.py` | `apply_engine_options()` command text; `parse_usi_option_line()` shapes | Real first-`isready` timing, exactly-once, runtime override precedence, CR/LF rejection over the wire, null/composite policy |
| `engine-wrapper/tests/test_config_editor.py` | `Api.save()` validation and `"both"` conversion (mocked file write) | Load-path validation, real file behavior, `analyze()` probe lifecycle, frontend behavior |
| `engine-wrapper/tests/test_common.py`, `test_server_settings.py`, `test_migration.py`, `test_update_checker.py`, `test_network.py`, `test_i18n.py` | Env upsert/merge, settings load/validate, migration selection, update selection, PC-URL selection, translations | Launcher lifecycle, tray, Job Object, probe supervision, `.env` parser equivalence with Node `process.loadEnvFile`, linked-settings atomicity |
| `engine-wrapper/tests/shutdown-coordinator.test.mjs` | Process/group/taskkill decision logic with injected fns | Real child/grandchild termination, batch-first-exit, blocked stdin, FIN/RST, repeated signals, parent force-kill |
| `shogihome/src/tests/server/engine_protocol.spec.ts` | Real server against a **mock** TCP wrapper, auth disabled | Real wrapper compatibility, auth handshake, option injection, output drain |
| `shogihome/src/tests/server/engine_auth.spec.ts`, `engine_start_cancel.spec.ts` | Auth timeout; startup cancellation against a non-verifying mock | Successful HMAC exchange, wrong token, replay/malformed digest, disconnect during spawn without orphans |

Key correction from the original plan: `test_network.py` tests launcher URL
selection (`get_pc_url_config`), not the TCP relay. `relay_protocol` tests cover
the browser↔server WebSocket JSON, not the server↔wrapper TCP text protocol.

## 2. New black-box contract suite (Phase 0)

`engine-wrapper/tests/test_wrapper_contract.py` runs the same scenarios against
each implementation through the `WRAPPER_CMD` environment variable:

- `python` — `uv run python engine_wrapper.py` equivalent on an ephemeral port
  with an isolated config dir (achieved by copying the wrapper sources).
- `node` — `node engine-wrapper.mjs` on an ephemeral port with the same isolation.
- `rust` — Rust wrapper via `--config-dir` (wired in Phase 1; builds the
  binary on demand). Tests must pass unchanged against the Rust binary
  except for documented intentional differences in `phase-0-compat.md`.

Scenarios:

| ID | Scenario | Why |
|---|---|---|
| C1 | `list` returns the configured array and closes (server sees EOF) | Regression for discovery hanging when FIN is missing |
| C2 | `run <id>` + pipelined `usi` in one write reaches the engine | Startup coalescing (`session.ts` sends `run` then `usi` immediately) |
| C3 | Configured options are injected once before first `isready` | Startup ordering + runtime override precedence |
| C4 | Unknown engine id returns `WRAPPER_ERROR` and no engine spawns | Error contract |
| C5 | Auth enabled: wrong token is rejected, buffered `run` is not processed | Fail-closed handshake |
| C6 | Auth enabled: correct HMAC completes `list` | Wire-format compatibility (hex-nonce HMAC) |
| C7 | Client FIN stops the engine process tree (fake engine exits promptly) | Ordinary server `stopEngine` path uses `socket.end()` |
| C8 | CP932 engine output arrives as UTF-8 | Japanese engine compatibility |

C8 uses a fake-engine command (`test_cp932`) that emits CP932 bytes; the
client asserts the UTF-8 decoded text. Malformed-byte exact mapping stays in
Phase 1 fixtures.

## 3. Phase 1+ gates (not in Phase 0)

- Fragmented handshake bytes (1-byte writes) and multi-connection concurrency.
- Exact malformed-byte table, split multibyte sequences, mixed encodings, BOMs.
- `quit`-ignoring engines and grandchild reaping on Windows and POSIX.
- Forced parent death (no handler runs) vs graceful standalone shutdown.
- Config reload between requests, duplicate IDs, unknown-field retention.
- Real server → real wrapper → fixture engine E2E with auth enabled.
- Assembled-ZIP smoke (no repo files, no dev runtimes): server, wrapper,
  Vision/models, webapp, settings persistence, migration, clean shutdown.
