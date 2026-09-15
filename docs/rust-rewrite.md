# Rust Rewrite Notes (Engine Wrapper / Launcher)

Python (`engine_wrapper.py`, `launcher.py`, `config_editor.py`) /
cTk / pywebview から Rust / Tauri へのリライトに関する決定事項の集約。
`docs/rust-rewrite/phase-*.md` 8件を1件にまとめた後継文書であり、
phase 文書は削除済み（履歴は git log で参照可能）。

正本は [ARCHITECTURE.md](../ARCHITECTURE.md) と
[Launcher / Config Editor Architecture](architecture/launcher.md) が所有する。
この文書は経緯・互換性判断・受け入れ残件のみを扱い、
設定値・プロトコルフィールド・UI 詳細の値は複製しない。

## 1. 互換性判断（旧 Python / Node ラッパーとの差分）

TCP line protocol 自体は不変。Middle Server の再配線は不要。
意図的な変更のみ以下に記録する（等価動作はコードと contract suite が正本）。

- Auth ダイジェストは strict 64-hex パースで fail closed（Node は寛容だった）。
- エンジン最終行の末尾改行なし出力は flush する（Python は破棄していた）。
- Client→engine 行は trim + UTF-8 再送出し、CR/LF 混入は拒否（Node 準拠）。
- Option 値は scalar-only schema。不正・複合値は警告して skip（両実装の黙示 stringify を継承しない）。
- 設定解決は暗黙の script-dir ではなく明示の `--config-dir`。
- エンコーディングは行単位で UTF-8 → CP932/Shift-JIS fallback → UTF-8 転送。
  Engine stdin への CP932 再変換はしない。stderr は stdout 同様に転送する。
- クリーンアップは Node 準拠：FIN/RST/write-failure/spawn-failure/engine-exit を
  冪等な per-connection cleanup に集約。`quit` → stdin close → 5s → SIGTERM
  （POSIX は process group、Windows は tree kill）→ 3s → SIGKILL。
  POSIX process group / Windows Job Object を保持し、leader 正常終了後も
  子孫を回収してから pipe を閉じる。

## 2. Rust Wrapper（`shogihome-wrapper`）

- `engine-wrapper/wrapper/src/`: `main.rs`（CLI/env、listener、SIGINT/SIGTERM + 10s deadline）、
  `relay.rs`（auth → command → list/run → 単一ループ relay → cleanup）、
  `process.rs`（POSIX setsid group、Windows は `.bat`/`.cmd` のみ shell + `CREATE_NO_WINDOW`）、
  `config.rs`（`engines.json` をリクエスト毎リロード、unknown field 保持）、
  `encoding.rs`、`auth.rs`（CRAM-SHA256、constant-time 比較）。
- Single stdin/socket write owner の単一タスク relay。relay 中は engine stdin を
  開けたままにし、cleanup が `quit` を先に届ける。
- Standalone 実行時は `<config-dir>/.env` を自動読込する
  （優先順位: CLI > 環境変数 > `.env` > 既定値。消費キーは `BIND_ADDRESS`、
  `LISTEN_PORT`、`WRAPPER_ACCESS_TOKEN` のみ）。
  Launcher 経由では確定済み snapshot を渡すため `--no-env-file` で再読込を抑止する。

## 3. Launcher Backend（`shogihome-launcher`）

責務の詳細は [Launcher Architecture](architecture/launcher.md) が正本。
要点のみ：

- `supervisor.rs` + `controller.rs` が起動・再起動・停止・移行を直列化し、
  状態 snapshot と稼働中 process 監視を所有する。時間のかかる処理は UI event loop の外で実行。
- `process` crate に tree 所有を集約（POSIX process group / Windows Job Object）。
  `launcher/src/process.rs` と `wrapper/src/process.rs` は互換 shim。
- `.env` codec は `env-file` crate に集約（BOM/UTF-8/CP932 decode、round-trip 検証、
  process 一意 tmp + atomic rename）。旧 `common.py` の bool/int 判定バグは修正済み。
- `settings.rs` は `server_settings.py` schema port。linked 設定
  （`LISTEN_PORT`/`REMOTE_ENGINE_PORT`、token）は atomic two-file save + rollback、
  既存 mismatch は隠さず報告する。
- `migration.rs` は staged copy（`data.tmp` + rename）と完了記録を持ち、
  失敗時は再開可能。server が data directory を作る前に移行を完了させる。
- `update.rs` は legacy `1.17.0a0` == `1.17.0-alpha.0` 比較、prerelease-channel 規則、
  snooze cache（ISO-8601 legacy tolerant）、5s GitHub fetch。

## 4. Tauri Shell / UI（`launcher-app/`）

詳細は [Launcher Architecture](architecture/launcher.md) が正本。要点のみ：

