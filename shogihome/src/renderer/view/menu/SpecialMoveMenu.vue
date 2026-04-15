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
        <button @click="onInsert(SpecialMoveType.INTERRUPT)">
          <Icon :icon="IconType.STOP" />
          <div class="label">{{ t.interrupt }}</div>
        </button>
        <button @click="onInsert(SpecialMoveType.RESIGN)">
          <Icon :icon="IconType.RESIGN" />
          <div class="label">{{ t.resign }}</div>
        </button>
        <button @click="onInsert(SpecialMoveType.DRAW)">
          <Icon :icon="IconType.NOTE" />
          <div class="label">{{ t.draw }}</div>
        </button>
        <button @click="onInsert(SpecialMoveType.IMPASS)">
          <Icon :icon="IconType.NOTE" />
          <div class="label">{{ t.impass }}</div>
        </button>
        <button @click="onInsert(SpecialMoveType.REPETITION_DRAW)">
          <Icon :icon="IconType.NOTE" />
          <div class="label">{{ t.repetitionDraw }}</div>
        </button>
        <button @click="onInsert(SpecialMoveType.MATE)">
          <Icon :icon="IconType.NOTE" />
          <div class="label">{{ t.mate }}</div>
        </button>
        <button @click="onInsert(SpecialMoveType.NO_MATE)">
          <Icon :icon="IconType.NOTE" />
          <div class="label">{{ t.noMate }}</div>
        </button>
        <button @click="onInsert(SpecialMoveType.TIMEOUT)">
          <Icon :icon="IconType.NOTE" />
          <div class="label">{{ t.timeout }}</div>
        </button>
        <button @click="onInsert(SpecialMoveType.FOUL_WIN)">
          <Icon :icon="IconType.NOTE" />
          <div class="label">{{ t.foulWin }}</div>
        </button>
        <button @click="onInsert(SpecialMoveType.FOUL_LOSE)">
          <Icon :icon="IconType.NOTE" />
          <div class="label">{{ t.foulLose }}</div>
        </button>
        <button @click="onInsert(SpecialMoveType.ENTERING_OF_KING)">
          <Icon :icon="IconType.NOTE" />
          <div class="label">{{ t.enteringOfKing }}</div>
        </button>
        <button @click="onInsert(SpecialMoveType.WIN_BY_DEFAULT)">
          <Icon :icon="IconType.NOTE" />
          <div class="label">{{ t.winByDefault }}</div>
        </button>
        <button @click="onInsert(SpecialMoveType.LOSE_BY_DEFAULT)">
          <Icon :icon="IconType.NOTE" />
          <div class="label">{{ t.loseByDefault }}</div>
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
import { useStore } from "@/renderer/store";
import { SpecialMoveType } from "tsshogi";
import { installHotKeyForDialog, uninstallHotKeyForDialog } from "@/renderer/devices/hotkey";

const emit = defineEmits<{
  close: [];
}>();

const store = useStore();
const dialog = ref();
const onClose = () => {
  emit("close");
};
const onInsert = (type: SpecialMoveType) => {
  store.insertSpecialMove(type);
  emit("close");
};
onMounted(() => {
  showModalDialog(dialog.value, onClose);
  installHotKeyForDialog(dialog.value);
});
onBeforeUnmount(() => {
  uninstallHotKeyForDialog(dialog.value);
});
</script>
