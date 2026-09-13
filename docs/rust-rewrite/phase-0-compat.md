# Phase 0 — Python / Node Wrapper Compatibility Inventory

Source of truth for the Rust rewrite. Verified against `engine-wrapper/engine_wrapper.py`,
`engine-wrapper/engine-wrapper.mjs`, `engine-wrapper/shutdown-coordinator.mjs`,
`shogihome/src/server/engine/list.ts`, `shogihome/src/server/engine/session.ts`,
and `shogihome/src/server/engine/auth.ts`.

Neither wrapper is canonical on its own. The table below fixes, per behavior,
what Rust must keep, which implementation to follow on conflict, and what is an
intentional change.

## 1. TCP contract

| # | Behavior | Python | Node | Rust decision |
|---|---|---|---|---|
| T1 | `list` returns one JSON line, flushes, then closes the connection | Yes (`engine_wrapper.py:195-201`) | Yes (`engine-wrapper.mjs:288-292`) | Keep. Server parses on socket `end` (`list.ts:98-133`). A Rust `list` that keeps the connection open breaks discovery. |
| T2 | `run <id>` plus legacy `research` / `game` aliases | Yes (`engine_wrapper.py:203-208`) | Yes (`engine-wrapper.mjs:295-306`) | Keep aliases unless explicitly deprecated in a later phase. |
| T3 | `run <id>\nusi\n` may arrive in a single TCP read | Buffered `readline` keeps remainder (`engine_wrapper.py:181-190`) | `readline` keeps remainder (`engine-wrapper.mjs:223`) | Keep. One buffered input stream must survive the auth → selection → relay transition. |
| T4 | After selection, every client line is engine input | Yes, raw bytes forwarded (`engine_wrapper.py:269-290`) | Yes, trimmed + UTF-8 (`engine-wrapper.mjs:227-243`) | Keep framing, but standardize the payload rule (see E3). |
| T5 | Unknown command / unknown engine id returns newline-terminated `WRAPPER_ERROR:` | Yes (`engine_wrapper.py:210-220`) | Yes (`engine-wrapper.mjs:301-313`) | Keep prefix and newline termination. Flush before close. |

## 2. Auth (CRAM-SHA256)

| # | Behavior | Python | Node | Rust decision |
|---|---|---|---|---|
| A1 | Challenge is `auth_cram_sha256 <32 hex chars>\n` (16 random bytes as hex) | `secrets.token_hex(16)` (`engine_wrapper.py:146`) | `crypto.randomBytes(16).toString('hex')` (`engine-wrapper.mjs:219`) | Keep wire format. |
| A2 | HMAC-SHA256 key is token UTF-8 bytes, message is the **hex nonce text** (not raw bytes) | `hmac.new(token.encode(), nonce.encode(), sha256)` (`engine_wrapper.py:159`) | `createHmac('sha256', token).update(nonce)` (`engine-wrapper.mjs:250`) | Keep. Both agree here. |
| A3 | Success is `auth_ok\n`; auth applies to both `list` and `run` | Yes (`engine_wrapper.py:145-179`) | Yes (`engine-wrapper.mjs:218-276`) | Keep. |
| A4 | Digest comparison strictness | String compare against lowercase hex (`engine_wrapper.py:162`) | Hex-decodes both sides first; accepts uppercase and may ignore some malformed suffixes (`engine-wrapper.mjs:251-256`) | Intentional change: strict 64-hex-char parse, fail closed. Record as hardening, not parity. |
| A5 | Behavior after auth failure | Closes after error line | Closes, ignores further buffered input (`engine-wrapper.mjs:270-275`) | Follow Node (fail closed, never spawn, never process buffered `run`). |
| A6 | No token configured | Server sends `list` / `run` immediately; wrapper skips the challenge | Same | Keep. |

Security note: HMAC authenticates the client only. It does not encrypt the later stream.

## 3. Encoding and stream direction

| # | Behavior | Python | Node | Rust decision |
|---|---|---|---|---|
| E1 | Engine output decoding is per complete line: strict UTF-8 first, then Japanese fallback, forward as UTF-8 | Strict `cp932`, final fallback UTF-8/replace (`engine_wrapper.py:68-95`) | Non-fatal `shift_jis` decoder, final fallback UTF-8 (`engine-wrapper.mjs:375-403`) | Keep the shape (UTF-8 → JP fallback → UTF-8 forward). Fix exact byte behavior with fixtures; do not assume `encoding_rs` label equality. Known divergence: Python strict-CP932 vs Node non-fatal Shift-JIS on malformed bytes and vendor extensions. |
| E2 | Engine stderr is forwarded to the TCP client like stdout | Yes (`engine_wrapper.py:292-295`) | Yes (`engine-wrapper.mjs:423-424`) | Keep. Do not reclassify stderr as wrapper errors. |
| E3 | Client → engine payload | Forwards received bytes unchanged (`engine_wrapper.py:287`) | Trims the line and re-emits UTF-8 (`engine-wrapper.mjs:239-240`) | Decide in Phase 1 with fixtures. Current plan: trim line terminators, reject CR/LF injection, forward UTF-8. This matches Node observably for normal USI but is recorded as a choice, not "Node is canonical for everything". |
| E4 | Engine stdin transcoding to CP932 | None | None | Do not add. Out of scope; would be a behavior change. |
| E5 | Unterminated final engine line | Dropped when the stream ends without `\n` (asyncio `readline` + task cancel) | Flushed on stream `end` (`engine-wrapper.mjs:415-420`) | Follow Node (flush trailing remainder). Needed so a final `bestmove` without newline is not lost. |
| E6 | Plan wording `encoding_rs (UTF-8→CP932)` | — | — | Correct to: decode engine bytes (UTF-8 → CP932/Shift-JIS fallback), encode to UTF-8 toward the server. Engine input stays UTF-8. |

