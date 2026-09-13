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
│   ├── tauri.conf.json     # main + singleton editor windows, CSP, externalBin wrapper
│   ├── capabilities/       # plugin permissions per window
│   ├── build.rs
│   └── src/main.rs         # commands, tray, close/exit policy
```

## 2. Security and lifecycle decisions

- Window isolation is enforced in Rust (`permissions::is_command_allowed`,
  unit-tested): the editor window can only touch the engine registry and
  probes; the dashboard can never do so. Capabilities grant only plugin
  permissions (`dialog:allow-open`, `opener:allow-open-url`).
- CSP: `default-src 'self'`, scripts `self` only, images `self/data/blob`.
- No `innerHTML` built from configuration data anywhere; badges, rows, and
  toasts use `textContent` + `addEventListener`.
- Probes: backend-owned with timeouts, bounded output, concurrent stderr
  drain, tree kill, and cancellation flags. The UI tracks a probe sequence
  so stale completions are discarded; `beforeunload` and editor-window
  close cancel running probes (backend also cancels on window destroy).
- Probe merges go through the backend `editor_refresh` command as the
  single source of truth: current values win, manual entries the engine no
  longer advertises are kept (old UI dropped them).
- Main-window close hides to tray; `stop_and_exit` sets the quitting flag,
  stops services, then exits. Tray creation failure leaves the dashboard
  visible instead of an unreachable hidden app.
- Services spawn via the backend with explicit paths (no shell), keeping
  the suspended-spawn → Job → resume option open for Phase 4 without
  fighting the shell plugin (which is therefore not used for services).
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
- Contract suite against a Windows wrapper build (`.bat` path).
- Tray hide/show, Stop&Exit descendant check, editor probe cancel on
  window close, WebView2-absent guidance on a clean VM.
- `tauri.conf.json` bundle resources: Node runtime, server bundle,
  Vision assets, webapp, `.env`/engines seeds, licenses (see
  `phase-0-baseline.md` §4).
