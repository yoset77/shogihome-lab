<script lang="ts">
import { RectSize } from "@/common/assets/geometry";

const MAX_DESKTOP_BOARD_SIZE = 720;
const MIN_DESKTOP_BOARD_SIZE = 500;
const DESKTOP_SEARCH_UI_HEIGHT = 220;
const BASE_SEARCH_BOARD_SIZE = 500;
const MAX_SEARCH_BOARD_CONTROL_SCALE = 1.35;
const BOARD_SIZE_HEIGHT_RATIO = 0.55;

export function getServerKifuBoardMaxSize(
  viewportWidth: number,
  viewportHeight: number,
  isMobile: boolean,
): RectSize {
  if (isMobile) {
    const size = viewportWidth * 0.9;
    return new RectSize(size, size);
  }

  const dynamicMax = Math.min(
    MAX_DESKTOP_BOARD_SIZE,
    Math.max(MIN_DESKTOP_BOARD_SIZE, viewportHeight * BOARD_SIZE_HEIGHT_RATIO),
  );
  const size = Math.max(
    0,
    Math.min(dynamicMax, viewportWidth * 0.5, viewportHeight - DESKTOP_SEARCH_UI_HEIGHT),
  );
  return new RectSize(size, size);
}

export function getServerKifuBoardControlScale(boardSize: number, isMobile: boolean): number {
  if (isMobile) {
    return 1;
  }
  return Math.min(MAX_SEARCH_BOARD_CONTROL_SCALE, Math.max(1, boardSize / BASE_SEARCH_BOARD_SIZE));
}
</script>

