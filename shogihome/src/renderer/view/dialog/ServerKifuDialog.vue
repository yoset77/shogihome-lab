<template>
  <DialogFrame @cancel="onCancel">
    <div class="title">{{ t.serverKifu }}</div>
    <div class="header row align-center">
      <div class="filter row align-center">
        <div class="view-mode-selector row align-center">
          <ToggleButton v-model:value="isFolderView" :label="t.folderView" />
        </div>
        <div class="search-filter row align-center">
          <input v-model.trim="searchWord" :placeholder="t.search" />
          <button @click="searchWord = ''">&#x2715;</button>
        </div>
      </div>
      <button class="reload" @click="updateList(true)">{{ t.reload }}</button>
    </div>
    <div v-if="isFolderView" class="breadcrumbs row align-center">
      <div class="breadcrumb-item" @click="currentDir = ''">Root</div>
      <template v-for="(dir, index) in breadcrumbs" :key="index">
        <div class="breadcrumb-separator">/</div>
        <div class="breadcrumb-item" @click="currentDir = dir.path">
          {{ dir.name }}
        </div>
      </template>
    </div>
    <div class="form-group kifu-list">
      <div v-for="entry in displayEntries" :key="entry.relPath">
        <div class="kifu-list-entry row align-center">
          <div class="kifu-header row align-center">
            <span
              v-if="entry.isDirectory"
              class="directory-name"
              @click="currentDir = entry.relPath"
              >{{ entry.name }}</span
            >
            <span v-else class="file-path">{{ entry.name }}</span>
          </div>
          <div class="connector"></div>
          <button v-if="!entry.isDirectory" @click="open(entry.relPath)">
            {{ t.open }}
          </button>
        </div>
      </div>
      <div v-if="list.length === 0" class="note">
        {{ t.noKifuFoundCheckKifuDir }}
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
import { computed, onMounted, ref, watch } from "vue";
import { useStore } from "@/renderer/store";
import api from "@/renderer/ipc/api";
import { useErrorStore } from "@/renderer/store/error";
import { useBusyState } from "@/renderer/store/busy";
import DialogFrame from "./DialogFrame.vue";
import ToggleButton from "@/renderer/view/primitive/ToggleButton.vue";

const store = useStore();
const busyState = useBusyState();
const list = ref<string[]>([]);
const searchWord = ref("");
const isFolderView = ref(localStorage.getItem("serverKifuFolderView") === "true");
const currentDir = ref("");

watch(isFolderView, (val) => {
  localStorage.setItem("serverKifuFolderView", String(val));
});

async function updateList(reload?: boolean) {
  try {
    busyState.retain();
    list.value = await api.listServerKifu(reload);
  } catch (e) {
    console.warn(e);
    useErrorStore().add(e);
  } finally {
    busyState.release();
  }
}

interface Entry {
  name: string;
  relPath: string;
  isDirectory: boolean;
}

const breadcrumbs = computed(() => {
  if (!currentDir.value) return [];
  const parts = currentDir.value.split(/[/\\]/);
  return parts.map((part, index) => ({
    name: part,
    path: parts.slice(0, index + 1).join("/"),
  }));
});

