<template>
  <DialogFrame limited @cancel="onCancel">
    <div class="title">{{ t.recordAnalysis }}</div>
    <div class="form-item center selector-item">
      <HorizontalSelector
        v-model:value="target"
        :items="[
          { label: t.currentRecord, value: 'record' },
          { label: t.serverFolder, value: 'folder' },
          ...(searchSource ? [{ label: t.batchAnalysisSearch, value: 'search' }] : []),
        ]"
      />
    </div>
    <div ref="scrollContainer" class="form-group scroll">
      <div v-show="target !== 'record'" class="form-group warning">
        <div class="note">{{ t.analyzedRecordFilesWillBeOverwritten }}</div>
      </div>
      <div v-show="target !== 'record'" class="form-group">
        <div class="form-item">
          <label class="form-item-label-wide" for="batch-analysis-parallelism">{{
            t.parallelism
          }}</label>
          <input
            id="batch-analysis-parallelism"
            v-model.number="batchSettings.parallelism"
            class="small"
            type="number"
            min="1"
            :max="MAX_BATCH_PARALLELISM"
            step="1"
          />
        </div>
        <div v-show="target === 'folder'">
          <ServerDirectoryBrowser
            :selected-path="selectedDirectory"
            :path="browseDirectory"
            :entries="directoryEntries"
            :open="browserOpen"
            @open="onOpenDirectoryPicker"
            @update:path="onNavigateDirectory"
            @select="onSelectDirectory"
          >
            <template #entry-actions="{ entry }">
              <button v-if="entry.isDirectory" class="thin" @click="onConfirmDirectory(entry.path)">
                {{ t.select }}
              </button>
            </template>
          </ServerDirectoryBrowser>
          <div class="form-item row">
            <div class="form-item-label-wide">{{ t.subdirectories }}</div>
            <ToggleButton v-model:value="batchSettings.subdirectories" class="toggle" />
          </div>
        </div>
        <div class="form-item row">
          <div class="form-item-label-wide">{{ t.skipAnalyzed }}</div>
          <ToggleButton v-model:value="batchSettings.skipAnalyzed" class="toggle" />
        </div>
        <div class="form-item">
          <button
            class="thin"
            data-test="check-targets"
            :disabled="!canCheckTargets"
            @click="onCheckTargets"
          >
            {{ t.checkBatchTargets }}
          </button>
        </div>
        <div v-if="batchSettings.skipAnalyzed" class="note">{{ t.batchAnalysisSkipNote }}</div>
        <template v-if="plan">
          <div class="note">{{ t.nKifuFound(plan.files.length) }}</div>
          <details>
            <summary>{{ t.batchAnalysisTargetFiles }} ({{ plan.files.length }})</summary>
            <ol class="target-files">
              <li v-for="file in plan.files" :key="file">{{ file }}</li>
            </ol>
          </details>
        </template>
      </div>
      <div class="form-group">
        <div>{{ t.searchEngine }}</div>
        <PlayerSelector v-model:player-uri="engineURI" engine-type="research" />
        <div class="form-item">
          <label class="form-item-label-wide" for="analysis-multi-pv">{{
            t.suggestionsCount
          }}</label>
          <ToggleButton v-model:value="settings.overrideMultiPV" data-test="override-multi-pv" />
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
          <div v-show="target === 'record'" class="form-item-small-label">
            ({{ t.totalMoves }}: {{ totalMoves }})
          </div>
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
      <div class="form-group">
        <div class="form-item">
          <ToggleButton
            v-model:value="background"
            data-test="background"
            :label="t.jobsBackground"
            :disabled="parallelBatch"
          />
        </div>
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
  </DialogFrame>
</template>

<script setup lang="ts">
import { t } from "@/common/i18n";
import api from "@/renderer/ipc/api";
import { defaultAnalysisSettings, validateAnalysisSettings } from "@/common/settings/analysis";
import { MIN_MULTIPV, MAX_MULTIPV } from "@/common/engine/relay_protocol";
import { CommentBehavior } from "@/common/settings/comment";
import { useStore } from "@/renderer/store";
import { computed, onMounted, ref, watch } from "vue";
import PlayerSelector from "@/renderer/view/dialog/PlayerSelector.vue";
import ToggleButton from "@/renderer/view/primitive/ToggleButton.vue";
import HorizontalSelector from "@/renderer/view/primitive/HorizontalSelector.vue";
import ServerDirectoryBrowser, {
  ServerDirectoryEntryUI,
} from "@/renderer/view/dialog/ServerDirectoryBrowser.vue";
import { useErrorStore } from "@/renderer/store/error";
import { useBusyState } from "@/renderer/store/busy";
import DialogFrame from "./DialogFrame.vue";
import { useLanStore } from "@/renderer/store/lan";
import { loadBatchAnalysisSettings, prepareBatchAnalysis } from "@/renderer/store/batch_analysis";
import {
  MAX_BATCH_PARALLELISM,
  readBatchParallelism,
  type BatchAnalysisPlan,
} from "@/common/analysis/batch";
import type { ServerDirectoryEntry } from "@/common/file/upload";
import { useConfirmationStore } from "@/renderer/store/confirm";
import { Move } from "tsshogi";
import { resolveLanEngine } from "@/renderer/helpers/engine";

