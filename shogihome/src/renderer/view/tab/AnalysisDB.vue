<template>
  <div>
    <div class="full column root">
      <!-- Desktop Layout -->
      <div v-if="!mobileLayout" class="list-area" :style="{ height: `${size.height - 2}px` }">
        <table v-if="formattedResults.length > 0" class="list">
          <thead>
            <tr class="list-header">
              <td class="engine-name">{{ t.engineName }}</td>
              <td class="multipv-index">{{ t.rank }}</td>
              <td class="depth">{{ t.depth }}</td>
              <td class="nodes">{{ t.nodes }}</td>
              <td class="score">{{ t.score }}</td>
              <td class="score-flag"></td>
              <td class="text">{{ t.pv }}</td>
            </tr>
          </thead>
          <tbody>
            <tr v-for="info in formattedResults" :key="info.id" class="list-item">
              <td class="engine-name" :title="info.engineName">{{ info.engineName }}</td>
              <td class="multipv-index">{{ info.multipv }}</td>
              <td class="depth">
                {{ info.depth
                }}{{ info.selectiveDepth !== undefined ? `/${info.selectiveDepth}` : "" }}
              </td>
              <td class="nodes">{{ info.nodesText }}</td>
              <td class="score">{{ info.scoreText }}</td>
              <td class="score-flag"></td>
              <td class="text">
                <button v-if="info.pv && info.pv.length > 0" @click="showPreview(info)">
                  <Icon :icon="IconType.PLAY" />
                  <span>{{ t.displayPVShort }}</span>
                </button>
                {{ info.pvText }}
              </td>
            </tr>
          </tbody>
        </table>
        <div v-else class="no-data full column center">
          <div v-if="!searching">
            <div v-if="!isAutoSearchEnabled && !searched" class="control">
              <button class="large" @click="fetchResults">
                <span>{{ t.search }}</span>
              </button>
            </div>
            <div v-else>{{ t.noDataInAnalysisDB }}</div>
          </div>
        </div>
      </div>

      <!-- Mobile Layout -->
      <div v-else class="mobile-list-area" :style="{ height: `${size.height - 2}px` }">
        <div v-if="formattedResults.length > 0">
          <div v-for="info in formattedResults" :key="info.id" class="mobile-pv-card">
            <div class="mobile-pv-header">
              <span class="multipv-index">[{{ info.multipv }}]</span>
              <span class="score"
                >{{ t.score }}: {{ info.scoreText }}
                <span class="engine-name">{{ info.engineName }}</span></span
              >
              <button
                v-if="info.pv && info.pv.length > 0"
                class="play-button"
                @click="showPreview(info)"
              >
                <Icon :icon="IconType.PLAY" />
                <span>{{ t.displayPVShort }}</span>
              </button>
            </div>
            <div class="mobile-pv-text">
              {{ info.pvText }}
            </div>
          </div>
        </div>
        <div v-else class="no-data full column center">
          <div v-if="!searching">
            <div v-if="!isAutoSearchEnabled && !searched" class="control">
              <button class="large" @click="fetchResults">
                <span>{{ t.search }}</span>
              </button>
            </div>
            <div v-else>{{ t.noDataInAnalysisDB }}</div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch, onUnmounted } from "vue";
import { useStore } from "@/renderer/store";
import { useAppSettings } from "@/renderer/store/settings";
import { t } from "@/common/i18n";
import { IconType } from "@/renderer/assets/icons";
import Icon from "@/renderer/view/primitive/Icon.vue";
import { RectSize } from "@/common/assets/geometry.js";
import { NodeCountFormat, EvaluationViewFrom, AnalysisDBSearchMode } from "@/common/settings/app";
import { AppState } from "@/common/control/state";
import { Move, Color } from "tsshogi";
import { formatDisplayPV } from "@/renderer/helpers/pv";

defineProps({
  size: { type: RectSize, required: true },
  mobileLayout: { type: Boolean, default: false },
  allowPlay: { type: Boolean, default: true },
});

interface DBRecord {
  engine_name: string;
  multipv: number;
  depth: number;
  seldepth: number | null;
  nodes: number | null;
  score_cp: number | null;
  score_mate: number | null;
  pv: string | null;
  updated_at: number;
}

