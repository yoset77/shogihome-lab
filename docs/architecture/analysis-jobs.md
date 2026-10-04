# Analysis Job Architecture

この文書は、Server 所有の棋譜解析 job の責務、実行寿命、結果同期の保証を説明します。API schema、解析条件、容量や保持期限の値は実装と共有 codec を正本とします。対象範囲と判断理由は [Analysis Jobs](../features/analysis-jobs.md) に記載します。

## Responsibilities

| 所有者                                                                               | 責務                                                                  |
| ------------------------------------------------------------------------------------ | --------------------------------------------------------------------- |
| [`server/analysis/job.ts`](../../shogihome/src/server/analysis/job.ts)               | 固定棋譜、解析順序・進捗、局面ごとの探索、注釈生成、途中結果、取消    |
| [`server/analysis/jobManager.ts`](../../shogihome/src/server/analysis/jobManager.ts) | engine 定義の解決、作成の冪等性、実行数と保持の制約、終了時 cleanup   |
| [`server/engine/internal.ts`](../../shogihome/src/server/engine/internal.ts)         | 既存 USI state machine への内部探索・停止・取消・終了 adapter         |
| [`renderer/store/analysis.ts`](../../shogihome/src/renderer/store/analysis.ts)       | 作成要求、HTTP 同期、reload 復元、閲覧追従、文書 lock、安全な結果反映 |
| [`common/analysis/types.ts`](../../shogihome/src/common/analysis/types.ts)           | 共有型と runtime decoder                                              |

解析 job の内部 `EngineSession` は公開 relay の registry に登録せず、Browser の attach／close で操作できないようにします。USI state と Analysis DB 保存経路は [Remote Engine Architecture](remote-engine.md) と共有し、job 側から結果を二重保存しません。

## Frozen Input and Execution

- 作成時に棋譜 snapshot、選択経路、解析設定を検証して固定します。Engine 名・能力・DB 保存方針は Server で解決します。
- 解析 cursor と閲覧 cursor は独立しています。Renderer は文書編集を lock しつつ閲覧・分岐選択を許可し、手動閲覧後は解析局面への追従を停止します。
- 局面ごとの解析時間は探索開始後に計測し、engine 起動や前の探索の停止待ちを含めません。
- 通常停止は terminal output と最終 info を取り込んでから注釈生成・次局面へ進みます。取消は探索結果を無効化する操作として区別します。
- 注釈生成の言語は job 設定に固定し、Server 全体の translation state を変更しません。

棋譜 snapshot の共有境界は [`common/record/snapshot.ts`](../../shogihome/src/common/record/snapshot.ts) を使います。

## Lifecycle and Failure Policy

- 準備・解析・終了処理を経て terminal 状態になります。Engine cleanup 完了までは次の job を受け付けず、待ち行列は持ちません。
- Browser 切断や polling 失敗は取消ではありません。完了・明示的取消・失敗が engine resource の cleanup を所有します。
- 取消は冪等です。進行中の探索を無効化し、停止完了まで Renderer も文書 lock を保持します。取消後の出力や新しい隣接局面コメントは採用しません。
- 有効な途中結果は取消・失敗後も保持します。入力、実行時間、出力、終了待ち、完了 job と作成要求台帳は有界です。
- 失効や Server 再起動では既存 job が失われたことを返し、空の job の再生成や自動再実行はしません。

## HTTP Synchronization

[`routes/analysis_jobs.ts`](../../shogihome/src/server/routes/analysis_jobs.ts) が作成・状態・固定入力・結果・取消の HTTP 境界を所有します。Analysis DB の検索・管理 API とは別の resource です。

- 作成要求は request ID と Server 実体 ID で照合します。同じ入力の再送は既存 job を解決し、同じ ID の異なる入力は拒否します。
- Renderer は重複しない polling を行い、Server の capabilities に従って同期間隔を選びます。一時的な障害では backoff し、rate limit の再試行待ちは `Retry-After` に従います。
- 状態と結果は job／Server 実体 ID で照合します。Revision 差分は各 node の最新注釈を絶対値で返し、再受信による comment の重複を防ぎます。完全結果からも同期できます。
- 通信待ち中は文書 lock、復元用識別子、結果 revision、取消要求を保持します。

## Reload and Safe Result Application

Browser は作成前に小さな request／Server／job linkage を保存し、応答喪失後も request ID から解決します。Job 入力全体を別途 localStorage に複製せず、復元時に Server の固定入力と完全結果を取得します。

現在の文書が固定入力または最新結果と一致する場合だけ自動反映します。別内容の未保存棋譜を置き換える場合は確認と既存 backup を先に行い、復元を断っても job は取り消しません。通常同期中も文書実体・内容を照合し、想定外の編集では反映を停止します。

完了時は Browser の通常の棋譜復元 storage への反映を flush してから linkage を消します。Storage 書き込み失敗時は linkage を保持し、Server の完全結果から復元する経路を残します。結果の保持は棋譜ファイルへの保存を意味しません。永続性の境界は [Storage Architecture](storage.md) を参照してください。
