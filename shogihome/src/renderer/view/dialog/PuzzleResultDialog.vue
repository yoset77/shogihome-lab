<template>
  <dialog ref="dialog" class="message-box">
    <div class="message-area">
      <Icon :icon="IconType.INFO" />
      <div class="message">{{ store.puzzleResult?.text }}</div>
    </div>
    <div class="main-buttons">
      <button v-if="store.puzzleResult?.status === 'incorrect'" @click="store.revealPuzzleAnswer()">
        {{ t.showAnswer }}
      </button>
      <button v-else @click="store.nextPuzzle()">{{ t.nextPuzzle }}</button>
      <button autofocus data-hotkey="Escape" @click="store.closePuzzleResult()">
        {{ t.close }}
      </button>
    </div>
  </dialog>
</template>

<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from "vue";
import { t } from "@/common/i18n";
import { IconType } from "@/renderer/assets/icons";
import { installHotKeyForDialog, uninstallHotKeyForDialog } from "@/renderer/devices/hotkey";
import { showModalDialog } from "@/renderer/helpers/dialog";
import { useStore } from "@/renderer/store";
import Icon from "@/renderer/view/primitive/Icon.vue";

const store = useStore();
const dialog = ref<HTMLDialogElement>();

onMounted(() => {
  showModalDialog(dialog.value!, () => store.closePuzzleResult());
  installHotKeyForDialog(dialog.value!);
});

onBeforeUnmount(() => {
  uninstallHotKeyForDialog(dialog.value!);
});
</script>

<style scoped>
.main-buttons {
  flex-wrap: wrap;
  gap: 8px;
}
</style>
