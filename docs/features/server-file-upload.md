# Server File Upload

この文書は、Browserから`KIFU_DIR`へ棋譜、定跡、SFEN fileを追加する機能の設計意図と判断基準を記録します。対応拡張子と容量上限の現行値はcodeと設定を正本とします。

## Intent

同期folderを`KIFU_DIR`に指定していないdeviceからも、serverが管理する棋譜や定跡を追加できるようにします。Uploadは現在開いている棋譜やBook sessionを変更せず、userが選択したfileのbyte列をそのまま保存します。

## Safety

- Browserが送るfile名やdirectory名をfilesystem capabilityとして扱いません。
- 保存先は`KIFU_DIR`内の既存directoryに限定し、Serverのpath resolverで再検証します。
- 1 fileを1 requestとしてstreamingし、file種別ごとの容量上限を適用します。
- 同時に処理するupload数を制限し、temporary fileによるdiskとfile descriptorの消費を抑えます。
- 完了前のfileをreaderやindexへ公開せず、atomic helperで完成したfileだけを公開します。
- 同名fileは既定で拒否し、userが競合fileの上書きを承認した場合だけ置き換えます。

## Batch Behavior

複数選択はfile単位のuploadを順番に実行します。新規fileの成功は維持し、競合したfileだけをまとめてuserへ確認して再送します。1件の失敗によって、別の成功済みfileを削除しません。

## Ownership

- Rendererはfile選択、保存先選択、競合確認、結果表示を所有します。
- Middle Serverはrequest validation、resource limit、path boundary、atomic publicationを所有します。
- Kifu indexは従来どおりfilesystem eventから更新され、upload routeはindex databaseを直接正本として更新しません。
