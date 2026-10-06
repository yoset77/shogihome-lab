# Storage Architecture

この文書は、Server filesystem、database、Book session、Browser storageの所有権と整合性境界を説明します。具体的なschema、対応拡張子、resource limitはコード、migration、設定を正本とします。

## Storage Map

| Store                    | Owner                             | Durability and Authority                                                              |
| ------------------------ | --------------------------------- | ------------------------------------------------------------------------------------- |
| `KIFU_DIR`               | Middle Serverと外部ファイル管理者 | ユーザー管理の棋譜、定跡、SFENの永続的な正本                                          |
| `data/analysis.db`       | Analysis DB module                | Engine解析結果の永続データ。`KIFU_DIR` の派生物ではありません。                       |
| `data/kifu_index.db`     | Kifu index module                 | `KIFU_DIR` から再構築可能な派生index                                                  |
| record history / backup  | History service                   | Serverで共有する履歴と復元データ                                                      |
| Book sessions            | Book session manager              | 保存前の変更を含む揮発性の作業状態                                                    |
| Analysis jobs            | Analysis job manager              | 固定入力・結果・進捗を持つ有期限の揮発性状態                                          |
| Game sessions            | Game session manager              | 棋譜・時計・checkpoint を持つ有期限の揮発性状態                                       |
| Browser `localStorage`   | Renderer                          | Originと端末に限定された設定、通常の棋譜復元、未確認要求台帳、公開 relay の接続識別子 |
| Browser `sessionStorage` | Renderer                          | タブ固有のジョブへのアタッチ・復帰意図と棋譜内容の照合情報                            |
| Process内cacheとjob map  | 各module                          | Process終了時に失われる揮発性状態                                                     |

Server data rootは [`src/node/proc/path.ts`](../../shogihome/src/node/proc/path.ts)、`KIFU_DIR` の解決は [`src/server/config.ts`](../../shogihome/src/server/config.ts) が所有します。

## Server-owned Databases

### Analysis Database

[`database/sqlite.ts`](../../shogihome/src/server/database/sqlite.ts) が `analysis.db` を所有します。Engine sessionが正規化局面と完了した解析結果を供給し、[`routes/analysis.ts`](../../shogihome/src/server/routes/analysis.ts) が検索、管理、exportのHTTP境界を提供します。

- 局面、engine、解析結果にまたがる更新はtransactionで適用します。
- Position hashは検索indexであり、identityの唯一の根拠ではありません。正規化SFENも比較します。
- 競合する解析結果の優先規則はDB implementationとテストを正本とします。
- Analysis DBはkifu indexとは独立しており、一方を他方から再構築しません。

### Kifu Index

[`database/kifu_index.ts`](../../shogihome/src/server/database/kifu_index.ts) が `kifu_index.db`、[`kifu_index/sync.ts`](../../shogihome/src/server/kifu_index/sync.ts) が `KIFU_DIR` との同期を所有します。

- Indexは検索を高速化する派生データであり、元ファイルの正本ではありません。
- File更新時はmetadata、局面関連、不要になった関連データをtransactionalに更新します。
- Full syncとfilesystem event処理を調停し、同じsingleton DBへの競合更新を避けます。
- 外部変更の検出とparseの間は一時的に以前のindexが見える可能性があります。
- 全件同期と監視eventの双方で既存のpath boundaryを通し、root配下のsymlinkや対象外fileを読み込みません。削除や対象外への置換は派生indexにも反映します。
- Watcherはconfigured rootのreal pathを基準に監視します。Atomic writerの内部名前空間は監視対象から除外し、内部lockの変化をユーザーファイルの変更として扱いません。
- Indexのschemaやclassifier versionが変わった場合は、元ファイルから再同期できます。
- 局面関連は同一file・正規化SFENを1件にまとめ、共有の深さ優先走査で最初の箇所を代表とします。その箇所の先頭の継続手と変化手順内かどうかも保持します。Previewとopenも同じ共有選択規則を使います。継続手の未取得と、取得済みだが継続がない状態は区別します。
- 局面関連の派生情報は戦型判定とは別の版で追跡します。Fileが未変更でも局面情報の版が古い場合は関連全体を再構築し、戦型だけのbackfillでは更新済みとみなしません。
- 検索統計は検索・件数取得と同じSQL条件から全一致fileを集計します。一覧のpaginationは集計対象に影響せず、戦型・対局者と、局面検索時の代表次手の集計を同一read transactionで取得します。集計時点のindexを対象とし、過去の検索結果を固定保存する機能ではありません。
- 対局者統計はDB集計後に上位件数を制限して返し、省略分の先後別登場件数を別fieldで保持します。共有decoderは返却件数の上限と、上位・省略分を合わせた各側の件数および総登場件数を検証します。Rendererは上位と省略分を表示し、対局者表のpaginationは行いません。

