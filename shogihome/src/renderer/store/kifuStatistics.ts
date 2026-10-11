import { computed, ref } from "vue";
import type { KifuSearchQuery } from "@/common/file/sfen_export";
import type { KifuSearchStatistics } from "@/common/file/kifu_statistics";
import { t } from "@/common/i18n";
import api from "@/renderer/ipc/api";

export function useKifuStatistics(search: KifuSearchQuery, initialSearchResultCount: number) {
  // Snapshot the executed query and count for this dialog's lifetime.
  const query = { ...search };
  const statistics = ref<KifuSearchStatistics>();
  const loading = ref(false);
  const error = ref("");
  let requestVersion = 0;

  async function reload() {
    if (loading.value) return;
    const version = ++requestVersion;
    loading.value = true;
    error.value = "";
    try {
      const result = await api.getServerKifuStatistics(query);
      if (version !== requestVersion) return;
      statistics.value = result;
    } catch (e) {
      if (version !== requestVersion) return;
      console.warn(e);
      error.value = t.kifuStatisticsFailed;
    } finally {
      if (version === requestVersion) loading.value = false;
    }
  }

  return {
    query,
    statistics,
    loading,
    error,
    reload,
    dispose: () => {
      requestVersion++;
    },
    countChanged: computed(
      () => statistics.value !== undefined && statistics.value.total !== initialSearchResultCount,
    ),
    players: computed(() => statistics.value?.players ?? []),
    otherPlayers: computed(() => statistics.value?.otherPlayers),
    strategies: computed(
      () =>
        statistics.value?.strategies.map((row) => ({
          ...row,
          percentage: statistics.value!.total
            ? ((row.count * 100) / statistics.value!.total).toFixed(1)
            : "—",
        })) ?? [],
    ),
    nextMoves: computed(
      () =>
        statistics.value?.nextMoves?.map((row) => ({
          ...row,
          percentage: statistics.value!.total
            ? ((row.count * 100) / statistics.value!.total).toFixed(1)
            : "—",
        })) ?? [],
    ),
  };
}
