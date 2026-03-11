<template>
  <DialogFrame limited @cancel="onClose">
    <div class="title">{{ t.addBookMoves }}</div>
    <div>
      <HorizontalSelector v-model:value="settings.sourceType" :items="sourceTypeOptions" />
    </div>
    <div class="form-group scroll">
      <div v-show="settings.sourceType === SourceType.MEMORY && !inMemoryList.length">
        {{ t.noMoves }}
      </div>
      <table
        v-show="settings.sourceType === SourceType.MEMORY && inMemoryList.length"
        class="move-list"
      >
        <tbody>
          <tr v-for="move of inMemoryList" :key="move.ply">
            <td v-if="move.type === 'move'">{{ move.ply }}</td>
            <td v-if="move.type === 'move'">{{ move.text }}</td>
            <td v-if="move.type === 'move'">
              <span v-if="move.score !== undefined">{{ t.score }} {{ move.score }}</span>
            </td>
            <td v-if="move.type === 'move'">
              <button v-if="!move.exists" class="thin" @click="registerMove(move)">
                {{ t.register }}
              </button>
              <button v-else-if="move.scoreUpdatable" class="thin" @click="updateScore(move)">
                {{ t.update }}
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
      <div v-show="settings.sourceType === SourceType.DIRECTORY" class="form-item row">
        <input
          v-model="settings.sourceDirectory"
          class="grow"
          type="text"
          :readonly="!isNative()"
        />
        <button class="thin" @click="selectDirectory()">
          {{ t.select }}
        </button>
        <button v-if="isNative()" class="thin open-dir" @click="openDirectory()">
          <Icon :icon="IconType.OPEN_FOLDER" />
        </button>
      </div>
      <div v-show="settings.sourceType === SourceType.FILE" class="form-item row">
        <input
          v-model="settings.sourceRecordFile"
          class="grow"
          type="text"
          :readonly="!isNative()"
        />
        <button class="thin" @click="selectRecordFile()">
          {{ t.select }}
        </button>
      </div>
      <div
        v-if="
          !isNative() && settings.sourceType !== SourceType.MEMORY && serverSelectionList.length > 0
        "
        class="server-selection-list"
      >
        <div class="server-selection-header breadcrumbs">
          <span class="breadcrumb-item" @click="currentServerDir = ''">Root</span>
          <template v-for="(dir, index) in breadcrumbs" :key="index">
            <span class="breadcrumb-separator">/</span>
            <span class="breadcrumb-item" @click="currentServerDir = dir.path">
              {{ dir.name }}
            </span>
          </template>
        </div>
        <div class="server-selection-scroll">
          <div
            v-for="entry in serverSelectionEntries"
            :key="entry.path"
            class="server-selection-item row align-center"
          >
            <div class="entry-header grow" @click="onSelectServerItem(entry)">
              <Icon v-if="entry.isDirectory" :icon="IconType.OPEN_FOLDER" class="entry-icon" />
              {{ entry.name }}
            </div>
            <button
              v-if="
                settings.sourceType === SourceType.DIRECTORY &&
                entry.isDirectory &&
                entry.name !== '..'
              "
              class="thin"
              @click="onConfirmServerDirectory(entry.path)"
            >
              {{ t.select }}
            </button>
          </div>
        </div>
      </div>
      <div
        v-show="
          settings.sourceType === SourceType.DIRECTORY || settings.sourceType === SourceType.FILE
        "
        class="form-item row"
      >
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
      <div
        v-show="
          settings.sourceType === SourceType.DIRECTORY || settings.sourceType === SourceType.FILE
        "
        class="form-item row"
      >
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
      <div
        v-show="
          settings.sourceType === SourceType.DIRECTORY || settings.sourceType === SourceType.FILE
        "
        class="form-item row"
      >
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
      <div
        v-show="
          settings.sourceType === SourceType.DIRECTORY || settings.sourceType === SourceType.FILE
        "
        class="form-item row"
      >
        <input
          v-show="settings.playerCriteria === 'filterByName'"
          v-model="settings.playerName"
          class="grow"
          type="text"
          :placeholder="t.enterPartOfPlayerNameHere"
        />
      </div>
    </div>
    <div
      v-show="
        settings.sourceType === SourceType.DIRECTORY || settings.sourceType === SourceType.FILE
      "
    >
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
import { computed, onMounted, ref, watch } from "vue";
import { useBusyState } from "@/renderer/store/busy";
import { Color, formatMove, ImmutableNode, Move, Position } from "tsshogi";
import { useBookStore } from "@/renderer/store/book";
import { RecordCustomData } from "@/renderer/store/record";
import { useErrorStore } from "@/renderer/store/error";
import { BookMove } from "@/common/book";
import { IconType } from "@/renderer/assets/icons";
import HorizontalSelector from "@/renderer/view/primitive/HorizontalSelector.vue";
import Icon from "@/renderer/view/primitive/Icon.vue";
import api, { isNative } from "@/renderer/ipc/api";
import { normalizePath } from "@/common/helpers/path";
import {
  defaultBookImportSettings,
  PlayerCriteria,
  SourceType,
  validateBookImportSettings,
} from "@/common/settings/book";
import DialogFrame from "./DialogFrame.vue";
import { RecordFileFormat, getStandardRecordFileFormats } from "@/common/file/record";

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

const store = useStore();
const bookStore = useBookStore();
const errorStore = useErrorStore();
const busyState = useBusyState();
const settings = ref(defaultBookImportSettings());
const inMemoryList = ref<(InMemoryMove | Branch)[]>([]);
const serverSelectionList = ref<string[]>([]);
const currentServerDir = ref("");

