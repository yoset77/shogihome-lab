<template>
  <DialogFrame limited @cancel="onClose">
    <div class="title">{{ t.addBookMoves }}</div>
    <div v-if="bookPath" class="book-path" :title="bookPath">{{ bookPath }}</div>
    <div>
      <HorizontalSelector v-model:value="activeTab" :items="sourceTypeOptions" />
    </div>
    <div class="form-group scroll">
      <div v-show="activeTab === 'memory' && !inMemoryList.length">
        {{ t.noMoves }}
      </div>
      <table v-show="activeTab === 'memory' && inMemoryList.length" class="move-list">
        <tbody>
          <tr
            v-for="(move, index) of inMemoryList"
            :key="index"
            :ref="(el) => setCurrentMoveRow(move, el)"
          >
            <td v-if="move.type === 'move'">{{ move.ply }}</td>
            <td v-if="move.type === 'move'">{{ move.text }}</td>
            <td v-if="move.type === 'move'">
              <span v-if="move.score !== undefined">{{ t.score }} {{ move.score }}</span>
            </td>
            <td v-if="move.type === 'move'">
              <button v-if="canRegisterMove(move)" class="thin" @click="registerMove(move)">
                {{ move.exists ? t.update : t.register }}
              </button>
            </td>
            <td v-if="move.type === 'move'">
              <span v-if="move.last">({{ t.currentMove }})</span>
            </td>
            <td v-if="move.type === 'branch'" class="branch" colspan="5">
              {{ t.branchFrom(move.ply) }}:
            </td>
          </tr>
        </tbody>
      </table>
      <div v-show="activeTab === 'file'" class="form-item row">
        <input v-model="settings.sourceRecordFile" class="grow" type="text" readonly />
        <button class="thin" @click="openServerBrowser()">
          {{ t.select }}
        </button>
      </div>
      <ServerDirectoryBrowser
        v-if="activeTab !== 'memory'"
        :show-path-input="activeTab === 'directory'"
        :selected-path="serverDirectorySelection"
        :path="currentServerDir"
        :entries="serverSelectionEntries"
        :open="serverSelectionList.length > 0"
        @open="openServerBrowser"
        @update:path="onNavigateServerDirectory"
        @select="onSelectServerItem"
      >
        <template #entry-actions="{ entry }">
          <button
            v-if="activeTab === 'directory' && entry.isDirectory"
            class="thin"
            @click="onConfirmServerDirectory(entry.path)"
          >
            {{ t.select }}
          </button>
        </template>
      </ServerDirectoryBrowser>
      <div v-show="activeTab === 'directory' || activeTab === 'file'" class="form-item row">
        <span>{{ t.fromPrefix }}</span>
        <input
          v-model.number="settings.minPly"
          class="small"
          type="number"
          min="0"
          step="1"
          value="0"
        />
        <span>{{ t.plySuffix }}{{ t.fromSuffix }}</span>
      </div>
      <div v-show="activeTab === 'directory' || activeTab === 'file'" class="form-item row">
        <span>{{ t.toPrefix }}</span>
        <input
          v-model.number="settings.maxPly"
          class="small"
          type="number"
          min="0"
          step="1"
          value="1000"
        />
        <span>{{ t.plySuffix }}{{ t.toSuffix }}</span>
      </div>
      <div v-show="activeTab === 'directory' || activeTab === 'file'" class="form-item row">
        <HorizontalSelector
          v-model:value="settings.playerCriteria"
          :items="[
            { value: PlayerCriteria.ALL, label: t.allPlayers },
            { value: PlayerCriteria.BLACK, label: t.blackPlayerOnly },
            { value: PlayerCriteria.WHITE, label: t.whitePlayerOnly },
            { value: PlayerCriteria.FILTER_BY_NAME, label: t.filterByName },
          ]"
        />
      </div>
      <div v-show="activeTab === 'directory' || activeTab === 'file'" class="form-item row">
        <input
          v-show="settings.playerCriteria === 'filterByName'"
          v-model="settings.playerName"
          class="grow"
          type="text"
          :placeholder="t.enterPartOfPlayerNameHere"
        />
      </div>
      <div v-show="activeTab === 'directory' || activeTab === 'file'" class="form-item row">
        <ToggleButton v-model:value="settings.importScore" :label="t.importScoreFromComment" />
      </div>
    </div>
    <div v-show="activeTab === 'memory' && inMemoryList.length">
      <div class="form-item">
        <ToggleButton v-model:value="importScoreDepth" :label="t.importScoreDepth" />
      </div>
      <button class="register-all" @click="registerAllMoves">{{ t.importAll }}</button>
    </div>
    <div v-show="activeTab === 'directory' || activeTab === 'file'">
      <button class="import" @click="importMoves">{{ t.import }}</button>
    </div>
    <div class="main-buttons">
      <button autofocus data-hotkey="Escape" @click="onClose">
        {{ t.close }}
      </button>
    </div>
  </DialogFrame>
