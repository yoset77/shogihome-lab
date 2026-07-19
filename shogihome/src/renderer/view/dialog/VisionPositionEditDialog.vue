<template>
  <DialogFrame :limited="isMobile" @cancel="onCancel">
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
        <div v-if="hasViolation" class="warning-message">
          {{ t.pieceCountExceeded }}
        </div>

        <div ref="contentRef" class="content">
          <div class="board-area">
            <BoardView
              :layout-type="isMobile ? BoardLayoutType.PORTRAIT : BoardLayoutType.STANDARD"
              :board-image-type="appSettings.boardImage"
              :custom-board-image-url="appSettings.boardImageFileURL"
              :board-image-opacity="appSettings.enableTransparent ? appSettings.boardOpacity : 1"
              :board-grid-color="appSettings.boardGridColor || undefined"
              :piece-stand-image-type="appSettings.pieceStandImage"
              :custom-piece-stand-image-url="appSettings.pieceStandImageFileURL"
              :piece-stand-image-opacity="
                appSettings.enableTransparent ? appSettings.pieceStandOpacity : 1
              "
              :promotion-selector-style="appSettings.promotionSelectorStyle"
              :board-label-type="appSettings.boardLabelType"
              :piece-image-url-template="getPieceImageURLTemplate(appSettings)"
              :king-piece-type="appSettings.kingPieceType"
              :max-size="boardMaxSize"
              :position="position"
              :flip="props.session.viewpoint === 'white'"
              :hide-clock="true"
              :mobile="isMobile"
              :allow-move="false"
              :allow-edit="true"
              :enable-drag-and-drop="appSettings.enableDragAndDrop"
              :external-drag="externalDrag"
              :piece-box-selection="pieceBoxSelection"
              :black-player-name="t.sente"
              :white-player-name="t.gote"
              :next-move-label="t.nextTurn"
              :drop-shadows="!isMobile"
              @edit="onEdit"
              @piece-box-drop="onPieceBoxDrop"
              @drop-outside="onDropOutside"
              @external-drag-end="externalDrag = null"
              @piece-box-selection-end="pieceBoxSelection = null"
              @edit-selection-change="editSelection = $event"
            />
          </div>

          <div class="piece-box-area">
            <PieceBox
              ref="pieceBoxRef"
              :position="position"
              :accept-tap-drop="editSelection !== null"
              :selection="pieceBoxSelection"
              @dragstart="onPieceBoxDragStart"
              @tap-drop="onPieceBoxTapDrop"
            />
          </div>
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
import { markRaw, shallowRef, ref, onMounted, onBeforeUnmount } from "vue";
import { Color, Position, PositionChange, Piece, PieceType, Square } from "tsshogi";
import { t } from "@/common/i18n";
import DialogFrame from "@/renderer/view/dialog/DialogFrame.vue";
import BoardView from "@/renderer/view/primitive/BoardView.vue";
import PieceBox from "@/renderer/view/primitive/PieceBox.vue";
import { useAppSettings } from "@/renderer/store/settings";
import { useStore } from "@/renderer/store";
import { getPieceImageURLTemplate } from "@/common/settings/app";
import { BoardLayoutType } from "@/common/settings/layout";
import { RectSize } from "@/common/assets/geometry";
import { isMobileWebApp } from "@/renderer/ipc/api";
import {
  computePieceBoxCounts,
  correctPieceCount,
  detectPieceCountViolations,
  fillUnusedPiecesToWhiteHand,
  pieceTypeToPieceBoxKey,
} from "@/common/game/pieceBox";
import type { VisionPositionType } from "@/common/vision/types";
import type { VisionEditSession } from "@/renderer/vision/types";

type PieceBoxExpose = {
  containsPoint(clientX: number, clientY: number): boolean;
};

const props = defineProps<{
  session: VisionEditSession;
}>();

const store = useStore();
const appSettings = useAppSettings();
const isMobile = isMobileWebApp();

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
const hasViolation = ref(detectPieceCountViolations(position.value).length > 0);
const pieceBoxRef = ref<PieceBoxExpose | null>(null);
const editSelection = shallowRef<Square | Piece | null>(null);

const contentRef = ref<HTMLElement | null>(null);
let resizeObserver: ResizeObserver | null = null;

const PORTRAIT_FRAME_WIDTH = 878;
const PORTRAIT_FRAME_HEIGHT = 1168;
const PIECE_BOX_HEIGHT = 160;

const boardMaxSize = ref(
  isMobile
    ? new RectSize(Math.min(380, window.innerWidth - 30), Math.min(700, window.innerHeight - 180))
    : new RectSize(800, 600),
);