const displayEntries = computed<Entry[]>(() => {
  const words = searchWord.value
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => !!w);

  if (!isFolderView.value) {
    return list.value
      .filter((file) => {
        const fileLower = file.toLowerCase();
        return words.every((word) => fileLower.includes(word));
      })
      .map((file) => ({
        name: file.replace(/\\/g, "/"),
        relPath: file,
        isDirectory: false,
      }));
  }

  // hierarchy mode
  const currentDirLower = currentDir.value.toLowerCase().replace(/\\/g, "/");
  const prefix = currentDir.value ? currentDir.value.replace(/\\/g, "/") + "/" : "";

  // 検索ワードがある場合は再帰的に検索
  if (words.length > 0) {
    return list.value
      .filter((file) => {
        const fileNormalized = file.replace(/\\/g, "/");
        if (!fileNormalized.toLowerCase().startsWith(currentDirLower)) {
          return false;
        }
        const relative = fileNormalized.substring(prefix.length).toLowerCase();
        return words.every((word) => relative.includes(word));
      })
      .map((file) => ({
        name: file.replace(/\\/g, "/").substring(prefix.length),
        relPath: file,
        isDirectory: false,
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  // 検索ワードがない場合は現在の階層のファイルとフォルダを表示
  const entriesMap = new Map<string, Entry>();
  list.value.forEach((file) => {
    const fileNormalized = file.replace(/\\/g, "/");
    if (fileNormalized.toLowerCase().startsWith(currentDirLower)) {
      const relative = fileNormalized.substring(prefix.length);
      const parts = relative.split("/");
      if (parts.length > 1) {
        // Subdirectory
        const dirName = parts[0];
        const dirPath = prefix + dirName;
        if (!entriesMap.has(dirName)) {
          entriesMap.set(dirName, {
            name: dirName,
            relPath: dirPath,
            isDirectory: true,
          });
        }
      } else if (parts.length === 1 && parts[0] !== "") {
        // File in current directory
        const fileName = parts[0];
        entriesMap.set(fileName, {
          name: fileName,
          relPath: file,
          isDirectory: false,
        });
      }
    }
  });

  return Array.from(entriesMap.values()).sort((a, b) => {
    if (a.isDirectory !== b.isDirectory) {
      return a.isDirectory ? -1 : 1;
    }
    return a.name.localeCompare(b.name);
  });
});

async function open(relPath: string) {
  try {
    busyState.retain();
    const fileURI = await api.loadServerKifu(relPath);
    busyState.release();
    store.closeModalDialog();
    store.openRecord(fileURI);
  } catch (e) {
    busyState.release();
    useErrorStore().add(e);
  }
}

function onCancel() {
  store.closeModalDialog();
}

onMounted(() => {
  updateList();
});
</script>

<style scoped>
.form-group {
  width: 600px;
  max-width: 100%;
  box-sizing: border-box;
}
.header {
  margin: 10px 5px;
}
.filter {
  text-align: left;
  width: 100%;
}
.view-mode-selector {
  margin-right: 15px;
  white-space: nowrap;
}
.search-filter {
  flex: 1;
  min-width: 0;
}
.search-filter > input {
  width: 100%;
  min-width: 100px;
}
.search-filter > button {
  font-size: 0.62em;
  margin: 0;
}
button.reload {
  width: 120px;
  margin-left: 10px;
}
@media (max-width: 600px) {
  .header.row {
    display: flex;
    flex-wrap: wrap;
    flex-direction: row;
    align-items: center;
    justify-content: space-between;
  }
  .filter.row {
    display: contents;
  }
  .view-mode-selector {
    order: 1;
    flex: 0 1 auto;
    margin-right: 0;
    margin-bottom: 10px;
  }
  button.reload {
    order: 2;
    width: auto;
    margin-left: auto;
    margin-right: 0;
    margin-bottom: 10px;
    padding: 5px 15px;
    flex-shrink: 0;
  }
  .search-filter {
    order: 3;
    width: 100%;
    flex: none;
    margin-bottom: 5px;
    margin-right: 0;
    box-sizing: border-box;
  }
}
.breadcrumbs {
  margin: 0 10px 5px 10px;
  padding: 5px 10px;
  background-color: var(--text-bg-color);
  border-radius: 5px;
  font-size: 0.85em;
  overflow-x: auto;
  white-space: nowrap;
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
.kifu-list {
  height: calc(100vh - 350px);
  overflow-y: auto;
  background-color: var(--text-bg-color);
}
.kifu-list-entry {
  padding: 8px 10px;
}
.kifu-list-entry button {
  flex-shrink: 0;
  white-space: nowrap;
}
.kifu-header {
  font-size: 0.9em;
  white-space: nowrap;
  overflow: hidden;
  max-width: 450px;
  min-width: 0;
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
.connector {
  flex: 1;
  border-bottom: 1px dashed var(--text-dashed-separator-color);
  margin: 0 10px;
}
.note {
  margin-top: 20px;
  font-size: 0.8em;
  color: var(--text-color-warning);
}
</style>
