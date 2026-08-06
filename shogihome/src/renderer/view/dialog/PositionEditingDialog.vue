<template>
  <DialogFrame ref="dialogFrame" :limited="isMobile" @cancel="onCancel">
    <div v-if="isMobile" class="mobile-shell">
      <div class="mobile-toolbar">
        <button type="button" data-test="undo" :disabled="!canUndo" @click="undo">
          {{ t.undo }}
        </button>
        <button type="button" data-test="redo" :disabled="!canRedo" @click="redo">
          {{ t.redo }}
        </button>
        <button type="button" @click="isInitialPositionMenuVisible = true">
          {{ t.initializePosition }}
        </button>
        <button type="button" data-test="change-turn" @click="onChangeTurn">
          {{ t.changeTurn }}
        </button>
        <button type="button" data-test="flip-board" data-hotkey="Mod+t" @click="flip = !flip">
          {{ t.flipBoard }}
        </button>
        <button type="button" data-test="copy-sfen" @click="onCopySFEN">{{ t.copy }} (SFEN)</button>
        <button type="button" data-test="copy-bod" @click="onCopyBOD">{{ t.copy }} (BOD)</button>
        <button type="button" data-test="paste" @click="onPaste">{{ t.paste }}</button>
      </div>
      <PositionEditorCore
        :position="position"
        :layout-type="BoardLayoutType.PORTRAIT"
        :mobile="true"
        :flip="flip"
        :ghost-teleport-target="ghostTeleportTarget"
        @change="commitPosition"
      />
      <div class="main-buttons mobile-buttons">
        <button type="button" data-test="ok" data-hotkey="Enter" @click="onOk">
          {{ t.ok }}
        </button>
        <button type="button" data-test="cancel" data-hotkey="Escape" @click="onCancel">
          {{ t.cancel }}
        </button>
      </div>
    </div>

    <div v-else class="desktop-dialog">
      <div class="desktop-toolbar">
        <button
          type="button"
          data-test="undo"
          data-hotkey="Mod+z"
          :disabled="!canUndo"
          @click="undo"
        >
          {{ t.undo }}
        </button>
        <button
          type="button"
          data-test="redo"
          data-hotkey="Mod+Shift+z"
          :disabled="!canRedo"
          @click="redo"
        >
          {{ t.redo }}
        </button>
        <button type="button" @click="isInitialPositionMenuVisible = true">
          {{ t.initializePosition }}
        </button>
        <button type="button" data-test="change-turn" @click="onChangeTurn">
          {{ t.changeTurn }}
        </button>
        <button type="button" data-test="flip-board" data-hotkey="Mod+t" @click="flip = !flip">
          {{ t.flipBoard }}
        </button>
        <button type="button" data-test="copy-sfen" @click="onCopySFEN">{{ t.copy }} (SFEN)</button>
        <button type="button" data-test="copy-bod" @click="onCopyBOD">{{ t.copy }} (BOD)</button>
        <button type="button" data-test="paste" @click="onPaste">
          {{ t.paste }}
        </button>
      </div>
      <div class="desktop-editor">
        <PositionEditorCore
          :position="position"
          :layout-type="BoardLayoutType.STANDARD"
          :flip="flip"
          :ghost-teleport-target="ghostTeleportTarget"
          @change="commitPosition"
        />
      </div>
      <div class="main-buttons">
        <button type="button" data-test="ok" data-hotkey="Enter" autofocus @click="onOk">
          {{ t.ok }}
        </button>
        <button type="button" data-test="cancel" data-hotkey="Escape" @click="onCancel">
          {{ t.cancel }}
        </button>
      </div>
    </div>

    <InitialPositionMenu
      v-if="isInitialPositionMenuVisible"
      @select="onSelectPreset"
      @close="isInitialPositionMenuVisible = false"
    />
  </DialogFrame>
</template>

<script setup lang="ts">
import { computed, markRaw, ref, shallowRef } from "vue";
import { exportBOD, importKIF, Position, Record, reverseColor } from "tsshogi";
import { t } from "@/common/i18n";
import { BoardLayoutType } from "@/common/settings/layout";
import { useStore } from "@/renderer/store";
import { useErrorStore } from "@/renderer/store/error";
import { isMobileWebApp } from "@/renderer/ipc/api";
import DialogFrame from "@/renderer/view/dialog/DialogFrame.vue";
import PositionEditorCore from "@/renderer/view/dialog/PositionEditorCore.vue";
import InitialPositionMenu from "@/renderer/view/menu/InitialPositionMenu.vue";

