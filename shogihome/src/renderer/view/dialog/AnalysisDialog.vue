<template>
  <DialogFrame limited @cancel="onCancel">
    <div class="root">
      <div class="title">{{ t.recordAnalysis }}</div>
      <div v-if="!isNative()" class="form-group">
        <HorizontalSelector
          v-model:value="target"
          :items="[
            { value: 'record', label: t.batchAnalysisCurrent },
            { value: 'folder', label: t.batchAnalysisFolder },
            ...(searchSource ? [{ value: 'search', label: t.batchAnalysisSearch }] : []),
          ]"
        />
      </div>
      <div v-if="target !== 'record'" class="form-group">
        <template v-if="target === 'folder'">
          <label for="batch-directory">{{ t.batchAnalysisFolder }}</label>
          <div class="form-item row">
            <span>server://</span>
            <input id="batch-directory" v-model="batchSettings.directory" type="text" />
            <button @click="openDirectory(batchSettings.directory)">{{ t.select }}</button>
          </div>
          <div v-if="directories" class="directory-list">
            <button @click="openDirectory('')">{{ t.rootDirectory }}</button>
            <button
              v-if="batchSettings.directory"
              @click="openDirectory(batchSettings.directory.split('/').slice(0, -1).join('/'))"
            >
              ..
            </button>
            <button
              v-for="directory in directories"
              :key="directory.path"
              @click="openDirectory(directory.path)"
            >
              {{ directory.name }}
            </button>
          </div>
          <div class="form-item">
            <span>{{ t.subdirectories }}</span
            ><ToggleButton v-model:value="batchSettings.subdirectories" />
          </div>
        </template>
        <div v-else class="note">{{ t.batchAnalysisSearch }}</div>
        <div class="form-item">
          <ToggleButton v-model:value="batchSettings.skipAnalyzed" :label="t.batchAnalysisSkip" />
        </div>
        <p class="note">{{ t.batchAnalysisSkipNote }}</p>
        <template v-if="plan">
          <p class="note">{{ t.batchAnalysisConfirm(plan.files.length) }}</p>
          <details>
            <summary>{{ t.batchAnalysisDetails }} ({{ plan.files.length }})</summary>
            <ol class="target-files">
              <li v-for="file in plan.files" :key="file">{{ file }}</li>
            </ol>
          </details>
        </template>
      </div>
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
        <div class="form-item">
          <label class="form-item-label-wide" for="analysis-multi-pv">{{
            t.suggestionsCount
          }}</label>
          <ToggleButton v-model:value="settings.overrideMultiPV" />
          <input
            id="analysis-multi-pv"
            v-model.number="settings.multiPV"
            class="small"
            type="number"
            :min="MIN_MULTIPV"
            :max="MAX_MULTIPV"
            step="1"
            :disabled="!settings.overrideMultiPV"
          />
        </div>
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
      <div v-if="!isNative()" class="form-group">
        <div class="form-item">
          <ToggleButton v-model:value="background" :label="t.jobsBackground" />
        </div>
      </div>
      <div class="main-buttons">
        <button data-hotkey="Enter" autofocus @click="onStart()">
          {{ target !== "record" && !plan ? t.batchAnalysisCheck : t.analyze }}
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
import api, { isNative } from "@/renderer/ipc/api";
import { defaultAnalysisSettings, validateAnalysisSettings } from "@/common/settings/analysis";
import { MIN_MULTIPV, MAX_MULTIPV } from "@/common/engine/relay_protocol";
import { CommentBehavior } from "@/common/settings/comment";
import { getPredefinedUSIEngineTag, USIEngines, USIEngine } from "@/common/settings/usi";
import { useStore } from "@/renderer/store";
import { onMounted, ref, watch } from "vue";
import PlayerSelector from "@/renderer/view/dialog/PlayerSelector.vue";
import ToggleButton from "@/renderer/view/primitive/ToggleButton.vue";
import HorizontalSelector from "@/renderer/view/primitive/HorizontalSelector.vue";
import { useErrorStore } from "@/renderer/store/error";
import { useBusyState } from "@/renderer/store/busy";
import DialogFrame from "./DialogFrame.vue";
import { useLanStore } from "@/renderer/store/lan";
import { loadBatchAnalysisSettings, prepareBatchAnalysis } from "@/renderer/store/batch_analysis";
import type { BatchAnalysisPlan } from "@/common/analysis/batch";
import type { ServerDirectoryEntry } from "@/common/file/upload";
import { useConfirmationStore } from "@/renderer/store/confirm";

const store = useStore();
const background = ref(false);
const busyState = useBusyState();
const settings = ref(defaultAnalysisSettings());
const engines = ref(new USIEngines());
const engineURI = ref("");
const lanStore = useLanStore();
const batchSettings = ref(loadBatchAnalysisSettings());
const target = ref(store.analysisSource?.kind ?? "record");
const searchSource = store.analysisSource?.kind === "search" ? store.analysisSource : undefined;
if (store.analysisSource?.kind === "folder")
  batchSettings.value.directory = store.analysisSource.directory;
const directories = ref<ServerDirectoryEntry[]>();
const plan = ref<BatchAnalysisPlan>();
let sourceGeneration = 0;
watch(
  [target, () => batchSettings.value.directory, () => batchSettings.value.subdirectories],
  () => {
    sourceGeneration++;
    plan.value = undefined;
  },
);
const openDirectory = async (directory: string) => {
  busyState.retain();
  try {
    const result = await api.listServerDirectories(directory);
    batchSettings.value.directory = result.path;
    directories.value = result.directories;
  } catch (error) {
    useErrorStore().add(error);
  } finally {
    busyState.release();
  }
};

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

const onStart = async () => {
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
  if (target.value === "record") {
    store.startAnalysis(newSettings, background.value);
    return;
  }
  if (!plan.value) {
    busyState.retain();
    const generation = sourceGeneration;
    try {
      const prepared = await prepareBatchAnalysis(
        target.value === "search" && searchSource
          ? searchSource
          : {
              kind: "folder",
              directory: batchSettings.value.directory,
              subdirectories: batchSettings.value.subdirectories,
            },
      );
      if (generation === sourceGeneration) plan.value = prepared;
    } catch (error) {
      useErrorStore().add(error);
    } finally {
      busyState.release();
    }
    return;
  }
  const confirmedPlan = plan.value;
  if (confirmedPlan.expiresAt <= Date.now()) {
    plan.value = undefined;
    useErrorStore().add(t.batchAnalysisPlanExpired);
    return;
  }
  const savedSettings = { ...batchSettings.value };
  const runInBackground = background.value;
  useConfirmationStore().show({
    message: t.batchAnalysisConfirm(confirmedPlan.files.length),
    onOk: () => {
      void store.startBatchAnalysis(savedSettings, newSettings, confirmedPlan, runInBackground);
    },
  });
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
  width: min(420px, calc(95vw - 32px));
  max-width: 100%;
  min-height: 0;
  overflow-y: auto;
  overflow-wrap: anywhere;
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
.directory-list,
.target-files {
  max-height: 160px;
  overflow-y: auto;
  overflow-wrap: anywhere;
}
#batch-directory {
  min-width: 0;
  width: 100%;
}
@media (max-width: 480px) {
  .form-item-label-wide {
    display: block;
    width: auto;
    margin-bottom: 5px;
  }
}
</style>