interface FormattedInfo {
  id: string;
  engineName: string;
  multipv: number;
  depth: number;
  selectiveDepth?: number;
  nodes?: number;
  nodesText: string;
  scoreText: string | number;
  pv: Move[];
  pvText: string;
  color: Color;
  scoreCp?: number;
  scoreMate?: number;
}

const store = useStore();
const appSettings = useAppSettings();
const results = ref<DBRecord[]>([]);
const searched = ref(false);
const searching = ref(false);
let debounceTimer: ReturnType<typeof setTimeout> | null = null;

const isGame = computed(() => {
  return store.appState === AppState.GAME || store.appState === AppState.CSA_GAME;
});

const isAutoSearchEnabled = computed(() => {
  const searchMode = appSettings.analysisDBSearchMode;
  return (
    searchMode === AnalysisDBSearchMode.ALWAYS ||
    (searchMode === AnalysisDBSearchMode.EXCEPT_GAMES && !isGame.value)
  );
});

onUnmounted(() => {
  if (debounceTimer) {
    clearTimeout(debounceTimer);
  }
});

const fetchResults = async () => {
  const requestedSfen = store.record.position.sfen;
  searching.value = true;
  try {
    const url = `/api/analysis?sfen=${encodeURIComponent(requestedSfen)}`;
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }
    const data = await response.json();
    if (store.record.position.sfen === requestedSfen) {
      results.value = data;
      searched.value = true;
    }
  } catch (e) {
    console.error("Failed to fetch DB results:", e);
    if (store.record.position.sfen === requestedSfen) {
      results.value = [];
      searched.value = true;
    }
  } finally {
    if (store.record.position.sfen === requestedSfen) {
      searching.value = false;
    }
  }
};

watch(
  [() => store.record.position.sfen, isAutoSearchEnabled],
  ([sfen, autoSearchEnabled], [oldSfen]) => {
    if (sfen !== oldSfen) {
      results.value = [];
      searched.value = false;
    }
    if (debounceTimer) clearTimeout(debounceTimer);
    if (autoSearchEnabled && !searched.value) {
      searching.value = true;
      debounceTimer = setTimeout(fetchResults, 300);
    } else {
      searching.value = false;
    }
  },
  { immediate: true },
);

const formatNodeCount = computed(() => {
  switch (appSettings.nodeCountFormat) {
    case NodeCountFormat.COMMA_SEPARATED:
      return (count: number) => count.toLocaleString();
    case NodeCountFormat.COMPACT:
      return Intl.NumberFormat("en-US", { notation: "compact" }).format;
    case NodeCountFormat.JAPANESE:
      return Intl.NumberFormat("ja-JP", { notation: "compact" }).format;
    default:
      return (count: number) => count.toString();
  }
});

const evaluationViewFrom = computed(() => {
  return appSettings.evaluationViewFrom;
});

const getDisplayScore = (score: number, color: Color, viewFrom: EvaluationViewFrom) => {
  return viewFrom === EvaluationViewFrom.EACH || color === Color.BLACK ? score : -score;
};

const formattedResults = computed<FormattedInfo[]>(() => {
  const position = store.record.position;
  return results.value.map((r, index) => {
    let scoreText: string | number = "---";

    if (r.score_mate !== null) {
      const displayScore = getDisplayScore(r.score_mate, position.color, evaluationViewFrom.value);
      scoreText = Math.abs(displayScore) >= 10000 ? t.mateShort : `${t.mateShort}${displayScore}`;
    } else if (r.score_cp !== null) {
      scoreText = getDisplayScore(r.score_cp, position.color, evaluationViewFrom.value);
    }

    const { parsedPv, text: pvText } = formatDisplayPV(
      position,
      r.pv?.split(" "),
      appSettings.analysisDBMaxPVLength,
    );

    return {
      id: `${r.engine_name}-${r.multipv}-${index}`,
      engineName: r.engine_name,
      multipv: r.multipv,
      depth: r.depth,
      selectiveDepth: r.seldepth ?? undefined,
      nodes: r.nodes ?? undefined,
      nodesText: r.nodes ? formatNodeCount.value(r.nodes) : "---",
      scoreText,
      scoreFlag: "",
      pv: parsedPv,
      pvText,
      color: position.color,
      scoreCp: r.score_cp ?? undefined,
      scoreMate: r.score_mate ?? undefined,
    };
  });
});

