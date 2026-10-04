# Game Session Architecture

この文書は、Server 所有の通常対局の責務、同期境界、時計・棋譜の整合性を説明します。操作条件、設定値、frame の詳細は共有 codec と実装を正本とします。機能の意図と対象外は [Game Sessions](../features/game-sessions.md) に記載します。

## Responsibilities

| 所有者                                                                       | 責務                                                                            |
| ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| [`server/game/controller.ts`](../../shogihome/src/server/game/controller.ts) | 対局ルール、手番、終局、連続対局、checkpoint と巻き戻し                         |
| [`server/game/clock.ts`](../../shogihome/src/server/game/clock.ts)           | monotonic time に基づく時計と deadline の確定                                   |
| [`server/game/session.ts`](../../shogihome/src/server/game/session.ts)       | 固定入力、棋譜・時計 snapshot、操作の冪等性、接続の制御権、各局の保存・履歴登録 |
| [`server/game/manager.ts`](../../shogihome/src/server/game/manager.ts)       | 作成要求の解決、実行数・保持期間の制約、session cleanup                         |
| [`server/game/player.ts`](../../shogihome/src/server/game/player.ts)         | 人間／LAN player、内部 engine session と外部定跡の寿命・取消                    |
| [`renderer/store/game.ts`](../../shogihome/src/renderer/store/game.ts)       | 操作要求、同期、reload 復元、時計の表示、対局中の文書編集 lock                  |

USI 遷移は player に複製せず、[`engine/internal.ts`](../../shogihome/src/server/engine/internal.ts) を通じて `EngineSession` を使用します。対局用の内部 session は公開 relay の registry へ登録しません。通常検討・詰み探索は Browser 側の既存経路に残ります。Engine 境界は [Remote Engine Architecture](remote-engine.md) を参照してください。

## Lifecycle and Record Ownership

- 作成時に検証した棋譜・設定を固定し、Server 上の session が対局を進めます。Renderer に代替の対局 executor は持ちません。
- 棋譜 node の ID は session 内で安定し、巻き戻し後も削除済み node の ID を再利用しません。
- 現局面からの連続対局は、前局の結果ではなく開始時に固定した棋譜から再開します。
- 各局終了時に棋譜を凍結し、自動保存と既存の履歴登録が収束してから次局へ進みます。自動保存成功時は保存ファイル、無効時・失敗時は履歴 backup を登録します。保存・履歴の失敗は通知し、連続対局は継続します。
- Player と外部定跡 handle は対局側が所有し、終了・失敗・中断時に解放します。Engine の解析結果は既存の Analysis DB 保存経路を使います。
- 実行中・完了済み session と操作台帳は有界で、進行中の対局は Server 再起動で失われます。終局棋譜の永続化は session 保持とは独立しています。

ファイル公開と履歴の保証は [Storage Architecture](storage.md) を参照してください。

## Clock and Disconnect Policy

Server の時計だけが時間切れを決定します。操作や切断への対応前に経過を確定し、既に成立した時間切れを巻き戻しや一時停止で取り消しません。Browser の時計補間や通信遅延は判定の正本ではありません。

- 人間手番は切断検知・application heartbeat の失効で停止します。検知前の時間は課金し、再開後も経過時間と秒読みを保持します。
- AI 手番は Browser 切断で取り消さず、次の人間手番で停止します。AI 同士は Browser なしで連続対局・保存を継続します。
- 新しい接続へ完全 snapshot を送ってから、人間操作の再開を受け付けます。

## Synchronization and Control

HTTP が作成・操作・復元を、専用 WebSocket が snapshot と時計・探索情報の同期を担当します。通常更新は HTTP polling に依存しません。共有契約は [`common/game/protocol.ts`](../../shogihome/src/common/game/protocol.ts)、HTTP 境界は [`routes/game_sessions.ts`](../../shogihome/src/server/routes/game_sessions.ts) が所有します。[`websocket.ts`](../../shogihome/src/server/websocket.ts) は公開 relay と同じ Host／Origin policy を適用します。

Browser 側の検討注釈は専用 WebSocket から送り、対局・手番・node・局面を照合して反映します。HTTP の共有 rate limit を使う操作とは分けます。

- 作成は request ID と Server 実体 ID で照合し、応答喪失後も同じ要求を解決します。操作も元の request ID を保って再送し、二重着手を防ぎます。
- 制御権の世代と対局・手番の世代を照合し、置換済み socket や旧手番の操作を拒否します。古い tab が自動で制御権を取り返すことはありません。
- Snapshot の revision と node ID で棋譜を同期し、古い snapshot で現在の状態を上書きしません。
- 通信障害や rate limit では復元用識別子、未確認操作、文書 lock を保持して再試行します。失効や Server 再起動を新しい対局の自動作成へ変換しません。
- 別の棋譜へ復元する場合は確認と backup を先に行い、完了棋譜を Browser storage へ反映してから session との linkage を解除します。

## Takeback Transaction

`GameController` が手番開始時の棋譜と双方の時計を checkpoint として所有します。巻き戻しは次の整合性を維持します。

- 旧操作を無効化して時計・入力を停止し、player の探索取消が完了するまで現在の棋譜を保持します。
- 取消完了後も操作が有効な場合だけ、[`common/game/record.ts`](../../shogihome/src/common/game/record.ts) で棋譜と時計を一括復元して snapshot を公開します。既存の分岐・注釈は保護します。
- 探索と定跡応答の識別は局面文字列だけに依存せず、同じ手の指し直しでも旧出力を採用しません。
- 取消失敗・期限超過では巻き戻しを確定せず、元の進行を保持して対局を中断します。先行した中断を遅延した取消完了で取り消しません。
- 切断中は人間手番を再開せず、同期後に再開します。Checkpoint は Server の揮発性状態であり、Server 再起動を越えた復旧は行いません。

巻き戻し範囲を選んだ理由は [Takeback](../features/takeback.md) を参照してください。
