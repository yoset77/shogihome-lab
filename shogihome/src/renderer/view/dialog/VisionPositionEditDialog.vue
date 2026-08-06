<template>
  <DialogFrame ref="dialogFrame" :limited="isMobile" @cancel="onCancel">
    <div class="vision-position-edit-dialog" :class="{ mobile: isMobile }">
      <header v-if="!isMobile" class="dialog-header">
        <h2>{{ t.importBoardImage }}</h2>
      </header>

      <div class="tab-header row" role="tablist">
        <div
          id="vision-position-tab"
          ref="positionTabRef"
          class="tab-item"
          :class="{ active: activeTab === 'position' }"
          data-tab="position"
          role="tab"
          :aria-selected="activeTab === 'position'"
          aria-controls="vision-position-panel"
          :tabindex="activeTab === 'position' ? 0 : -1"
          @click="selectTab('position')"
          @keydown="onTabKeydown"
        >
          {{ t.editing }}
        </div>
        <div
          id="vision-source-tab"
          ref="sourceTabRef"
          class="tab-item"
          :class="{ active: activeTab === 'source' }"
          data-tab="source"
          role="tab"
          :aria-selected="activeTab === 'source'"
          aria-controls="vision-source-panel"
          :tabindex="activeTab === 'source' ? 0 : -1"
          @click="selectTab('source')"
          @keydown="onTabKeydown"
        >
          {{ t.visionImage }}
        </div>
      </div>

      <div
        v-show="activeTab === 'position'"
        id="vision-position-panel"
        class="position-tab"
        role="tabpanel"
        aria-labelledby="vision-position-tab"
      >
        <div class="content">
          <PositionEditorCore
            :position="position"
            :layout-type="isMobile ? BoardLayoutType.PORTRAIT : BoardLayoutType.STANDARD"
            :mobile="isMobile"
            :flip="props.session.viewpoint === 'white'"
            :ghost-teleport-target="ghostTeleportTarget"
            @change="updatePosition"
          />
        </div>
      </div>

      <div
        v-if="activeTab === 'source'"
        id="vision-source-panel"
        class="source-tab"
        role="tabpanel"
        aria-labelledby="vision-source-tab"
      >
        <img class="source-image" :src="sourceImageUrl" :alt="t.visionImage" />
      </div>

      <div class="main-buttons">
        <button
          v-if="activeTab === 'position'"
          type="button"
          class="correct-button"
          :disabled="!hasViolation"
          @click="onCorrectPieceCount"
        >
          {{ t.correctPieceCount }}
        </button>
        <button type="button" @click="onConfirm">
          {{ t.ok }}
        </button>
        <button type="button" @click="onCancel">
          {{ t.cancel }}
        </button>
      </div>
    </div>
  </DialogFrame>
</template>

<script setup lang="ts">
import { computed, markRaw, shallowRef, ref, onBeforeUnmount } from "vue";
import { Position } from "tsshogi";
import { t } from "@/common/i18n";
import DialogFrame from "@/renderer/view/dialog/DialogFrame.vue";
import PositionEditorCore from "@/renderer/view/dialog/PositionEditorCore.vue";
import { useStore } from "@/renderer/store";
import { BoardLayoutType } from "@/common/settings/layout";
import { isMobileWebApp } from "@/renderer/ipc/api";
import {
  correctPieceCount,
  detectPieceCountViolations,
  fillUnusedPiecesToWhiteHand,
} from "@/common/game/pieceBox";
import type { VisionPositionType } from "@/common/vision/types";
import type { VisionEditSession } from "@/renderer/vision/types";

const props = defineProps<{
  session: VisionEditSession;
}>();

const store = useStore();
const isMobile = isMobileWebApp();
const dialogFrame = ref<InstanceType<typeof DialogFrame>>();
const ghostTeleportTarget = computed(() => dialogFrame.value?.dialog ?? "body");

const createPosition = (sfen: string, positionType: VisionPositionType): Position => {
  const pos = Position.newBySFEN(sfen) ?? new Position();
  return positionType === "mate" ? fillUnusedPiecesToWhiteHand(pos) : pos;
};

