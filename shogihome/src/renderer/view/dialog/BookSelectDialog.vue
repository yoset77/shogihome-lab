<template>
  <DialogFrame @cancel="onCancel">
    <div class="title">{{ t.book }}</div>
    <div class="header row align-center">
      <div class="filter row align-center">
        <div class="search-filter row align-center">
          <input v-model.trim="searchWord" :placeholder="t.search" />
          <button @click="searchWord = ''">&#x2715;</button>
        </div>
      </div>
      <button class="reload" @click="updateList()">{{ t.reload }}</button>
    </div>
    <div class="form-group book-list">
      <div v-for="file in filteredList" :key="file">
        <div class="book-list-entry row align-center">
          <div class="book-header">{{ displayPath(file) }}</div>
          <div class="connector"></div>
          <button @click="open(file)">{{ t.open }}</button>
        </div>
      </div>
      <div v-if="list.length === 0" class="note">
        {{ t.noBookFoundCheckKifuDir }}
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
import { computed, onMounted, ref } from "vue";
import { useStore } from "@/renderer/store";
import api from "@/renderer/ipc/api";
import { useErrorStore } from "@/renderer/store/error";
import { useBusyState } from "@/renderer/store/busy";
import { useBookStore } from "@/renderer/store/book";
import DialogFrame from "./DialogFrame.vue";
import { normalizePath } from "@/common/helpers/path";

const store = useStore();
const bookStore = useBookStore();
const busyState = useBusyState();
const list = ref<string[]>([]);
const searchWord = ref("");

async function updateList() {
  try {
    busyState.retain();
    list.value = await api.listServerBook();
  } catch (e) {
    console.warn(e);
    useErrorStore().add(e);
  } finally {
    busyState.release();
  }
}

const filteredList = computed(() => {
  const words = searchWord.value
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => !!w);
  return list.value.filter((file) => {
    const fileLower = file.toLowerCase();
    return words.every((word) => fileLower.includes(word));
  });
});

const displayPath = (file: string) => {
  return normalizePath(file);
};

async function open(relPath: string) {
  store.closeModalDialog();
  bookStore.openBook("server://" + relPath);
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
  flex-shrink: 0;
  white-space: nowrap;
}
@media (max-width: 600px) {
  button.reload {
    width: auto;
    padding: 5px 10px;
  }
}
.book-list {
  height: calc(100vh - 300px);
  overflow-y: auto;
  background-color: var(--text-bg-color);
}
.book-list-entry {
  padding: 8px 10px;
}
.book-list-entry button {
  flex-shrink: 0;
  white-space: nowrap;
}
.book-header {
  font-size: 0.9em;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 450px;
  min-width: 0;
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