戦型自動判定の設計意図は [Strategy Inference Intent](../features/strategy-inference.md) を参照してください。
棋譜検索の代表局面と集計単位の設計意図は [Server Kifu Search](../features/server-kifu-search.md) を参照してください。

## KIFU_DIR Boundary

[`helpers/kifu.ts`](../../shogihome/src/server/helpers/kifu.ts) がServer側ファイルアクセスの中心的なpath boundaryです。

- 許可するファイル種別を限定します。
- Traversalとconfigured root外へのpath解決を拒否します。
- Existing targetまたは最も近いexisting ancestorのreal pathを確認します。
- Directory scanではsymlinkを追跡しません。
- 外部変更を検出した場合は、関連cacheとindex synchronizationへ通知します。
- 棋譜・定跡保存、export、uploadは同じ書き込み専用resolverを使い、保存先の全segment・既存parent・file種別を検証します。新規保存は競合を拒否し、明示的な上書きだけを許可します。
- Directory作成は検証済みの既存parent直下に限定し、既存entryを置き換えません。保存時の暗黙の再帰的directory作成とは区別します。

Rendererの `server://` URIは `KIFU_DIR` 相対pathを表す論理識別子であり、アクセス権限ではありません。各routeはURIを直接filesystem pathとして使用せず、必ずServerのresolverを通します。

主なroute ownerは次のとおりです。

- 棋譜とSFEN: [`routes/kifu.ts`](../../shogihome/src/server/routes/kifu.ts)
- 定跡: [`routes/book.ts`](../../shogihome/src/server/routes/book.ts)
- 解析結果export: [`routes/analysis.ts`](../../shogihome/src/server/routes/analysis.ts)

Bodyの形状検証は [`routes/body.ts`](../../shogihome/src/server/routes/body.ts)、共通のエラー応答は [`errors.ts`](../../shogihome/src/server/errors.ts) が所有します。Routeごとに独自のparserやエラー契約を持ちません。

HostとOriginの検証は [`security.ts`](../../shogihome/src/server/security.ts) が担当します。Session IDや `server://` URIを認証credentialとして扱いません。

## Atomic File Publication

[`file/atomic.ts`](../../shogihome/src/server/file/atomic.ts) と [`file/atomic_stream.ts`](../../shogihome/src/server/file/atomic_stream.ts) は、同じtargetへのwriterを直列化し、temporary fileへの書き込み後にrenameまたはlinkで公開します。

- Readerへ部分的な内容を通常のtargetとして見せないことが目的です。
- 失敗時はtemporary fileをcleanupします。
- 新規作成では存在確認と公開のraceを避けます。
- 非上書き保存は内容生成前に通常の競合を返し、公開時にも競合を拒否します。事前の存在確認だけで安全とみなしません。
- Atomic writerは親directoryを暗黙に作成しません。`KIFU_DIR`内の保存は検証済みの既存parentに限定します。Server内部の履歴用directoryなどは、そのデータ所有者が作成します。
- Writer lockの名前空間は内部専用です。共有name validatorとpath resolverでユーザーからの作成・アクセスを拒否し、一覧や監視へ公開しません。
- このatomicityは論理的な公開とwriter排他を意味し、突然のstorage failureに対する完全なdurability保証ではありません。

新しいServer側ファイル保存処理は、特別な理由がない限り既存のatomic helperを使用します。

## Browser File Addition

Renderer storeが保存名・保存先を固定したbatchと競合再送を、UIがfile選択・確認を所有します。Middle Serverは名前・path・容量を再検証し、uploadとdirectory作成を実行します。Uploadによる棋譜やBook sessionの変更は行いません。

Uploadはraw bodyをtemporary fileへstreamingし、完成したfileだけをatomicに公開します。容量と同時処理数はServer側で制限します。新しい保存名の指定は既存fileのrenameではなく、directory作成も明示的な独立操作です。Kifu indexはfilesystem eventから更新し、upload routeからDBを直接更新しません。

追加・上書き・batch失敗の判断理由は [Server File Upload](../features/server-file-upload.md)、名前や容量の具体的な制約は共有validator・各route・[`config.ts`](../../shogihome/src/server/config.ts) を参照してください。

## Book Sessions

[`bookSessionManager.ts`](../../shogihome/src/server/bookSessionManager.ts) がclient session IDと内部Book sessionを対応付け、[`server/book/`](../../shogihome/src/server/book) がopen file handle、検索、未保存変更を所有します。