<template>
  <DialogFrame ref="dialogFrame" @cancel="onCancel">
    <div class="title">{{ t.serverKifu }}</div>
    <div v-if="indexStatus && indexStatus.isIndexing" class="indexing-status">
      {{ t.indexingKifuProgress(indexStatus.total, indexStatus.indexed) }}
    </div>
    <div class="tab-header row">
      <div class="tab-item" :class="{ active: activeTab === 'list' }" @click="activeTab = 'list'">
        {{ t.list }}
      </div>
      <div
        class="tab-item"
        :class="{ active: activeTab === 'search' }"
        @click="activeTab = 'search'"
      >
        {{ t.search }}
      </div>
      <div
        class="tab-item"
        :class="{ active: activeTab === 'results' }"
        @click="activeTab = 'results'"
      >
        {{ t.results }}
      </div>
    </div>

    <!-- LIST TAB -->
    <div v-if="activeTab === 'list'" class="list-tab column">
      <div class="list-header row align-center justify-between">
        <div class="breadcrumbs row align-center">
          <div class="breadcrumb-item" @click="currentDir = ''">Root</div>
          <template v-for="(dir, index) in breadcrumbs" :key="index">
            <div class="breadcrumb-separator">/</div>
            <div class="breadcrumb-item" @click="currentDir = dir.path">
              {{ dir.name }}
            </div>
          </template>
        </div>
        <button class="reload-btn thin row align-center" :title="t.reload" @click="onReload">
          <Icon :icon="IconType.REFRESH" />
        </button>
      </div>
      <div class="form-group kifu-list">
        <div
          v-for="entry in displayEntries"
          :key="entry.path"
          class="kifu-list-entry row align-center"
        >
          <div class="kifu-header row align-center">
            <span
              v-if="entry.isDirectory"
              class="directory-name"
              @click="currentDir = entry.path"
              >{{ entry.name }}</span
            >
            <span v-else class="file-path">{{ entry.name }}</span>
          </div>
          <div v-if="!entry.isDirectory" class="result-actions row align-center">
            <button :aria-label="t.preview" :title="t.preview" @click="preview(entry.path)">
              <Icon v-if="isMobile" :icon="IconType.PV" />
              <template v-else>{{ t.preview }}</template>
            </button>
            <button :aria-label="t.open" :title="t.open" @click="open(entry.path)">
              <Icon v-if="isMobile" :icon="IconType.OPEN" />
              <template v-else>{{ t.open }}</template>
            </button>
          </div>
        </div>
        <div v-if="list.length === 0" class="note">
          {{ t.noKifuFoundCheckKifuDir }}
        </div>
      </div>
    </div>

    <!-- SEARCH TAB -->
    <div v-if="activeTab === 'search'" class="search-tab column">
      <div class="search-params">
        <div class="search-content">
          <div class="search-preview column align-center">
            <BoardView
              class="search-board"
              :layout-type="BoardLayoutType.COMPACT"
              :board-image-type="appSettings.boardImage"
              :custom-board-image-url="appSettings.boardImageFileURL"
              :board-image-opacity="appSettings.enableTransparent ? appSettings.boardOpacity : 1"
              :board-grid-color="appSettings.boardGridColor || undefined"
              :piece-stand-image-type="appSettings.pieceStandImage"
              :custom-piece-stand-image-url="appSettings.pieceStandImageFileURL"
              :piece-stand-image-opacity="
                appSettings.enableTransparent ? appSettings.pieceStandOpacity : 1
              "
              :promotion-selector-style="appSettings.promotionSelectorStyle"
              :board-label-type="appSettings.boardLabelType"
              :piece-image-url-template="getPieceImageURLTemplate(appSettings)"
              :king-piece-type="appSettings.kingPieceType"
              :max-size="maxBoardSize"
              :position="searchPosition"
              :last-move="searchLastMove"
              :flip="flip"
              :hide-clock="true"
              :allow-move="true"
              :allow-edit="true"
              :drop-shadows="true"
              :next-move-label="t.nextTurn"
              :ghost-teleport-target="ghostTeleportTarget"
              @move="onSearchBoardMove"
              @edit="onEditPosition"
            />
            <div class="board-controls row" :style="boardControlsStyle">
              <button class="thin" @click="syncPosition">{{ t.currentPosition }}</button>
              <button class="thin" @click="paste">{{ t.paste }}</button>
              <button class="thin" @click="swapTurn">{{ t.changeTurn }}</button>
              <button class="thin" @click="resetToStart">{{ t.initializePosition }}</button>
              <button class="thin" @click="toggleFlip">
                <Icon v-if="isMobile" :icon="IconType.FLIP" />
                <template v-else>{{ t.flipBoard }}</template>
              </button>
            </div>
          </div>
          <div class="search-inputs column">
            <datalist id="server-kifu-keyword-history">
              <option v-for="item in keywordHistory" :key="item" :value="item" />
            </datalist>
            <datalist id="server-kifu-player-history">
              <option v-for="item in playerHistory" :key="item" :value="item" />
            </datalist>
            <div class="search-row row align-center">
              <div class="label">{{ t.keyword }}</div>
              <input
                v-model.trim="keyword"
                class="flex-1"
                :placeholder="t.keyword"
                list="server-kifu-keyword-history"
                @keypress.enter="search"
              />
            </div>
            <div class="search-row row align-center">
              <div class="label">{{ isStrictTurn ? t.senteOrShitate : t.player1 }}</div>
              <input
                v-model.trim="player1"
                class="flex-1"
                :placeholder="isStrictTurn ? t.senteOrShitate : t.player1"
                list="server-kifu-player-history"
                @keypress.enter="search"
              />
            </div>
            <div class="search-row row align-center">
              <div class="label">{{ isStrictTurn ? t.goteOrUwate : t.player2 }}</div>
              <input
                v-model.trim="player2"
                class="flex-1"
                :placeholder="isStrictTurn ? t.goteOrUwate : t.player2"
                list="server-kifu-player-history"
                @keypress.enter="search"
              />
            </div>
            <div class="search-row row align-center">
              <div class="label">{{ t.distinguishSenteGote }}</div>
              <ToggleButton v-model:value="isStrictTurn" />
              <button class="thin swap-players-btn" :disabled="!isStrictTurn" @click="swapPlayers">
                {{ t.swapSenteGote }}
              </button>
            </div>
            <div class="search-row row align-center">
              <div class="label">{{ t.startDateTime }}</div>
              <ComboBox v-model="searchYear" :options="yearOptions" free-text-label="Year" />
              <div class="separator">/</div>
              <ComboBox v-model="searchMonth" :options="monthOptions" free-text-label="Month" />
            </div>
            <div class="search-row row align-center">
              <div class="label">{{ t.strategy }}</div>
              <ComboBox
                v-model="searchStrategy"
                class="flex-1"
                :options="strategyOptions"
                :allow-free-text="false"
              />
            </div>
            <div class="search-row row align-center">
              <div class="label">{{ t.searchByPosition }}</div>
              <ToggleButton v-model:value="searchByPosition" />
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- RESULTS TAB -->
    <div v-if="activeTab === 'results'" class="search-tab column">
      <div class="search-results-view column">
        <div class="results-header row align-center">
          <div class="results-count">
            <span>{{ t.nKifuFound(searchResultCount) }}</span>
            <span v-if="searchResultCount > searchResults.length" class="note">
              {{ t.showingFirstKifu(searchResults.length) }}
            </span>
          </div>
          <button v-if="searchResultCount > 0" class="thin" @click="showSfenExportDialog = true">
            {{ isSfenExportRunning ? t.convertingToSfen : t.exportSearchResultsAsSfen }}
          </button>
        </div>
        <div class="form-group search-results-container">
          <div
            v-for="entry in searchResults"
            :key="entry.id"
            class="kifu-list-entry row align-center"
          >
            <div class="kifu-info column">
              <div class="kifu-header row align-center">
                <span class="file-path">{{ entry.file_path }}</span>
              </div>
              <div class="kifu-metadata row">
                <span v-if="entry.start_date" class="metadata-item">{{ entry.start_date }}</span>
                <span v-if="entry.event" class="metadata-item">{{ entry.event }}</span>
                <span v-if="entry.black_name || entry.white_name" class="metadata-item">
                  {{ entry.black_name || "?" }} vs {{ entry.white_name || "?" }}
                </span>
                <span v-if="entry.strategy" class="metadata-item">
                  {{ t.strategy }}:
                  {{
                    entry.strategy_source === "metadata"
                      ? entry.strategy_raw
                      : getStrategyName(entry.strategy)
                  }}
                  <template
                    v-if="entry.strategy_source === 'rule' || entry.strategy_source === 'inferred'"
                  >
                    ({{ t.automaticallyInferredStrategy }})
                  </template>
                </span>
                <span v-else-if="entry.strategy_raw" class="metadata-item">
                  {{ t.strategy }}: {{ entry.strategy_raw }}
                </span>
                <span v-else class="metadata-item">
                  {{ t.strategy }}: {{ t.unclassified }}
                </span>
              </div>
            </div>
            <div class="result-actions row align-center">
              <button
                :aria-label="t.preview"
                :title="t.preview"
                @click="preview(entry.file_path, entry.matched_ply, entry.matched_sfen)"
              >
                <Icon v-if="isMobile" :icon="IconType.PV" />
                <template v-else>{{ t.preview }}</template>
              </button>
              <button
                :aria-label="t.open"
                :title="t.open"
                @click="open(entry.file_path, entry.matched_ply, entry.matched_sfen)"
              >
                <Icon v-if="isMobile" :icon="IconType.OPEN" />
                <template v-else>{{ t.open }}</template>
              </button>
            </div>
          </div>
          <div v-if="searchResults.length === 0" class="note">
            {{ t.noKifuFound }}
          </div>
        </div>
      </div>
    </div>
    <div class="main-buttons">
      <button v-if="activeTab === 'search'" class="execute-search-btn" @click="search">
        {{ t.search }}
      </button>
      <button data-hotkey="Escape" @click="onCancel()">
        {{ t.cancel }}
      </button>
    </div>
  </DialogFrame>
  <SfenExportDialog
    v-if="showSfenExportDialog"
    @close="showSfenExportDialog = false"
    @completed="updateList(true)"
  />
