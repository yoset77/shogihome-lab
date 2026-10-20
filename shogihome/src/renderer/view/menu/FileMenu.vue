<template>
  <div>
    <dialog v-if="!isGameMenuVisible && !isSpecialMoveMenuVisible" ref="dialog" class="menu">
      <div class="group">
        <button data-hotkey="Escape" class="close" @click="onClose">
          <Icon :icon="IconType.CLOSE" />
          <div class="label">{{ t.back }}</div>
        </button>
      </div>
      <div v-if="isMobileWebApp()" class="group">
        <button @click="onFlip">
          <Icon :icon="IconType.FLIP" />
          <div class="label">{{ t.flipBoard }}</div>
        </button>
      </div>
      <div v-if="isMobileWebApp()" class="group">
        <button v-if="states.game" @click="onGame">
          <Icon :icon="IconType.GAME" />
          <div class="label">{{ t.game }}</div>
        </button>
        <button v-if="states.stopGame" class="close" @click="onStopGame">
          <Icon :icon="IconType.STOP" />
          <div class="label">{{ t.stopGame }}</div>
        </button>
        <button v-if="states.resign" class="close" @click="onResign">
          <Icon :icon="IconType.RESIGN" />
          <div class="label">{{ t.resign }}</div>
        </button>
        <button
          v-if="store.supportsTakeback"
          :disabled="!store.canTakeback"
          :aria-busy="store.isTakingBack"
          @click="onTakeback"
        >
          <Icon :icon="store.isTakingBack ? IconType.BUSY : IconType.BACK" />
          <div class="label">{{ store.isTakingBack ? t.takingBack : t.takeback }}</div>
        </button>
        <button v-if="states.puzzle" @click="onPuzzle">
          <Icon :icon="IconType.QUESTION" />
          <div class="label">{{ t.puzzles }}</div>
        </button>
        <button v-if="states.research" @click="onResearch">
          <Icon :icon="IconType.RESEARCH" />
          <div class="label">{{ t.research }}</div>
        </button>
        <button v-if="states.research" @click="onResearchSettings">
          <Icon :icon="IconType.SETTINGS" />
          <div class="label">{{ t.researchSettings }}</div>
        </button>
        <button v-if="states.stopResearch" class="close" @click="onStopResearch">
          <Icon :icon="IconType.END" />
          <div class="label">{{ t.endResearch }}</div>
        </button>
        <button v-if="states.analysis" @click="onAnalysis">
          <Icon :icon="IconType.ANALYSIS" />
          <div class="label">{{ t.recordAnalysis }}</div>
        </button>
        <button
          v-if="states.stopAnalysis"
          class="close"
          :disabled="store.isAnalysisCancelling"
          :aria-busy="store.isAnalysisCancelling"
          @click="onStopAnalysis"
        >
          <Icon :icon="IconType.STOP" />
          <div class="label">
            {{ store.isAnalysisCancelling ? t.analysisCancelling : t.stopAnalysis }}
          </div>
        </button>
        <button v-if="states.mateSearch" @click="onMateSearch">
          <Icon :icon="IconType.MATE_SEARCH" />
          <div class="label">{{ t.mateSearch }}</div>
        </button>
        <button v-if="states.stopMateSearch" class="close" @click="onStopMateSearch">
          <Icon :icon="IconType.END" />
          <div class="label">{{ t.stopMateSearch }}</div>
        </button>
        <button v-if="states.positionEditing" @click="onPositionEditing">
          <Icon :icon="IconType.EDIT" />
          <div class="label">{{ t.setupPosition }}</div>
        </button>
      </div>
      <div class="group">
        <button :disabled="!states.newFile" @click="onNewFile">
          <Icon :icon="IconType.FILE" />
          <div class="label">{{ t.clear }}</div>
        </button>
        <button :disabled="!states.open" @click="onOpen">
          <Icon :icon="IconType.OPEN" />
          <div class="label">{{ t.open }}</div>
        </button>
        <button
          v-if="!isMobileWebApp() || store.isServerSideKifuEnabled"
          :disabled="!isFileQuickActionEnabled(FileQuickAction.LOAD_FROM_SERVER, store)"
          @click="onLoadFromServer"
        >
          <Icon :icon="IconType.BATCH" />
          <div class="label">{{ t.serverKifu }}</div>
        </button>
        <button v-if="store.isServerSideKifuEnabled" :disabled="!states.open" @click="onUpload">
          <Icon :icon="IconType.BATCH" />
          <div class="label">{{ t.upload }}</div>
        </button>
        <button v-if="store.serverKifuPath" :disabled="!states.save" @click="onSave">
          <Icon :icon="IconType.SAVE" />
          <div class="label">{{ t.saveOverwrite }}</div>
        </button>
        <button
          v-if="store.isServerSideKifuEnabled"
          :disabled="!states.save"
          @click="onSaveToServer"
        >
          <Icon :icon="IconType.SAVE_AS" />
          <div class="label">{{ t.saveToServer }}</div>
        </button>

        <button v-if="!isMobileWebApp()" :disabled="!states.saveAs" @click="onSaveLocal">
          <Icon :icon="IconType.SAVE_AS" />
          <div class="label">{{ t.saveAs }}</div>
        </button>
        <button :disabled="!states.history" @click="onHistory">
          <Icon :icon="IconType.HISTORY" />
          <div class="label">{{ t.history }}</div>
        </button>
        <button v-if="!isMobileWebApp()" :disabled="!states.puzzle" @click="onPuzzle">
          <Icon :icon="IconType.QUESTION" />
          <div class="label">{{ t.puzzles }}</div>
        </button>
        <button :disabled="!states.loadRemoteFile" @click="onLoadRemoteFile">
          <Icon :icon="IconType.INTERNET" />
          <div class="label">{{ t.loadRecordFromWeb }}</div>
        </button>
        <button :disabled="!states.share" @click="onShare">
          <Icon :icon="IconType.SHARE" />
          <div class="label">{{ t.share }}</div>
        </button>
        <button :disabled="!states.searchDuplicatePositions" @click="onSearchDuplicatePositions">
          <Icon :icon="IconType.PV" />
          <div class="label">{{ t.searchDuplicatePositions }}</div>
        </button>
        <button :disabled="!states.elapsedTimeChart" @click="onElapsedTimeChart">
          <Icon :icon="IconType.HISTORY" />
          <div class="label">{{ t.elapsedTimeChart }}</div>
        </button>
        <button v-if="!isMobileWebApp()" :disabled="!states.exportImage" @click="onExportImage">
          <Icon :icon="IconType.GRID" />
          <div class="label">{{ t.positionImage }}</div>
        </button>
        <button :disabled="!states.visionScan" @click="onVisionScan">
          <Icon :icon="IconType.GRID" />
          <div class="label">{{ t.importBoardImage }}</div>
        </button>
        <button :disabled="!states.analysisDBManager" @click="onAnalysisDBManager">
          <Icon :icon="IconType.BATCH" />
          <div class="label">{{ t.analysisDBManager }}</div>
        </button>
        <button @click="onJobs">
          <Icon :icon="IconType.MONITOR" />
          <div class="label">{{ t.jobsTitle }}</div>
        </button>
        <button v-if="store.canDetachJob" @click="onDetach">
          <Icon :icon="IconType.END" />
          <div class="label">{{ t.jobsDetach }}</div>
        </button>
      </div>
      <div class="group">
        <button @click="onCopyKIF">
          <Icon :icon="IconType.COPY" />
          <div class="label">{{ t.copyAsKIF }}</div>
        </button>
        <button @click="onCopyKI2">
          <Icon :icon="IconType.COPY" />
          <div class="label">{{ t.copyAsKI2 }}</div>
        </button>
        <button @click="onCopyCSA">
          <Icon :icon="IconType.COPY" />
          <div class="label">{{ t.copyAsCSA }}</div>
        </button>
        <button @click="onCopyJKF">
          <Icon :icon="IconType.COPY" />
          <div class="label">{{ t.copyAsJKF }}</div>
        </button>
        <button @click="onCopyUSI">
          <Icon :icon="IconType.COPY" />
          <div class="label">{{ t.copyAsUSI }}</div>
        </button>
        <button @click="onCopyUSEN">
          <Icon :icon="IconType.COPY" />
          <div class="label">{{ t.copyAsUSEN }}</div>
        </button>
        <button @click="onCopySFEN">
          <Icon :icon="IconType.COPY" />
          <div class="label">{{ t.copyAsSFEN }}</div>
        </button>
        <button @click="onCopyBOD">
          <Icon :icon="IconType.COPY" />
          <div class="label">{{ t.copyAsBOD }}</div>
        </button>
        <button :disabled="!states.paste" @click="onPaste">
          <Icon :icon="IconType.PASTE" />
          <div class="label">{{ t.paste }}</div>
        </button>
        <button :disabled="!states.paste" @click="onPasteMergeToRoot">
          <Icon :icon="IconType.PASTE" />
          <div class="label">{{ t.mergeToRootPosition }}</div>
        </button>
        <button :disabled="!states.paste" @click="onPasteMergeToCurrent">
          <Icon :icon="IconType.PASTE" />
          <div class="label">{{ t.mergeToCurrentPosition }}</div>
        </button>
        <button @click="onAddSpecialMove">
          <Icon :icon="IconType.NOTE" />
          <div class="label">{{ t.addSpecialMove }}</div>
        </button>
      </div>
      <div v-if="isMobileWebApp()" class="group">
        <button @click="onAppSettings">
          <Icon :icon="IconType.SETTINGS" />
          <div class="label">{{ t.appSettings }}</div>
        </button>
      </div>
      <div v-if="isMobileWebApp()" class="group">
        <button @click="openCopyright">
          <Icon :icon="IconType.LICENSE" />
          <div class="label">{{ t.license }}</div>
        </button>
      </div>
    </dialog>
    <MobileGameMenu v-if="isGameMenuVisible" @close="emit('close')" />
    <SpecialMoveMenu v-if="isSpecialMoveMenuVisible" @close="emit('close')" />
  </div>
