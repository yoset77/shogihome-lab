<template>
  <DialogFrame @cancel="onCancel">
    <div class="root">
      <div class="title">{{ t.research }}</div>
      <div class="form-group">
        <PlayerSelector v-model:player-uri="engineURI" engine-type="research" />
      </div>
      <div v-for="(_, index) in secondaryEngineURIs" :key="index" class="form-group">
        <PlayerSelector v-model:player-uri="secondaryEngineURIs[index]" engine-type="research">
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
          <label class="form-item-label-wide" for="research-multi-pv">{{
            t.suggestionsCount
          }}</label>
          <ToggleButton v-model:value="researchSettings.overrideMultiPV" />
          <input
            id="research-multi-pv"
            v-model.number="researchSettings.multiPV"
            class="number"
            type="number"
            :min="MIN_MULTIPV"
            :max="MAX_MULTIPV"
            step="1"
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
import { MIN_MULTIPV, MAX_MULTIPV } from "@/common/engine/relay_protocol";
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
import { resolveLanEngine } from "@/renderer/helpers/engine";

const store = useStore();
const appSettings = useAppSettings();
const busyState = useBusyState();
const researchSettings = ref(defaultResearchSettings());
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

const onStart = () => {
  const engine = resolveLanEngine(engineURI.value, lanStore.engineList.value, "research");
  const secondaries = [];
  for (const uri of secondaryEngineURIs.value) {
    const secondary = resolveLanEngine(uri, lanStore.engineList.value, "research");
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
