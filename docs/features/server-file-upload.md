# Server File Upload

この文書は、Browserから`KIFU_DIR`へ棋譜、定跡、SFEN fileを追加する機能の設計意図と判断基準を記録します。対応拡張子と容量上限の現行値はcodeと設定を正本とします。

## Intent

同期folderを`KIFU_DIR`に指定していないdeviceからも、serverが管理する棋譜や定跡を追加できるようにします。Uploadは現在開いている棋譜やBook sessionを変更せず、userが選択したfileのbyte列をそのまま保存します。

保存名の変更と保存先folderの作成をupload画面内で提供し、local fileの改名やserver側の手動操作なしに同名競合の回避と分類を行えるようにします。既存server fileのrenameや削除は、この機能に含めません。

## Safety

- Browserが送るfile名やdirectory名をfilesystem capabilityとして扱いません。
- 保存先は`KIFU_DIR`内の既存directoryに限定し、Serverのpath resolverで再検証します。
- 新規folderは検証済みの既存parent直下に1階層だけ作成します。再帰的な作成、symlinkを経由するparent、深さ制限超過を許可せず、同名entryとの競合では既存entryを変更しません。
- 新しい保存名とfolder名はBrowserとServerの共有validatorで検証します。空名、hidden name、path区切り、制御文字、Windowsの禁止文字・予約名、末尾のdotや前後の空白を拒否し、lock用suffixを考慮してUTF-8 byte長も制限します。
- Atomic writerが使う`*.lock` directoryは保存先に表示せず、その内部へのuploadやfolder作成、同名folderの新規作成も拒否します。大文字小文字やWindowsの末尾dot/spaceによる別表記も予約対象とし、内部lockの更新時刻をuser操作で変更させません。
- 1 fileを1 requestとしてstreamingし、file種別ごとの容量上限を適用します。
- 同時に処理するupload数を制限し、temporary fileによるdiskとfile descriptorの消費を抑えます。
- 完了前のfileをreaderやindexへ公開せず、atomic helperで完成したfileだけを公開します。
- 同名fileは既定で拒否し、userが競合fileの上書きを承認した場合だけ置き換えます。

## Batch Behavior

複数選択はfile単位のuploadを順番に実行します。新規fileの成功は維持し、競合したfileだけをまとめてuserへ確認して再送します。1件の失敗によって、別の成功済みfileを削除しません。

保存名はfileごとに編集し、元の拡張子とbyte列は維持します。同じlocal file名でも異なる保存名なら同時に選択できます。保存名の検証とcase-insensitiveな重複検出は送信開始前に行います。送信開始時に保存名と保存先を固定し、競合確認には実際の保存先pathを表示して、承認後も同じpathへ再送します。

Folder作成に成功すると、そのfolderを保存先に選択します。作成済みfolderはuploadをキャンセルしても残します。名前の検証失敗やfolder作成失敗では選択fileと入力値を維持し、userが修正して再試行できるようにします。

## Ownership

- Renderer storeは保存名の検証、batchのsnapshot、競合再送の対象を所有し、UIはfile選択、保存名編集、保存先選択、folder作成操作、競合確認、結果表示を所有します。
- Middle Serverはrequest validation、resource limit、path boundary、folder作成、atomic publicationを所有します。
- Kifu indexは従来どおりfilesystem eventから更新され、upload routeはindex databaseを直接正本として更新しません。