watch(
  () => settings.value.sourceType,
  () => {
    serverSelectionList.value = [];
  },
);

const breadcrumbs = computed(() => {
  if (!currentServerDir.value) return [];
  const parts = normalizePath(currentServerDir.value).split("/");
  return parts.map((part, index) => ({
    name: part,
    path: parts.slice(0, index + 1).join("/"),
  }));
});

const sourceTypeOptions = computed(() => {
  return [
    { value: SourceType.MEMORY, label: t.fromCurrentRecord },
    { value: SourceType.FILE, label: t.fromFile },
    { value: SourceType.DIRECTORY, label: t.fromDirectory },
  ];
});

const serverSelectionEntries = computed(() => {
  const currentDirNormalized = normalizePath(currentServerDir.value);
  const currentDirLower = currentDirNormalized.toLowerCase();
  const prefix = currentDirNormalized ? currentDirNormalized + "/" : "";

  const entriesMap = new Map<string, { name: string; path: string; isDirectory: boolean }>();
  if (currentServerDir.value) {
    const parent = currentDirNormalized.split("/").slice(0, -1).join("/");
    entriesMap.set("..", { name: "..", path: parent, isDirectory: true });
  }

  serverSelectionList.value.forEach((file) => {
    const fileNormalized = normalizePath(file);
    if (fileNormalized.toLowerCase().startsWith(currentDirLower)) {
      const relative = fileNormalized.substring(prefix.length);
      const parts = relative.split("/");
      if (parts.length > 1) {
        const dirName = parts[0];
        const dirPath = prefix + dirName;
        if (!entriesMap.has(dirName)) {
          entriesMap.set(dirName, { name: dirName, path: dirPath, isDirectory: true });
        }
      } else if (
        parts.length === 1 &&
        parts[0] !== "" &&
        settings.value.sourceType !== SourceType.DIRECTORY
      ) {
        const fileName = parts[0];
        entriesMap.set(fileName, { name: fileName, path: file, isDirectory: false });
      }
    }
  });

  return Array.from(entriesMap.values()).sort((a, b) => {
    if (a.name === "..") return -1;
    if (b.name === "..") return 1;
    if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
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

  const bookMovesMap = await bookStore.searchMovesBatch(Array.from(sfens));

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

const registerMove = (move: InMemoryMove) => {
  bookStore.updateMove(move.sfen, {
    ...move.book,
    score: move.score,
    depth: move.depth,
  });
  move.exists = true;
  move.scoreUpdatable = false;
};

const updateScore = (move: InMemoryMove) => {
  bookStore.updateMove(move.sfen, {
    ...move.book,
    score: move.score,
    depth: move.depth,
  });
  move.scoreUpdatable = false;
};

const selectDirectory = async () => {
  if (!isNative()) {
    try {
      busyState.retain();
      serverSelectionList.value = await api.listServerKifu();
      currentServerDir.value = "";
    } catch (e) {
      useErrorStore().add(e);
    } finally {
      busyState.release();
    }
    return;
  }
  busyState.retain();
  try {
    const path = await api.showSelectDirectoryDialog(settings.value.sourceDirectory);
    if (path) {
      settings.value.sourceDirectory = path;
    }
  } catch (e) {
    useErrorStore().add(e);
  } finally {
    busyState.release();
  }
};

const openDirectory = () => {
  api.openExplorer(settings.value.sourceDirectory);
};

const selectRecordFile = async () => {
  if (!isNative()) {
    try {
      busyState.retain();
      serverSelectionList.value = await api.listServerKifu();
    } catch (e) {
      useErrorStore().add(e);
    } finally {
      busyState.release();
    }
    return;
  }
  busyState.retain();
  try {
    const path = await api.showOpenRecordDialog([
      ...getStandardRecordFileFormats(),
      RecordFileFormat.SFEN,
    ]);
    if (path) {
      settings.value.sourceRecordFile = path;
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
  const error = validateBookImportSettings(settings.value);
  if (error) {
    useErrorStore().add(error);
    return;
  }
  bookStore.importBookMoves(settings.value);
};
</script>

<style scoped>
.form-group {
  width: 580px;
  max-width: 100%;
  box-sizing: border-box;
  min-height: calc(80dvh - 200px);
  max-height: 600px;
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
button.import {
  width: 100%;
}
.server-selection-list {
  width: 100%;
  box-sizing: border-box;
  margin-top: 10px;
  border: 1px solid var(--dialog-border-color);
  background-color: var(--text-bg-color);
}
.server-selection-header {
  padding: 4px 8px;
  font-size: 0.8em;
  font-weight: bold;
  background-color: var(--selector-bg-color);
  border-bottom: 1px solid var(--dialog-border-color);
}
.server-selection-header.breadcrumbs {
  text-align: left;
  white-space: nowrap;
  overflow-x: auto;
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
.server-selection-scroll {
  max-height: 400px;
  overflow-y: auto;
}
.server-selection-item {
  padding: 8px 10px;
  font-size: 0.9em;
  cursor: pointer;
  text-align: left;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  border-bottom: 1px solid var(--dialog-border-color);
}
.server-selection-item .entry-header {
  min-width: 0;
  text-overflow: ellipsis;
  overflow: hidden;
}
.server-selection-item button {
  flex-shrink: 0;
  margin-left: 10px;
}
.server-selection-item:last-child {
  border-bottom: none;
}
.server-selection-item:hover {
  background-color: var(--selector-bg-color);
}
.entry-icon {
  width: 1.2em;
  height: 1.2em;
  vertical-align: middle;
  margin-right: 5px;
}
</style>
