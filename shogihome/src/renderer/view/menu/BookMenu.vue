<template>
  <div>
    <dialog ref="dialog" class="menu">
      <div class="group">
        <button data-hotkey="Escape" class="close" @click="onClose">
          <Icon :icon="IconType.CLOSE" />
          <div class="label">{{ t.back }}</div>
        </button>
      </div>
      <div class="group">
        <button @click="onOpen">
          <Icon :icon="IconType.OPEN" />
          <div class="label">{{ t.open }}</div>
        </button>
        <button :disabled="!isBookOperational" @click="onSaveAs">
          <Icon :icon="IconType.SAVE_AS" />
          <div class="label">{{ t.saveAs }}</div>
        </button>
        <button :disabled="!isBookOperational" @click="onAddMoves">
          <Icon :icon="IconType.ADD" />
          <div class="label">{{ t.addMoves }}</div>
        </button>
        <button @click="onClear">
          <Icon :icon="IconType.REFRESH" />
          <div class="label">{{ t.clear }}</div>
        </button>
      </div>
      <div class="group">
        <button @click="onToggleFlippedBook">
          <Icon :icon="flippedBook ? IconType.CHECK : IconType.FLIP" />
          <div class="label">{{ t.flippedBook }}</div>
        </button>
      </div>
    </dialog>
  </div>
</template>

<script setup lang="ts">
import { t } from "@/common/i18n";
import { showModalDialog } from "@/renderer/helpers/dialog.js";
import { onBeforeUnmount, onMounted, ref } from "vue";
import Icon from "@/renderer/view/primitive/Icon.vue";
import { IconType } from "@/renderer/assets/icons";
import { installHotKeyForDialog, uninstallHotKeyForDialog } from "@/renderer/devices/hotkey";

defineProps({
  isBookOperational: {
    type: Boolean,
    required: true,
  },
  flippedBook: {
    type: Boolean,
    required: true,
  },
});

const emit = defineEmits<{
  close: [];
  open: [];
  saveAs: [];
  addMoves: [];
  clear: [];
  toggleFlippedBook: [];
}>();

const dialog = ref();
const onClose = () => {
  emit("close");
};
onMounted(() => {
  showModalDialog(dialog.value, onClose);
  installHotKeyForDialog(dialog.value);
});
onBeforeUnmount(() => {
  uninstallHotKeyForDialog(dialog.value);
});

const onOpen = () => {
  emit("open");
  emit("close");
};
const onSaveAs = () => {
  emit("saveAs");
  emit("close");
};
const onAddMoves = () => {
  emit("addMoves");
  emit("close");
};
const onClear = () => {
  emit("clear");
  emit("close");
};
const onToggleFlippedBook = () => {
  emit("toggleFlippedBook");
};
</script>
