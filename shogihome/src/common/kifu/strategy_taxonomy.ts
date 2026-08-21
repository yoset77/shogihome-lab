export const searchableStrategies = [
  "相掛かり",
  "角換わり",
  "横歩取り",
  "三間飛車",
  "四間飛車",
  "中飛車",
  "向かい飛車",
  "相振り飛車",
  "矢倉",
  "角交換型振り飛車",
  "雁木",
  "その他",
] as const;

export type SearchableStrategy = (typeof searchableStrategies)[number];
export const UNCLASSIFIED_STRATEGY = "unclassified" as const;
export type StrategySearchFilter = SearchableStrategy | typeof UNCLASSIFIED_STRATEGY;
export type StrategySource = "metadata" | "rule" | "inferred";

const EXACT_STRATEGIES: Record<string, SearchableStrategy> = {
  相掛かり: "相掛かり",
  相掛り: "相掛かり",
  相懸かり: "相掛かり",
  相懸り: "相掛かり",
  aigakari: "相掛かり",
  角換わり: "角換わり",
  角換り: "角換わり",
  角替り: "角換わり",
  kakugawari: "角換わり",
  横歩取り: "横歩取り",
  yokofudori: "横歩取り",
  三間飛車: "三間飛車",
  "3間飛車": "三間飛車",
  sangenbisha: "三間飛車",
  sankenbisha: "三間飛車",
  四間飛車: "四間飛車",
  "4間飛車": "四間飛車",
  shikenbisha: "四間飛車",
  中飛車: "中飛車",
  nakabisha: "中飛車",
  向かい飛車: "向かい飛車",
  向い飛車: "向かい飛車",
  向飛車: "向かい飛車",
  mukaibisha: "向かい飛車",
  相振り飛車: "相振り飛車",
  相振飛車: "相振り飛車",
  相振り: "相振り飛車",
  aifuribisha: "相振り飛車",
  矢倉: "矢倉",
  相矢倉: "矢倉",
  yagura: "矢倉",
  角交換型振り飛車: "角交換型振り飛車",
  角交換振り飛車: "角交換型振り飛車",
  角交換型四間飛車: "角交換型振り飛車",
  角交換四間飛車: "角交換型振り飛車",
  ダイレクト向かい飛車: "角交換型振り飛車",
  阪田流向かい飛車: "角交換型振り飛車",
  kks: "角交換型振り飛車",
  雁木: "雁木",
  雁木囲い: "雁木",
  gangi: "雁木",
  その他: "その他",
  その他の戦型: "その他",
  other: "その他",
  力戦: "その他",
};

const EDGE_STRATEGY_ALIASES: readonly [string, SearchableStrategy][] = [
  ["石田流", "三間飛車"],
  ["藤井システム", "四間飛車"],
  ["青野流", "横歩取り"],
  ["脇システム", "矢倉"],
];

function normalizeForMatching(value: string): string {
  return value.normalize("NFKC").trim().replace(/\s+/g, " ").toLowerCase();
}

export function normalizeManualStrategy(rawValue: string | undefined): {
  raw?: string;
  strategy?: SearchableStrategy;
} {
  const raw = rawValue?.trim();
  if (!raw) return {};
  const normalized = normalizeForMatching(raw);
  const exact = EXACT_STRATEGIES[normalized];
  if (exact) return { raw, strategy: exact };
  if (normalized.includes("右四間飛車")) return { raw };

  const matches = new Set<SearchableStrategy>();
  for (const strategy of searchableStrategies) {
    if (strategy === "その他") continue;
    if (normalized.startsWith(strategy) || normalized.endsWith(strategy)) {
      matches.add(strategy);
    }
  }
  for (const [alias, strategy] of EDGE_STRATEGY_ALIASES) {
    if (normalized.startsWith(alias) || normalized.endsWith(alias)) {
      matches.add(strategy);
    }
  }
  return matches.size === 1 ? { raw, strategy: matches.values().next().value } : { raw };
}
