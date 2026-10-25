# Analysis Job Architecture

この文書は、Server 所有の棋譜解析 job の責務、実行寿命、結果同期の保証を説明します。API schema、解析条件、容量や保持期限の値は実装と共有 codec を正本とします。対象範囲と判断理由は [Analysis Jobs](../features/analysis-jobs.md) に記載します。

## Responsibilities

| 所有者                                                                               | 責務                                                                     |
| ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------ |
| [`server/analysis/job.ts`](../../shogihome/src/server/analysis/job.ts)               | 固定棋譜、解析順序・進捗、局面ごとの探索、注釈生成、途中結果、取消       |
| [`server/analysis/batch.ts`](../../shogihome/src/server/analysis/batch.ts)           | 棋譜の割当、内部の単一解析、worker別engine再利用、棋譜別成否、保存中取消 |
| [`server/analysis/files.ts`](../../shogihome/src/server/analysis/files.ts)           | 確認用対象一覧、検証済みファイル読込、原本変更検出、atomic保存           |
| [`server/analysis/jobManager.ts`](../../shogihome/src/server/analysis/jobManager.ts) | engine 定義の解決、作成の冪等性、実行数と保持の制約、終了時 cleanup      |
| [`server/engine/internal.ts`](../../shogihome/src/server/engine/internal.ts)         | 既存 USI state machine への内部探索・停止・取消・終了 adapter            |
| [`renderer/store/analysis.ts`](../../shogihome/src/renderer/store/analysis.ts)       | 作成要求、HTTP 同期、reload 復元、局面追従、文書 lock、安全な結果反映    |
| [`server/jobs/attachment.ts`](../../shogihome/src/server/jobs/attachment.ts)         | アタッチ所有者、heartbeat、移譲の世代照合                                |
| [`renderer/store/job_storage.ts`](../../shogihome/src/renderer/store/job_storage.ts) | タブの復帰意図と端末の未確認要求台帳の分離                               |
| [`common/analysis/types.ts`](../../shogihome/src/common/analysis/types.ts)           | 共有型と runtime decoder                                                 |

解析 job の内部 `EngineSession` は公開 relay の registry に登録せず、Browser の attach／close で操作できないようにします。USI state と Analysis DB 保存経路は [Remote Engine Architecture](remote-engine.md) と共有し、job 側から結果を二重保存しません。

## Frozen Input and Execution

- 作成時に棋譜 snapshot、選択経路、解析設定を検証して固定します。Engine 名・能力・DB 保存方針は Server で解決します。
- アタッチ中の Renderer は文書編集と閲覧・分岐選択を lock し、盤面を解析局面へ追従させます。閲覧はデタッチ後に行います。
- 局面ごとの解析時間は探索開始後に計測し、engine 起動や前の探索の停止待ちを含めません。
- 初回探索の開始確認までは準備状態を維持します。その間に届く探索出力も現在の探索へ照合して取り込み、最初の info を失いません。
- 通常停止は terminal output と最終 info を取り込んでから注釈生成・次局面へ進みます。取消は探索結果を無効化する操作として区別します。
- 注釈生成の言語は job 設定に固定し、Server 全体の translation state を変更しません。

棋譜 snapshot の共有境界は [`common/record/snapshot.ts`](../../shogihome/src/common/record/snapshot.ts) を使います。

連続解析は確認用planの対象path・割当順を固定して開始します。内容は各棋譜の処理開始時に既存importerとsnapshot decoderで検証し、本譜の固定入力へ変換します。バッチ内部の単一解析は公開ジョブとして登録せず、各workerが専用engine adapterを再利用します。棋譜内の局面解析は直列のままです。親jobが全worker分の資源を起動前にまとめて予約し、全workerの保存・cleanup完了まで保持します。Managerの実行枠と作成要求台帳は単一解析と共有します。

並列バッチはバックグラウンド専用です。Serverはアタッチと単一棋譜用source/result取得を拒否し、処理中のsnapshotを代表棋譜として公開しません。JobsDialogが全体進捗と冪等な停止を扱い、保存済み棋譜はファイル別結果から通常の棋譜open経路で回収します。取消・engine異常では全workerへの新規割当を停止し、保存開始済みの処理は確定を待ちます。

確認用planは実行枠ではなく有界キャッシュとして保持します。受付後は解放し、期限切れ・退避済みのplanは再確認を求めます。受付済みの作成要求はplanの保持に依存せず要求台帳から解決します。各棋譜は解析開始前に既存の保存先validatorも通し、名前の制約で上書きできない対象にはengine resourceを費やしません。

棋譜ごとの結果revisionは独立しているため、連続解析のsourceとresultはrecord indexでも照合します。古い棋譜を指定した取得は再同期可能な応答で拒否し、別棋譜の同名nodeへ結果を適用しません。Rendererは新しい棋譜への切替前にsourceと完全結果を取得し、非同期取得中の手動閲覧も優先します。最初の切替やアタッチでは未保存棋譜の確認・backupを先行させ、以後の内部切替を履歴へ大量登録しません。