</template>

<script setup lang="ts">
import { t } from "@/common/i18n";
import { showModalDialog } from "@/renderer/helpers/dialog.js";
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import Icon from "@/renderer/view/primitive/Icon.vue";
import { IconType } from "@/renderer/assets/icons";
import { useStore } from "@/renderer/store";
import { AppState, ResearchState } from "@/common/control/state.js";
import { isMobileWebApp } from "@/renderer/ipc/api";
import { useAppSettings } from "@/renderer/store/settings";
import { installHotKeyForDialog, uninstallHotKeyForDialog } from "@/renderer/devices/hotkey";
import { openCopyright } from "@/renderer/helpers/copyright";
import MobileGameMenu from "@/renderer/view/menu/MobileGameMenu.vue";
import SpecialMoveMenu from "@/renderer/view/menu/SpecialMoveMenu.vue";
import { defaultResearchSettings } from "@/common/settings/research";
import { resolveLanEngine } from "@/renderer/helpers/engine";
import { useLanStore } from "@/renderer/store/lan";
import { generateRecordFileName } from "@/renderer/helpers/path";
import { FileQuickAction } from "@/common/settings/app";
import { isFileQuickActionEnabled, runFileQuickAction } from "@/renderer/helpers/fileQuickAction";

const emit = defineEmits<{
  close: [];
}>();

