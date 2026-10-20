<template>
  <DialogFrame @cancel="onCancel">
    <div class="root">
      <div class="title">{{ t.mateSearch }}</div>
      <div class="form-group">
        <PlayerSelector v-model:player-uri="engineURI" engine-type="mate" />
        <div class="form-item">
          <ToggleButton v-model:value="mateSearchSettings.enableMaxSeconds" />
          <div class="form-item-small-label">{{ t.toPrefix }}</div>
          <input
            v-model.number="mateSearchSettings.maxSeconds"
            class="number"
            type="number"
            min="1"
            :disabled="!mateSearchSettings.enableMaxSeconds"
          />
          <div class="form-item-small-label">{{ t.secondsSuffix }}{{ t.toSuffix }}</div>
        </div>
      </div>
      <div class="main-buttons">
        <button data-hotkey="Enter" autofocus @click="onStart()">
          {{ t.startMateSearch }}
        </button>
        <button data-hotkey="Escape" @click="onCancel()">{{ t.cancel }}</button>
      </div>
    </div>
  </DialogFrame>
</template>

<script setup lang="ts">
import { t } from "@/common/i18n";
import { defaultMateSearchSettings, MateSearchSettings } from "@/common/settings/mate";
import api from "@/renderer/ipc/api";
import { useStore } from "@/renderer/store";
import { onMounted, ref } from "vue";
import PlayerSelector from "./PlayerSelector.vue";
import { useErrorStore } from "@/renderer/store/error";
import { useBusyState } from "@/renderer/store/busy";
import DialogFrame from "./DialogFrame.vue";
import ToggleButton from "@/renderer/view/primitive/ToggleButton.vue";
import { useLanStore } from "@/renderer/store/lan";
import { resolveLanEngine } from "@/renderer/helpers/engine";

const store = useStore();
const busyState = useBusyState();
const mateSearchSettings = ref<MateSearchSettings>(defaultMateSearchSettings());
const engineURI = ref("");
const lanStore = useLanStore();

busyState.retain();

onMounted(async () => {
  try {
    mateSearchSettings.value = await api.loadMateSearchSettings();
    engineURI.value = mateSearchSettings.value.usi?.uri || "";

    if (lanStore.status.value === "disconnected") {
      try {
        await lanStore.fetchEngineList();
      } catch (e) {
        console.warn("Failed to connect to engine server:", e);
      }
    }
  } catch (e) {
    useErrorStore().add(e);
    store.destroyModalDialog();
  } finally {
    busyState.release();
  }
});

const onStart = () => {
  const engine = resolveLanEngine(engineURI.value, lanStore.engineList.value, "mate");
  if (!engine) {
    useErrorStore().add(t.engineNotSelected);
    return;
  }
  const newSettings: MateSearchSettings = {
    ...mateSearchSettings.value,
    usi: engine,
  };
  store.startMateSearch(newSettings);
};

const onCancel = () => {
  store.closeModalDialog();
};
</script>

<style scoped>
.root {
  width: 420px;
}
input.number {
  text-align: right;
  width: 80px;
}
@media (max-width: 600px) {
  .root {
    width: 80vw;
  }
  :deep(.form-item-label-wide) {
    width: 120px;
  }
}
</style>