const store = useStore();
const isMobile = isMobileWebApp();
const dialogFrame = ref<InstanceType<typeof DialogFrame>>();
const ghostTeleportTarget = computed(() => dialogFrame.value?.dialog ?? "body");
const position = shallowRef(markRaw(store.record.position.clone()));
const history = ref([position.value.sfen]);
const historyIndex = ref(0);
const isInitialPositionMenuVisible = ref(false);
const flip = ref(false);
const canUndo = computed(() => historyIndex.value > 0);
const canRedo = computed(() => historyIndex.value < history.value.length - 1);

const setPositionFromHistory = () => {
  const restored = Position.newBySFEN(history.value[historyIndex.value]);
  if (restored) {
    position.value = markRaw(restored);
  }
};

const commitPosition = (newPosition: Position) => {
  if (newPosition.sfen === position.value.sfen) return;
  history.value = [...history.value.slice(0, historyIndex.value + 1), newPosition.sfen];
  historyIndex.value = history.value.length - 1;
  position.value = markRaw(newPosition);
};

const undo = () => {
  if (!canUndo.value) return;
  historyIndex.value--;
  setPositionFromHistory();
};

const redo = () => {
  if (!canRedo.value) return;
  historyIndex.value++;
  setPositionFromHistory();
};

const onChangeTurn = () => {
  const newPosition = position.value.clone();
  newPosition.setColor(reverseColor(newPosition.color));
  commitPosition(newPosition);
};

const onSelectPreset = (sfen: string) => {
  isInitialPositionMenuVisible.value = false;
  const newPosition = Position.newBySFEN(sfen);
  if (newPosition) {
    commitPosition(newPosition);
  }
};

const writeClipboard = async (text: string) => {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    useErrorStore().add(new Error(t.clipboardOperationFailed));
  }
};

const onCopySFEN = () => writeClipboard(position.value.sfen);
const onCopyBOD = () => writeClipboard(exportBOD(new Record(position.value)));

const onPaste = async () => {
  let text: string;
  try {
    text = (await navigator.clipboard.readText()).trim();
  } catch {
    useErrorStore().add(new Error(t.clipboardOperationFailed));
    return;
  }
  if (!text) return;
  if (Position.isValidSFEN(text)) {
    commitPosition(Position.newBySFEN(text) as Position);
    return;
  }
  if (
    !/^(手合割[：:]|(先|下)手の持駒[：:]|(後|上)手の持駒[：:]|\||(?:先|下|後|上)手番| *[0-9]+ +)/m.test(
      text,
    )
  ) {
    useErrorStore().add(new Error(t.failedToDetectRecordFormat));
    return;
  }
  let record: ReturnType<typeof importKIF>;
  try {
    record = importKIF(text);
  } catch {
    useErrorStore().add(new Error(t.failedToDetectRecordFormat));
    return;
  }
  if (record instanceof Error) {
    useErrorStore().add(new Error(t.failedToDetectRecordFormat));
    return;
  }
  commitPosition(record.position.clone());
};

const onOk = () => store.closePositionEditingDialog(position.value.sfen);
const onCancel = () => store.closePositionEditingDialog();
</script>

<style scoped>
.desktop-dialog {
  display: flex;
  flex-direction: column;
  gap: 12px;
  width: auto;
  min-width: min(800px, calc(95vw - 30px));
  max-width: calc(95vw - 30px);
  height: clamp(520px, 90dvh, 1400px);
  aspect-ratio: 4 / 3;
  align-self: center;
}

.desktop-toolbar {
  display: flex;
  flex: 0 0 auto;
  flex-wrap: nowrap;
  gap: 4px;
  justify-content: center;
}

.desktop-toolbar button {
  min-width: 0;
  padding: 5px 7px;
  font-size: 12px;
  white-space: nowrap;
}

.desktop-editor {
  display: flex;
  flex: 1;
  min-width: 0;
  min-height: 0;
}

.mobile-shell {
  display: flex;
  flex-direction: column;
  gap: 6px;
  width: 100%;
  height: 100%;
  max-width: 100%;
  max-height: calc(100dvh - 2em - 33px);
  min-height: 0;
  overflow: hidden;
}

.mobile-toolbar {
  display: grid;
  flex: 0 0 auto;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 4px;
}

.mobile-toolbar button {
  min-width: 0;
  padding: 5px 2px;
  font-size: 12px;
}

.mobile-buttons {
  flex: 0 0 auto;
  padding-bottom: env(safe-area-inset-bottom, 0);
}

.main-buttons {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  justify-content: center;
}

button:disabled {
  cursor: not-allowed;
  opacity: 0.45;
}

@media (orientation: landscape) {
  .mobile-toolbar button {
    padding: 4px 1px;
    font-size: 11px;
    line-height: 1.15;
  }
}

@media (max-width: 860px) {
  .desktop-toolbar {
    flex-wrap: wrap;
  }
}
</style>