</template>

<script setup lang="ts">
import { t } from "@/common/i18n";
import { useStore } from "@/renderer/store";
import { computed, nextTick, onMounted, ref, watch } from "vue";
import { useBusyState } from "@/renderer/store/busy";
import { Color, formatMove, ImmutableNode, Move, Position } from "tsshogi";
import { useBookStore } from "@/renderer/store/book";
import { RecordCustomData } from "@/common/record/types";
import { useErrorStore } from "@/renderer/store/error";
import { BookMove } from "@/common/book";
import HorizontalSelector from "@/renderer/view/primitive/HorizontalSelector.vue";
import ToggleButton from "@/renderer/view/primitive/ToggleButton.vue";
import api from "@/renderer/ipc/api";
import {
  defaultBookImportSettings,
  PlayerCriteria,
  SourceType,
  validateBookImportSettings,
} from "@/common/settings/book";
import DialogFrame from "./DialogFrame.vue";
import ServerDirectoryBrowser from "./ServerDirectoryBrowser.vue";
import { useConfirmationStore } from "@/renderer/store/confirm";
import { useToastStore } from "@/renderer/store/toast";
import { KifuListEntry } from "@/common/file/record";

type InMemoryMove = {
  type: "move";
  ply: number;
  sfen: string;
  book: BookMove;
  text: string;
  score?: number;
  depth?: number;
  scoreUpdatable: boolean;
  exists: boolean;
  last: boolean;
};
type Branch = {
  type: "branch";
  ply: number;
};
type Tab = "memory" | "file" | "directory";

const STORAGE_KEY = "addBookMovesDialog:tab";
const STORAGE_KEY_IMPORT_SCORE_DEPTH = "addBookMovesDialog:importScoreDepth";
const tabs: Tab[] = ["memory", "file", "directory"];
const storedTab = localStorage.getItem(STORAGE_KEY);

const sourceTypeFromTab = (tab: Tab): SourceType | undefined => {
  switch (tab) {
    case "file":
      return SourceType.FILE;
    case "directory":
      return SourceType.DIRECTORY;
    case "memory":
      return;
  }
};

const store = useStore();
const bookStore = useBookStore();
const bookSessionId = bookStore.activeBookId;
const bookPath = bookStore.path;
const errorStore = useErrorStore();
const busyState = useBusyState();
const activeTab = ref<Tab>(tabs.includes(storedTab as Tab) ? (storedTab as Tab) : "memory");
const importScoreDepth = ref(localStorage.getItem(STORAGE_KEY_IMPORT_SCORE_DEPTH) !== "false");
const settings = ref(defaultBookImportSettings());
const inMemoryList = ref<(InMemoryMove | Branch)[]>([]);
const serverSelectionList = ref<KifuListEntry[]>([]);
const currentServerDir = ref("");
let currentMoveRow: HTMLElement | undefined;

const setCurrentMoveRow = (move: InMemoryMove | Branch, el: unknown) => {
  if (move.type === "move" && move.last && el instanceof HTMLElement) {
    currentMoveRow = el;
  }
};

watch(activeTab, (tab) => {
  localStorage.setItem(STORAGE_KEY, tab);
  serverSelectionList.value = [];
});

watch(importScoreDepth, (value) => {
  localStorage.setItem(STORAGE_KEY_IMPORT_SCORE_DEPTH, String(value));
});

const serverSelectionEntries = computed(() => {
  if (activeTab.value === "directory") {
    return serverSelectionList.value.filter((entry) => entry.isDirectory);
  }
  return serverSelectionList.value;
});

const serverDirectorySelection = computed(() => {
  const source = settings.value.sourceDirectory;
  return source.startsWith("server://") ? source.slice("server://".length) : undefined;
});

const onNavigateServerDirectory = (path: string) => {
  currentServerDir.value = path;
};

const sourceTypeOptions = computed(() => {
  return [
    { value: "memory", label: t.fromCurrentRecord },
    { value: "file", label: t.fromFile },
    { value: "directory", label: t.fromDirectory },
  ];
});

watch(currentServerDir, async () => {
  try {
    busyState.retain();
    serverSelectionList.value = [];
    serverSelectionList.value = await api.listServerKifu(currentServerDir.value);
  } catch (e) {
    useErrorStore().add(e);
  } finally {
    busyState.release();
  }
});

