<template>
  <DialogFrame @cancel="onCancel">
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
          <button v-if="!entry.isDirectory" @click="open(entry.path)">
            {{ t.open }}
          </button>
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
              @move="onSearchBoardMove"
              @edit="onEditPosition"
            />
            <div class="board-controls row">
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
            <div class="search-row row align-center">
              <div class="label">{{ t.keyword }}</div>
              <input
                v-model.trim="keyword"
                class="flex-1"
                :placeholder="t.keyword"
                @keypress.enter="search"
              />
            </div>
            <div class="search-row row align-center">
              <div class="label">{{ t.startDateTime }}</div>
              <ComboBox v-model="searchYear" :options="yearOptions" free-text-label="Year" />
              <div class="separator">/</div>
              <ComboBox v-model="searchMonth" :options="monthOptions" free-text-label="Month" />
            </div>
            <div class="search-row row align-center">
              <div class="label">{{ t.searchByPosition }}</div>
              <ToggleButton v-model:value="searchByPosition" />
            </div>
            <div class="execute-row row">
              <button class="execute-search-btn" @click="search">{{ t.search }}</button>
              <button class="cancel-search-btn" @click="onCancel">{{ t.cancel }}</button>
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
            {{ t.nKifuFound(searchResults.length) }}
          </div>
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
              </div>
            </div>
            <button @click="open(entry.file_path, entry.matched_ply, entry.matched_sfen)">
              {{ t.open }}
            </button>
          </div>
          <div v-if="searchResults.length === 0" class="note">
            {{ t.noKifuFound }}
          </div>
        </div>
      </div>
    </div>

    <div class="main-buttons">
      <button data-hotkey="Escape" @click="onCancel()">
        {{ t.cancel }}
      </button>
    </div>
  </DialogFrame>
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
import { RectSize } from "@/common/assets/geometry";
import { Move, reverseColor, PositionChange, Record as TssRecord } from "tsshogi";
import { useAppSettings } from "@/renderer/store/settings";
import { getPieceImageURLTemplate } from "@/common/settings/app";
import { BoardLayoutType } from "@/common/settings/layout";
import { IconType } from "@/renderer/assets/icons";
import { useServerKifuStore } from "@/renderer/store/serverKifu";
import { KifuListEntry } from "@/common/file/record";

const store = useStore();
const {
  activeTab,
  currentDir,
  keyword,
  searchByPosition,
  searchYear,
  searchMonth,
  searchResults,
  searchRecord,
  triggerSearchRecord,
} = useServerKifuStore();
const appSettings = useAppSettings();
const busyState = useBusyState();
const list = ref<KifuListEntry[]>([]);

const indexStatus = ref<{ total: number; indexed: number; isIndexing: boolean } | null>(null);
let statusTimer: ReturnType<typeof setInterval> | null = null;

const flip = ref(appSettings.boardFlipping);

const isMobile = computed(() => window.innerWidth < 600);

const maxBoardSize = computed(() => {
  if (isMobile.value) {
    return new RectSize(window.innerWidth * 0.9, window.innerWidth * 0.9);
  }
  return new RectSize(540, 540);
});

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

    searchResults.value = await api.searchServerKifu({
      keyword: keyword.value,
      sfen: sfen,
      startDate: startDate,
    });
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
  width: 600px;
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
  width: 600px;
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
  height: calc(100vh - 350px);
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
.execute-row {
  gap: 10px;
  margin-top: 8px;
}
.execute-search-btn,
.cancel-search-btn {
  flex: 1;
  padding: 8px;
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
  gap: 5px;
  flex-wrap: wrap;
  justify-content: center;
}
.board-controls button {
  font-size: 0.7em;
  padding: 2px 8px;
  display: flex;
  align-items: center;
  gap: 4px;
}
.board-controls button .icon {
  height: 1.2em;
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
.search-results-container {
  height: calc(100vh - 350px);
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
  .search-inputs {
    gap: 4px;
  }
}
</style>