</template>

<script setup lang="ts">
import { t } from "@/common/i18n";
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import { useStore } from "@/renderer/store";
import api from "@/renderer/ipc/api";
import { useErrorStore } from "@/renderer/store/error";
import { useBusyState } from "@/renderer/store/busy";
import DialogFrame from "./DialogFrame.vue";
import ToggleButton from "@/renderer/view/primitive/ToggleButton.vue";
import ComboBox from "@/renderer/view/primitive/ComboBox.vue";
import BoardView from "@/renderer/view/primitive/BoardView.vue";
import Icon from "@/renderer/view/primitive/Icon.vue";
import { normalizePath } from "@/common/helpers/path";
import { Move, reverseColor, PositionChange, Record as TssRecord } from "tsshogi";
import { useAppSettings } from "@/renderer/store/settings";
import { getPieceImageURLTemplate } from "@/common/settings/app";
import { BoardLayoutType } from "@/common/settings/layout";
import { IconType } from "@/renderer/assets/icons";
import { useServerKifuStore } from "@/renderer/store/serverKifu";
import { KifuListEntry } from "@/common/file/record";
import {
  getStrategyName,
  searchableStrategies,
  UNCLASSIFIED_STRATEGY,
} from "@/common/kifu/strategy";
import type { KifuSearchQuery } from "@/common/file/sfen_export";
import SfenExportDialog from "./SfenExportDialog.vue";

