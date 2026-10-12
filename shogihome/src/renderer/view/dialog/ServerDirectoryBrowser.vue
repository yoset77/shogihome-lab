<template>
  <div class="server-directory">
    <div v-if="showPathInput" class="form-item row path-input">
      <input class="grow" type="text" :value="displayPath" readonly />
      <button class="thin" type="button" @click="emit('open')">{{ t.select }}</button>
    </div>
    <div v-if="open" class="server-selection-list">
      <div class="server-selection-header breadcrumbs">
        <span class="breadcrumb-item" @click="onNavigate('')">{{ t.rootDirectory }}</span>
        <template v-for="part in breadcrumbParts" :key="part.path">
          <span class="breadcrumb-separator">/</span>
          <span class="breadcrumb-item" @click="onNavigate(part.path)">
            {{ part.name }}
          </span>
        </template>
      </div>
      <div class="server-selection-scroll">
        <div v-if="!path" class="server-selection-item row align-center">
          <div class="entry-header grow" @click="emit('select', rootEntry)">
            <Icon :icon="IconType.OPEN_FOLDER" class="entry-icon" />
            {{ t.rootDirectory }}
          </div>
          <slot name="entry-actions" :entry="rootEntry"></slot>
        </div>
        <div
          v-if="path"
          class="server-selection-item row align-center"
          @click="onNavigate(parentPath)"
        >
          <div class="entry-header grow">
            <Icon :icon="IconType.OPEN_FOLDER" class="entry-icon" />
            ..
          </div>
        </div>
        <div
          v-for="entry in entries"
          :key="entry.path"
          class="server-selection-item row align-center"
        >
          <div class="entry-header grow" @click="emit('select', entry)">
            <Icon v-if="entry.isDirectory" :icon="IconType.OPEN_FOLDER" class="entry-icon" />
            {{ entry.name }}
          </div>
          <slot name="entry-actions" :entry="entry"></slot>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from "vue";
import { t } from "@/common/i18n";
import { normalizePath } from "@/common/helpers/path";
import Icon from "@/renderer/view/primitive/Icon.vue";
import { IconType } from "@/renderer/assets/icons";

export type ServerDirectoryEntryUI = {
  name: string;
  path: string;
  isDirectory: boolean;
};

const props = withDefaults(
  defineProps<{
    /** Selected directory. undefined means nothing is selected and "" means the root. */
    selectedPath?: string;
    /** Current browsing directory used for breadcrumbs and the parent entry. */
    path: string;
    entries: ServerDirectoryEntryUI[];
    open?: boolean;
    showPathInput?: boolean;
  }>(),
  {
    selectedPath: undefined,
    open: false,
    showPathInput: true,
  },
);

const emit = defineEmits<{
  open: [];
  "update:path": [value: string];
  select: [entry: ServerDirectoryEntryUI];
}>();

const displayPath = computed(() =>
  props.selectedPath === undefined ? "" : `server://${props.selectedPath}`,
);

const rootEntry = computed<ServerDirectoryEntryUI>(() => ({
  name: t.rootDirectory,
  path: "",
  isDirectory: true,
}));

const breadcrumbParts = computed(() => {
  if (!props.path) return [];
  const parts = normalizePath(props.path).split("/");
  return parts.map((part, index) => ({ name: part, path: parts.slice(0, index + 1).join("/") }));
});

const parentPath = computed(() =>
  props.path ? normalizePath(props.path).split("/").slice(0, -1).join("/") : "",
);

const onNavigate = (path: string) => {
  emit("update:path", path);
};
</script>

<style scoped>
.path-input {
  align-items: center;
}
.path-input input {
  min-width: 0;
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
  max-height: min(400px, 45dvh);
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
.server-selection-item:last-child {
  border-bottom: none;
}
.server-selection-item:hover {
  background-color: var(--selector-bg-color);
}
.server-selection-item :slotted(button) {
  flex-shrink: 0;
  margin-left: 10px;
}
.entry-icon {
  width: 1.2em;
  height: 1.2em;
  vertical-align: middle;
  margin-right: 5px;
}
</style>
