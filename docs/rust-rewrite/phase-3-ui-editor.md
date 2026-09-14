# Phase 3 — Launcher UI and Config Editor

## 1. Layout (`engine-wrapper/launcher-app/`)

```text
launcher-app/
├── package.json            # Vanilla TS + vite + vitest; tauri CLI via npx in Phase 4
├── vite.config.ts / tsconfig.json
├── src/
│   ├── index.html          # dashboard (status, QR, controls, dialogs)
│   ├── editor.html         # config editor 2nd window
│   ├── styles.css          # ported editor styles + dashboard
│   ├── main.ts / editor-main.ts
│   ├── api.ts              # typed invoke bindings
│   ├── i18n.ts             # full ja/en port (launcher + editor.*)
│   ├── dashboard.ts        # status/QR/settings dialog/logs/update/migration
│   ├── editor.ts           # editor DOM wiring (textContent only, no innerHTML)
│   └── editor-state.ts     # pure registry/group/option logic (vitest)
├── src-tauri/
│   ├── Cargo.toml          # EXCLUDED from workspace; built on Windows (Phase 4)
│   ├── tauri.conf.json     # CSP only; initial windows are created in setup per launch mode
│   ├── capabilities/       # plugin permissions per window
│   ├── build.rs
│   └── src/main.rs         # commands, tray, launch modes, close/exit policy
├── ../launcher/src/launch_mode.rs  # --config-editor / --config-dir parsing + config-dir resolution
```

## 2. Security and lifecycle decisions

- Window isolation is enforced in Rust (`permissions::is_command_allowed`,
  unit-tested): the editor window can only touch the engine registry and
  probes; the dashboard can never do so. Capabilities grant only plugin
  permissions (`dialog:allow-open`, `dialog:allow-message`, and
  `opener:allow-open-url` with explicit HTTP/HTTPS scopes).
- CSP: `default-src 'self'`, scripts `self` only, images `self/data/blob`.
- No `innerHTML` built from configuration data anywhere; badges, rows, and
  toasts use `textContent` + `addEventListener`.
- Probes: backend-owned with timeouts, bounded output, concurrent stderr
  drain, tree kill, and cancellation flags. The UI tracks a probe sequence
  so stale completions are discarded; `beforeunload` and editor-window
  close cancel running probes (backend also cancels on window destroy).
- Probe stdout uses a bounded queue and bounded line reads; stderr is drained
  as fixed-size byte chunks. POSIX process groups / Windows Jobs are swept
  even after the leader exits normally, before joining the pipe pumps.
  Probe registrations are removed on both success and failure; application
  exit waits for cancelled probes to finish cleanup.
- Probe merges go through the backend `editor_refresh` command as the
  single source of truth: current values win, manual entries the engine no
  longer advertises are kept (old UI dropped them).
- Main-window close hides to tray; `stop_and_exit` sets the quitting flag,
  stops services, then exits. Tray creation failure leaves the dashboard
  visible instead of an unreachable hidden app.
- Launch modes: default creates the `main` window + tray + health polling;
  `--config-editor [--config-dir DIR]` creates only the `editor` window with
  no services, no tray, and no dashboard init. `tauri.conf.json` keeps
  `windows: []`; `setup` owns initial-window creation so hidden-dashboard
  startup can never auto-start services in editor mode.
- Editor shutdown is `Running → Closing → ReadyToExit`: `Closing` rejects
  new probes and holds every exit request while a single drain waiter runs;
  only a drained probe set exits 0, deadline expiry exits 1 (never confused
  with a clean shutdown). The budget matches `stop_and_exit`.
- Edit sessions hold a per-config-dir OS-managed lock (`session_lock`:
  Unix `flock`, Windows share-mode-0; auto-released on crash). Launcher and
  standalone editors on the same registry never last-writer-win each other;
  same-process reopen reuses the held lock, and the lock releases after
  probe cleanup drains. `stop_and_exit` keeps its abort-on-timeout contract.
- CLI validation: `--config-dir` requires `--config-editor` (an editor
  pointed elsewhere would save settings the supervised wrapper never
  reads); a following flag is a missing value, never a directory.
- Editor `--config-dir` matches the wrapper meaning (registry location,
  relative-path and probe base; default `<exe-dir>/engine-wrapper`).
  `engines.json` saves use a per-process unique tmp file + atomic rename.
