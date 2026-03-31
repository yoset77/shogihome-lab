<template>
  <div class="dialog-mask" @click.self="onClose">
    <dialog ref="dialog" class="mobile-dialog">
      <div class="title">{{ t.game }}</div>

      <div v-if="initialized" class="content">
        <!-- Section: Start Position -->
        <div class="section">
          <div class="section-header">{{ t.startPosition }}</div>
          <div class="section-body selector-container">
            <HorizontalSelector
              :value="settings.startPosition"
              :items="[
                { value: InitialPositionType.STANDARD, label: t.noHandicap },
                { value: 'current', label: t.currentPosition },
                { value: 'list', label: t.positionList },
              ]"
              :height="36"
              @update:value="
                settings.startPosition = $event as InitialPositionType | 'current' | 'list'
              "
            />
          </div>
          <!-- SFEN File Selection -->
          <div v-show="settings.startPosition === 'list'" class="form-item">
            <div class="form-item-value full-width" style="margin-left: 0">
              <DropdownList
                :value="settings.startPositionListFile"
                :items="sfenFileList"
                :tags="[]"
                @update:value="settings.startPositionListFile = $event"
              />
            </div>
          </div>
          <!-- Shuffle Toggle -->
          <div v-show="settings.startPosition === 'list'" class="form-item">
            <div class="form-item-label">{{ t.shuffle }}</div>
            <ToggleButton v-model:value="settings.startPositionListShuffle" />
          </div>
        </div>

        <!-- Section: Sente (Black) -->
        <div class="form-group section">
          <div class="section-header">
            <span class="role">{{ t.sente }}</span>
          </div>
          <div class="section-body">
            <MobilePlayerSetting
              v-model:player-uri="settings.black.uri"
              v-model:player-name="settings.black.name"
              v-model:time-limit="settings.blackTime"
              v-model:extra-book="blackExtraBook"
              :book-file-list="bookFileList"
            />
          </div>
        </div>

        <!-- Swap Button -->
        <div class="swap-container">
          <button class="swap-btn" @click="onSwapColor">
            <Icon :icon="IconType.SWAP" />
            <span>{{ t.swapSenteGote }}</span>
          </button>
        </div>

        <!-- Section: Gote (White) -->
        <div class="form-group section">
          <div class="section-header">
            <span class="role">{{ t.gote }}</span>
          </div>
          <div class="section-body">
            <MobilePlayerSetting
              v-model:player-uri="settings.white.uri"
              v-model:player-name="settings.white.name"
              v-model:time-limit="settings.whiteTime"
              v-model:extra-book="whiteExtraBook"
              :book-file-list="bookFileList"
            />
          </div>
        </div>

        <!-- Section: Settings -->
        <div class="section">
          <div class="section-header">{{ t.settings }}</div>
          <div class="section-body">
            <!-- Max Moves -->
            <div class="form-item">
              <div class="form-item-label">{{ t.maxMoves }}</div>
              <input v-model.number="settings.maxMoves" class="number" type="number" min="1" />
            </div>
            <!-- Game Repetition -->
            <div class="form-item">
              <div class="form-item-label">{{ t.gameRepetition }}</div>
              <input v-model.number="settings.repeat" class="number" type="number" min="1" />
            </div>
            <!-- Jishogi Rule -->
            <div class="form-item">
              <div class="form-item-label">{{ t.jishogi }}</div>
              <div class="form-item-value full-width">
                <DropdownList
                  :value="settings.jishogiRule"
                  :items="jishogiRuleItems"
                  :tags="[]"
                  @update:value="settings.jishogiRule = $event as JishogiRule"
                />
              </div>
            </div>
            <!-- Swap Players -->
            <div class="form-item">
              <div class="form-item-label">{{ t.swapTurnWhenGameRepetition }}</div>
              <ToggleButton v-model:value="settings.swapPlayers" />
            </div>
            <!-- Auto Save -->
            <div class="form-item">
              <div class="form-item-label">{{ t.saveRecordAutomatically }}</div>
              <ToggleButton v-model:value="settings.enableAutoSave" />
            </div>
          </div>
        </div>
      </div>

      <div class="main-buttons">
        <button class="start" :disabled="!isValid" @click="onStart">
          {{ t.startGame }}
        </button>
        <button class="cancel" @click="onClose">
          {{ t.cancel }}
        </button>
      </div>
    </dialog>
  </div>
</template>

