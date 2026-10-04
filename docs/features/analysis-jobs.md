# Server-owned Analysis Jobs

## Intent and Scope

棋譜解析をBrowserのtimerやWebSocket接続寿命から分離し、Browserを閉じてもServer上で解析を完了できるようにします。Serverが固定入力・設定・進捗・結果・取消・engine寿命を所有し、Rendererは要求・同期・表示・結果反映を担当します。

対象はWrapperに登録されたresearch対応LAN engineです。この機能では通常の `ResearchManager`、詰み探索を移行しません。対局・時計・待ったの移譲は別機能の [Game Sessions](game-sessions.md) が所有します。native USI、解析時の外部定跡探索、Server再起動からの復旧、共同編集、別端末への制御移譲、解析棋譜ファイルへの自動保存は対象外です。

## Frozen Input and Browsing

- version付きsnapshotで棋譜tree、分岐順、metadata、注釈、bookmark、消費時間、既存評価を保持します。
- 解析対象のrootから末尾までの選択経路と実行設定は要求開始時に固定します。他の分岐を閲覧しても対象を切り替えません。
- 昇順・降順、開始／終了手数、特殊な終局手のskip、コメント形式・挿入規則、精度分類を維持します。engine名とDB方針はBrowserの表示名ではなくServerで解決します。
- 解析中は編集をlockし、閲覧と分岐選択は許可します。最初は解析局面へ追従し、手動閲覧後は追従を停止します。
- 局面ごとのtimerは探索開始後に開始します。通常停止はterminal outputを待って最終infoを反映し、それから隣接局面の比較と次の探索へ進みます。
- 保存する精度分類の言語はjob設定で固定し、Server全体のtranslation状態を変更しません。

## Lifecycle and Failure Policy

通常は `preparing → running → finishing → completed`、取消は `cancelling → cancelled` と進みます。失敗はengine cleanup後に `failed` になります。terminal状態になるまで次のjobを受け付けません。実行・入力・node・PV・結果容量・終了待ちには上限を設けます。上限と保持期限の正本は [`job.ts`](../../shogihome/src/server/analysis/job.ts)、[`jobManager.ts`](../../shogihome/src/server/analysis/jobManager.ts)、共有snapshot codecです。

- Browser切断やpolling失敗は取消ではありません。
- 通信断は既存の短い `connectionLostRetrying` トーストで一度だけ通知し、状態・結果の再同期後に `reconnected` へ置き換えます。再試行ごとには通知しません。ControlPaneには進捗・通信状態を表示せず、解析中断と取消待ちの操作feedbackのみを残します。
- PCとmobileは同じ棋譜解析dialog・server jobを使用します。mobileのMenuに棋譜解析／解析中断を用意し、dialogは狭い画面と縦scrollに対応します。
- 明示的取消は冪等で、進行中の探索を無効化して停止完了を待ちます。確認されるまでRendererも編集lockを保持します。
- 取消・失敗時は有効な途中結果を残します。取消後の出力を採用せず、取消をきっかけとした新しい隣接局面コメントは作りません。
- job不明・保持期限超過・Server再起動は410です。失われたjobを空の状態で再生成したり自動再実行したりしません。
- Analysis DBへの保存は既存のEngineSession経路だけを使用します。`/api/analysis` は引き続きDBの検索・管理用で、job APIとは別です。

## HTTP Synchronization Contract

共有型とruntime decoderは [`common/analysis/types.ts`](../../shogihome/src/common/analysis/types.ts)、HTTP境界は [`routes/analysis_jobs.ts`](../../shogihome/src/server/routes/analysis_jobs.ts) が所有します。追加のWebSocket routeはありません。

| `/api/analysis-jobs` 以下            | 用途                                            |
| ------------------------------------ | ----------------------------------------------- |
| `GET /capabilities`                  | Server実体IDと入力制限・poll間隔                |
| `POST /`                             | 固定snapshot・設定・request IDで非同期作成      |
| `GET /by-request/:requestId`         | 作成応答を失った要求の解決                      |
| `GET /:jobId`                        | 状態・進捗・現在局面・有界live info             |
| `GET /:jobId/source`                 | 固定入力の完全snapshot                          |
| `GET /:jobId/result?afterRevision=…` | revision以後に変化した最新node注釈。0で完全結果 |
| `POST /:jobId/cancel`                | 明示的取消                                      |

