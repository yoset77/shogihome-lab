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
const isStrictTurn = ref(false);
const searchByPosition = ref(true);
const searchYear = ref("");
const searchMonth = ref("");
const searchResults = ref<KifuSearchResult[]>([]);
const searchRecord = shallowRef(new TssRecord());

// Persist to localStorage
watch(activeTab, (val) => {
  // メモリ上（Store内）では results を維持するが、アプリ再起動時は search から始まるように保存する
  const persistentTab = val === "results" ? "search" : val;
  localStorage.setItem("serverKifuActiveTab", persistentTab);
});

function triggerSearchRecord() {
  triggerRef(searchRecord);
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
    triggerSearchRecord,
  };
}