const showPreview = (info: FormattedInfo) => {
  if (info.pv && info.pv.length > 0) {
    const pos = store.record.position.clone();
    const pvMoves: Move[] = [];
    for (const move of info.pv) {
      if (!pos.doMove(move)) {
        break;
      }
      pvMoves.push(move);
    }
    store.showPVPreviewDialog({
      position: store.record.position,
      engineName: info.engineName,
      multiPV: info.multipv,
      depth: info.depth,
      selectiveDepth: info.selectiveDepth,
      nodes: info.nodes,
      score: info.scoreCp,
      mate: info.scoreMate,
      lowerBound: false,
      upperBound: false,
      pv: pvMoves,
    });
  }
};
</script>

<style scoped>
.root {
  position: relative;
  padding-bottom: 2px;
  background-color: var(--active-tab-bg-color);
}
.control {
  box-sizing: border-box;
}
.list-area {
  width: 100%;
  overflow-y: scroll;
  background-color: var(--text-bg-color);
  color: var(--text-color);
  display: flex;
  flex-direction: column;
}
table.list {
  width: 100%;
  max-width: 100%;
  border-collapse: collapse;
  flex-shrink: 0;
}
tr.list-header > td {
  height: 16px;
  width: 100%;
  font-size: 12px;
  background-color: var(--text-bg-color);
  color: var(--text-color);
  position: sticky;
  top: 0;
  left: 0;
}
tr.list-item > td {
  height: 24px;
  font-size: 12px;
}
table.list td {
  box-sizing: border-box;
  border: 0;
  padding: 0;
  height: 100%;
  white-space: nowrap;
  overflow: hidden;
  padding-left: 4px;
}
table.list td.engine-name {
  width: 160px;
  max-width: 160px;
  text-align: left;
  text-overflow: ellipsis;
}
table.list td.multipv-index {
  width: 30px;
  text-align: right;
}
table.list td.depth {
  width: 50px;
  text-align: right;
}
table.list td.nodes {
  width: 80px;
  text-align: right;
}
table.list td.score {
  width: 60px;
  text-align: right;
}
table.list td.score-flag {
  width: 25px;
  text-align: left;
}
table.list td.text {
  max-width: 0;
  text-align: left;
  text-overflow: ellipsis;
  overflow: hidden;
}
.no-data {
  box-sizing: border-box;
  width: 100%;
  flex: 1;
  display: flex;
  flex-direction: column;
  justify-content: center;
  align-items: center;
  padding: 1rem;
  color: var(--text-color-light);
}
button.large {
  padding: 8px 16px;
  height: auto;
  font-size: 16px;
}
button.large .icon {
  height: 24px;
  width: 24px;
}
button.large span {
  line-height: 24px;
  font-size: 16px;
}
.icon {
  height: 18px;
}
button span {
  line-height: 19px;
  font-size: 12px;
}

/* Mobile */
.mobile-list-area {
  width: 100%;
  height: 100%;
  overflow-y: auto;
  background-color: var(--text-bg-color);
  color: var(--text-color);
  font-size: 14px;
  text-align: left;
  display: flex;
  flex-direction: column;
}
.mobile-pv-card {
  border-bottom: 1px solid var(--text-separator-color);
  padding: 8px 5px;
  color: var(--text-color);
  -webkit-text-fill-color: initial;
  text-shadow: none;
}
.mobile-pv-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 8px;
}
.mobile-pv-header .multipv-index {
  font-weight: bold;
  flex-shrink: 0;
  color: var(--text-color);
}
.mobile-pv-header .score {
  flex-grow: 1;
  text-align: left;
  white-space: nowrap;
  color: var(--text-color);
  overflow: hidden;
  text-overflow: ellipsis;
}
.mobile-pv-header .engine-name {
  margin-left: 12px;
}
.mobile-pv-header .play-button {
  flex-shrink: 0;
  margin: 0;
  padding: 1px 2px;
  height: auto;
}
.mobile-pv-text {
  padding-top: 5px;
  word-break: break-all;
  white-space: normal;
  color: var(--text-color);
}
</style>
