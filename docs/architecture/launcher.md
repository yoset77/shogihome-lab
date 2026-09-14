# Launcher / Config Editor Architecture

## Responsibilities

Windows・Linux・macOS で同じ Tauri shell を native build します。設定エディタは同一実行ファイルの `--config-editor` モードです。UI・IPC・probe・終了処理を共用し、editor 専用成果物による二重保守を避けます。

| 所有者 | 責務 |
|---|---|
| `engine-wrapper/launcher-app/src-tauri/src/app.rs` | 起動モードに応じた window 生成、native event の配送 |
| `src-tauri/src/state.rs` | shell state と window command allowlist への bridge |
| `src-tauri/src/editor.rs` | editor IPC、window と編集セッションの結び付け |
| `src-tauri/src/launcher.rs` | dashboard IPC、controller への委譲 |
| `src-tauri/src/tray.rs` | トレイ生成・メニュー操作 |
| `src-tauri/src/shutdown.rs` | native／IPC 共通の非同期 cleanup と exit |
| `engine-wrapper/launcher/src/paths.rs` | portable root、native 実行ファイル名、設定・ログの所在 |
| `launcher/src/lifecycle.rs` | close／quit の方針と `Running → Closing → ReadyToExit` |
| `launcher/src/editor_session.rs` | session lock の寿命、probe 登録・キャンセル・完了の直列化 |
| `launcher/src/editor.rs` | registry 検証・atomic save・USI option probe |
| `launcher/src/controller.rs` + `service.rs` | service lifecycle、設定 snapshot、readiness、移行との排他 |
| `launcher/src/process.rs` + `session_lock.rs` | Windows Job／Unix process group と OS 管理ファイルロック |

Tauri shell は GUI システム依存を通常の backend test から切り離すため、Cargo workspace とは独立した manifest／lockfile を持ちます。これは Windows 限定の境界ではありません。

## Path and State Ownership

- 現在の native 起動は書き込み可能な portable layout を対象とし、root は実行ファイルの親ディレクトリです。
- server／wrapper の実行ファイル名は `paths` が OS ごとの suffix を付与します。server runtime builder は同じ命名契約で native Node をコピーし、実行権限を保持します。
- launcher の設定フォーム、editor、service 起動、ログ、移行は同一 root を使います。service ごとの `.env` snapshot を起動環境と readiness の両方に使い、wrapper の再読込は `--no-env-file` で抑止します。
- editor の明示的 `--config-dir` は wrapper と同じ意味で、registry の所在と相対 engine path の基準です。probe の CWD は解決した engine の親ディレクトリです。明示した相対 directory だけが起動 CWD に依存します。
- standalone editor は controller を構築せず、dashboard、service、health polling、tray を初期化しません。
- インストール型の `.app`／AppImage／deb と OS 標準保存先は別の配布段階で扱います。bundle 内の assets を書き込み可能な設定の所在と混同してはいけません。

## Close and Exit Invariants

- トレイ常駐が有効で、実際にトレイを作成できた場合だけ main close を hide に変換します。
- Linux は tray host の表示を検出できないため常駐を opt-in にします。`--no-tray` は全 desktop OS で利用できます。
- standalone editor close、トレイなし main close、dashboard／tray／OS の明示 Quit は共通 shutdown を開始します。macOS の最後の window close に暗黙の process exit を期待しません。
- shutdown worker は一度だけ開始し、処理中の追加終了要求を保留します。controller の停止と probe cleanup が完了した後だけ exit 0 を許可します。
- probe drain timeout は standalone では exit 1、launcher では UI を保持してエラー通知・終了再試行とします。controller は quit 後の再起動を拒否します。
- editor session の mutex は probe 登録と close を直列化します。close 後は probe と保存を拒否し、IPC future の終了ではなく blocking worker の RAII guard 破棄をもって probe 完了とします。
- 編集ロックは probe が残る間は解放しません。window 再表示で generation を更新し、古い timer は新しい session を解放できません。期限後に完了した worker も、閉じた session のロックを解放できます。

## Trust and UI Boundaries

window allowlist と Tauri capability を維持します。UI は filesystem や process を直接操作せず、既存 registry validator／env decoder／probe を通過します。USI session state machine は Middle Server の責務のままです。

## Dashboard Windows

- dashboard（`main`）は状態表示・起動制御・QR／URL・更新通知・初回移行に専念し、サーバー設定とログ表示は持たない。設定は `settings` window（620x640）、ログは `logs` window（600x640）の独立 WebviewWindow で表示する（Python 版の別 Toplevel 相当）。
- `settings`／`logs` は単一インスタンスで、存在すれば show＋focus する。閉鎖はバックエンドの `close_settings_window`／`close_logs_window`（`window.destroy()`、エディタの `close_window` と同パターン）で行い、フロントの window 権限に依存しない。保存後は `settings-saved` イベントで dashboard が QR／URL を再読込する。
- window 別の command allowlist（`launcher/src/permissions.rs`）と capability（`src-tauri/capabilities/{settings,logs}.json`）を持つ。`settings` は設定系＋再起動のみ、`logs` はログ読込のみ許可する。
- データ移行に常設ボタンは置かない。初回起動時（`shogihome/data` 不在）のみ `startAfterMigration` が案内し、既存データへの上書きは提供しない。
- dashboard の表示 URL は QR ペイロード（LAN URL）と一致させる。QR がない構成（127.0.0.1 bind・strict 等）では従来通り PC URL を表示する。

## UI Language

- WebView 内の表示言語は日英切替可能で、セレクトは dashboard（`main`）と editor のヘッダー右にのみ置く（幅90px固定のコンパクト表示）。`settings`／`logs` にセレクトは置かず、保存済み言語に追従する。全窓のタイトル文字サイズは共通（1.25rem）で、400px幅の dashboard でも1行に収まる。全窓が `src/i18n.ts` を共用する。選択は localStorage と backend の `.update_cache.json`（`ui_language`、Python 版と同キー）に保存し、backend 保存値を優先する。
- native shell 文言（tray・起動前エラー・`--help`）は `shogihome/src/common/i18n/launcher-native.json` を Rust backend に埋め込み、OS locale（`LC_ALL`→`LC_MESSAGES`→`LANG`）で選択する。WebView 内の言語選択とは独立している。

ネイティブファイル選択は Windows で実行ファイルと全ファイルを提供し、Unix では拡張子による制約を設けません。実行エラーは既存 probe 経路で報告し、任意ファイルを shell 経由で実行するフォールバックは追加しません。

native shell 文言は `shogihome/src/common/i18n/launcher-native.json` を Rust backend に埋め込みます。詳細な build／検証手順は [launcher-app README](../../engine-wrapper/launcher-app/README.md) に記載します。
