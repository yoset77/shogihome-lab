<template>
  <DialogFrame @cancel="onCancel">
    <div class="title">{{ t.serverKifu }}</div>
    <div class="header row align-center">
      <div class="filter row align-center">
        <div class="search-filter row align-center">
          <input v-model.trim="searchWord" :placeholder="t.search" />
          <button @click="searchWord = ''">&#x2715;</button>
        </div>
      </div>
      <button class="reload" @click="updateList()">{{ t.reload }}</button>
    </div>
    <div class="form-group kifu-list">
      <div v-for="file in filteredList" :key="file">
        <div class="kifu-list-entry row align-center">
          <div class="kifu-header">{{ displayPath(file) }}</div>
          <div class="connector"></div>
          <button @click="open(file)">{{ t.open }}</button>
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
import { computed, onMounted, ref } from "vue";
import { useStore } from "@/renderer/store";
import api from "@/renderer/ipc/api";
import { useErrorStore } from "@/renderer/store/error";
import { useBusyState } from "@/renderer/store/busy";
import DialogFrame from "./DialogFrame.vue";

const store = useStore();
const busyState = useBusyState();
const list = ref<string[]>([]);
const searchWord = ref("");

async function updateList() {
  try {
    busyState.retain();
    list.value = await api.listServerKifu();
  } catch (e) {
    console.warn(e);
    useErrorStore().add(e);
  } finally {
    busyState.release();
  }
}

const filteredList = computed(() => {
  const word = searchWord.value.toLowerCase();
  return list.value.filter((file) => {
    return !word || file.toLowerCase().includes(word);
  });
});

const displayPath = (file: string) => {
  return file.replace(/\\/g, "/");
};

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
  max-width: calc(100vw - 50px);
}
.header {
  margin: 10px 5px;
}
.filter {
  text-align: left;
  width: 100%;
}
.search-filter > input {
  width: 200px;
}
.search-filter > button {
  font-size: 0.62em;
  margin: 0;
}
button.reload {
  width: 120px;
}
.kifu-list {
  height: calc(100vh - 300px);
  overflow-y: auto;
  background-color: var(--text-bg-color);
}
.kifu-list-entry {
  padding: 8px 10px;
}
.kifu-header {
  font-size: 0.9em;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 450px;
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