- 単一バイナリの launch mode：通常は dashboard + tray + health polling、
  `--config-editor [--config-dir DIR]` は editor のみ（controller・service・tray なし）。
  `tauri.conf.json` に静的 window は持たず、`setup` が mode に応じて生成する。
- `frontendDist: ../dist`（Vite multi-page：`index.html` + `editor.html`）。
  `mainBinaryName: ShogiHomeLab` で portable exe 名を固定。
  `externalBin` は使わない（wrapper.exe を exe 横の明示 path で spawn）。
  `webviewInstallMode` は使わない（portable ZIP のため）。
- Window 別 command allowlist（`launcher/src/permissions.rs` + capability）と CSP。
  UI は process 起動・設定書込を直接行わない。`innerHTML` 構成禁止（`textContent` のみ）。
- Probe は backend 所有：timeout、bounded 出力、stdout/stderr 並行 drain、tree kill、
  cancel flag。IPC future ではなく blocking worker の RAII guard 破棄をもって完了とする。
- Editor は config-dir 単位の OS 管理 session lock（異常終了時は自動解放）。
  保存は process 一意 tmp + atomic rename。
- `editor` window 生成は async command（Windows での同期 IPC 内 WebView 生成 deadlock 回避）。
- WebView2 はバンドルしない。起動失敗時は公式 download URL を案内する。
- Icons（`src-tauri/icons/`）はコミット必須（`tauri build` が失敗するため）。
- `src-tauri` は headless workspace から独立した manifest/lockfile を持つ
  （GUI システム依存を通常 backend test から切り離す。通常境界であり Windows 限定ではない）。

## 5. リリース・バージョン・ライセンス

- Portable ZIP 配置（Windows 成果物。Unix package / installed data-dir layout は別段階）：
  `ShogiHomeLab.exe`（`tauri build --no-bundle`）、`wrapper.exe`（`shogihome-wrapper` release 改名）、
  `icon.png` / `README.txt`、`shogihome/`（dist/bin + docs/webapp + `.env`）、
  `engine-wrapper/`（`engines.json` / `.env` seed、`VERSION`、`licenses/`）。
  分割配置向け `engine-tools` ZIP（`ShogiHomeLab.exe`、`wrapper.exe`、
  `engine-wrapper/`、専用 README）も配布する。
- 配布物から除外：embedded Python、`launcher.py`、`engine_wrapper.py`、`config_editor.py`、
  `config_editor.html`、`common.py`、`i18n.py`、`server_settings.py`、`update_checker.py`、C# shim。
- Version authority（`scripts/check_versions.py`、stdlib only）：
  `pyproject.toml`、`shogihome/package.json`、workspace `[workspace.package]`、
  `launcher-app/package.json`、`tauri.conf.json` の一致を CI（全 push）と release（+ `--tag`）で検証。
  両 crate は `version.workspace` を使用する。
- License pipeline：Rust は `about.toml` gate + `scripts/generate_rust_licenses.py`
  （`cargo-about` 0.9.2 pin）。Launcher UI は `license-checker`。
  Server/browser は従来通り（`shogihome` 内）。
- `release.yml` は repo ファイルなしで assembled tree を起動検証する
  （manifest check + 空 registry への `list` で `[]` を期待。
  `server_settings.py` クラスの欠落検出が目的）。

## 6. Contract Suite

`engine-wrapper/tests/test_wrapper_contract.py` を `WRAPPER_CMD=python|node|rust` で
3 実装に同一条件で実行する（protocol 変更時は 3 実装を同期させる）。
`list`+EOF、pipelined `run`+`usi`、option 単回注入、unknown id、
auth fail-closed/success、FIN での engine 停止、CP932→UTF-8 をカバーする。

## 7. 旧実装の扱い

`engine_wrapper.py`、`engine-wrapper.mjs`、`shutdown-coordinator.mjs`、
`launcher.py`、`config_editor.py` と支援モジュールは repo と CI に残す。
初回 Rust ベース release を draft として出し、manual acceptance（§8）が通るまで
fallback を消さない。削除は本切替とは別の変更で行う。

## 8. Windows 受け入れ残件

- [ ] `npx tauri build --no-bundle` + `cargo build --release` green（async `editor_probe` 含む）。
- [ ] Windows wrapper build への contract suite（`.bat` path、`CREATE_NO_WINDOW`、`taskkill /T`）。
- [ ] Tray hide/show、Stop&Exit descendant check、window close 時の editor probe cancel、
      clean VM での WebView2 不在ガイダンス。
- [ ] Release 数値：ZIP size、cold start、per-component RSS（同一 script + Windows 計測）。
- [ ] Draft release を clean machine の ZIP から導入（旧 root からの migration、QR open、
      engine probe + save round-trip）。
- [x] Job Object containment（`process-wrap`）。親正常終了後も tree 所有を保持して cleanup。
      runtime acceptance は回帰 job と上記 manual descendant check の一部。
