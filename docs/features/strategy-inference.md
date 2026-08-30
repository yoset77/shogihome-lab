# Strategy Inference Intent

この文書は棋譜の戦型自動判定における設計意図と判断基準を記録します。判定規則、閾値、分類、DB schema の現行仕様はコードとテストを正本とし、この文書へ複製しません。

## Goal

戦型検索で有用な分類を提供しつつ、不確実な自動判定によってユーザーが記録した情報を壊したり、誤った検索結果を確定させたりしないことを優先します。判定できない棋譜を残すことは誤分類より安全な結果です。

## Evidence Priority

手動メタデータ、局面の完全一致ルール、モデル推論の順で判定します。

- ユーザーまたは棋譜が明示した戦型は、最も強い根拠として扱います。自動判定は手動記録を上書きしません。
- 局面の完全一致ルールは、特徴が明確な序盤形だけに使います。一般化しすぎたルールによる誤分類を避けるためです。
- モデル推論は、十分な根拠が得られた場合だけ採用します。確信度の低い結果を保存・検索対象にすると、後続の検索や分析で誤った分類が事実のように扱われるためです。

手動メタデータがある棋譜に対して自動判定を実行しないことも、この優先順位を守るための制約です。

## Model Fallbacks

モデルの最上位候補が通常の受理対象にならない場合でも、既知の誤分類傾向を無条件に一般化しません。

- `その他` が最上位となるケースでは、既知の矢倉・雁木の取りこぼしだけを限定的に再評価します。他の戦型へ広げると、根拠のない救済による誤分類を増やすためです。
- 矢倉と雁木は駒組み上どちらにも該当し得ます。この組み合わせだけは、個別分類の優劣だけでなく共通系統としての確信度も考慮します。
- これらの救済でも十分な根拠が得られない場合は、未判定のままにします。

救済対象と受理条件を変更する場合は、誤分類事例と期待する検索上の効果をテストで示してから変更します。

## Manual Metadata Normalization

手動メタデータは、表示用の原文と検索用の標準分類を分離して保持します。

- 明確に一意に対応付けられる別名だけを標準分類へ正規化します。
- 複数分類に解釈できる値、未知の値、誤分類の危険がある表現は原文を保持し、検索用分類へ強制しません。
- 手動メタデータが存在するが標準分類に正規化できない棋譜は、メタデータ自体がない未判定棋譜と区別します。

この方針は、検索の一貫性よりユーザー記録の意味を失わないことを優先します。

## Persistence and Reindexing

戦型は `KIFU_DIR` のユーザーファイルから導かれる検索用データです。元ファイルを正本として扱い、分類ロジックやモデルが変わった場合は再同期で更新できます。

- 判定ロジックの版を追跡し、既存棋譜を必要な範囲で再評価します。局面インデックス全体を不要に再構築しないためです。
- モデルを利用できなかった棋譜を現行判定済みとして確定しません。次回の同期で再試行できるようにします。
- 検索、件数取得、SFEN export は同じ分類条件を共有します。表示と出力で対象棋譜が食い違わないことを守るためです。

## Sources of Truth

- 判定順序、ルール、モデル選択、救済: [`strategy.ts`](../../shogihome/src/server/kifu_index/strategy.ts)
- 棋譜メタデータとの統合と判定結果の保存: [`engine.ts`](../../shogihome/src/server/kifu_index/engine.ts)
- 検索用戦型と手動メタデータの正規化: [`strategy_taxonomy.ts`](../../shogihome/src/common/kifu/strategy_taxonomy.ts)
- モデルの分類と受理条件: [`manifest.json`](../../shogihome/src/server/kifu_index/models/manifest.json)
- 同期と再インデックス: [`sync.ts`](../../shogihome/src/server/kifu_index/sync.ts) と [`kifu_index.ts`](../../shogihome/src/server/database/kifu_index.ts)
- 回帰テスト: [`strategy.spec.ts`](../../shogihome/src/tests/background/kifu_index/strategy.spec.ts)、[`strategy_model.spec.ts`](../../shogihome/src/tests/background/kifu_index/strategy_model.spec.ts)、[`strategy_taxonomy.spec.ts`](../../shogihome/src/tests/common/kifu/strategy_taxonomy.spec.ts)
