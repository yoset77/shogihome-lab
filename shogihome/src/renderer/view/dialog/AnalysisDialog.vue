<template>
  <DialogFrame @cancel="onCancel">
    <div class="root">
      <div class="title">{{ t.recordAnalysis }}</div>
      <div class="form-group">
        <div>{{ t.searchEngine }}</div>
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
      <div class="form-group">
        <div>{{ t.startEndCriteria }}</div>
        <div class="form-item">
          <ToggleButton v-model:value="settings.startCriteria.enableNumber" />
          <div class="form-item-small-label">{{ t.fromPrefix }}{{ t.plyPrefix }}</div>
          <input
            v-model.number="settings.startCriteria.number"
            class="small"
            type="number"
            min="1"
            step="1"
            :disabled="!settings.startCriteria.enableNumber"
          />
          <div class="form-item-small-label">{{ t.plySuffix }}{{ t.fromSuffix }}</div>
        </div>
        <div class="form-item">
          <ToggleButton v-model:value="settings.endCriteria.enableNumber" />
          <div class="form-item-small-label">{{ t.toPrefix }}{{ t.plyPrefix }}</div>
          <input
            v-model.number="settings.endCriteria.number"
            class="small"
            type="number"
            min="1"
            step="1"
            :disabled="!settings.endCriteria.enableNumber"
          />
          <div class="form-item-small-label">{{ t.plySuffix }}{{ t.toSuffix }}</div>
        </div>
        <div class="form-item">
          <ToggleButton v-model:value="settings.descending" :label="t.descending" />
        </div>
      </div>
      <div class="form-group">
        <div>{{ t.endCriteria1Move }}</div>
        <div class="form-item">
          <div class="form-item-small-label">{{ t.toPrefix }}</div>
          <input
            v-model.number="settings.perMoveCriteria.maxSeconds"
            class="small"
            type="number"
            min="0"
            step="1"
          />
          <div class="form-item-small-label">{{ t.secondsSuffix }}{{ t.toSuffix }}</div>
        </div>
      </div>
      <div class="form-group">
        <div>{{ t.outputSettings }}</div>
        <div class="form-item">
          <div class="form-item-label-wide">{{ t.moveComments }}</div>
          <HorizontalSelector
            v-model:value="settings.commentBehavior"
            class="selector"
            :items="[
              { value: CommentBehavior.NONE, label: t.noOutputs },
              { value: CommentBehavior.INSERT, label: t.insertCommentToTop },
              { value: CommentBehavior.APPEND, label: t.appendCommentToBottom },
              { value: CommentBehavior.OVERWRITE, label: t.overwrite },
            ]"
          />
        </div>
      </div>
      <div class="main-buttons">
        <button data-hotkey="Enter" autofocus @click="onStart()">
          {{ t.analyze }}
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
import { defaultAnalysisSettings, validateAnalysisSettings } from "@/common/settings/analysis";
import { CommentBehavior } from "@/common/settings/comment";
import { getPredefinedUSIEngineTag, USIEngines, USIEngine } from "@/common/settings/usi";
import { useStore } from "@/renderer/store";
import { onMounted, ref } from "vue";
import PlayerSelector from "@/renderer/view/dialog/PlayerSelector.vue";
import ToggleButton from "@/renderer/view/primitive/ToggleButton.vue";
import HorizontalSelector from "@/renderer/view/primitive/HorizontalSelector.vue";
import { useErrorStore } from "@/renderer/store/error";
import { useBusyState } from "@/renderer/store/busy";
import DialogFrame from "./DialogFrame.vue";
import { useLanStore } from "@/renderer/store/lan";

const store = useStore();
const busyState = useBusyState();
const settings = ref(defaultAnalysisSettings());
const engines = ref(new USIEngines());
const engineURI = ref("");
const lanStore = useLanStore();

busyState.retain();

onMounted(async () => {
  try {
    settings.value = await api.loadAnalysisSettings();
    engines.value = await api.loadUSIEngines();
    engineURI.value = settings.value.usi?.uri || "";

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
  if (!engine) {
    useErrorStore().add(t.engineNotSelected);
    return;
  }
  const newSettings = {
    ...settings.value,
    usi: engine,
  };
  const error = validateAnalysisSettings(newSettings);
  if (error) {
    useErrorStore().add(error);
    return;
  }
  store.startAnalysis(newSettings);
};

const onCancel = () => {
  store.closeModalDialog();
};

const onUpdatePlayerSettings = async (val: USIEngines) => {
  engines.value = val;
};
</script>

<style scoped>
.root {
  width: 420px;
}
input.toggle {
  height: 1em;
  width: 1em;
  margin-right: 10px;
}
input.small {
  width: 50px;
}
.selector {
  max-width: 210px;
}
</style>
