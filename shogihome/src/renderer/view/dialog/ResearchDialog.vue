<template>
  <DialogFrame @cancel="onCancel">
    <div class="root">
      <div class="title">{{ t.research }}</div>
      <div class="form-group">
        <PlayerSelector
          v-model:player-uri="engineURI"
          :engines="engines"
          :contains-lan="true"
          :default-tag="getPredefinedUSIEngineTag('research')"
          :display-thread-state="true"
          :display-multi-pv-state="true"
          @update-engines="onUpdatePlayerSettings"
        />
      </div>
      <div v-for="(_, index) in secondaryEngineURIs" :key="index" class="form-group">
        <PlayerSelector
          v-model:player-uri="secondaryEngineURIs[index]"
          :engines="engines"
          :contains-lan="true"
          :default-tag="getPredefinedUSIEngineTag('research')"
          :display-thread-state="true"
          :display-multi-pv-state="true"
          @update-engines="onUpdatePlayerSettings"
        >
          <template #extra-buttons>
            <button @click="secondaryEngineURIs.splice(index, 1)">
              {{ t.remove }}
            </button>
          </template>
        </PlayerSelector>
      </div>
      <button
        v-if="secondaryEngineURIs.length < MAX_SECONDARY_ENGINES"
        class="center thin"
        @click="secondaryEngineURIs.push('')"
      >
        <Icon :icon="IconType.ADD" />
        {{ t.addNthEngine(secondaryEngineURIs.length + 2) }}
      </button>
      <div class="form-group">
        <div class="form-item">
          <div class="form-item-label-wide">{{ t.timePerPosition }}</div>
          <ToggleButton v-model:value="researchSettings.enableMaxSeconds" />
          <input
            v-model.number="researchSettings.maxSeconds"
            class="number"
            type="number"
            min="1"
            :disabled="!researchSettings.enableMaxSeconds"
          />
        </div>
        <div class="form-item">
          <div class="form-item-label-wide">{{ t.suggestionsCount }}</div>
          <ToggleButton v-model:value="researchSettings.overrideMultiPV" />
          <input
            v-model.number="researchSettings.multiPV"
            class="number"
            type="number"
            min="1"
            :disabled="!researchSettings.overrideMultiPV"
          />
        </div>
      </div>
      <div class="main-buttons">
        <button data-hotkey="Enter" autofocus @click="onStart()">
          {{ t.startResearch }}
        </button>
        <button data-hotkey="Escape" @click="onCancel()">
          {{ t.cancel }}
        </button>
      </div>
    </div>
  </DialogFrame>
</template>

<script setup lang="ts">
import { t } from "@/common/i18n";
import api from "@/renderer/ipc/api";
import {
  defaultResearchSettings,
  ResearchSettings,
  validateResearchSettings,
} from "@/common/settings/research";
import { USIEngine, getPredefinedUSIEngineTag, USIEngines } from "@/common/settings/usi";
import { useStore } from "@/renderer/store";
import { onMounted, ref } from "vue";
import PlayerSelector from "@/renderer/view/dialog/PlayerSelector.vue";
import ToggleButton from "@/renderer/view/primitive/ToggleButton.vue";
import Icon from "@/renderer/view/primitive/Icon.vue";
import { IconType } from "@/renderer/assets/icons";
import { useErrorStore } from "@/renderer/store/error";
import { useBusyState } from "@/renderer/store/busy";
import DialogFrame from "./DialogFrame.vue";
import { useLanStore } from "@/renderer/store/lan";
import { useAppSettings } from "@/renderer/store/settings";

const store = useStore();
const appSettings = useAppSettings();
const busyState = useBusyState();
const researchSettings = ref(defaultResearchSettings());
const engines = ref(new USIEngines());
const engineURI = ref("");
const secondaryEngineURIs = ref([] as string[]);
const lanStore = useLanStore();

const MAX_SECONDARY_ENGINES = 2;

busyState.retain();

onMounted(async () => {
  try {
    researchSettings.value = await api.loadResearchSettings();
    if (!researchSettings.value.usi) {
      researchSettings.value.overrideMultiPV = true;
      researchSettings.value.multiPV = appSettings.researchMultiPV;
    }
    engines.value = await api.loadUSIEngines();

    engineURI.value = researchSettings.value.usi?.uri || "";
    secondaryEngineURIs.value =
      researchSettings.value.secondaries?.map((engine) => engine.usi?.uri || "") || [];

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
      uri: uri,
      name: name,
      defaultName: "",
      author: "",
      path: "",
      options: {},
      labels: {},
      enableEarlyPonder: false,
    };
  }
  return engines.value.getEngine(uri);
};

const onStart = () => {
  const engine = resolveEngine(engineURI.value);
  const secondaries = [];
  for (const uri of secondaryEngineURIs.value) {
    const secondary = resolveEngine(uri);
    if (secondary) {
      secondaries.push({
        usi: secondary,
      });
    }
  }
  const newSettings: ResearchSettings = {
    ...researchSettings.value,
    usi: engine,
    secondaries: secondaries,
  };
  const e = validateResearchSettings(newSettings);
  if (e) {
    useErrorStore().add(e);
    return;
  }
  store.startResearch(newSettings);
};

const onCancel = () => {
  store.closeResearchDialog();
};

const onUpdatePlayerSettings = async (val: USIEngines) => {
  engines.value = val;
};
</script>

<style scoped>
.root {
  width: 450px;
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