同じrequest ID・同じ入力のPOSTは既存jobを返し、入力変更は409、古いServer実体IDは410です。作成要求の入力はServerで検証して複製します。同時実行は1件でqueueはありません。

Rendererは非重複のHTTP pollingと失敗時のbackoffを使用します。通常間隔はcapabilitiesに従い、reload復元時も再取得します。既定は1秒で、statusとresultを毎回取得しても約1,800 requests／15分に抑え、共有の3,000 requests／15分制限に他の操作の余裕を残します。

429は同期・取消・作成POST応答待ち・reload復元で再試行対象とし、編集lock・job linkage・結果revisionを保持します。有効な `Retry-After`（秒数またはHTTP date）があれば、その期間以上待機します。欠落・不正の場合はbackoffを使います。待機中の取消操作は要求だけ保持し、待機を短縮しません。他の通信も同じ制限を共有するため、通常間隔を守っても429の再試行は必要です。

commentと評価はnode IDごとの絶対値として適用し、同じ結果を再受信しても重複しません。statusとresultにはjob／Server実体IDを付け、別jobの結果を誤反映しません。

## Reload and Safe Result Application

作成POST前に、小さなrequest／Server／job linkageをBrowser storageへ保存します。作成応答の喪失後もrequest IDから解決でき、入力snapshot全体をlocalStorageへ追加保存しません。同じBrowser originから再度開いた場合は、このlinkageを使って復元します。

復元時はServerの固定入力と完全結果を照合します。内容比較はsnapshotのobject key順に依存せず、node・分岐・PVなどの配列順は維持します。現在の棋譜が入力または最新結果と一致するときだけ自動反映し、それ以外は保持されている解析棋譜を開く確認を求めます。確認前にローカルな未保存内容を上書きしません。既存backupが失敗した場合も置き換えません。復元を断ってもjobを取り消さず、復元用linkageを保持します。

Reload時は自動的に復元を試みます。復元を断った場合もPC／mobileの通常の解析操作から再度復元でき、独立した「解析結果を復元」ボタンは設けません。linkageが残っている間は新規jobの作成へ切り替えません。

通常同期中も文書実体・内容を照合し、想定外の編集があれば注釈反映を停止します。閲覧位置の変更は内容変更と区別します。解析結果はunsaved扱いで、ファイルへの保存は従来どおりユーザーの操作です。

## Regression Coverage

- `tests/common/record/snapshot.spec.ts`: tree・分岐順・注釈・metadata・PVの往復、key順に依存しない内容比較、不正snapshotの拒否。
- `tests/server/analysis_job.spec.ts`: 昇降順・範囲・精度分類・comment規則、探索開始／停止待ち、取消・部分結果・期限。
- `tests/server/analysis_job_api.spec.ts`: 作成の冪等性・失効・境界validation・revision delta。
- `tests/server/analysis_job_integration.spec.ts`: HTTP → 実TCP → USI遷移、最終info、DB保存、切断とcleanup。
- `tests/renderer/store/analysis.spec.ts`: 非重複同期・共有レート制限下の長時間同期、429待機・取消・再試行、応答喪失・reload復元、編集lock、手動閲覧、別文書の保護。
- `tests/renderer/api/client.spec.ts`: `Retry-After` の秒数・HTTP date・欠落・不正値と既存エラーの互換性。
- `tests/renderer/api/analysis_jobs.spec.ts`: 実RPC clientのroute・response decoder・復元・失効・取消。
- production buildのmobile画面を320px幅で確認し、共通dialogの幅・scroll、解析開始／取消、短い切断／再接続トーストをRust Wrapperとfixture USI engine経由で検証しています。実engineの解析品質・性能や切断中のbatch完走を保証する検証ではありません。
- 既存のrelay・engine state・対局・待ったテストは従来経路の退行を検出します。
