# Launcher / Config Editor Architecture

この文書は、native shell と headless backend の責務、設定・process の所有権、終了時の保証を説明します。Window 構成、IPC schema、設定値、CLI の詳細はコードと操作文書を正本とします。

## Responsibilities

Windows・Linux・macOS で同じ Tauri shell を native build します。Launcher と standalone 設定エディタは同一アプリの起動モードで、UI・IPC・probe・終了処理を共用します。

| 所有者                                                                                                                                               | 責務                                                                            |
| ---------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| [`launcher-app/src-tauri/src/`](../../engine-wrapper/launcher-app/src-tauri/src/)                                                                    | Window・tray・native event、IPC と backend の bridge、非同期 shutdown           |
| [`launcher/src/controller.rs`](../../engine-wrapper/launcher/src/controller.rs) + [`service.rs`](../../engine-wrapper/launcher/src/service.rs)       | Service supervision、設定 snapshot、readiness、起動・停止・移行・設定保存の排他 |
| [`launcher/src/paths.rs`](../../engine-wrapper/launcher/src/paths.rs)                                                                                | Portable root と設定・ログ・実行ファイルの所在                                  |
| [`launcher/src/settings.rs`](../../engine-wrapper/launcher/src/settings.rs) + [`server_env.rs`](../../engine-wrapper/launcher/src/server_env.rs)     | 設定の解決・検証・保存と Server の Node 準拠の環境解決                          |
| [`launcher/src/network.rs`](../../engine-wrapper/launcher/src/network.rs)                                                                            | 実行設定に基づく接続 URL・QR・接続可否                                          |
| [`launcher/src/editor.rs`](../../engine-wrapper/launcher/src/editor.rs) + [`editor_session.rs`](../../engine-wrapper/launcher/src/editor_session.rs) | Engine registry、probe、編集 session と lock の寿命                             |
| [`launcher/src/lifecycle.rs`](../../engine-wrapper/launcher/src/lifecycle.rs)                                                                        | Close／quit と cleanup 完了までの終了制御                                       |
| [`process/`](../../engine-wrapper/process/) + [`env-file/`](../../engine-wrapper/env-file/)                                                          | Wrapper と共有する process tree 所有・設定ファイル codec と atomic write        |

設定の正本は各 `.env` と service 側の設定解決であり、Launcher は読み書きの bridge に留まります。UI は process 起動や設定書き込みを直接行いません。Backend の型付きエラーは [`error.rs`](../../engine-wrapper/launcher/src/error.rs) が所有し、IPC 境界で表示用の表現へ変換します。

Tauri shell は GUI システム依存を通常の backend test から切り離すため、Cargo workspace とは独立した manifest／lockfile を持ちます。これは Windows 限定の境界ではありません。

## Path and State Ownership

- 現在の native 起動は書き込み可能な portable layout を対象とします。設定フォーム、editor、service 起動、ログ、移行は同じ root を使用し、bundle 内の assets を書き込み可能な設定の所在と混同しません。
- Service ごとに解決した設定 snapshot を起動環境と readiness の双方に使い、Wrapper 側で設定ファイルを再読込して snapshot がずれることを防ぎます。
- Server の `.env` は同梱 Node runtime、Wrapper の `.env` は共有 `env-file` codec で解決します。親環境変数の優先順位や OS ごとの扱いも直接起動と一致させます。解決に失敗した場合はエラーを返し、既定値への置換で表示・保存を続けません。
- Wrapper の設定構文はアプリ固有の契約とし、他の dotenv 実装への追従は行いません。保存値が Wrapper と Server の両方で保持されることは [実 reader による往復テスト](../../engine-wrapper/launcher/tests/env_parity.rs) で検証します。
- 設定保存は controller の操作 lock 内で現在値の解決・検証・書込を完結させます。既存のカスタム値を別項目の編集で暗黙に置き換えません。
- 接続表示はフォーム用の型変換ではなく Server の生の設定値から解決し、実際の待受・Origin policy と一致させます。
- 初回移行と未完了移行の再開は service 起動前に処理します。未完了の移行中は起動を拒否し、既存データの上書き移行は提供しません。
- 通常 Launcher の編集対象は supervision と同じ root に固定します。Standalone editor は service を起動せず、Wrapper と同じ基準で設定 directory と相対 engine path を解決します。

## Close and Exit Invariants

- Wrapper・probe は共有 process module を使い、親 process の終了後も子孫を回収してから pipe を閉じます。IPC future の終了だけを probe の完了とみなしません。
- Main window の close を hide に変換するのは、トレイ常駐が有効で実際に tray を作成できた場合だけです。Linux は tray host の表示を検出できないため常駐を opt-in とし、最後の window close による OS の暗黙終了に依存しません。
- Standalone editor の close、tray 常駐しない main window の close、明示的 Quit は共通 shutdown に収束させます。Shutdown は重複実行せず、service 停止と probe cleanup 完了後だけ正常終了します。Quit 開始後の再起動は拒否します。
- Probe cleanup が収束しない場合、standalone editor は異常終了を返し、Launcher は UI を保持して通知・終了再試行を可能にします。
- 設定 directory 単位の編集 lock は probe が残る間は解放しません。Probe 登録と close を直列化し、close 後の probe・保存や古い session の完了通知が新しい編集 session を変更することを防ぎます。

## Trust and UI Boundaries

Window ごとの [`command allowlist`](../../engine-wrapper/launcher/src/permissions.rs) と [Tauri capability](../../engine-wrapper/launcher-app/src-tauri/capabilities/) を維持します。UI は既存 registry validator／env decoder／probe を通過し、filesystem や process を直接操作しません。長時間の IPC は UI event loop の外で実行します。USI session state machine は Middle Server の責務のままです。

## Presentation State

- Dashboard、設定、ログ、editor は権限を分けた window とし、window lifecycle は backend が管理します。起動・再起動・設定保存後の状態と接続表示を同期し、遅延した応答で古い表示へ戻しません。
- QR は実際に LAN 接続可能な構成だけを表し、表示 URL と payload を一致させます。待受・Origin policy で接続できない構成に QR を出しません。
- WebView の表示言語はアプリ内で共有する保存設定に従います。Native shell の tray・起動前エラー・CLI 文言は OS locale に基づく独立した表示境界です。

操作・build 手順は [launcher-app README](../../engine-wrapper/launcher-app/README.md)、設定名・既定値は各 `.env.example`、配布 layout は build script を参照してください。
