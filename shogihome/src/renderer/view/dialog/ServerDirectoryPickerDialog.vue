<template>
  <DialogFrame limited :aria-label="title || t.saveDestination" @cancel="emit('cancel')">
    <div class="directory-picker">
      <div class="title">{{ title || t.saveDestination }}</div>
      <div class="directory-path">server://{{ path }}</div>
      <div class="directory-list" :aria-busy="loading">
        <ServerDirectoryBrowser
          :path="path"
          :entries="directoryEntries"
          :open="true"
          :show-path-input="false"
          @update:path="load"
          @select="(entry) => load(entry.path)"
        />
      </div>
      <div class="main-buttons">
        <button
          ref="confirmButton"
          type="button"
          data-hotkey="Enter"
          autofocus
          :disabled="!canSelect"
          @click="onConfirm"
        >
          {{ t.selectCurrentDirectory }}
        </button>
        <button type="button" data-hotkey="Escape" @click="emit('cancel')">
          {{ t.cancel }}
        </button>
      </div>
    </div>
  </DialogFrame>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from "vue";
import { t } from "@/common/i18n";
import { useServerDirectoryPicker } from "@/renderer/store/serverDirectoryPicker";
import DialogFrame from "./DialogFrame.vue";
import ServerDirectoryBrowser from "./ServerDirectoryBrowser.vue";

const props = defineProps<{ initialPath: string; title?: string }>();
const emit = defineEmits<{ select: [path: string]; cancel: [] }>();
const { path, entries, loading, canSelect, load, close } = useServerDirectoryPicker(
  props.initialPath,
);
const confirmButton = ref<HTMLButtonElement>();
const directoryEntries = computed(() =>
  entries.value.map((entry) => ({ ...entry, isDirectory: true })),
);

const onConfirm = () => {
  if (canSelect.value) emit("select", path.value);
};

onMounted(async () => {
  if (!(await load(props.initialPath))) return;
  await nextTick();
  if (canSelect.value) confirmButton.value?.focus();
});
onBeforeUnmount(close);
</script>

<style scoped>
.directory-picker {
  display: flex;
  flex-direction: column;
  width: 520px;
  max-width: 100%;
  min-height: 0;
}
.title,
.directory-path,
.main-buttons {
  flex-shrink: 0;
}
.directory-path {
  overflow-wrap: anywhere;
  text-align: left;
  margin-bottom: 8px;
  padding: 4px;
  border: 1px solid var(--dialog-border-color);
  background-color: var(--text-bg-color);
}
.directory-list {
  min-height: 0;
  overflow-y: auto;
}
.directory-list :deep(.server-selection-list) {
  margin-top: 0;
}
</style>
