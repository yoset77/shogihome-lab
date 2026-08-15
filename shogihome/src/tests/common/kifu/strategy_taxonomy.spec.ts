import { describe, expect, it } from "vitest";
import { normalizeManualStrategy } from "@/common/kifu/strategy_taxonomy";

describe("common/kifu/strategy_taxonomy", () => {
  it.each([
    ["角換り", "角換わり"],
    ["角換わり腰掛け銀", "角換わり"],
    ["横歩取り青野流", "横歩取り"],
    ["YAGURA", "矢倉"],
    ["SANKENBISHA", "三間飛車"],
    ["ゴキゲン中飛車", "中飛車"],
    ["角交換型四間飛車", "角交換型振り飛車"],
    ["その他", "その他"],
    ["その他の戦型", "その他"],
    ["力戦", "その他"],
  ])("normalizes %s", (raw, strategy) => {
    expect(normalizeManualStrategy(raw)).toEqual({ raw, strategy });
  });

  it.each([
    "角替わり",
    "横歩取",
    "三間飛",
    "早石田",
    "四間飛",
    "中飛",
    "右四間飛車",
    "角交換型",
    "居飛車",
    "矢倉／雁木",
    "石田流四間飛車",
    "その他派",
    "対その他",
    "戦型テスト",
  ])("preserves unsearchable metadata %s without guessing", (raw) => {
    expect(normalizeManualStrategy(raw)).toEqual({ raw });
  });

  it.each([
    ["相掛かり", "相掛かり"],
    ["角換わり", "角換わり"],
    ["横歩取り", "横歩取り"],
    ["三間飛車", "三間飛車"],
    ["四間飛車", "四間飛車"],
    ["中飛車", "中飛車"],
    ["向かい飛車", "向かい飛車"],
    ["相振り飛車", "相振り飛車"],
    ["矢倉", "矢倉"],
    ["角交換型振り飛車", "角交換型振り飛車"],
    ["雁木", "雁木"],
  ])("normalizes prefix and suffix forms of %s", (strategy, expected) => {
    expect(normalizeManualStrategy(`${strategy}派`)).toEqual({
      raw: `${strategy}派`,
      strategy: expected,
    });
    expect(normalizeManualStrategy(`対${strategy}`)).toEqual({
      raw: `対${strategy}`,
      strategy: expected,
    });
  });

  it.each([
    ["新雁木", "雁木"],
    ["ツノ銀中飛車", "中飛車"],
    ["原始中飛車", "中飛車"],
    ["三間飛車対策", "三間飛車"],
    ["対横歩取り", "横歩取り"],
  ])("normalizes %s through an edge match", (raw, strategy) => {
    expect(normalizeManualStrategy(raw)).toEqual({ raw, strategy });
  });

  it.each([
    ["角交換型雁木", "雁木"],
    ["角交換型角換わり", "角換わり"],
  ])("prefers the canonical edge classification for %s", (raw, strategy) => {
    expect(normalizeManualStrategy(raw)).toEqual({ raw, strategy });
  });

  it("normalizes a retained explicit composite alias", () => {
    expect(normalizeManualStrategy("升田式石田流")).toEqual({
      raw: "升田式石田流",
      strategy: "三間飛車",
    });
  });

  it.each(["ダイレクト向かい飛車", "阪田流向かい飛車", "角交換四間飛車", "角交換型四間飛車"])(
    "normalizes %s as a bishop-exchange ranging rook strategy",
    (raw) => {
      expect(normalizeManualStrategy(raw)).toEqual({ raw, strategy: "角交換型振り飛車" });
    },
  );

  it.each(["未判定", "unknown", "不明", "-"])("preserves manual placeholder %s", (raw) => {
    expect(normalizeManualStrategy(raw)).toEqual({ raw });
  });

  it.each([undefined, " "])("treats %s as absent", (raw) => {
    expect(normalizeManualStrategy(raw)).toEqual({});
  });
});