const store = useStore();
const dialogFrame = ref<InstanceType<typeof DialogFrame>>();
const ghostTeleportTarget = computed(() => dialogFrame.value?.dialog ?? "body");
const {
  activeTab,
  currentDir,
  keyword,
  player1,
  player2,
  isStrictTurn,
  searchByPosition,
  searchYear,
  searchMonth,
  searchStrategy,
  searchResults,
  searchResultCount,
  lastExecutedSearch,
  sfenExportJob,
  searchRecord,
  keywordHistory,
  playerHistory,
  triggerSearchRecord,
  addHistory,
} = useServerKifuStore();
const appSettings = useAppSettings();
const busyState = useBusyState();
const list = ref<KifuListEntry[]>([]);
const showSfenExportDialog = ref(false);
const isSfenExportRunning = computed(() =>
  sfenExportJob.value ? ["queued", "running"].includes(sfenExportJob.value.state) : false,
);

const indexStatus = ref<{ total: number; indexed: number; isIndexing: boolean } | null>(null);
let statusTimer: ReturnType<typeof setInterval> | null = null;

const flip = ref(appSettings.boardFlipping);
const windowSize = ref(new RectSize(window.innerWidth, window.innerHeight));

const isMobile = computed(() => windowSize.value.width < 600);

const maxBoardSize = computed(() =>
  getServerKifuBoardMaxSize(windowSize.value.width, windowSize.value.height, isMobile.value),
);
const boardControlsStyle = computed(() => {
  const scale = getServerKifuBoardControlScale(maxBoardSize.value.width, isMobile.value);
  return {
    "--board-control-gap": `${isMobile.value ? 4 : 5 * scale}px`,
    "--board-control-font-size": `${0.7 * scale}em`,
    "--board-control-padding-y": `${2 * scale}px`,
    "--board-control-padding-x": `${isMobile.value ? 6 : 8 * scale}px`,
    "--board-control-icon-height": `${1.2 * scale}em`,
  };
});

const updateWindowSize = () => {
  windowSize.value = new RectSize(window.innerWidth, window.innerHeight);
};

const yearOptions = computed(() => {
  const currentYear = new Date().getFullYear();
  const options = [{ value: "", label: t.all }];
  for (let y = currentYear; y >= 2000; y--) {
    options.push({ value: String(y), label: String(y) });
  }
  return options;
});

const monthOptions = computed(() => {
  const options = [{ value: "", label: t.all }];
  for (let m = 1; m <= 12; m++) {
    const s = String(m).padStart(2, "0");
    options.push({ value: s, label: s });
  }
  return options;
});

const strategyOptions = computed(() => [
  { value: "", label: t.all },
  ...searchableStrategies.map((strategy) => ({
    value: strategy,
    label: getStrategyName(strategy),
  })),
  { value: UNCLASSIFIED_STRATEGY, label: t.unclassified },
]);

const searchPosition = computed(() => searchRecord.value.position);
const searchLastMove = computed(() => {
  const move = searchRecord.value.current.move;
  return move instanceof Move ? move : null;
});

function onSearchBoardMove(move: Move) {
  if (searchRecord.value.append(move)) {
    triggerSearchRecord();
  }
}

function onEditPosition(change: PositionChange) {
  const position = searchRecord.value.position.clone();
  position.edit(change);
  searchRecord.value.clear(position);
  triggerSearchRecord();
}

function swapTurn() {
  const position = searchRecord.value.position.clone();
  position.setColor(reverseColor(position.color));
  searchRecord.value.clear(position);
  triggerSearchRecord();
}

function swapPlayers() {
  [player1.value, player2.value] = [player2.value, player1.value];
}

function toggleFlip() {
  flip.value = !flip.value;
}

function syncPosition() {
  searchRecord.value.clear(store.record.position);
  triggerSearchRecord();
}

function paste() {
  store.showPasteDialog();
}

function resetToStart() {
  searchRecord.value = new TssRecord();
}

async function updateList(reload?: boolean) {
  try {
    busyState.retain();
    list.value = [];
    list.value = await api.listServerKifu(currentDir.value, reload);
  } catch (e) {
    console.warn(e);
    useErrorStore().add(e);
  } finally {
    busyState.release();
  }
}

function onReload() {
  updateList(true);
}

function preview(path: string, ply?: number, sfen?: string) {
  store.showKifuPreviewDialog({
    path,
    matchedPly: ply,
    matchedSfen: sfen,
  });
}