const position = shallowRef<Position>(
  markRaw(createPosition(props.session.response.sfen, props.session.positionType)),
);
const activeTab = ref<"position" | "source">("position");
const sourceImageUrl = ref("");
const positionTabRef = ref<HTMLDivElement | null>(null);
const sourceTabRef = ref<HTMLDivElement | null>(null);
const hasViolation = computed(() => detectPieceCountViolations(position.value).length > 0);

onBeforeUnmount(() => {
  if (sourceImageUrl.value) {
    URL.revokeObjectURL(sourceImageUrl.value);
    sourceImageUrl.value = "";
  }
});

const selectTab = (tab: "position" | "source") => {
  if (tab === "source" && !sourceImageUrl.value) {
    sourceImageUrl.value = URL.createObjectURL(props.session.sourceImage);
  }
  activeTab.value = tab;
};

const onTabKeydown = (event: KeyboardEvent) => {
  let tab: "position" | "source";
  switch (event.key) {
    case "ArrowLeft":
    case "ArrowRight":
      tab = activeTab.value === "position" ? "source" : "position";
      break;
    case "Home":
      tab = "position";
      break;
    case "End":
      tab = "source";
      break;
    default:
      return;
  }
  event.preventDefault();
  selectTab(tab);
  (tab === "position" ? positionTabRef.value : sourceTabRef.value)?.focus();
};

const updatePosition = (newPos: Position) => {
  position.value = markRaw(newPos);
};

const onCorrectPieceCount = () => {
  updatePosition(correctPieceCount(position.value));
};

const onConfirm = () => {
  store.importVisionSFEN(position.value.sfen);
  store.destroyModalDialog();
};

const onCancel = () => {
  store.destroyModalDialog();
};
</script>

<style scoped>
.vision-position-edit-dialog {
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

.vision-position-edit-dialog.mobile {
  width: 100%;
  min-width: 0;
  height: 100%;
  max-width: 100%;
  max-height: calc(100dvh - 2em - 33px);
  aspect-ratio: auto;
  overflow: hidden;
  gap: 0;
}

.vision-position-edit-dialog.mobile .tab-header {
  flex-shrink: 0;
  margin-top: 0;
}

.vision-position-edit-dialog.mobile .position-tab,
.vision-position-edit-dialog.mobile .source-tab {
  flex: 1;
  min-height: 0;
  padding-top: 10px;
  box-sizing: border-box;
}

.vision-position-edit-dialog.mobile .main-buttons {
  flex-shrink: 0;
}

.vision-position-edit-dialog.mobile .content {
  flex: 1;
  min-height: 0;
  justify-content: center;
  gap: 8px;
  padding: 0 8px;
}

.dialog-header {
  display: flex;
  align-items: center;
  justify-content: center;
}

h2 {
  margin: 0;
  font-size: 120%;
}

.tab-header {
  margin: 10px 10px 0 10px;
  border-bottom: 1px solid var(--text-dashed-separator-color);
}

.tab-item {
  padding: 8px 20px;
  cursor: pointer;
  border: 1px solid transparent;
  border-bottom: none;
  border-radius: 5px 5px 0 0;
  margin-bottom: -1px;
}

.tab-item.active {
  background-color: var(--text-bg-color);
  border-color: var(--text-dashed-separator-color);
  font-weight: bold;
}

.position-tab {
  display: flex;
  flex: 1;
  flex-direction: column;
  gap: 12px;
  min-height: 0;
}

.source-tab {
  display: flex;
  flex: 1;
  align-items: center;
  justify-content: center;
  min-height: 0;
  overflow: hidden;
}

.source-image {
  display: block;
  max-width: 100%;
  max-height: 100%;
  object-fit: contain;
}

.vision-position-edit-dialog.mobile .source-image {
  width: 100%;
  height: auto;
  max-height: calc(100dvh - 190px);
}

.warning-message {
  padding: 8px 12px;
  background-color: var(--warn-bg-color, #fff3cd);
  border: 1px solid var(--warn-border-color, #ffc107);
  color: var(--warn-text-color, #856404);
  font-size: 14px;
}

.content {
  display: flex;
  flex: 1;
  flex-direction: column;
  gap: 12px;
  align-items: center;
  min-height: 0;
}

.main-buttons {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  justify-content: center;
}

.correct-button {
  background-color: var(--main-color);
  color: var(--control-button-color);
}

button:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
</style>
