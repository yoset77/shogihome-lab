<template>
  <div>
    <dialog ref="dialog" class="menu">
      <div class="group">
        <button data-hotkey="Escape" class="close" @click="emit('close')">
          <Icon :icon="IconType.CLOSE" />
          <div class="label">{{ t.back }}</div>
        </button>
      </div>
      <div class="group">
        <button
          v-if="
            store.isMovableByUser && DeclarableJishogiRules.includes(store.gameSettings.jishogiRule)
          "
          class="close"
          @click="onWin"
        >
          <Icon :icon="IconType.CALL" />
          <div class="label">{{ t.declareWin }}</div>
        </button>
        <button @click="onJishogiPoints">
          <Icon :icon="IconType.QUESTION" />
          <div class="label">{{ t.jishogiPoints }}</div>
        </button>
        <button v-if="store.gameSettings.repeat >= 2" @click="onShowGameResults">
          <Icon :icon="IconType.SCORE" />
          <div class="label">{{ t.displayGameResults }}</div>
        </button>
      </div>
    </dialog>
  </div>
</template>

<script setup lang="ts">
import { t } from "@/common/i18n";
import { DeclarableJishogiRules } from "@/common/settings/game";
import { IconType } from "@/renderer/assets/icons";
import { installHotKeyForDialog, uninstallHotKeyForDialog } from "@/renderer/devices/hotkey";
import { showModalDialog } from "@/renderer/helpers/dialog";
import { useStore } from "@/renderer/store";
import Icon from "@/renderer/view/primitive/Icon.vue";
import { onBeforeUnmount, onMounted, ref } from "vue";

const emit = defineEmits<{ close: [] }>();
const store = useStore();
const dialog = ref<HTMLDialogElement>();

onMounted(() => {
  showModalDialog(dialog.value!, () => emit("close"));
  installHotKeyForDialog(dialog.value!);
});
onBeforeUnmount(() => {
  uninstallHotKeyForDialog(dialog.value!);
});

const onWin = () => {
  store.declareWin();
  emit("close");
};
const onJishogiPoints = () => {
  store.showJishogiPoints();
  emit("close");
};
const onShowGameResults = () => {
  store.showGameResults();
  emit("close");
};
</script>
