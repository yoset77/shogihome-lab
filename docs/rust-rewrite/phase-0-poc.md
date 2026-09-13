# Phase 0 — Windows / Tauri PoC Results

## 1. Verified on Linux (automated)

`engine-wrapper/rust-poc` (`cargo test`, 7 tests) covers the launcher logic
that does not need Windows or WebView:

| Item | Result |
|---|---|
| Supervisor `Stopped / Starting / Running / Stopping / Failed / Quitting` with generation guard | Pass. Exit-during-startup, double-start rejection, failed-start recovery, restart-during-startup all tested |
| `resolve_config_dir` (explicit `--config-dir` or exe dir, never implicit CWD) | Pass |
| `.env` decode fallback UTF-8 BOM → UTF-8 → CP932 (Shift-JIS) → lossy | Pass, including a raw CP932 byte case |
| Tauri `externalBin` sidecar source naming (`<base>-<triple>[.exe]`, suffix stripped at install) | Pass |

Run: `cargo test` in `engine-wrapper/rust-poc`.

## 2. Tauri integration design (not yet executed — needs Windows)

No Tauri app is scaffolded in Phase 0. The binding contract for Phase 2/3:

- **Windows**: main window `CloseRequested` → prevent close + hide to tray.
  Editor window close → dirty-check, cancel probes, then destroy the window.
  `RunEvent::ExitRequested` → `prevent_exit()` only while resident or while
  the supervisor is `Starting/Stopping`; the explicit Stop&Exit flow lets the
  final exit proceed after supervisor reports `Stopped`.
- **Commands/capabilities**: per-window command allowlists. The editor window
  gets config read/write + probe commands; only the main window gets service
  start/stop, update-check open-URL, and file-browse. No generic shell or
  arbitrary-file-write command is exposed to any WebView.
- **Sidecar spawn**: Tauri `externalBin` + shell plugin covers placement and
  lookup, but **not** race-free Job Object assignment. The shell plugin has no
  suspended-creation option, so Phase 2 must either spawn managed services via
  its own supervised `Command` (suspended → assign to Job → resume) or prove
  that assign-after-spawn leaves no observable escape window under the real
  engine set. This is the top Windows verification item; it cannot be closed
  on Linux.
- **Services**: Node server stays a bundled runtime (renamed plain Node +
  `server.js` argument + CWD), not a sidecar in the Tauri sense. The wrapper
  is the `externalBin` sidecar and additionally remains a standalone binary.

## 3. Job Object verification plan (Windows, Phase 2 entry)

1. Spawn a test tree (batch launcher → child → grandchild) suspended, assign
   to a kill-on-close Job, resume.
2. Kill the Job and assert no descendants survive (tool: `tasklist` / WMI).
3. Repeat with the parent killed first (batch-first-exit edge).
4. Repeat for Stop&Exit during `Starting` (stale spawn must be contained).
5. Repeat for probe cancellation and editor-window close mid-probe.
6. Negative control: external browser / unrelated processes untouched.

## 4. WebView2 fallback (portable ZIP decision)

Decision: no runtime bundling; on missing WebView2 show a native (non-WebView)
message box pointing at the official Microsoft download page.

- ZIP distribution cannot rely on installer `webviewInstallMode`
  (`downloadBootstrapper` / `offlineInstaller` are installer features and add
  ~1.8MB / ~127MB respectively; `fixedRuntime` adds ~180MB).
- Therefore the launcher must detect WebView2 absence at startup **before**
  creating any WebView and fall back to `MessageBoxW` (or equivalent) with the
  download guidance. This path is Windows-only and is a manual acceptance item:
  run the ZIP build on a VM without WebView2, confirm the guidance appears and
  no silent no-op launch occurs.
- No silent download-and-execute of runtimes is added in this migration.

## 5. Phase 0 gate status

- [x] Supervisor / config-dir / env-decode / sidecar-naming PoC on Linux
- [ ] Suspended-spawn + Job Object containment on Windows (Phase 2 entry)
- [ ] Tray hide/show + Stop&Exit + second-window lifecycle on Windows
- [ ] WebView2-absent guidance on a clean Windows VM
- [ ] Decision recorded if shell-plugin spawn proves insufficient for Job
      assignment (custom spawn path in the supervisor)