const store = useStore();
const appSettings = useAppSettings();
const lanStore = useLanStore();
const dialog = ref();
const isGameMenuVisible = ref(false);
const isSpecialMoveMenuVisible = ref(false);
const onClose = () => {
  emit("close");
};
onMounted(() => {
  showModalDialog(dialog.value, onClose);
  installHotKeyForDialog(dialog.value);
});
onBeforeUnmount(() => {
  uninstallHotKeyForDialog(dialog.value);
});
const onFlip = () => {
  useAppSettings().flipBoard();
  emit("close");
};
const onGame = () => {
  if (store.hasRetainedGame) {
    store.showGameDialog();
    emit("close");
    return;
  }
  isGameMenuVisible.value = true;
};
const onStopGame = () => {
  store.stopGame();
  emit("close");
};
const onResign = () => {
  store.resign();
  emit("close");
};
const onTakeback = () => {
  void store.takeback();
  emit("close");
};
const onPuzzle = () => {
  runFileQuickAction(FileQuickAction.PUZZLE, store);
  emit("close");
};
const onMateSearch = () => {
  store.showMateSearchDialog();
  emit("close");
};
const onStopMateSearch = () => {
  store.stopMateSearch();
  emit("close");
};
const onResearch = async () => {
  const uri = appSettings.defaultResearchEngineURI;
  if (isMobileWebApp() && uri) {
    await lanStore.fetchEngineList();
    const engine = resolveLanEngine(uri, lanStore.engineList.value);

    if (engine) {
      store.startResearch({
        ...defaultResearchSettings(),
        usi: engine,
        overrideMultiPV: true,
        multiPV: appSettings.researchMultiPV,
      });
      emit("close");
      return;
    }
  }
  store.showResearchDialog();
  emit("close");
};
const onResearchSettings = () => {
  store.showResearchDialog();
  emit("close");
};
const onStopResearch = () => {
  store.stopResearch();
  emit("close");
};
const onAnalysis = () => {
  store.showAnalysisDialog();
  emit("close");
};
const onStopAnalysis = () => {
  store.stopAnalysis();
  emit("close");
};
const onJobs = () => {
  store.showJobsDialog();
  emit("close");
};
const onDetach = () => {
  store.detachJob();
  emit("close");
};
const onPositionEditing = () => {
  store.startPositionEditing();
  emit("close");
};
const onNewFile = () => {
  store.resetRecord();
  emit("close");
};
const onOpen = () => {
  runFileQuickAction(FileQuickAction.OPEN, store);
  emit("close");
};
const onLoadFromServer = () => {
  runFileQuickAction(FileQuickAction.LOAD_FROM_SERVER, store);
  emit("close");
};
const onUpload = () => {
  store.showServerFileUploadDialog();
  emit("close");
};
const onSave = () => {
  store.saveRecord({ overwrite: true });
  emit("close");
};
const onSaveToServer = () => {
  const defaultName =
    store.serverKifuPath ||
    (store.recordFilePath ? store.recordFilePath.split(/[\\/]/).pop() : undefined) ||
    generateRecordFileName(store.record, {
      template: appSettings.recordFileNameTemplate,
      extension: appSettings.defaultRecordFileFormat,
    });
  const name = window.prompt(t.enterFileName, defaultName);
  if (name) {
    store.saveRecord({ path: "server://" + name });
  }
  emit("close");
};
const onSaveLocal = () => {
  const defaultName = generateRecordFileName(store.record, {
    template: appSettings.recordFileNameTemplate,
    extension: appSettings.defaultRecordFileFormat,
  });
  const name = window.prompt(t.enterFileName, defaultName);
  if (name) {
    store.saveRecord({ path: name });
  }
  emit("close");
};
const onHistory = () => {
  runFileQuickAction(FileQuickAction.HISTORY, store);
  emit("close");
};
const onLoadRemoteFile = () => {
  store.showLoadRemoteFileDialog();
  emit("close");
};
const onShare = () => {
  store.showShareDialog();
  emit("close");
};
const onSearchDuplicatePositions = () => {
  store.showSearchDuplicatePositionsDialog();
  emit("close");
};
const onElapsedTimeChart = () => {
  runFileQuickAction(FileQuickAction.ELAPSED_TIME_CHART, store);
  emit("close");
};
const onAnalysisDBManager = () => {
  store.showAnalysisDBManagerDialog();
  emit("close");
};
const onExportImage = () => {
  store.showExportBoardImageDialog();
  emit("close");
};
const onVisionScan = () => {
  store.showVisionScanDialog();
  emit("close");
};
const onCopyKIF = () => {
  store.copyRecordKIF();
  emit("close");
};
const onCopyKI2 = () => {
  store.copyRecordKI2();
  emit("close");
};
const onCopyCSA = () => {
  store.copyRecordCSA();
  emit("close");
};
const onCopyJKF = () => {
  store.copyRecordJKF();
  emit("close");
};
const onCopyUSI = () => {
  store.copyRecordUSIAll();
  emit("close");
};
const onCopyUSEN = () => {
  store.copyRecordUSEN();
  emit("close");
};
const onCopySFEN = () => {
  store.copyBoardSFEN();
  emit("close");
};
const onCopyBOD = () => {
  store.copyBoardBOD();
  emit("close");
};
const onPaste = () => {
  store.showPasteDialog();
  emit("close");
};
const onPasteMergeToRoot = () => {
  store.showPasteDialog("mergeIntoRoot");
  emit("close");
};
const onPasteMergeToCurrent = () => {
  store.showPasteDialog("mergeIntoCurrent");
  emit("close");
};
const onAddSpecialMove = () => {
  isSpecialMoveMenuVisible.value = true;
};
const onAppSettings = () => {
  store.showAppSettingsDialog();
  emit("close");
};
const states = computed(() => {
  return {
    game: store.appState === AppState.NORMAL,
    stopGame: store.appState === AppState.GAME,
    analysis: store.appState === AppState.NORMAL,
    stopAnalysis: store.appState === AppState.ANALYSIS,
    resign: store.appState === AppState.GAME && store.isMovableByUser,
    puzzle: isFileQuickActionEnabled(FileQuickAction.PUZZLE, store),
    research: store.appState === AppState.NORMAL && store.researchState === ResearchState.IDLE,
    mateSearch: store.appState === AppState.NORMAL && store.researchState === ResearchState.IDLE,
    stopMateSearch: store.appState === AppState.MATE_SEARCH,
    stopResearch:
      store.researchState === ResearchState.RUNNING ||
      store.researchState === ResearchState.PAUSED ||
      store.researchState === ResearchState.STOPPING,
    positionEditing: store.appState === AppState.NORMAL,
    newFile: store.appState === AppState.NORMAL,
    open: isFileQuickActionEnabled(FileQuickAction.OPEN, store),
    save: store.appState === AppState.NORMAL,
    saveAs: store.appState === AppState.NORMAL,
    history: isFileQuickActionEnabled(FileQuickAction.HISTORY, store),
    loadRemoteFile: store.appState === AppState.NORMAL,
    share: store.appState === AppState.NORMAL,
    searchDuplicatePositions: store.appState === AppState.NORMAL,
    elapsedTimeChart: isFileQuickActionEnabled(FileQuickAction.ELAPSED_TIME_CHART, store),
    analysisDBManager: store.appState === AppState.NORMAL,
    exportImage: store.appState === AppState.NORMAL,
    visionScan: store.appState === AppState.NORMAL,
    paste: store.appState === AppState.NORMAL,
  };
});
</script>
