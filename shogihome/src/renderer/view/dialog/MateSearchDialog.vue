<template>
  <DialogFrame @cancel="onCancel">
    <div class="root">
      <div class="title">{{ t.mateSearch }}</div>
      <div class="form-group">
        <PlayerSelector
          v-model:player-uri="engineURI"
          :engines="engines"
          :contains-lan="true"
          :default-tag="getPredefinedUSIEngineTag('mate')"
          :display-thread-state="true"
          :display-multi-pv-state="false"
          @update-engines="
            (val: USIEngines) => {
              engines = val;
            }
          "
        />
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
import {
  getPredefinedUSIEngineTag,
  USIEngines,
  USIEngine,
  emptyUSIEngine,
} from "@/common/settings/usi";
import api from "@/renderer/ipc/api";
import { useStore } from "@/renderer/store";
import { onMounted, ref } from "vue";
import PlayerSelector from "./PlayerSelector.vue";
import { useErrorStore } from "@/renderer/store/error";
import { useBusyState } from "@/renderer/store/busy";
import DialogFrame from "./DialogFrame.vue";
import ToggleButton from "@/renderer/view/primitive/ToggleButton.vue";
import { useLanStore } from "@/renderer/store/lan";

const store = useStore();
const busyState = useBusyState();
const engines = ref(new USIEngines());
const mateSearchSettings = ref<MateSearchSettings>(defaultMateSearchSettings());
const engineURI = ref("");
const lanStore = useLanStore();

busyState.retain();

onMounted(async () => {
  try {
    mateSearchSettings.value = await api.loadMateSearchSettings();
    engines.value = await api.loadUSIEngines();
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

const resolveEngine = (uri: string): USIEngine | undefined => {
  if (uri.startsWith("lan-engine")) {
    let name = uri;
    if (uri.startsWith("lan-engine:")) {
      const id = uri.split(":")[1];
      const info = lanStore.engineList.value.find((e) => e.id === id);
      if (info) {
        name = info.name;
      } else {
        name = `${id} (Not Found)`;
      }
    }
    return {
      ...emptyUSIEngine(),
      uri: uri,
      name: name,
      defaultName: "",
    };
  }
  return engines.value.getEngine(uri);
};

const onStart = () => {
  const engine = resolveEngine(engineURI.value);
  if (!engine) {
    useErrorStore().add("エンジンを選択してください。");
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
