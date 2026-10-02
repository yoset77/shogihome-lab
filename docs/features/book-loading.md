# Book Loading Intent

## 主な利用対象

主な利用形式はYBB、YaneuraOu DB、SBKとします。YBB／DBは大規模な定跡も対象とし、1局面に4手以上の候補手を持つものを中心に想定します。SBKは数MBから数十MB程度の利用を中心とします。Aperyは互換性を維持しますが、その形式の最悪ケースだけに合わせて他形式の閾値を決めません。

## 読み込み方式とメモリ管理

- ファイルサイズ閾値はIn-memoryとOn-the-flyの選択条件です。展開後のメモリ使用量や複数sessionの合計使用量を制限するものではありません。
- 個人利用を前提に、全sessionの推定メモリ予算は設けません。局面数、候補手数、comment、評価情報、編集差分や切替時の旧・新状態の併存を一律に推定会計する複雑さと、保守的な見積もりによる利用制約を避けます。大規模定跡はOn-the-flyを利用し、session数・idle期限・importの処理制限と形式固有の制約で運用します。
- YBB／DBは保守的な既定閾値で大きい定跡を早めにOn-the-flyへ移しつつ、より大きいIn-memory読み込みを利用者が選べる調整範囲を残します。
- DBのOn-the-flyには局面順の整列が必要です。閾値を下げると未整列のDBを開けなくなる場合があるため、この条件を設定説明に含めます。
- SBKはraw fileの容量制限を持ち、On-the-flyもraw file全体と局面indexを保持するため、専用のindex構築予算を維持します。上書き保存時は旧raw dataとindexの併存も構築予算に含めます。閾値を低くすれば必ず開きやすくなるとは限らないため、小～中規模のIn-memory利用と設定による調整を両立します。

## 設定変更の判断基準

既定値・許容範囲の正本は [`config.ts`](../../shogihome/src/server/config.ts) とLauncherの [`settings.rs`](../../engine-wrapper/launcher/src/settings.rs) です。設定説明は [`.env.example`](../../shogihome/.env.example) とLauncherのi18n resourceへ反映します。

設定値を調整する際は、各形式の代表的な内容と候補手数で、初回読み込み、旧sessionを保持した切替、On-the-fly検索・保存を確認します。ファイルサイズ境界、読み込み失敗時の旧状態保持、SBKのindex構築予算超過時の公開前拒否は別々に検証します。

閾値の調整や形式別のメモリ効率改善は、代表的な定跡で問題が残る場合に個別に検討します。読み込み方式を変更する際はDBの整列条件やSBKの構築予算など、切替先の制約も評価します。
