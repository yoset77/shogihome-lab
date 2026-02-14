<template>
  <div>
    <dialog v-if="!isGameMenuVisible" ref="dialog" class="menu">
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
        <button v-if="states.stopGame" @click="onStopGame">
          <Icon :icon="IconType.STOP" />
          <div class="label">{{ t.stopGame }}</div>
        </button>
        <button v-if="states.resign" @click="onResign">
          <Icon :icon="IconType.RESIGN" />
          <div class="label">{{ t.resign }}</div>
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
        <button v-if="states.stopResearch" @click="onStopResearch">
          <Icon :icon="IconType.END" />
          <div class="label">{{ t.endResearch }}</div>
        </button>
        <button v-if="states.pauseResearch" @click="onPauseResearch">
          <Icon :icon="IconType.PAUSE" />
          <div class="label">{{ t.stop }}</div>
        </button>
        <button v-if="states.resumeResearch" @click="onResumeResearch">
          <Icon :icon="IconType.RESUME" />
          <div class="label">{{ t.resume }}</div>
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
          v-if="!isNative() && store.isServerSideKifuEnabled"
          :disabled="!states.open"
          @click="onLoadFromServer"
        >
          <Icon :icon="IconType.BATCH" />
          <div class="label">{{ t.loadFromServer }}</div>
        </button>
        <button v-if="isNative() || store.serverKifuPath" :disabled="!states.save" @click="onSave">
          <Icon :icon="IconType.SAVE" />
          <div class="label">{{ t.saveOverwrite }}</div>
        </button>
        <button
          v-if="!isNative() && store.isServerSideKifuEnabled"
          :disabled="!states.save"
          @click="onSaveToServer"
        >
          <Icon :icon="IconType.SAVE_AS" />
          <div class="label">{{ t.saveToServer }}</div>
        </button>

        <button v-if="isNative()" :disabled="!states.saveAs" @click="onSaveAs">
          <Icon :icon="IconType.SAVE_AS" />
          <div class="label">{{ t.saveAs }}</div>
        </button>
        <template
          v-for="format of [
            RecordFileFormat.KIF,
            RecordFileFormat.KIFU,
            RecordFileFormat.KI2,
            RecordFileFormat.KI2U,
            RecordFileFormat.CSA,
            RecordFileFormat.JKF,
          ]"
          :key="format"
        >
          <button
            v-if="!isNative() && !isMobileWebApp()"
            :disabled="!states.saveAs"
            @click="onSaveForWeb(format)"
          >
            <Icon :icon="IconType.SAVE" />
            <div class="label">{{ format }}</div>
          </button>
        </template>
        <button v-if="isNative()" :disabled="!states.history" @click="onHistory">
          <Icon :icon="IconType.HISTORY" />
          <div class="label">{{ t.history }}</div>
        </button>
        <button v-if="isNative()" :disabled="!states.loadRemoteFile" @click="onLoadRemoteFile">
          <Icon :icon="IconType.INTERNET" />
          <div class="label">{{ t.loadRecordFromWeb }}</div>
        </button>
        <button :disabled="!states.share" @click="onShare">
          <Icon :icon="IconType.SHARE" />
          <div class="label">{{ t.share }}</div>
        </button>
        <button v-if="!isMobileWebApp()" :disabled="!states.exportImage" @click="onExportImage">
          <Icon :icon="IconType.GRID" />
          <div class="label">{{ t.positionImage }}</div>
        </button>
        <button v-if="isNative()" :disabled="!states.batchConversion" @click="onBatchConversion">
          <Icon :icon="IconType.BATCH" />
          <div class="label">{{ t.batchConversion }}</div>
        </button>
        <button v-if="isNative()" @click="onOpenAutoSaveDirectory">
          <Icon :icon="IconType.OPEN_FOLDER" />
          <div class="label">{{ t.openAutoSaveDirectory }}</div>
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
import api, { isMobileWebApp, isNative } from "@/renderer/ipc/api";
import { useAppSettings } from "@/renderer/store/settings";
import { installHotKeyForDialog, uninstallHotKeyForDialog } from "@/renderer/devices/hotkey";
import { openCopyright } from "@/renderer/helpers/copyright";
import { RecordFileFormat } from "@/common/file/record";
import MobileGameMenu from "@/renderer/view/menu/MobileGameMenu.vue";
import { defaultResearchSettings } from "@/common/settings/research";
import { USIEngine } from "@/common/settings/usi";
import { useLanStore } from "@/renderer/store/lan";