const store = useStore();
const background = ref(false);
const busyState = useBusyState();
const settings = ref(defaultAnalysisSettings());
const engineURI = ref("");
const lanStore = useLanStore();
const batchSettings = ref(loadBatchAnalysisSettings());
const selectedDirectory = ref<string | undefined>(batchSettings.value.directory || undefined);
const searchSource = store.analysisSource?.kind === "search" ? store.analysisSource : undefined;
const target = ref(searchSource ? "search" : "record");
const parallelBatch = computed(
  () => target.value !== "record" && batchSettings.value.parallelism > 1,
);
// Parallel batch analysis runs only in the background; restore the user's choice otherwise.
let userBackground = background.value;
watch(
  parallelBatch,
  (value) => {
    if (value) {
      userBackground = background.value;
      background.value = true;
    } else {
      background.value = userBackground;
    }
  },
  { immediate: true },
);
const directories = ref<ServerDirectoryEntry[]>([]);
const browseDirectory = ref("");
const browserOpen = ref(false);
const plan = ref<BatchAnalysisPlan>();
let sourceGeneration = 0;

const directoryEntries = computed(() =>
  directories.value.map((entry) => ({ ...entry, isDirectory: true })),
);

const canCheckTargets = computed(() =>
  target.value === "folder" ? selectedDirectory.value !== undefined : true,
);

const totalMoves = computed(() => {
  const moves = store.record?.moves;
  const lastMove = moves?.[moves.length - 1];
  if (!lastMove) {
    return 0;
  }
  return lastMove.ply === 0 ? 0 : lastMove.move instanceof Move ? lastMove.ply : lastMove.ply - 1;
});

const scrollContainer = ref<HTMLElement>();

watch([target, selectedDirectory, () => batchSettings.value.subdirectories], () => {
  sourceGeneration++;
  plan.value = undefined;
});

watch(target, () => {
  if (scrollContainer.value) {
    scrollContainer.value.scrollTop = 0;
  }
});

const loadDirectory = async (directory: string) => {
  busyState.retain();
  try {
    const result = await api.listServerDirectories(directory);
    browseDirectory.value = result.path;
    directories.value = result.directories;
    browserOpen.value = true;
  } catch (error) {
    useErrorStore().add(error);
  } finally {
    busyState.release();
  }
};

const onOpenDirectoryPicker = () => {
  void loadDirectory(selectedDirectory.value ?? "");
};

const onNavigateDirectory = (path: string) => {
  void loadDirectory(path);
};

const onSelectDirectory = (entry: ServerDirectoryEntryUI) => {
  void loadDirectory(entry.path);
};

const onConfirmDirectory = (path: string) => {
  selectedDirectory.value = path;
  browserOpen.value = false;
};

busyState.retain();

onMounted(async () => {
  try {
    settings.value = await api.loadAnalysisSettings();
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

const onStart = async () => {
  const engine = resolveLanEngine(engineURI.value, lanStore.engineList.value, "research");
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
  try {
    readBatchParallelism(batchSettings.value.parallelism);
  } catch {
    useErrorStore().add(t.batchAnalysisInvalid);
    return;
  }
  if (target.value === "folder" && selectedDirectory.value === undefined) {
    useErrorStore().add(t.batchAnalysisInvalid);
    return;
  }
  let confirmedPlan = plan.value;
  if (!confirmedPlan || confirmedPlan.expiresAt <= Date.now()) {
    confirmedPlan = await preparePlan();
    if (!confirmedPlan) {
      return;
    }
  }
  const savedSettings = {
    ...batchSettings.value,
    directory: selectedDirectory.value ?? batchSettings.value.directory,
  };
  const runInBackground = background.value || parallelBatch.value;
  useConfirmationStore().show({
    message: t.batchAnalysisConfirm(confirmedPlan.files.length),
    onOk: () => {
      void store.startBatchAnalysis(savedSettings, newSettings, confirmedPlan!, runInBackground);
    },
  });
};

const onCheckTargets = () => {
  void preparePlan();
};

const preparePlan = async (): Promise<BatchAnalysisPlan | undefined> => {
  busyState.retain();
  const generation = sourceGeneration;
  try {
    const prepared = await prepareBatchAnalysis(
      target.value === "search" && searchSource
        ? searchSource
        : {
            kind: "folder",
            directory: selectedDirectory.value ?? "",
            subdirectories: batchSettings.value.subdirectories,
          },
    );
    if (generation !== sourceGeneration) {
      return undefined;
    }
    plan.value = prepared;
    return prepared;
  } catch (error) {
    useErrorStore().add(error);
    return undefined;
  } finally {
    busyState.release();
  }
};

const onCancel = () => {
  store.closeModalDialog();
};
</script>

<style scoped>
/* Include borders and padding so groups fit inside the scroll container on narrow screens. */
.form-group:not(.scroll) {
  box-sizing: border-box;
  min-width: min(502px, calc(95vw - 54px));
}
/* Keep toggle columns aligned even when a label is long. */
.form-item.row > .form-item-label-wide {
  flex: 0 0 160px;
  min-width: 0;
  overflow-wrap: anywhere;
}
.selector-item {
  margin: 0 !important;
}
input.small {
  width: 50px;
}
.selector {
  max-width: 210px;
}
.target-files {
  max-height: 160px;
  overflow-y: auto;
  overflow-wrap: anywhere;
}
@media (max-width: 480px) {
  /* Keep labels inline so toggle rows stay on a single line, as in ResearchDialog. */
  .form-item-label-wide {
    width: 120px;
  }
}
</style>