async function updateIndexStatus() {
  try {
    indexStatus.value = await api.getServerKifuIndexStatus();
    if (!indexStatus.value.isIndexing && statusTimer) {
      clearInterval(statusTimer);
      statusTimer = null;
    }
  } catch (e) {
    console.warn(e);
  }
}

async function search() {
  try {
    busyState.retain();
    let sfen: string | undefined;

    if (searchByPosition.value) {
      sfen = searchRecord.value.position.sfen;
    }

    let startDate: string | undefined;
    if (searchYear.value && searchMonth.value) {
      startDate = searchYear.value + "/" + searchMonth.value;
    } else if (searchYear.value) {
      startDate = searchYear.value;
    }

    const params: KifuSearchQuery = {
      keyword: keyword.value,
      player1: player1.value,
      player2: player2.value,
      isStrictTurn: isStrictTurn.value,
      sfen: sfen,
      startDate: startDate,
      strategy: searchStrategy.value || undefined,
    };
    const [results, count] = await Promise.all([
      api.searchServerKifu(params),
      api.countServerKifu(params),
    ]);
    searchResults.value = results;
    searchResultCount.value = count;
    lastExecutedSearch.value = params;
    addHistory(keyword.value, player1.value, player2.value);
    activeTab.value = "results";
  } catch (e) {
    console.warn(e);
    useErrorStore().add(e);
  } finally {
    busyState.release();
  }
}

watch(currentDir, () => {
  updateList();
});

const breadcrumbs = computed(() => {
  if (!currentDir.value) return [];
  const parts = normalizePath(currentDir.value).split("/");
  return parts.map((part, index) => ({
    name: part,
    path: parts.slice(0, index + 1).join("/"),
  }));
});

const displayEntries = computed(() => list.value);

async function open(relPath: string, ply?: number, sfen?: string) {
  let fileURI: string;
  try {
    busyState.retain();
    fileURI = await api.loadServerKifu(relPath);
  } catch (e) {
    busyState.release();
    useErrorStore().add(e);
    return;
  }
  busyState.release();
  store.closeModalDialog();
  try {
    if (sfen != null && ply != null) {
      store.openRecord(fileURI, { ply, sfen });
    } else if (ply != null) {
      store.openRecord(fileURI, { ply });
    } else {
      store.openRecord(fileURI);
    }
  } catch (e) {
    useErrorStore().add(e);
  }
}

function onCancel() {
  store.closeModalDialog();
}

onMounted(() => {
  window.addEventListener("resize", updateWindowSize);
  updateList();
  updateIndexStatus();
  statusTimer = setInterval(() => {
    updateIndexStatus();
  }, 2000);

  const handlePaste = (data: string) => {
    const recordOrError = store.parseRecordData(data);
    if (recordOrError instanceof Error) {
      useErrorStore().add(recordOrError);
      return;
    }
    searchRecord.value.clear(recordOrError.position);
    triggerSearchRecord();
  };

  store.setOnPasteHandler(handlePaste);

  const pendingData = store.dequeuePendingPasteData();
  if (pendingData) {
    handlePaste(pendingData);
  }
});

onUnmounted(() => {
  window.removeEventListener("resize", updateWindowSize);
  store.setOnPasteHandler(undefined);
  if (statusTimer) {
    clearInterval(statusTimer);
  }
});
</script>

<style scoped>
.tab-header {
  margin: 10px 10px 0 10px;
  border-bottom: 1px solid var(--text-dashed-separator-color);
}
.tab-item {
  padding: 8px 20px;
  cursor: pointer;
  border: 1px solid transparent;
  border-bottom: none;
  border-radius: 5px 5px 0 0;
  margin-bottom: -1px;
}
.tab-item.active {
  background-color: var(--text-bg-color);
  border-color: var(--text-dashed-separator-color);
  font-weight: bold;
}
.list-tab,
.search-tab {
  display: flex;
  flex-direction: column;
  padding: 10px;
}
.form-group {
  width: clamp(640px, 40vw, 840px);
  max-width: 100%;
  box-sizing: border-box;
}
.search-params {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-height: 0;
}
.search-content {
  width: clamp(640px, 40vw, 840px);
  max-width: 100%;
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  gap: 10px;
  margin-bottom: 10px;
}
.indexing-status {
  margin: 5px 10px;
  font-size: 0.85em;
  color: var(--text-color-sub);
  text-align: left;
}
.list-header {
  margin: 10px 5px;
}
.reload-btn {
  padding: 2px 8px;
}
.reload-btn .icon {
  height: 1.5em;
}

