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
        <div v-for="(file, index) in files" :key="index" class="file row align-center">
          <div class="file-details">
            <span class="name" :title="file.file.name">{{ file.file.name }}</span>
            <label class="save-name row align-center">
              <span>{{ t.uploadFileName }}</span>
              <input
                v-model="file.baseName"
                type="text"
                :aria-label="`${t.uploadFileName}: ${file.file.name}`"
              />
              <span class="extension">{{ file.extension }}</span>
            </label>
          </div>
          <span class="size">{{ formatSize(file.file.size) }}</span>
          <button class="thin remove" :aria-label="t.remove" @click="removeFile(index)">
            <Icon :icon="IconType.CLOSE" />
          </button>
        </div>
      </div>

      <div class="destination-label">{{ t.uploadDestination }}</div>
      <div class="server-selection-list">
        <div class="server-selection-header breadcrumbs">
          <span class="breadcrumb-item" @click="openDirectory('')">{{ t.rootDirectory }}</span>
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

      <form class="new-directory row align-center" @submit.prevent="createDirectory">
        <input
          v-model="newDirectoryName"
          type="text"
          :placeholder="t.folderName"
          :aria-label="t.folderName"
        />
        <button
          class="create-directory"
          type="submit"
          :disabled="!directoryReady || !newDirectoryName"
        >
          {{ t.createNewFolder }}
        </button>
      </form>

      <div class="main-buttons">
        <button class="upload" :disabled="!directoryReady || files.length === 0" @click="upload">
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
import { SERVER_UPLOAD_ACCEPT, type ServerDirectoryEntry } from "@/common/file/upload";
import { useStore } from "@/renderer/store";
import { useBusyState } from "@/renderer/store/busy";
import { useConfirmationStore } from "@/renderer/store/confirm";
import { useErrorStore } from "@/renderer/store/error";
import {
  createUploadDirectory,
  createUploadItem,
  getUploadFileName,
  listUploadDirectories,
  uploadServerFiles,
  type ServerFileUploadItem,
} from "@/renderer/store/serverFileUpload";
import { useToastStore } from "@/renderer/store/toast";
import DialogFrame from "./DialogFrame.vue";
import Icon from "@/renderer/view/primitive/Icon.vue";
import { IconType } from "@/renderer/assets/icons";

const store = useStore();
const files = ref<ServerFileUploadItem[]>([]);
const currentDirectory = ref("");
const directories = ref<ServerDirectoryEntry[]>([]);
const fileInput = ref<HTMLInputElement>();
const newDirectoryName = ref("");
const directoryReady = ref(false);

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
  files.value.push(...Array.from(input.files ?? []).map(createUploadItem));
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
    directoryReady.value = true;
  } catch (error) {
    useErrorStore().add(error);
  } finally {
    busy.release();
  }
};

const createDirectory = async () => {
  const busy = useBusyState();
  busy.retain();
  try {
    const created = await createUploadDirectory(currentDirectory.value, newDirectoryName.value);
    currentDirectory.value = created.path;
    directories.value = [];
    newDirectoryName.value = "";
    directoryReady.value = true;
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
  const directory = currentDirectory.value;
  try {
    const initial = await uploadServerFiles(files.value, directory);
    if (!initial.conflicts.length) {
      finish(initial.uploaded.length, initial.errors);
      return;
    }

    useConfirmationStore().show({
      message: t.overwriteUploadConflicts(
        initial.conflicts
          .map((file) =>
            directory ? `${directory}/${getUploadFileName(file)}` : getUploadFileName(file),
          )
          .join("\n"),
      ),
      onOk: async () => {
        const retried = await uploadServerFiles(initial.conflicts, directory, true);
        finish(initial.uploaded.length + retried.uploaded.length, [
          ...initial.errors,
          ...retried.errors,
        ]);
      },
      onCancel: () => finish(initial.uploaded.length, initial.errors),
    });
  } catch (error) {
    useErrorStore().add(error);
  }
};

onMounted(() => openDirectory(""));
</script>

<style scoped>
.root {
  width: clamp(420px, 45vw, 640px);
  max-width: calc(95vw - 32px);
  max-height: min(864px, 95dvh);
  gap: 10px;
  overflow-y: auto;
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
.file-details {
  flex: 1;
  min-width: 0;
  text-align: left;
}
.file .name {
  display: block;
  overflow: hidden;
  text-align: left;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.save-name {
  gap: 5px;
  margin-top: 5px;
}
.save-name > span,
.create-directory {
  flex-shrink: 0;
}
.save-name input,
.new-directory input {
  flex: 1;
  min-width: 0;
  width: 0;
}
.new-directory {
  gap: 8px;
}
.file-picker,
.new-directory,
.main-buttons {
  flex-shrink: 0;
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