onMounted(() => {
  if (!isMobile) return;
  const el = contentRef.value;
  if (!el) return;
  resizeObserver = new ResizeObserver((entries) => {
    for (const entry of entries) {
      const availableHeight = entry.contentRect.height - PIECE_BOX_HEIGHT;
      if (availableHeight <= 0) continue;
      const availableWidth = entry.contentRect.width;
      const ratio = Math.min(
        availableWidth / PORTRAIT_FRAME_WIDTH,
        availableHeight / PORTRAIT_FRAME_HEIGHT,
      );
      boardMaxSize.value = new RectSize(
        Math.floor(PORTRAIT_FRAME_WIDTH * ratio),
        Math.floor(PORTRAIT_FRAME_HEIGHT * ratio),
      );
    }
  });
  resizeObserver.observe(el);
});

onBeforeUnmount(() => {
  resizeObserver?.disconnect();
  resizeObserver = null;
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
  const raw = markRaw(newPos);
  position.value = raw;
  hasViolation.value = detectPieceCountViolations(raw).length > 0;
};

const onEdit = (change: PositionChange) => {
  const newPos = position.value.clone();
  newPos.edit(change);
  updatePosition(newPos);
  externalDrag.value = null;
  editSelection.value = null;
};

const externalDrag = ref<{
  piece: Piece;
  pieceImagePath: string;
  pointerId: number;
  clientX: number;
  clientY: number;
  source: "pieceBox";
} | null>(null);
const pieceBoxSelection = ref<PieceType | null>(null);

const onPieceBoxDragStart = (
  piece: Piece,
  pieceImagePath: string,
  pointerId: number,
  clientX: number,
  clientY: number,
) => {
  if (editSelection.value) return;
  pieceBoxSelection.value = pieceBoxSelection.value === piece.type ? null : piece.type;
  externalDrag.value = { piece, pieceImagePath, pointerId, clientX, clientY, source: "pieceBox" };
};

const onPieceBoxTapDrop = () => {
  const source = editSelection.value;
  if (!source) return;
  const newPos = position.value.clone();
  if (source instanceof Square) {
    if (!newPos.board.at(source)) return;
    newPos.board.remove(source);
  } else {
    if (source.type === PieceType.KING || newPos.hand(source.color).count(source.type) === 0) {
      return;
    }
    newPos.hand(source.color).reduce(source.type, 1);
  }
  updatePosition(newPos);
  editSelection.value = null;
};

const onPieceBoxDrop = (pieceType: PieceType, to: Square | Color) => {
  const newPos = position.value.clone();
  const key = pieceTypeToPieceBoxKey(pieceType);
  if (computePieceBoxCounts(newPos)[key] === 0) {
    externalDrag.value = null;
    pieceBoxSelection.value = null;
    return;
  }
  if (to instanceof Square) {
    if (newPos.board.at(to)) {
      externalDrag.value = null;
      pieceBoxSelection.value = null;
      return;
    }
    newPos.board.set(to, new Piece(newPos.color, pieceType));
  } else {
    if (pieceType === PieceType.KING) {
      externalDrag.value = null;
      pieceBoxSelection.value = null;
      return;
    }
    newPos.hand(to).add(pieceType, 1);
  }
  updatePosition(newPos);
  externalDrag.value = null;
  pieceBoxSelection.value = null;
};

const onDropOutside = (source: Square | Piece, clientX: number, clientY: number) => {
  if (!pieceBoxRef.value?.containsPoint(clientX, clientY)) return;
  const newPos = position.value.clone();
  if (source instanceof Square) {
    if (!newPos.board.at(source)) return;
    newPos.board.remove(source);
  } else {
    if (source.type === PieceType.KING || newPos.hand(source.color).count(source.type) === 0)
      return;
    newPos.hand(source.color).reduce(source.type, 1);
  }
  updatePosition(newPos);
  editSelection.value = null;
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
  width: min(800px, calc(95vw - 30px));
}

.vision-position-edit-dialog.mobile {
  width: 100%;
  height: 100%;
  max-width: 100%;
  max-height: calc(100dvh - 2em - 33px);
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

.vision-position-edit-dialog.mobile .board-area {
  flex: 1;
  min-height: 0;
  align-items: center;
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
  flex-direction: column;
  gap: 12px;
}

.source-tab {
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 320px;
  overflow: hidden;
}

.source-image {
  display: block;
  max-width: 100%;
  max-height: calc(100vh - 190px);
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
  flex-direction: column;
  gap: 12px;
  align-items: center;
}

.board-area {
  display: flex;
  justify-content: center;
}

.piece-box-area {
  display: flex;
  justify-content: center;
  width: 100%;
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
