<template>
  <DialogFrame limited @cancel="emit('close')">
    <div class="root column">
      <div class="title">{{ t.kifuStatisticsTitle }}</div>
      <div class="content form-group column">
        <details class="conditions">
          <summary>{{ t.kifuStatisticsConditions }}</summary>
          <dl>
            <dt>{{ t.keyword }}</dt>
            <dd>{{ query.keyword || t.all }}</dd>
            <dt>{{ query.isStrictTurn ? t.senteOrShitate : t.player1 }}</dt>
            <dd>{{ query.player1 || t.all }}</dd>
            <dt>{{ query.isStrictTurn ? t.goteOrUwate : t.player2 }}</dt>
            <dd>{{ query.player2 || t.all }}</dd>
            <dt>{{ t.startDateTime }}</dt>
            <dd>{{ query.startDate || t.all }}</dd>
            <dt>{{ t.strategy }}</dt>
            <dd>{{ strategyName(query.strategy || "") || t.all }}</dd>
            <template v-if="query.sfen"
              ><dt>{{ t.searchByPosition }}</dt>
              <dd class="sfen">{{ query.sfen }}</dd></template
            >
          </dl>
        </details>
        <div v-if="loading" role="status">{{ t.kifuStatisticsLoading }}</div>
        <div v-if="error" class="warning" role="alert">{{ error }}</div>
        <template v-if="statistics">
          <div class="target-count row align-center wrap">
            <span>{{ t.kifuStatisticsTargetCount(statistics.total) }}</span>
            <span class="collected-at">
              {{ t.kifuStatisticsCollectedAt }}:
              {{ new Date(statistics.generatedAt).toLocaleString() }}
            </span>
          </div>
          <div v-if="countChanged" class="warning">{{ t.kifuStatisticsCountChanged }}</div>
          <div v-if="statistics.total === 0">{{ t.noKifuFound }}</div>
          <template v-else>
            <section>
              <h3>{{ t.strategy }}</h3>
              <p class="note">{{ t.kifuStatisticsStrategyNote }}</p>
              <table>
                <thead>
                  <tr>
                    <th>{{ t.strategy }}</th>
                    <th>{{ t.kifuStatisticsCount }}</th>
                    <th>{{ t.kifuStatisticsRatio }}</th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="row in strategies" :key="row.strategy">
                    <td>{{ strategyName(row.strategy) }}</td>
                    <td>{{ row.count }}</td>
                    <td>{{ row.percentage }}%</td>
                  </tr>
                </tbody>
              </table>
            </section>
            <section>
              <h3>{{ t.playerName }}</h3>
              <table class="players">
                <thead>
                  <tr>
                    <th>{{ t.playerName }}</th>
                    <th>{{ t.senteOrShitate }}</th>
                    <th>{{ t.goteOrUwate }}</th>
                    <th>{{ t.kifuStatisticsTotal }}</th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="row in players" :key="row.name ?? ''">
                    <td>{{ row.name ?? t.kifuStatisticsMissingPlayer }}</td>
                    <td>{{ row.black }}</td>
                    <td>{{ row.white }}</td>
                    <td>{{ row.total }}</td>
                  </tr>
                </tbody>
              </table>
              <div v-if="pageCount > 1" class="pagination row align-center">
                <button
                  :disabled="page === 0"
                  :aria-label="t.kifuStatisticsPreviousPage"
                  @click="page--"
                >
                  ‹
                </button>
                <span>{{ t.kifuStatisticsPage(page + 1, pageCount) }}</span>
                <button
                  :disabled="page + 1 >= pageCount"
                  :aria-label="t.kifuStatisticsNextPage"
                  @click="page++"
                >
                  ›
                </button>
              </div>
            </section>
            <details class="notes">
              <summary>{{ t.kifuStatisticsAbout }}</summary>
              <p class="note">{{ t.kifuStatisticsFileNote }}</p>
              <p class="note">{{ t.kifuStatisticsPlayerNote }}</p>
            </details>
          </template>
        </template>
      </div>
      <div class="main-buttons">
        <button :disabled="loading" @click="reload">{{ t.recalculateKifuStatistics }}</button>
        <button data-hotkey="Escape" @click="emit('close')">{{ t.close }}</button>
      </div>
    </div>
  </DialogFrame>
</template>

<script setup lang="ts">
import { onMounted, onUnmounted } from "vue";
import { t } from "@/common/i18n";
import type { KifuSearchQuery } from "@/common/file/sfen_export";
import { getStrategyName } from "@/common/kifu/strategy";
import { useKifuStatistics } from "@/renderer/store/kifuStatistics";
import DialogFrame from "./DialogFrame.vue";

const props = defineProps<{ search: KifuSearchQuery; searchResultCount: number }>();
const emit = defineEmits<{ close: [] }>();
const {
  query,
  statistics,
  loading,
  error,
  page,
  pageCount,
  players,
  strategies,
  countChanged,
  reload,
  dispose,
} = useKifuStatistics(props.search, props.searchResultCount);

function strategyName(strategy: string): string {
  if (strategy === "raw-only") return t.kifuStatisticsRawStrategy;
  if (strategy === "unclassified") return t.unclassified;
  return getStrategyName(strategy);
}

onMounted(reload);
onUnmounted(dispose);
</script>

<style scoped>
.root {
  width: clamp(320px, 55vw, 780px);
  max-width: 100%;
  gap: 12px;
}
.content {
  overflow-y: auto;
  max-height: calc(85dvh - 150px);
  gap: 10px;
  text-align: left;
}
.conditions summary,
.notes summary {
  cursor: pointer;
}
.target-count {
  gap: 8px;
}
.collected-at {
  font-size: 0.8em;
  color: var(--text-color-sub);
}
dl {
  display: grid;
  grid-template-columns: minmax(90px, auto) 1fr;
  gap: 6px 12px;
}
dd {
  margin: 0;
  overflow-wrap: anywhere;
  min-width: 0;
}
.sfen {
  font-family: monospace;
  font-size: 0.8em;
}
h3,
p {
  margin: 0 0 8px;
}
.note {
  font-size: 0.8em;
  color: var(--text-color-sub);
}
.warning {
  color: var(--text-color-warning);
}
table {
  width: 100%;
  border-collapse: separate;
  border-spacing: 0;
  table-layout: fixed;
}
th,
td {
  padding: 6px;
  border-bottom: 1px solid var(--text-separator-color);
  text-align: right;
  overflow-wrap: anywhere;
}
th {
  background-color: var(--text-bg-color);
  position: sticky;
  top: 0;
  z-index: 1;
}
th:first-child,
td:first-child {
  width: 48%;
  text-align: left;
}
.players th:first-child,
.players td:first-child {
  width: 40%;
}
.pagination {
  justify-content: center;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 10px;
}
@media (max-width: 600px) {
  .root {
    width: 100%;
  }
  th,
  td {
    padding: 4px;
    font-size: 0.85em;
  }
}
</style>
