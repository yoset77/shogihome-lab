# Storage Architecture

この文書は、Server filesystem、database、Book session、Browser storageの所有権と整合性境界を説明します。具体的なschema、対応拡張子、resource limitはコード、migration、設定を正本とします。

## Storage Map

| Store                   | Owner                             | Durability and Authority                                        |
| ----------------------- | --------------------------------- | --------------------------------------------------------------- |
| `KIFU_DIR`              | Middle Serverと外部ファイル管理者 | ユーザー管理の棋譜、定跡、SFENの永続的な正本                    |
| `data/analysis.db`      | Analysis DB module                | Engine解析結果の永続データ。`KIFU_DIR` の派生物ではありません。 |
| `data/kifu_index.db`    | Kifu index module                 | `KIFU_DIR` から再構築可能な派生index                            |
| record history / backup | History service                   | Serverで共有する履歴と復元データ                                |
| Book sessions           | Book session manager              | 保存前の変更を含む揮発性の作業状態                              |
| Browser `localStorage`  | Renderer                          | Originと端末に限定された設定、復元情報、接続識別子              |
| Process内cacheとjob map | 各module                          | Process終了時に失われる揮発性状態                               |

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
- Indexのschemaやclassifier versionが変わった場合は、元ファイルから再同期できます。

戦型自動判定の設計意図は [Strategy Inference Intent](../features/strategy-inference.md) を参照してください。

## KIFU_DIR Boundary

[`helpers/kifu.ts`](../../shogihome/src/server/helpers/kifu.ts) がServer側ファイルアクセスの中心的なpath boundaryです。

- 許可するファイル種別を限定します。
- Traversalとconfigured root外へのpath解決を拒否します。
- Existing targetまたは最も近いexisting ancestorのreal pathを確認します。
- Directory scanではsymlinkを追跡しません。
- 外部変更を検出した場合は、関連cacheとindex synchronizationへ通知します。
- Browserからのuploadは既存directoryだけを保存先として許可し、形式別の容量制限を適用してからatomicに公開します。
- Browserからのdirectory作成は、検証済みの既存parent直下の1階層に限定します。共有name validatorとpath resolverで名前・深さ・symlinkを検証し、既存entryは置き換えません。Upload時の保存名指定は、新しいfileの保存先を指定する操作であり、既存fileのrenameではありません。

Rendererの `server://` URIは `KIFU_DIR` 相対pathを表す論理識別子であり、アクセス権限ではありません。各routeはURIを直接filesystem pathとして使用せず、必ずServerのresolverを通します。

主なroute ownerは次のとおりです。

- 棋譜とSFEN: [`routes/kifu.ts`](../../shogihome/src/server/routes/kifu.ts)
- 定跡: [`routes/book.ts`](../../shogihome/src/server/routes/book.ts)
- 解析結果export: [`routes/analysis.ts`](../../shogihome/src/server/routes/analysis.ts)

HostとOriginの検証は [`security.ts`](../../shogihome/src/server/security.ts) が担当します。Session IDや `server://` URIを認証credentialとして扱いません。

## Atomic File Publication

[`file/atomic.ts`](../../shogihome/src/server/file/atomic.ts) と [`file/atomic_stream.ts`](../../shogihome/src/server/file/atomic_stream.ts) は、同じtargetへのwriterを直列化し、temporary fileへの書き込み後にrenameまたはlinkで公開します。

- Readerへ部分的な内容を通常のtargetとして見せないことが目的です。
- 失敗時はtemporary fileをcleanupします。
- 新規作成では存在確認と公開のraceを避けます。
- このatomicityは論理的な公開とwriter排他を意味し、突然のstorage failureに対する完全なdurability保証ではありません。

新しいServer側ファイル保存処理は、特別な理由がない限り既存のatomic helperを使用します。

Browser uploadは1 fileを1 requestのraw bodyとしてstreamingし、全体をmemoryへ保持しません。同時処理数を制限してtemporary fileによるresource消費を抑えます。同名fileは既定で拒否し、明示的に承認されたrequestだけが既存fileを置き換えます。

## Book Sessions

[`bookSessionManager.ts`](../../shogihome/src/server/bookSessionManager.ts) がclient session IDと内部Book sessionを対応付け、[`server/book/`](../../shogihome/src/server/book) がopen file handle、検索、未保存変更を所有します。

- 同じsessionの検索、編集、保存、close、cleanupは同じFIFO lockで直列化します。
- 異なるsessionは並行動作できます。
- Book sessionは作業状態であり、明示的に `KIFU_DIR` へ保存されるまで永続データではありません。
- Session IDはresourceを選択する識別子であり、認証credentialではありません。
- 同じfileを複数sessionが開く場合、file publicationの排他と編集競合の解決は別の問題です。暗黙の共同編集を仮定しません。

### On-the-fly Bookの上書き保存

On-the-fly modeで読み込み中の定跡は、読み込み元のfileへの上書き保存が可能です。公開とsession状態の切り替えは次の契約に従います。

- マージ結果は同じdirectoryの一時fileへ書き出され、writer lock内でatomicなrenameにより公開されます。保存途中の内容がtargetへ公開されることはありません。
- 公開前に、一時fileから読み取りhandleや形式別metadataを含む新しいsession状態を構築して検証します。失敗した場合はtargetを変更せず、元のfile、旧handle、未保存の編集差分をそのまま維持します。
- 公開成功直後（writer lock保持中）に、sessionを準備済みの状態へ切り替えます。sessionは公開済みの内容と一致し、取り込み済みの差分を再適用しません。公開後にtargetのpathを再オープンしないため、別writerによる置換を取り込むこともありません。
- 公開後のcleanup（旧handleのclose、lock解放）の失敗は保存の失敗に変換せず、logに記録します。
- Windowsを含む環境でrenameが許可されない場合は、安全に保存を失敗させます。元fileの削除や直接上書きへのフォールバックは行いません。
- SBKでは、旧sessionのraw dataとindexを保持したまま新しいindexを構築するため、その分をmemory予算に含めて検証します。予算を超える場合は公開前に拒否します。
- この保証は論理的な公開とwriter排他であり、電源断に対する完全なdurability、外部processによる直接書き換え、複数session間の編集競合の自動解決を含みません。

## History and Backups

[`file/history.ts`](../../shogihome/src/server/file/history.ts) がServer共有のrecord historyとbackupを所有します。Read-modify-writeはprocess内lockで直列化し、文書全体をatomicに置き換えます。

共有contractは [`src/common/file/history.ts`](../../shogihome/src/common/file/history.ts)、HTTP boundaryは [`routes/history.ts`](../../shogihome/src/server/routes/history.ts) が所有します。保存されたユーザーpathは履歴metadataであり、検証済みfilesystem capabilityではありません。

## Settings and Browser Storage

Rendererの設定、record recovery、remote engine session ID、feature preferenceなどはBrowser originのstorageへ保存されます。これは端末固有の状態であり、Server共有の正本ではありません。

[`server/settings.ts`](../../shogihome/src/server/settings.ts) が読むServer側設定ファイルは、Browser設定とは別のsourceです。両者が常に同期すると仮定しません。

Browser recovery情報は複数keyまたは一時cacheから構成される場合があるため、読み込み側は欠落や部分的な不整合を許容する必要があります。Server側の永続性が必要なdomain dataをBrowser storageだけへ保存しないでください。
