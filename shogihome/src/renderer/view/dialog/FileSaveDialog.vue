<template>
  <DialogFrame limited :aria-label="options.title" @cancel="emit('cancel')">
    <form class="file-save column" @submit.prevent="save">
      <div class="title">{{ options.title }}</div>
      <template v-if="options.server">
        <div>{{ t.saveDestination }}</div>
        <ServerDirectoryField
          v-model:value="directory"
          :disabled="false"
          :label="t.saveDestination"
        />
      </template>
      <div class="save-name column">
        <label :for="nameId">{{ t.uploadFileName }}</label>
        <div class="row align-center">
          <input
            :id="nameId"
            ref="nameInput"
            v-model="baseName"
            type="text"
            autofocus
            :aria-invalid="!!error"
            :aria-describedby="error ? errorId : undefined"
          />
          <span v-if="options.extensions.length === 1" class="extension">{{ extension }}</span>
          <select v-else v-model="extension" :aria-label="t.format">
            <option v-for="ext in options.extensions" :key="ext" :value="ext">{{ ext }}</option>
          </select>
        </div>
      </div>
      <div class="destination">{{ path }}</div>
      <div v-if="error" :id="errorId" class="validation-error" role="status">{{ error }}</div>
      <div class="main-buttons">
        <button type="submit" data-hotkey="Enter" :disabled="!!error">{{ t.save }}</button>
        <button type="button" data-hotkey="Escape" @click="emit('cancel')">{{ t.cancel }}</button>
      </div>
    </form>
  </DialogFrame>
</template>

<script setup lang="ts">
import { onMounted, ref, useId } from "vue";
import { t } from "@/common/i18n";
import { useFileSaveDraft, type FileSaveOptions } from "@/renderer/store/fileSave";
import DialogFrame from "./DialogFrame.vue";
import ServerDirectoryField from "./ServerDirectoryField.vue";

const props = defineProps<{ options: FileSaveOptions }>();
const emit = defineEmits<{ select: [path: string]; cancel: [] }>();
const { baseName, extension, directory, path, error } = useFileSaveDraft(props.options);
const nameId = useId();
const errorId = useId();
const nameInput = ref<HTMLInputElement>();
const save = () => {
  if (!error.value) emit("select", path.value);
};
onMounted(() => {
  const input = nameInput.value;
  if (!input) return;
  input.focus();
  input.setSelectionRange(input.value.length, input.value.length);
});
</script>

<style scoped>
.file-save {
  width: 520px;
  max-width: 100%;
  min-height: 0;
  gap: 10px;
  overflow-y: auto;
  text-align: left;
}
.save-name input {
  flex: 1;
  min-width: 0;
}
.save-name .row {
  gap: 8px;
}
.destination,
.validation-error {
  overflow-wrap: anywhere;
  white-space: pre-wrap;
}
.validation-error {
  color: var(--text-color-warning);
}
</style>