<script setup lang="ts">
import { t } from "@/common/i18n";
import { TimeLimitSettings, JishogiRule, validateGameSettingsForWeb } from "@/common/settings/game";
import Icon from "@/renderer/view/primitive/Icon.vue";
import HorizontalSelector from "@/renderer/view/primitive/HorizontalSelector.vue";
import { IconType } from "@/renderer/assets/icons";
import { installHotKeyForDialog, uninstallHotKeyForDialog } from "@/renderer/devices/hotkey";
import { showModalDialog } from "@/renderer/helpers/dialog";
import { useStore } from "@/renderer/store";
import { InitialPositionType } from "tsshogi";
import { onBeforeUnmount, onMounted, ref, reactive, computed } from "vue";
import { useLanStore } from "@/renderer/store/lan";
import { useErrorStore } from "@/renderer/store/error";
import MobilePlayerSetting from "./MobilePlayerSetting.vue";
import ToggleButton from "@/renderer/view/primitive/ToggleButton.vue";
import api from "@/renderer/ipc/api";
import * as uri from "@/common/uri";
import DropdownList from "@/renderer/view/primitive/DropdownList.vue";
import { USIEngineExtraBookConfig } from "@/common/settings/usi";
import { PlayerSettings } from "@/common/settings/player";

const store = useStore();
const dialog = ref();
const lanStore = useLanStore();
const initialized = ref(false);

const settings = reactive({
  black: { uri: uri.ES_HUMAN, name: t.human, usi: undefined } as PlayerSettings,
  white: {
    uri: uri.ES_BASIC_ENGINE_STATIC_ROOK_V1,
    name: `${t.beginner} (${t.staticRook})`,
    usi: undefined,
  } as PlayerSettings,
  blackTime: { timeSeconds: 600, byoyomi: 30, increment: 0 } as TimeLimitSettings,
  whiteTime: { timeSeconds: 600, byoyomi: 30, increment: 0 } as TimeLimitSettings,
  startPosition: InitialPositionType.STANDARD as InitialPositionType | "current" | "list",
  startPositionListFile: "",
  startPositionListShuffle: false,
  maxMoves: 1000,
  repeat: 1,
  swapPlayers: false,
  jishogiRule: JishogiRule.GENERAL27,
  enableAutoSave: false,
});

const blackExtraBook = ref<USIEngineExtraBookConfig>({ enabled: false, filePath: "" });
const whiteExtraBook = ref<USIEngineExtraBookConfig>({ enabled: false, filePath: "" });
const sfenFileList = ref<{ label: string; value: string }[]>([]);
const bookFileList = ref<{ label: string; value: string }[]>([]);

const jishogiRuleItems = computed(() => [
  { value: JishogiRule.NONE, label: t.none },
  { value: JishogiRule.GENERAL24, label: t.rule24 },
  { value: JishogiRule.GENERAL27, label: t.rule27 },
  { value: JishogiRule.TRY, label: t.tryRule },
]);

const emit = defineEmits<{
  close: [];
}>();

const onClose = () => {
  emit("close");
};

const loadSFENFileList = async () => {
  try {
    const kifuFiles = await api.listServerPosition();
    sfenFileList.value = kifuFiles.map((f) => ({ label: f, value: "server://" + f }));
  } catch (e) {
    console.warn("Failed to load SFEN file list:", e);
    sfenFileList.value = [];
  }
};

const loadBookFileList = async () => {
  try {
    const bookFiles = await api.listServerBook();
    bookFileList.value = bookFiles.map((f) => ({ label: f, value: "server://" + f }));
  } catch (e) {
    console.warn("Failed to load book file list:", e);
    bookFileList.value = [];
  }
};

onMounted(async () => {
  showModalDialog(dialog.value, onClose);
  installHotKeyForDialog(dialog.value);

  try {
    const saved = await api.loadGameSettings();
    settings.black = { ...saved.black };
    settings.white = { ...saved.white };
    settings.blackTime = { ...saved.timeLimit };
    settings.whiteTime = { ...(saved.whiteTimeLimit || saved.timeLimit) };
    settings.startPosition = saved.startPosition;
    settings.startPositionListFile = saved.startPositionListFile || "";
    settings.startPositionListShuffle = saved.startPositionListOrder === "shuffle";
    settings.maxMoves = saved.maxMoves || 1000;
    settings.repeat = saved.repeat || 1;
    settings.swapPlayers = saved.swapPlayers || false;
    settings.jishogiRule = saved.jishogiRule || JishogiRule.GENERAL27;
    settings.enableAutoSave = saved.enableAutoSave;

    if (saved.black.usi?.extraBook) {
      blackExtraBook.value = { ...saved.black.usi.extraBook };
    }
    if (saved.white.usi?.extraBook) {
      whiteExtraBook.value = { ...saved.white.usi.extraBook };
    }

    initialized.value = true;
  } catch (e) {
    console.error("Failed to load game settings:", e);
    initialized.value = true;
  }

  await Promise.all([loadSFENFileList(), loadBookFileList()]);

  if (lanStore.status.value === "disconnected") {
    lanStore.fetchEngineList().catch(console.error);
  }
});

onBeforeUnmount(() => {
  uninstallHotKeyForDialog(dialog.value);
});