const setupInMemoryList = async () => {
  inMemoryList.value = [];
  const nodes: { node: ImmutableNode; sfen: string }[] = [];
  const sfens = new Set<string>();
  store.record.forEach((node) => {
    const move = node.move;
    if (!(move instanceof Move)) {
      return;
    }
    const prev = node.prev;
    if (prev) {
      nodes.push({ node, sfen: prev.sfen });
      sfens.add(prev.sfen);
    }
  });

  const bookMovesMap = await bookStore.searchMovesBatch(Array.from(sfens), bookSessionId);

  for (const { node, sfen } of nodes) {
    if (!node.isFirstBranch) {
      inMemoryList.value.push({ type: "branch", ply: node.ply });
    }
    const position = Position.newBySFEN(sfen) as Position;
    const move = node.move as Move;
    const bookMoves = bookMovesMap.get(sfen) || [];
    const book = bookMoves.find((book) => book.usi === move.usi);
    const customData = node.customData ? (node.customData as RecordCustomData) : undefined;
    const searchInfo = customData?.researchInfo || customData?.playerSearchInfo;
    const score =
      searchInfo?.score !== undefined && move.color === Color.WHITE
        ? -searchInfo.score
        : searchInfo?.score;
    const depth = searchInfo?.depth;
    inMemoryList.value.push({
      type: "move",
      ply: node.ply,
      sfen,
      book: book || { usi: move.usi, comment: "" },
      text: formatMove(position, move),
      score,
      depth,
      scoreUpdatable:
        score !== undefined &&
        (score !== book?.score || (!!depth && (!book.depth || depth > book.depth))),
      exists: bookMoves.some((book) => book.usi === move.usi),
      last: node === store.record.current,
    });
  }
};

busyState.retain();

onMounted(async () => {
  try {
    await setupInMemoryList();
    settings.value = await api.loadBookImportSettings();
    await nextTick();
    currentMoveRow?.scrollIntoView({ block: "center" });
  } catch (e) {
    errorStore.add(e);
    store.destroyModalDialog();
  } finally {
    busyState.release();
  }
});

const onClose = () => {
  store.closeModalDialog();
};

const canRegisterMove = (move: InMemoryMove): boolean => {
  return !move.exists || (importScoreDepth.value && move.scoreUpdatable);
};

const registerAllMoves = () => {
  useConfirmationStore().show({
    message: t.doYouWantToImportAllMoves,
    onOk: async () => {
      let added = 0;
      for (const item of inMemoryList.value) {
        if (item.type !== "move") continue;
        if (canRegisterMove(item)) {
          await registerMove(item);
          added++;
        }
      }
      useToastStore().success(t.importedMoves(added));
    },
  });
};

const registerMove = async (move: InMemoryMove) => {
  try {
    if (importScoreDepth.value) {
      await bookStore.updateMove(
        move.sfen,
        {
          ...move.book,
          score: move.score,
          depth: move.depth,
        },
        bookSessionId,
      );
    } else {
      await bookStore.updateMove(
        move.sfen,
        {
          usi: move.book.usi,
          comment: move.book.comment,
        },
        bookSessionId,
      );
    }
    move.exists = true;
    move.scoreUpdatable = false;
  } catch (e) {
    errorStore.add(e);
  }
};

const openServerBrowser = async () => {
  busyState.retain();
  try {
    if (currentServerDir.value === "") {
      serverSelectionList.value = await api.listServerKifu("");
    } else {
      currentServerDir.value = "";
    }
  } catch (e) {
    useErrorStore().add(e);
  } finally {
    busyState.release();
  }
};

const onSelectServerItem = (entry: { name: string; path: string; isDirectory: boolean }) => {
  if (entry.isDirectory) {
    currentServerDir.value = entry.path;
    return;
  }
  settings.value.sourceRecordFile = "server://" + entry.path;
  serverSelectionList.value = [];
};

const onConfirmServerDirectory = (path: string) => {
  settings.value.sourceDirectory = "server://" + path;
  serverSelectionList.value = [];
};

const importMoves = () => {
  const sourceType = sourceTypeFromTab(activeTab.value);
  if (!sourceType) {
    return;
  }
  settings.value.sourceType = sourceType;
  const error = validateBookImportSettings(settings.value);
  if (error) {
    useErrorStore().add(error);
    return;
  }
  bookStore.importBookMoves(settings.value, bookSessionId);
};
</script>

<style scoped>
.book-path {
  max-width: 420px;
  margin: -8px auto 10px;
  overflow: hidden;
  color: var(--text-color-sub);
  font-size: 0.8em;
  text-align: center;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.form-group {
  width: clamp(580px, 35vw, 800px);
  max-width: 100%;
  box-sizing: border-box;
  height: clamp(320px, calc(100dvh - 240px), 600px);
}
table.move-list td {
  font-size: 0.8em;
  height: 2em;
  text-align: left;
  padding: 0 0.5em;
}
table.move-list td.branch {
  font-size: 0.6em;
}
input.small {
  width: 50px;
}
button.register-all,
button.import {
  width: 100%;
}
</style>
