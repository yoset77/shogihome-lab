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
              ]"
              :height="36"
              @update:value="settings.startPosition = $event as InitialPositionType | 'current'"
            />
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
            />
          </div>
        </div>
        <!-- Section: Settings -->
        <div class="section">
          <div class="section-header">{{ t.settings }}</div>
          <div class="section-body">
            <div class="form-item">
              <ToggleButton
                v-model:value="settings.enableAutoSave"
                :label="t.saveRecordAutomatically"
              />
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
import { TimeLimitSettings } from "@/common/settings/game";
import Icon from "@/renderer/view/primitive/Icon.vue";
import HorizontalSelector from "@/renderer/view/primitive/HorizontalSelector.vue";
import { IconType } from "@/renderer/assets/icons";
import { installHotKeyForDialog, uninstallHotKeyForDialog } from "@/renderer/devices/hotkey";
import { showModalDialog } from "@/renderer/helpers/dialog";
import { useStore } from "@/renderer/store";
import { InitialPositionType } from "tsshogi";
import { onBeforeUnmount, onMounted, ref, reactive, computed } from "vue";
import { useLanStore } from "@/renderer/store/lan";
import MobilePlayerSetting from "./MobilePlayerSetting.vue";
import ToggleButton from "@/renderer/view/primitive/ToggleButton.vue";
import api from "@/renderer/ipc/api";
import * as uri from "@/common/uri";

const store = useStore();
const dialog = ref();
const lanStore = useLanStore();
const initialized = ref(false);

const settings = reactive({
  black: { uri: uri.ES_HUMAN, name: t.human },
  white: { uri: uri.ES_BASIC_ENGINE_STATIC_ROOK_V1, name: `${t.beginner} (${t.staticRook})` },
  blackTime: { timeSeconds: 600, byoyomi: 30, increment: 0 } as TimeLimitSettings,
  whiteTime: { timeSeconds: 600, byoyomi: 30, increment: 0 } as TimeLimitSettings,
  startPosition: InitialPositionType.STANDARD as InitialPositionType | "current",
  enableAutoSave: false,
});

const emit = defineEmits<{
  close: [];
}>();

const onClose = () => {
  emit("close");
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
    if (saved.startPosition !== "list") {
      settings.startPosition = saved.startPosition;
    }
    settings.enableAutoSave = saved.enableAutoSave;
    initialized.value = true;
  } catch (e) {
    console.error("Failed to load game settings:", e);
    initialized.value = true; // Still show with defaults if load fails
  }

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
  settings.black = { ...settings.white };
  settings.blackTime = { ...settings.whiteTime };
  settings.white = tmpBlack;
  settings.whiteTime = tmpBlackTime;
};

const isValid = computed(() => {
  return settings.black.uri && settings.white.uri;
});

const onStart = async () => {
  const newSettings = {
    ...store.gameSettings,
    black: { ...settings.black },
    white: { ...settings.white },
    timeLimit: { ...settings.blackTime },
    whiteTimeLimit: { ...settings.whiteTime },
    startPosition: settings.startPosition,
    enableAutoSave: settings.enableAutoSave,
    jishogiRule: store.gameSettings.jishogiRule,
    repeat: 1,
  };

  try {
    // Explicitly save settings before starting
    await api.saveGameSettings(newSettings);
    store.startGame(newSettings);
    emit("close");
  } catch (e) {
    console.error("Failed to save game settings:", e);
    // Even if saving fails, we try to start the game
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
  flex: 1;
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
