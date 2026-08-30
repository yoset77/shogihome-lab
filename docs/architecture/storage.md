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

## Book Sessions

[`bookSessionManager.ts`](../../shogihome/src/server/bookSessionManager.ts) がclient session IDと内部Book sessionを対応付け、[`server/book/`](../../shogihome/src/server/book) がopen file handle、検索、未保存変更を所有します。

- 同じsessionの検索、編集、保存、close、cleanupは同じFIFO lockで直列化します。
- 異なるsessionは並行動作できます。
- Book sessionは作業状態であり、明示的に `KIFU_DIR` へ保存されるまで永続データではありません。
- Session IDはresourceを選択する識別子であり、認証credentialではありません。
- 同じfileを複数sessionが開く場合、file publicationの排他と編集競合の解決は別の問題です。暗黙の共同編集を仮定しません。

## History and Backups

[`file/history.ts`](../../shogihome/src/server/file/history.ts) がServer共有のrecord historyとbackupを所有します。Read-modify-writeはprocess内lockで直列化し、文書全体をatomicに置き換えます。

共有contractは [`src/common/file/history.ts`](../../shogihome/src/common/file/history.ts)、HTTP boundaryは [`routes/history.ts`](../../shogihome/src/server/routes/history.ts) が所有します。保存されたユーザーpathは履歴metadataであり、検証済みfilesystem capabilityではありません。

## Settings and Browser Storage

Rendererの設定、record recovery、remote engine session ID、feature preferenceなどはBrowser originのstorageへ保存されます。これは端末固有の状態であり、Server共有の正本ではありません。

[`server/settings.ts`](../../shogihome/src/server/settings.ts) が読むServer側設定ファイルは、Browser設定とは別のsourceです。両者が常に同期すると仮定しません。

Browser recovery情報は複数keyまたは一時cacheから構成される場合があるため、読み込み側は欠落や部分的な不整合を許容する必要があります。Server側の永続性が必要なdomain dataをBrowser storageだけへ保存しないでください。
