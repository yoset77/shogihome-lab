<template>
  <DialogFrame limited @cancel="close">
    <div class="root column">
      <div class="title">{{ t.upload }}</div>

      <div class="file-picker row align-center">
        <button @click="fileInput?.click()">{{ t.selectFiles }}</button>
        <input
          ref="fileInput"
          hidden
          type="file"
          multiple
          :accept="SERVER_UPLOAD_ACCEPT"
          @change="selectFiles"
        />
      </div>

      <div v-if="files.length" class="file-list">
        <div
          v-for="(file, index) in files"
          :key="`${file.name}:${file.size}:${file.lastModified}`"
          class="file row align-center"
        >
          <span class="name">{{ file.name }}</span>
          <span class="size">{{ formatSize(file.size) }}</span>
          <button class="thin remove" :aria-label="t.remove" @click="removeFile(index)">
            <Icon :icon="IconType.CLOSE" />
          </button>
        </div>
      </div>

      <div class="destination-label">{{ t.uploadDestination }}</div>
      <div class="server-selection-list">
        <div class="server-selection-header breadcrumbs">
          <span class="breadcrumb-item" @click="openDirectory('')">Root</span>
          <template v-for="part in breadcrumbs" :key="part.path">
            <span class="breadcrumb-separator">/</span>
            <span class="breadcrumb-item" @click="openDirectory(part.path)">
              {{ part.name }}
            </span>
          </template>
        </div>
        <div class="server-selection-scroll">
          <div
            v-if="currentDirectory"
            class="server-selection-item row align-center"
            @click="openDirectory(parentDirectory)"
          >
            <div class="entry-header grow">
              <Icon :icon="IconType.OPEN_FOLDER" class="entry-icon" />
              ..
            </div>
          </div>
          <div
            v-for="directory in directories"
            :key="directory.path"
            class="server-selection-item row align-center"
            @click="openDirectory(directory.path)"
          >
            <div class="entry-header grow">
              <Icon :icon="IconType.OPEN_FOLDER" class="entry-icon" />
              {{ directory.name }}
            </div>
          </div>
        </div>
      </div>

      <div class="main-buttons">
        <button class="upload" :disabled="files.length === 0" @click="upload">
          {{ t.upload }}
        </button>
        <button data-hotkey="Escape" @click="close">{{ t.cancel }}</button>
      </div>
    </div>
  </DialogFrame>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { t } from "@/common/i18n";
import { normalizePath } from "@/common/helpers/path";
import {
  getServerFileKind,
  SERVER_UPLOAD_ACCEPT,
  type ServerDirectoryEntry,
} from "@/common/file/upload";
import { useStore } from "@/renderer/store";
import { useBusyState } from "@/renderer/store/busy";
import { useConfirmationStore } from "@/renderer/store/confirm";
import { useErrorStore } from "@/renderer/store/error";
import { listUploadDirectories, uploadServerFiles } from "@/renderer/store/serverFileUpload";
import { useToastStore } from "@/renderer/store/toast";
import DialogFrame from "./DialogFrame.vue";
import Icon from "@/renderer/view/primitive/Icon.vue";
import { IconType } from "@/renderer/assets/icons";

const store = useStore();
const files = ref<File[]>([]);
const currentDirectory = ref("");
const directories = ref<ServerDirectoryEntry[]>([]);
const fileInput = ref<HTMLInputElement>();

const breadcrumbs = computed(() => {
  if (!currentDirectory.value) return [];
  const parts = normalizePath(currentDirectory.value).split("/");
  return parts.map((name, index) => ({ name, path: parts.slice(0, index + 1).join("/") }));
});

const parentDirectory = computed(() =>
  currentDirectory.value
    ? normalizePath(currentDirectory.value).split("/").slice(0, -1).join("/")
    : "",
);