const onSwapColor = () => {
  const tmpBlack = { ...settings.black };
  const tmpBlackTime = { ...settings.blackTime };
  const tmpBlackExtraBook = { ...blackExtraBook.value };
  settings.black = { ...settings.white };
  settings.blackTime = { ...settings.whiteTime };
  blackExtraBook.value = { ...whiteExtraBook.value };
  settings.white = tmpBlack;
  settings.whiteTime = tmpBlackTime;
  whiteExtraBook.value = tmpBlackExtraBook;
};

const isValid = computed(() => {
  return settings.black.uri && settings.white.uri;
});

const onStart = async () => {
  const black = { ...settings.black };
  if (black.uri.startsWith("lan-engine") && black.usi) {
    black.usi = { ...black.usi, extraBook: { ...blackExtraBook.value } };
  }
  const white = { ...settings.white };
  if (white.uri.startsWith("lan-engine") && white.usi) {
    white.usi = { ...white.usi, extraBook: { ...whiteExtraBook.value } };
  }

  const newSettings = {
    ...store.gameSettings,
    black,
    white,
    timeLimit: { ...settings.blackTime },
    whiteTimeLimit: { ...settings.whiteTime },
    startPosition: settings.startPosition,
    startPositionListFile: settings.startPositionListFile,
    startPositionListOrder: settings.startPositionListShuffle
      ? ("shuffle" as const)
      : ("sequential" as const),
    maxMoves: settings.maxMoves,
    repeat: settings.repeat,
    swapPlayers: settings.swapPlayers,
    jishogiRule: settings.jishogiRule,
    enableAutoSave: settings.enableAutoSave,
  };

  const err = validateGameSettingsForWeb(newSettings);
  if (err) {
    useErrorStore().add(err);
    return;
  }

  try {
    await api.saveGameSettings(newSettings);
    store.startGame(newSettings);
    emit("close");
  } catch (e) {
    console.error("Failed to save game settings:", e);
    store.startGame(newSettings);
    emit("close");
  }
};
</script>

<style scoped>
.dialog-mask {
  position: fixed;
  top: 0;
  left: 0;
  width: 100vw;
  height: 100dvh;
  background-color: rgba(0, 0, 0, 0.5);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 100;
}
.mobile-dialog {
  width: 92vw;
  max-height: 80dvh;
  border: 1px solid var(--dialog-border-color);
  border-radius: 4px;
  padding: 0;
  display: flex;
  flex-direction: column;
  background-color: var(--dialog-bg-color);
  box-shadow: 0 8px 30px rgba(0, 0, 0, 0.4);
  color: var(--dialog-color);
}
.title {
  font-size: 1.1em;
  font-weight: bold;
  padding: 12px;
  text-align: center;
  border-bottom: 1px solid var(--text-separator-color);
}
.content {
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  padding: 10px;
}
.section {
  margin-bottom: 10px;
}
.section-header {
  padding: 5px 10px;
  font-weight: bold;
  font-size: 0.95em;
}
.section-body {
  padding: 0 5px;
}
.form-item {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-top: 5px;
  padding: 0 10px;
}
.form-item-label {
  font-size: 0.85em;
  color: var(--text-color);
  flex: 1;
  margin-right: 10px;
  line-height: 1.2;
  text-align: left;
}
.form-item-value.full-width {
  flex: 1;
  margin-left: 10px;
  min-width: 0;
}
input.number {
  text-align: right;
  width: 80px;
}
.selector-container {
  padding: 5px;
  display: flex;
  justify-content: center;
}
.form-group {
  border: 1px dashed var(--text-dashed-separator-color);
  border-radius: 10px;
  padding: 10px;
  margin: 5px 0;
}
.swap-container {
  display: flex;
  justify-content: center;
  margin: 5px 0;
  position: relative;
  z-index: 1;
}
.swap-btn {
  padding: 4px 15px;
  font-size: 0.85em;
  background-color: var(--button-bg-color);
  border: 1px solid var(--dialog-border-color);
  color: var(--control-button-color);
  display: flex;
  align-items: center;
  gap: 5px;
  cursor: pointer;
}
.swap-btn:active {
  background-color: var(--active-bg-color);
}
.main-buttons {
  display: flex;
  padding: 10px;
  gap: 10px;
  border-top: 1px solid var(--text-separator-color);
}
.main-buttons button {
  flex: 1;
  padding: 12px;
  font-size: 1em;
  font-weight: bold;
  border: 1px solid var(--dialog-border-color);
  background-color: var(--control-button-bg-color);
  color: var(--control-button-color);
  border-radius: 0;
  cursor: pointer;
}
.main-buttons button.start {
  background-color: var(--pushed-selector-bg-color);
  color: var(--pushed-selector-color);
}
.main-buttons button:active:not(:disabled) {
  opacity: 0.8;
}
.main-buttons button:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}
</style>