## Lifecycle and Failure Policy

- 準備・解析・終了処理を経て terminal 状態になります。Engine cleanup 完了までは次の job を受け付けず、待ち行列は持ちません。
- Browser 切断や polling 失敗は取消ではありません。完了・明示的取消・失敗が engine resource の cleanup を所有します。
- バックグラウンド開始とデタッチは実行や取消を変更しません。デタッチ時に文書 lock と表示への同期を解放し、旧世代の遅延応答は別の棋譜へ反映しません。
- 取消は冪等です。進行中の探索を無効化し、停止完了まで Renderer も文書 lock を保持します。取消後の出力や新しい隣接局面コメントは採用しません。
- 終了処理に入った後の取消は状態や結果を変更しません。Engine cleanup の完了は待ち、cleanup 失敗は引き続き失敗として報告します。
- 単一解析と直列バッチの有効な途中結果は取消・失敗後も保持します。並列バッチは未保存の途中棋譜を回収対象にしません。入力、実行時間、出力、終了待ち、完了 job と作成要求台帳は有界です。棋譜単位とバッチ全体の実行期限は独立しています。
- バッチのファイル別成否と保持中棋譜は別のデータです。全棋譜のsnapshotは保持しません。完了時の原本保存はServerが所有し、Browserの反映・保存確認を待ちません。保存公開前の内容照合とatomic writerの保証は [Storage Architecture](storage.md) に従います。
- 失効や Server 再起動では既存 job が失われたことを返し、空の job の再生成や自動再実行はしません。

## HTTP Synchronization

[`routes/analysis_jobs.ts`](../../shogihome/src/server/routes/analysis_jobs.ts) が作成・状態・固定入力・結果・取消の HTTP 境界を所有します。Analysis DB の検索・管理 API とは別の resource です。

- 作成要求は request ID と Server 実体 ID で照合します。同じ入力の再送は既存 job を解決し、同じ ID の異なる入力は拒否します。
- Renderer は重複しない polling を行い、Server の capabilities に従って同期間隔を選びます。一時的な障害では backoff し、rate limit の再試行待ちは `Retry-After` に従います。
- 状態と結果は job／Server 実体 ID で照合します。Revision 差分は各 node の最新注釈を絶対値で返し、再受信による comment の重複を防ぎます。完全結果からも同期できます。
- 通信待ち中は文書 lock、復元用識別子、結果 revision、取消要求を保持します。
- 画面上での新規開始は、エンジン準備と初回解析局面の反映まで待機表示で UI を lock します。最初の info や結果は待たず、バックグラウンド開始では作成要求の完了までに留めます。通信障害・終了・デタッチでは初回待機を解除し、再接続や復元で再取得しません。待機の解除と文書 lock・復帰情報の解放は別の判断です。
- 一覧から開始端末の保存情報なしでジョブを発見できます。同時アタッチは一画面とし、別画面への移譲は既知の世代と明示確認を伴います。同期と取消はアタッチ所有者を照合し、旧画面が自動で制御権を取り返すことはありません。
- 公開状態は所有者の識別子を含まず、台帳は世代で照合します。対局と共通の [`jobs/control.ts`](../../shogihome/src/server/jobs/control.ts) が画面・復帰権限を検証します。画面置換後に元の取消要求を再送する場合は、現在の画面の認可も必要です。

## Reload and Safe Result Application

Browser は作成前に request／Server の未確認要求を localStorage に記録し、応答喪失後も同じ request ID で照合します。入力全体を台帳へ複製せず、復元時に Server の固定入力と完全結果を取得します。台帳は自動アタッチの指示にはしません。

アタッチ先、所有者・世代、棋譜の照合情報は sessionStorage に保存し、同じタブの reload 時だけ安全な自動復帰を試みます。通常の新規画面は一覧から選び、複製された sessionStorage だけで自動移譲しません。デタッチは復帰意図を消しますが、未確認要求の台帳は消しません。旧 localStorage linkage は台帳へ移行し、復帰意図へ自動変換しません。

[`renderer/store/job_tab_guard.ts`](../../shogihome/src/renderer/store/job_tab_guard.ts) と Server の画面識別・復帰権限の照合で、生存画面への自動移譲を防ぎます。同じ origin の排他確認ができない Browser では一覧からの明示操作を使います。ページ離脱時は画面の lease を解放しますが、ジョブと復帰意図は残します。

現在の文書が前回の同期内容、固定入力または最新結果と一致する場合だけ自動反映します。別内容の未保存棋譜を置き換える場合は確認と既存 backup を先に行い、復元を断っても job は取り消しません。通常同期中も文書実体・内容を照合し、想定外の編集では反映を停止します。

完了時は Browser の通常の棋譜復元 storage への反映を flush してからタブの復帰意図を消します。Storage 書き込み失敗時は復帰情報を保持し、一覧からも Server の完全結果を開けます。結果の保持は棋譜ファイルへの保存を意味しません。永続性の境界は [Storage Architecture](storage.md) を参照してください。