- 同じsessionの検索、編集、保存、close、cleanupは同じFIFO lockで直列化します。
- 異なるsessionは並行動作できます。
- Session数とidle期限にはserver側の上限を適用します。保持・構築データや編集差分に対する全sessionの推定メモリ会計は行いません。
- Session作成は明示的なopen／clearだけが行います。検索・保存・変更で失効・未知のIDを空sessionとして再生成せず、Rendererも自動clearで回復しません。
- Book openは新しい定跡を構築してからsessionを切り替えます。読み込みや形式別の検証に失敗した場合は、旧sessionと未保存変更を保持します。
- In-memory / On-the-fly は形式別のファイルサイズ閾値で選びます。閾値は展開後のメモリ使用量や複数sessionの合計を制限するものではありません。
- Importはresource制限と事前検証を終えてから一括反映し、途中失敗で既存entryや未保存変更を失いません。処理上限は [`import_limits.ts`](../../shogihome/src/server/book/import_limits.ts) を正本とします。
- Book更新のHTTP境界では既存のSFEN・指し手decoderと形式別validatorを使用します。Batch検索とimportは重い事前処理でもevent loopの実行機会を確保し、HTTP／WebSocket中継を長時間ブロックしません。
- Book sessionは作業状態であり、明示的に `KIFU_DIR` へ保存されるまで永続データではありません。
- Session IDはresourceを選択する識別子であり、認証credentialではありません。
- 同じfileを複数sessionが開く場合、file publicationの排他と編集競合の解決は別の問題です。暗黙の共同編集を仮定しません。

YBB／DBのOn-the-flyはfile handleを中心とし、SBKはraw dataと局面indexを保持します。SBKのindex構築予算はこの局所的な構築に対する制約であり、process全体のメモリ上限ではありません。設定の既定値・範囲は [`config.ts`](../../shogihome/src/server/config.ts)、運用上の説明は [`.env.example`](../../shogihome/.env.example)、形式別の判断理由は [Book Loading](../features/book-loading.md) を参照してください。

### On-the-fly Bookの上書き保存

On-the-fly modeで読み込み中の定跡は、読み込み元のfileへの上書き保存が可能です。公開とsession状態の切り替えは次の契約に従います。

- 公開前に新しい読み取り状態を構築・検証し、失敗時は元file、旧handle、未保存差分を保持します。SBKの予算検証も旧・新状態の併存を含めて公開前に終えます。
- Atomic publicationとsessionの切替は同じwriter lock内で確定します。公開した内容とsessionを一致させ、反映済み差分の再適用や別writerの内容の取り込みを防ぎます。
- 公開後のcleanup失敗は保存失敗へ変換せず、logに記録します。OSがatomicな置換を許可しない場合は公開を失敗させ、元fileの削除・直接上書きへfallbackしません。
- この保証は複数session間の編集競合の自動解決や外部processによる直接書き換えを含みません。

## History and Backups

[`file/history.ts`](../../shogihome/src/server/file/history.ts) がServer共有のrecord historyとbackupを所有します。Read-modify-writeはprocess内lockで直列化し、文書全体をatomicに置き換えます。

共有contractは [`src/common/file/history.ts`](../../shogihome/src/common/file/history.ts)、HTTP boundaryは [`routes/history.ts`](../../shogihome/src/server/routes/history.ts) が所有します。保存されたユーザーpathは履歴metadataであり、検証済みfilesystem capabilityではありません。

履歴は件数を限定した復元用データであり、全対局を保存するarchiveではありません。対局側の保存・登録の順序は [Game Session Architecture](game-sessions.md)、既存履歴を再利用する理由は [Game Sessions](../features/game-sessions.md) を参照してください。

## Record Snapshots and Session Recovery

[`common/record/snapshot.ts`](../../shogihome/src/common/record/snapshot.ts) がversion付きの共有棋譜snapshotを所有します。Node identityと棋譜内容を保持し、復元時は既存のSFEN／指し手decoderを通します。Snapshotは通常の棋譜ファイル形式や対局checkpointの代替ではありません。

Game sessionとAnalysis jobはこのcodecを共有しますが、進行状態はServerの揮発性データです。Browser storageには再接続用の識別子と通常の棋譜復元情報を保持し、Server再起動を越えたsession復旧を保証しません。同期・安全な文書反映の契約は [Game Session Architecture](game-sessions.md) と [Analysis Job Architecture](analysis-jobs.md) に記載します。

## Settings and Browser Storage

Rendererの設定、record recovery、remote engine session ID、feature preferenceなどはBrowser originのstorageへ保存されます。これは端末固有の状態であり、Server共有の正本ではありません。

ジョブの復帰意図と未確認要求台帳は [`renderer/store/job_storage.ts`](../../shogihome/src/renderer/store/job_storage.ts) が分離して管理します。台帳は要求の照合にだけ使い、ジョブの選択や自動アタッチの根拠にはしません。通常の棋譜復元は従来の共有 localStorage に残り、アタッチ情報をタブ別にしても別棋譜を置き換える際の確認は省略しません。詳細な同期・移譲契約は上記の subsystem 文書を参照してください。

[`server/settings.ts`](../../shogihome/src/server/settings.ts) が読むServer側設定ファイルは、Browser設定とは別のsourceです。両者が常に同期すると仮定しません。

Browser recovery情報は複数keyまたは一時cacheから構成される場合があるため、読み込み側は欠落や部分的な不整合を許容する必要があります。Server側の永続性が必要なdomain dataをBrowser storageだけへ保存しないでください。
