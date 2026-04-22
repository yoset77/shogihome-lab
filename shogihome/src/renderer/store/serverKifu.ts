import { ref, shallowRef, triggerRef, watch } from "vue";
import { KifuSearchResult } from "@/common/file/record";
import { Record as TssRecord } from "tsshogi";

export type ServerKifuTab = "list" | "search" | "results";

// Singleton states
const activeTab = ref<ServerKifuTab>(
  (localStorage.getItem("serverKifuActiveTab") as ServerKifuTab) || "list",
);
const currentDir = ref("");
const keyword = ref("");
const player1 = ref("");
const player2 = ref("");
const isStrictTurn = ref(localStorage.getItem("serverKifuIsStrictTurn") === "true");
const searchByPosition = ref(localStorage.getItem("serverKifuSearchByPosition") !== "false");
const searchYear = ref("");
const searchMonth = ref("");
const searchResults = ref<KifuSearchResult[]>([]);
const searchRecord = shallowRef(new TssRecord());

function getArrayFromLocalStorage(key: string): string[] {
  try {
    const value = localStorage.getItem(key);
    if (!value) return [];
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

const keywordHistory = ref<string[]>(getArrayFromLocalStorage("serverKifuKeywordHistory"));
const playerHistory = ref<string[]>(getArrayFromLocalStorage("serverKifuPlayerHistory"));

// Persist to localStorage
watch(activeTab, (val) => {
  // メモリ上（Store内）では results を維持するが、アプリ再起動時は search から始まるように保存する
  const persistentTab = val === "results" ? "search" : val;
  localStorage.setItem("serverKifuActiveTab", persistentTab);
});
watch(isStrictTurn, (val) => {
  localStorage.setItem("serverKifuIsStrictTurn", String(val));
});
watch(searchByPosition, (val) => {
  localStorage.setItem("serverKifuSearchByPosition", String(val));
});
watch(
  keywordHistory,
  (val) => {
    localStorage.setItem("serverKifuKeywordHistory", JSON.stringify(val));
  },
  { deep: true },
);
watch(
  playerHistory,
  (val) => {
    localStorage.setItem("serverKifuPlayerHistory", JSON.stringify(val));
  },
  { deep: true },
);

function triggerSearchRecord() {
  triggerRef(searchRecord);
}

function updateHistoryList(list: string[], newValue: string) {
  const index = list.indexOf(newValue);
  if (index >= 0) {
    list.splice(index, 1);
  }
  list.unshift(newValue);
  if (list.length > 10) {
    list.splice(10);
  }
}

function addHistory(keyword: string, p1: string, p2: string) {
  if (keyword) {
    updateHistoryList(keywordHistory.value, keyword);
  }
  if (p1) {
    updateHistoryList(playerHistory.value, p1);
  }
  if (p2) {
    updateHistoryList(playerHistory.value, p2);
  }
}

export function useServerKifuStore() {
  return {
    activeTab,
    currentDir,
    keyword,
    player1,
    player2,
    isStrictTurn,
    searchByPosition,
    searchYear,
    searchMonth,
    searchResults,
    searchRecord,
    keywordHistory,
    playerHistory,
    triggerSearchRecord,
    addHistory,
  };
}