## 4. Option injection

| # | Behavior | Python | Node | Rust decision |
|---|---|---|---|---|
| O1 | Configured options are inserted immediately before the **first** forwarded `isready`, exactly once | Yes (`engine_wrapper.py:267-284`) | Yes (`engine-wrapper.mjs:232-237`) | Keep. Fits server sequence `run → usi → usiok → options → isready → readyok` (`session.ts:533-557`). |
| O2 | Serialization `setoption name <name> value <value>\n`, booleans lowercase | Yes (`engine_wrapper.py:104-132`) | Yes (`engine-wrapper.mjs:43-80`) | Keep. |
| O3 | CR/LF in name/value is skipped, not escaped | Yes | Yes | Keep as a security boundary. |
| O4 | Null / composite values | `str(value)` (e.g. `None`, dict repr) | `String(value)` (e.g. `null`, `[object Object]`) | Define explicitly in Phase 1 (scalar-only schema). Do not silently inherit either stringification. |
| O5 | Runtime `setoption` after startup overrides the configured value | Yes, by not re-applying | Yes | Keep. Never re-apply on later `isready`. |
| O6 | Browser USI allowlist vs configured options | Browser validator allows only MultiPV (`relay_protocol.ts`); config injection allows arbitrary options | Same | Keep separate. Do not reuse the browser allowlist for config injection (`Threads`, `USI_Hash`, book paths must keep working). |

## 5. Process launch and cleanup

| # | Behavior | Python | Node | Rust decision |
|---|---|---|---|---|
| P1 | Wrapper shutdown on ordinary server stop is triggered by **TCP FIN**, not by `quit` | Relies on task completion after FIN, but only owns the direct child (`engine_wrapper.py:304-348`) | Explicit `end`/`close`/`error` → cleanup (`engine-wrapper.mjs:434-447`) | Follow Node: FIN/RST/write-failure/spawn-failure/engine-exit all route to one idempotent per-connection cleanup. |
| P2 | Cleanup sequence | `quit` → close stdin → 5s → `terminate` → 3s → `kill`, direct PID only | `quit` → close stdin → 5s → group `SIGTERM` (POSIX) / forced `taskkill /T` (Windows) → 3s → group `SIGKILL` | Follow Node for tree ownership; keep the 5s/3s timeouts as the starting point. Windows first escalation stays forced tree kill (document that it is not graceful). |
| P3 | POSIX process groups | No (`create_subprocess_exec` without group) | Yes, `detached` + negative-PID kill (`shutdown-coordinator.mjs:7-9,27-49`) | Follow Node. Required so `.bat`-equivalent shell launchers and grandchild engines die. |
| P4 | Windows `.bat` / `.cmd` | No explicit branch; direct spawn with `CREATE_NO_WINDOW` (`engine_wrapper.py:236-249`) | Explicit case-insensitive extension match, shell spawn, quoted path (`engine-wrapper.mjs:331-342`) | Follow Node for batch files only. Do not shell-spawn every executable. Preserve no-window behavior. |
| P5 | Relative engine path base and CWD | Resolved against wrapper dir; CWD is engine parent (`engine_wrapper.py:229-234`) | Same against `__dirname` (`engine-wrapper.mjs:324-329`) | Keep. With an explicit `--config-dir` in Rust so sidecar layout changes do not break relative paths. |
| P6 | Standalone signals | `KeyboardInterrupt` only (`engine_wrapper.py:383-387`) | `SIGINT` + `SIGTERM` with 10s coordinator deadline (`engine-wrapper.mjs:471-498`, `shutdown-coordinator.mjs:51-124`) | Follow Node for standalone; additionally define the forced-parent-death path (launcher `taskkill /F /T`, POSIX SIGKILL) where no handler runs. Signal handlers alone do not solve sidecar cleanup. |
| P7 | Engine probe (`config_editor.py`) owns only the direct child, pipes stderr without draining, unbounded stdout queue | Yes (`config_editor.py:228-322`) | N/A | Do not port as-is. Phase 2 gives probes cancellation, bounded output, concurrent stdout/stderr drain, and tree cleanup. |

## 6. Config surface carried by `list`

- Both wrappers return the **full** `engines.json` array; the server strips private fields and extracts `skipAnalysisDB` / DB group metadata (`list.ts:21-55,101-120`, `session.ts:429-460`).
- Rust must preserve unknown fields, entry order, duplicate-ID behavior (explicit decision), and legacy `type` forms (`"both"`, string, array, absent).
- Both wrappers reload `engines.json` per request, not only at startup (`engine-wrapper.mjs:21-36,284-308`, `engine_wrapper.py:52-65,193`).

## 7. Intentional changes (not parity bugs)

1. Strict 64-hex-char auth digest parsing (Node is lenient).
2. Trailing engine line flush on EOF (Python drops it).
3. Client→engine line normalization + CR/LF rejection (Python forwards raw).
4. Scalar-only option value schema (both stringify arbitrarily today).
5. `--config-dir` resolution instead of implicit script-dir-only config.
6. Existing bugs to fix, not preserve: boolean `load_env_value` int-check (`common.py:71`), `server_settings` vs server validator mismatches, editor `innerHTML` injection path, probe stderr deadlock risk.

## 8. Open items for Phase 1 fixtures

- Exact malformed-byte mapping table (CP932 extensions, lone `0xFF`, split multibyte reads, mixed UTF-8/CP932 lines, BOM, CRLF).
- Null/composite option policy.
- Duplicate engine IDs, malformed schema, unknown-field retention.
- Spaces / Japanese / shell metacharacters in Windows engine paths.