.kifu-list {
  height: clamp(320px, calc(100dvh - 350px), 750px);
  overflow-y: auto;
  background-color: var(--text-bg-color);
}

.search-inputs {
  width: 100%;
  gap: 6px;
}
.search-row {
  gap: 10px;
}
.search-row .label {
  width: 100px;
  text-align: left;
  font-size: 0.9em;
  flex-shrink: 0;
}
.search-row .separator {
  color: var(--text-color-sub);
}
.swap-players-btn {
  padding-right: 10px;
  padding-left: 10px;
  white-space: nowrap;
}
.main-buttons {
  gap: 20px;
}
.main-buttons button {
  min-width: 120px;
  padding: 8px 20px;
  font-weight: bold;
}
.search-preview {
  width: 100%;
  padding: 8px;
  background-color: var(--text-bg-color);
  border-radius: 5px;
  box-sizing: border-box;
}
.search-board {
  margin: 0 auto;
}
.board-controls {
  margin-top: 4px;
  gap: var(--board-control-gap);
  flex-wrap: wrap;
  justify-content: center;
}
.board-controls button {
  font-size: var(--board-control-font-size);
  padding: var(--board-control-padding-y) var(--board-control-padding-x);
  display: flex;
  align-items: center;
  gap: 4px;
}
.board-controls button .icon {
  height: var(--board-control-icon-height);
}

.search-results-view {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-height: 0;
}
.results-header {
  padding: 0 5px 10px 5px;
  display: flex;
  justify-content: space-between;
  align-items: center;
  flex-shrink: 0;
}
.results-count {
  font-size: 0.85em;
  color: var(--text-color-sub);
}
@media (max-width: 600px) {
  .results-count > span {
    display: block;
  }
  .results-count .note {
    margin-top: 2px;
  }
}
.search-results-container {
  height: clamp(320px, calc(100dvh - 350px), 750px);
  overflow-y: auto;
  background-color: var(--text-bg-color);
}

.kifu-list-entry {
  padding: 8px 10px;
  border-bottom: 1px dashed var(--text-dashed-separator-color);
  justify-content: space-between;
}
.kifu-list-entry button {
  flex-shrink: 0;
  white-space: nowrap;
}
.result-actions {
  flex-shrink: 0;
  gap: 4px;
}
.result-actions button {
  margin: 0;
}
.result-actions button .icon {
  height: 1.4em;
}
.kifu-info {
  flex: 1;
  text-align: left;
  overflow: hidden;
  margin-right: 10px;
}
.kifu-header {
  font-size: 0.9em;
  white-space: nowrap;
  overflow: hidden;
  max-width: 450px;
  min-width: 0;
}
.kifu-list > .kifu-list-entry > .kifu-header {
  flex: 1;
}
.kifu-metadata {
  font-size: 0.75em;
  color: var(--text-color-sub);
  margin-top: 4px;
  gap: 15px;
  flex-wrap: wrap;
}
.metadata-item {
  white-space: nowrap;
}
.directory-name {
  cursor: pointer;
  color: var(--text-color-link);
  font-weight: bold;
}
.directory-name:hover {
  text-decoration: underline;
}
.file-path {
  text-overflow: ellipsis;
  overflow: hidden;
}
.note {
  margin-top: 20px;
  font-size: 0.8em;
  color: var(--text-color-warning);
}

.breadcrumbs {
  margin: 0;
  padding: 5px 10px;
  background-color: var(--text-bg-color);
  border-radius: 5px;
  font-size: 0.85em;
  overflow-x: auto;
  white-space: nowrap;
  flex: 1;
  margin-right: 10px;
}
.breadcrumb-item {
  cursor: pointer;
  color: var(--text-color-link);
}
.breadcrumb-item:hover {
  text-decoration: underline;
}
.breadcrumb-separator {
  margin: 0 5px;
  color: var(--text-color-sub);
}

@media (max-width: 600px) {
  .search-preview {
    padding: 4px;
    background-color: transparent;
  }
  .board-controls {
    gap: 4px;
  }
  .board-controls button {
    padding: 2px 6px;
  }
  .kifu-list,
  .search-results-container {
    height: calc(100dvh - 280px);
  }
  .search-content {
    gap: 6px;
  }
  .result-actions button {
    display: inline-flex;
    width: 40px;
    height: 32px;
    align-items: center;
    justify-content: center;
    padding: 4px;
  }
  .search-inputs {
    gap: 4px;
  }
}
</style>
