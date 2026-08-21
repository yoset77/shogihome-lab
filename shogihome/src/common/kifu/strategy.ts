import { t } from "@/common/i18n";

export {
  searchableStrategies,
  UNCLASSIFIED_STRATEGY,
  type SearchableStrategy,
  type StrategySearchFilter,
} from "./strategy_taxonomy";

export function getStrategyName(strategy: string): string {
  switch (strategy) {
    case "相掛かり":
      return t.strategyAigakari;
    case "角換わり":
      return t.strategyKakugawari;
    case "横歩取り":
      return t.strategyYokofudori;
    case "三間飛車":
      return t.strategySankenbisha;
    case "四間飛車":
      return t.strategyShikenbisha;
    case "中飛車":
      return t.strategyNakabisha;
    case "向かい飛車":
      return t.strategyMukaibisha;
    case "相振り飛車":
      return t.strategyAifuribisha;
    case "矢倉":
      return t.strategyYagura;
    case "角交換型振り飛車":
      return t.strategyKakukokanFuribisha;
    case "雁木":
      return t.strategyGangi;
    case "その他":
      return t.strategyOther;
    default:
      return strategy;
  }
}