- The editor is created on demand by the **async** `open_editor` command.
  Creating a WebView in a synchronous IPC handler deadlocks on Windows
  ([upstream issue](https://github.com/tauri-apps/wry/issues/583)), leaving
  a blank native window and preventing both windows from responding.
  `editor_browse` is also async and runs `blocking_pick_file` through
  `spawn_blocking`; neither the UI event loop nor an async executor thread
  waits for the user to dismiss the native file picker.
- Services spawn via the backend with explicit paths (no shell), keeping
  Windows suspended-spawn → Job → resume in `process-wrap` without using
  the shell plugin for services.
- WebView2: not bundled; startup failure prints the official download URL
  (portable ZIP has no installer bootstrap). Manual clean-VM check in
  Phase 4.

## 3. Verification (Linux)

- `cargo test -p shogihome-launcher`: 39 passed (editor parser/validation/
  probe incl. cancel, network URL selection, permissions isolation).
- Frontend `tsc --noEmit` clean; `vitest`: 9 passed (registry/groups/
  options/i18n).
- `src-tauri` is NOT compiled here (needs WebView system libs); it is
  excluded from the Cargo workspace and gets its first build on Windows
  in Phase 4. Its Tauri API usage follows the v2 window/tray/event
  patterns; review checklist lives in §4.

## 4. Phase 4 entry checklist (Windows)

- `cargo build` + `npx tauri build` for `launcher-app/src-tauri`.
- Contract suite against a Windows wrapper build (`.bat` path), plus the
  Rust-only `.env` autoload case (file supplies `LISTEN_PORT` with the
  environment absent).
- Tray hide/show, Stop&Exit descendant check, editor probe cancel on
  window close, standalone `--config-editor` (custom `--config-dir` with a
  space, no server bundle, service IPC blocked, single CDP page,
  in-flight probe cancelled with `quit` delivered, window close exits 0,
  saved registry readable back through `wrapper --config-dir`),
  `ConfigEditor.cmd` entry point, WebView2-absent guidance on a clean VM.
- `tauri.conf.json` bundle resources: Node runtime, server bundle,
  Vision assets, webapp, `.env`/engines seeds, licenses (see
  `phase-0-baseline.md` §4).

## 5. Windows GUI regression

After building the Windows wrapper (`cargo build -p shogihome-engine-wrapper`)
and launcher (`npx tauri build --no-bundle` from `launcher-app/`), run from
`engine-wrapper/` in PowerShell:

```powershell
$env:SHOGIHOME_GUI_EXE = (Resolve-Path "launcher-app/src-tauri/target/release/ShogiHomeLab.exe").Path
uv run --with playwright pytest tests/test_launcher_gui.py -q
```

`SHOGIHOME_GUI_WRAPPER_EXE` can override `target/debug/shogihome-wrapper.exe`.
The test needs Node.js on PATH and the installed WebView2 runtime; Playwright
attaches to WebView2, so no separate browser download is needed. Without Windows
and `SHOGIHOME_GUI_EXE`, the ordinary Python test suite skips this test.

The test copies the executables to a temporary portable layout with an empty
registry, a minimal Node TCP readiness server, unique ports, and isolated
WebView2 storage. CDP is enabled only in the test child's environment. It checks:

- Opening the editor through the dashboard renders its controls.
- Opening the native file picker leaves dashboard status IPC responsive.
- Cancelling the picker and posting native `WM_CLOSE` closes the editor.
- Reopening the editor renders its controls again.
- Stop&Exit terminates the launcher successfully while the editor is open.

`test_config_editor_standalone_mode` covers the no-server layout in two cases:
explicit `--config-editor --config-dir "<tmp>/my config"` from an unrelated
CWD, and the shipped `ConfigEditor.cmd` with the default `<exe-dir>/
engine-wrapper` layout. It checks editor-only rendering (exactly one CDP
page, `editor.html`, no dashboard controls), the custom config-dir registry,
blocked service IPC (`get_status` rejected), an in-flight probe cancelled
with `quit` delivered to the engine child, process exit 0 on window close,
and the saved registry reading back through `wrapper --config-dir`.

The GUI driver runs in a separate process with a hard deadline and process-tree
cleanup, so a native deadlock fails the test instead of hanging CI indefinitely.
The Windows CI job runs this test after building the Tauri executable.
