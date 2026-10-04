<template>
  <dialog ref="dialog" class="game-records">
    <h2>{{ messages.retainedRecords }}</h2>
    <div class="records">
      <div v-for="(record, index) in store.gameStatus?.records" :key="record.gameId" class="record">
        <span>{{ index + 1 }}: {{ messages[record.state] }} {{ record.path }}</span>
        <button v-if="record.state !== 'saved'" @click="open(record.gameId)">{{ t.open }}</button>
      </div>
    </div>
    <div class="actions">
      <button :disabled="busy.isBusy" @click="store.retryGameSaving()">
        {{ messages.retrySave }}
      </button>
      <button :disabled="busy.isBusy" @click="forget">{{ messages.forget }}</button>
      <button @click="emit('close')">{{ t.close }}</button>
    </div>
  </dialog>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { t } from "@/common/i18n";
import { gameTexts } from "@/common/i18n/game";
import { useStore } from "@/renderer/store";
import { useAppSettings } from "@/renderer/store/settings";
import { useBusyState } from "@/renderer/store/busy";
import { showModalDialog } from "@/renderer/helpers/dialog";
import { installHotKeyForDialog, uninstallHotKeyForDialog } from "@/renderer/devices/hotkey";

const emit = defineEmits<{ close: [] }>();
const dialog = ref<HTMLDialogElement>();
const store = useStore();
const busy = useBusyState();
const messages = computed(() => gameTexts(useAppSettings().language));
onMounted(() => {
  showModalDialog(dialog.value!, () => emit("close"));
  installHotKeyForDialog(dialog.value!);
});
onBeforeUnmount(() => uninstallHotKeyForDialog(dialog.value!));
const open = async (gameId: string) => {
  await store.openRetainedGameRecord(gameId);
  emit("close");
};
const forget = () => {
  emit("close");
  store.forgetGame();
};
</script>

<style scoped>
.game-records {
  max-width: 90vw;
}
.records {
  max-height: 50vh;
  overflow: auto;
}
.record,
.actions {
  display: flex;
  gap: 0.5rem;
  align-items: center;
  padding: 0.5rem;
}
.record span {
  flex: 1;
  overflow-wrap: anywhere;
}
.actions {
  flex-wrap: wrap;
}
</style>