const emit = defineEmits<{
  close: [];
}>();

const store = useStore();
const appSettings = useAppSettings();
const lanStore = useLanStore();
const dialog = ref();
const isGameMenuVisible = ref(false);
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
const onPuzzle = () => {
  store.startPuzzle();
  emit("close");
};
const onResearch = async () => {
  const uri = appSettings.defaultResearchEngineURI;
  if (isMobileWebApp() && uri) {
    let engine: USIEngine | undefined;
    if (uri.startsWith("lan-engine")) {
      let name = "LAN Engine";
      if (uri.startsWith("lan-engine:")) {
        const id = uri.split(":")[1];
        try {
          await lanStore.fetchEngineList();
          const list = lanStore.engineList.value;
          const info = list.find((e) => e.id === id);
          if (info) name = info.name;
          else name = `LAN Engine (${id})`;
        } catch {
          name = `LAN Engine (${id})`;
        }
      }
      engine = {
        uri,
        name,
        defaultName: "LAN Engine",
        author: "",
        path: "",
        options: {},
        labels: {},
        enableEarlyPonder: false,
      };
    } else {
      try {
        const engines = await api.loadUSIEngines();
        engine = engines.getEngine(uri);
      } catch (e) {
        console.warn(e);
      }
    }

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
const onPauseResearch = () => {
  store.pauseResearch();
  emit("close");
};
const onResumeResearch = () => {
  store.resumeResearch();
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
  store.openRecord();
  emit("close");
};
const onLoadFromServer = () => {
  store.showServerKifuDialog();
  emit("close");
};
const onSave = () => {
  store.saveRecord({ overwrite: true });
  emit("close");
};
const onSaveToServer = () => {
  const name = window.prompt(t.enterFileName, "record.kif");
  if (name) {
    store.saveRecord({ path: "server://" + name });
  }
  emit("close");
};
const onSaveAs = () => {
  store.saveRecord();
  emit("close");
};
const onSaveForWeb = (format: RecordFileFormat) => {
  store.saveRecord({ format });
  emit("close");
};
const onHistory = () => {
  store.showRecordFileHistoryDialog();
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
const onBatchConversion = () => {
  store.showBatchConversionDialog();
  emit("close");
};
const onExportImage = () => {
  store.showExportBoardImageDialog();
  emit("close");
};
const onOpenAutoSaveDirectory = () => {
  api.openExplorer(appSettings.autoSaveDirectory);
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
const onAppSettings = () => {
  store.showAppSettingsDialog();
  emit("close");
};
const states = computed(() => {
  return {
    game: store.appState === AppState.NORMAL,
    stopGame: store.appState === AppState.GAME,
    resign: store.appState === AppState.GAME && store.isMovableByUser,
    puzzle: store.appState === AppState.NORMAL,
    research: store.appState === AppState.NORMAL && store.researchState === ResearchState.IDLE,
    stopResearch:
      store.researchState === ResearchState.RUNNING || store.researchState === ResearchState.PAUSED,
    pauseResearch: store.researchState === ResearchState.RUNNING,
    resumeResearch: store.researchState === ResearchState.PAUSED,
    positionEditing: store.appState === AppState.NORMAL,
    newFile: store.appState === AppState.NORMAL,
    open: store.appState === AppState.NORMAL,
    save: store.appState === AppState.NORMAL,
    saveAs: store.appState === AppState.NORMAL,
    history: store.appState === AppState.NORMAL,
    loadRemoteFile: store.appState === AppState.NORMAL,
    share: store.appState === AppState.NORMAL,
    batchConversion: store.appState === AppState.NORMAL,
    exportImage: store.appState === AppState.NORMAL,
    paste: store.appState === AppState.NORMAL,
  };
});
</script>