const formatSize = (size: number) => {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KiB`;
  return `${(size / 1024 / 1024).toFixed(1)} MiB`;
};

const selectFiles = (event: Event) => {
  const input = event.target as HTMLInputElement;
  files.value = [...files.value, ...Array.from(input.files ?? [])];
  input.value = "";
};

const removeFile = (index: number) => {
  files.value.splice(index, 1);
};

const openDirectory = async (path: string) => {
  const busy = useBusyState();
  busy.retain();
  try {
    const result = await listUploadDirectories(path);
    currentDirectory.value = result.path;
    directories.value = result.directories;
  } catch (error) {
    useErrorStore().add(error);
  } finally {
    busy.release();
  }
};

const close = () => store.closeModalDialog();

const finish = (uploaded: number, errors: Error[]) => {
  store.destroyModalDialog();
  if (errors.length) useErrorStore().add(new AggregateError(errors));
  if (uploaded) useToastStore().success(t.nFilesUploaded(uploaded));
};

const upload = async () => {
  const unsupported = files.value.filter((file) => !getServerFileKind(file.name));
  if (unsupported.length) {
    useErrorStore().add(
      new Error(t.unsupportedUploadFiles(unsupported.map((file) => file.name).join("\n"))),
    );
    return;
  }
  const names = new Map<string, string[]>();
  for (const file of files.value) {
    const key = file.name.toLocaleLowerCase();
    names.set(key, [...(names.get(key) ?? []), file.name]);
  }
  const duplicates = [...names.values()].filter((entries) => entries.length > 1).flat();
  if (duplicates.length) {
    useErrorStore().add(new Error(t.duplicateUploadFileNames(duplicates.join("\n"))));
    return;
  }

  const initial = await uploadServerFiles(files.value, currentDirectory.value);
  if (!initial.conflicts.length) {
    finish(initial.uploaded.length, initial.errors);
    return;
  }

  useConfirmationStore().show({
    message: t.overwriteUploadConflicts(initial.conflicts.map((file) => file.name).join("\n")),
    onOk: async () => {
      const retried = await uploadServerFiles(initial.conflicts, currentDirectory.value, true);
      finish(initial.uploaded.length + retried.uploaded.length, [
        ...initial.errors,
        ...retried.errors,
      ]);
    },
    onCancel: () => finish(initial.uploaded.length, initial.errors),
  });
};

onMounted(() => openDirectory(""));
</script>

<style scoped>
.root {
  width: clamp(420px, 45vw, 640px);
  max-width: 88vw;
  max-height: min(864px, 95dvh);
  gap: 10px;
}
.title {
  font-size: 1.2rem;
  font-weight: bold;
  text-align: center;
}
.file-picker {
  gap: 10px;
}
.file-list {
  overflow-y: auto;
  max-height: 200px;
  border: 1px solid var(--dialog-border-color);
  background-color: var(--text-bg-color);
}
.file {
  gap: 12px;
  padding: 5px 10px;
  font-size: 0.9em;
  border-bottom: 1px solid var(--dialog-border-color);
}
.file:last-child {
  border-bottom: none;
}
.file .name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-align: left;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.file .size {
  flex-shrink: 0;
  color: var(--text-color-sub);
}
.file .remove {
  flex-shrink: 0;
  margin: 0;
  padding: 2px 6px;
}
.destination-label {
  font-weight: bold;
  margin-top: 4px;
}
.server-selection-list {
  width: 100%;
  box-sizing: border-box;
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
  max-height: min(340px, 40dvh);
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
.entry-icon {
  width: 1.2em;
  height: 1.2em;
  vertical-align: middle;
  margin-right: 5px;
}
.main-buttons {
  display: flex;
  justify-content: center;
  gap: 10px;
}
@media (max-width: 600px) {
  .root {
    width: 88vw;
    max-height: 85dvh;
  }
  .file-picker {
    flex-wrap: wrap;
  }
  .server-selection-scroll {
    max-height: 36dvh;
  }
}
</style>
