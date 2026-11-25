<template>
  <DialogFrame @cancel="onCancel">
    <div class="form-group column">
      <div class="message">{{ t.importingFollowingRecordOrPosition }}</div>
      <div class="message">{{ t.supportsKIF_KI2_CSA_USI_SFEN_JKF_USEN }}</div>
      <div class="message">
        {{ t.pleasePasteRecordIntoTextArea }}
      </div>
      <textarea ref="textarea"></textarea>
      <HorizontalSelector
        v-model:value="mode"
        :items="[
          { label: t.asNewFile, value: 'standard' },
          { label: t.mergeToRootPosition, value: 'mergeIntoRoot' },
          { label: t.mergeToCurrentPosition, value: 'mergeIntoCurrent' },
        ]"
      />
    </div>
    <div class="main-buttons">
      <button data-hotkey="Enter" autofocus @click="onOk">
        {{ t.import }}
      </button>
      <button data-hotkey="Escape" @click="onCancel">
        {{ t.cancel }}
      </button>
    </div>
  </DialogFrame>
</template>

<script setup lang="ts">
import { t } from "@/common/i18n";
import { useStore } from "@/renderer/store";
import { ref } from "vue";
import { useErrorStore } from "@/renderer/store/error";
import DialogFrame from "./DialogFrame.vue";
import HorizontalSelector from "@/renderer/view/primitive/HorizontalSelector.vue";

const store = useStore();
const textarea = ref();
const mode = ref<"standard" | "mergeIntoRoot" | "mergeIntoCurrent">(store.pasteMode);

const onOk = () => {
  const data = textarea.value.value;
  if (!data) {
    useErrorStore().add(new Error(t.emptyRecordInput));
    return;
  }
  store.closeModalDialog();
  store.pasteRecord(data, mode.value);
};

const onCancel = () => {
  store.closeModalDialog();
};
</script>

<style scoped>
.form-group > * {
  /* Apply the fixed cap before the dialog computes its fit-content width. */
  width: min(460px, 80vw);
  max-width: 100%;
  box-sizing: border-box;
}
.message {
  text-align: left;
  font-size: 0.8em;
}
textarea {
  height: clamp(100px, 60dvh, 640px);
  resize: none;
}
</style>
