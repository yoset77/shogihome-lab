import { computed, ref } from "vue";
import type { KifuSearchQuery } from "@/common/file/sfen_export";
import type { KifuSearchStatistics } from "@/common/file/kifu_statistics";
import { t } from "@/common/i18n";
import api from "@/renderer/ipc/api";

export function useKifuStatistics(search: KifuSearchQuery, searchResultCount: number) {
  const query = { ...search };
  const statistics = ref<KifuSearchStatistics>();
  const loading = ref(false);
  const error = ref("");
  const page = ref(0);
  const pageSize = 50;
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
      page.value = 0;
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
    page,
    reload,
    dispose: () => {
      requestVersion++;
    },
    countChanged: computed(
      () => statistics.value !== undefined && statistics.value.total !== searchResultCount,
    ),
    pageCount: computed(() =>
      Math.max(1, Math.ceil((statistics.value?.players.length ?? 0) / pageSize)),
    ),
    players: computed(
      () =>
        statistics.value?.players.slice(page.value * pageSize, (page.value + 1) * pageSize) ?? [],
    ),
    strategies: computed(
      () =>
        statistics.value?.strategies.map((row) => ({
          ...row,
          percentage: statistics.value!.total
            ? ((row.count * 100) / statistics.value!.total).toFixed(1)
            : "—",
        })) ?? [],
    ),
  };
}
