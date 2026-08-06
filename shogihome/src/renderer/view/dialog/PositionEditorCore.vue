<template>
  <div class="position-editor-core">
    <div v-if="hasViolation" class="warning-message">
      {{ t.pieceCountExceeded }}
    </div>
    <div ref="boardAreaRef" class="board-area">
      <BoardView
        :layout-type="layoutType"
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
        :flip="flip"
        :hide-clock="true"
        :mobile="mobile"
        :allow-move="false"
        :allow-edit="true"
        :enable-drag-and-drop="appSettings.enableDragAndDrop"
        :external-drag="externalDrag"
        :piece-box-selection="pieceBoxSelection"
        :black-player-name="t.sente"
        :white-player-name="t.gote"
        :next-move-label="t.nextTurn"
        :drop-shadows="!mobile"
        :ghost-teleport-target="ghostTeleportTarget"
        @edit="onEdit"
        @piece-box-drop="onPieceBoxDrop"
        @drop-outside="onDropOutside"
        @external-drag-end="externalDrag = null"
        @piece-box-selection-end="pieceBoxSelection = null"
        @edit-selection-change="editSelection = $event"
      />
    </div>
    <div class="piece-box-column">
      <PieceBox
        ref="pieceBoxRef"
        :position="position"
        :scale="pieceBoxScale"
        :accept-tap-drop="editSelection !== null"
        :selection="pieceBoxSelection"
        @dragstart="onPieceBoxDragStart"
        @tap-drop="onPieceBoxTapDrop"
      />
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, markRaw, onBeforeUnmount, onMounted, ref, shallowRef, watch } from "vue";
import { Color, Piece, PieceType, Position, PositionChange, Square } from "tsshogi";
import { t } from "@/common/i18n";
import { RectSize } from "@/common/assets/geometry";
import { BoardLayoutType } from "@/common/settings/layout";
import { getPieceImageURLTemplate } from "@/common/settings/app";
import {
  computePieceBoxCounts,
  detectPieceCountViolations,
  pieceTypeToPieceBoxKey,
} from "@/common/game/pieceBox";
import { useAppSettings } from "@/renderer/store/settings";
import BoardView from "@/renderer/view/primitive/BoardView.vue";
import PieceBox from "@/renderer/view/primitive/PieceBox.vue";
import { portraitViewParams, standardViewParams } from "@/renderer/view/primitive/board/params";

const PIECE_BOX_SCALE_STEP = 0.05;
// Ignore layout jitter smaller than one quantization step.
const PIECE_BOX_SCALE_HYSTERESIS = PIECE_BOX_SCALE_STEP;

type PieceBoxExpose = {
  containsPoint(clientX: number, clientY: number): boolean;
};

type ExternalDrag = {
  piece: Piece;
  pieceImagePath: string;
  pointerId: number;
  clientX: number;
  clientY: number;
  source: "pieceBox";
};

const props = withDefaults(
  defineProps<{
    position: Position;
    layoutType: BoardLayoutType;
    mobile?: boolean;
    flip?: boolean;
    ghostTeleportTarget?: string | HTMLElement;
  }>(),
  {
    mobile: false,
    flip: false,
    ghostTeleportTarget: "body",
  },
);

const emit = defineEmits<{
  change: [position: Position];
}>();

const appSettings = useAppSettings();
const boardAreaRef = ref<HTMLElement | null>(null);
const pieceBoxRef = ref<PieceBoxExpose | null>(null);
const boardMaxSize = shallowRef(new RectSize(800, 600));
const externalDrag = ref<ExternalDrag | null>(null);
const pieceBoxSelection = ref<PieceType | null>(null);
const editSelection = shallowRef<Square | Piece | null>(null);
const hasViolation = computed(() => detectPieceCountViolations(props.position).length > 0);
const calculatePieceBoxScale = (boardSize: RectSize, layoutType: BoardLayoutType): number => {
  const frame =
    layoutType === BoardLayoutType.PORTRAIT ? portraitViewParams.frame : standardViewParams.frame;
  const boardScale = Math.min(boardSize.width / frame.width, boardSize.height / frame.height);
  const defaultScale = Math.min(800 / frame.width, 600 / frame.height);
  return Math.min(1.5, Math.max(0.75, boardScale / defaultScale));
};
const pieceBoxScale = ref(1);

watch(
  [boardMaxSize, () => props.layoutType],
  ([boardSize, layoutType]) => {
    const scale = calculatePieceBoxScale(boardSize, layoutType);
    const quantizedScale = Math.round(scale / PIECE_BOX_SCALE_STEP) * PIECE_BOX_SCALE_STEP;
    if (Math.abs(scale - pieceBoxScale.value) < PIECE_BOX_SCALE_HYSTERESIS) return;
    pieceBoxScale.value = quantizedScale;
  },
  { immediate: true },
);
let resizeObserver: ResizeObserver | null = null;

const clearInteraction = () => {
  externalDrag.value = null;
  pieceBoxSelection.value = null;
  editSelection.value = null;
};

const updatePosition = (position: Position) => {
  clearInteraction();
  emit("change", markRaw(position));
};

const onEdit = (change: PositionChange) => {
  const position = props.position.clone();
  position.edit(change);
  updatePosition(position);
};

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
  const position = props.position.clone();
  if (source instanceof Square) {
    if (!position.board.at(source)) return;
    position.board.remove(source);
  } else {
    if (source.type === PieceType.KING || position.hand(source.color).count(source.type) === 0) {
      return;
    }
    position.hand(source.color).reduce(source.type, 1);
  }
  updatePosition(position);
};

const getNearSideColor = (): Color => (props.flip ? Color.WHITE : Color.BLACK);

const getNewKingColor = (position: Position): Color => {
  let hasBlackKing = false;
  let hasWhiteKing = false;
  for (const square of Square.all) {
    const piece = position.board.at(square);
    if (piece?.type !== PieceType.KING) continue;
    if (piece.color === Color.BLACK) {
      hasBlackKing = true;
    } else {
      hasWhiteKing = true;
    }
  }
  if (hasBlackKing !== hasWhiteKing) {
    return hasBlackKing ? Color.WHITE : Color.BLACK;
  }
  return getNearSideColor();
};

const onPieceBoxDrop = (pieceType: PieceType, to: Square | Color) => {
  const position = props.position.clone();
  const key = pieceTypeToPieceBoxKey(pieceType);
  if (computePieceBoxCounts(position)[key] === 0) {
    clearInteraction();
    return;
  }
  if (to instanceof Square) {
    if (position.board.at(to)) {
      clearInteraction();
      return;
    }
    const color = pieceType === PieceType.KING ? getNewKingColor(position) : getNearSideColor();
    position.board.set(to, new Piece(color, pieceType));
  } else {
    if (pieceType === PieceType.KING) {
      clearInteraction();
      return;
    }
    position.hand(to).add(pieceType, 1);
  }
  updatePosition(position);
};

const onDropOutside = (source: Square | Piece, clientX: number, clientY: number) => {
  if (!pieceBoxRef.value?.containsPoint(clientX, clientY)) return;
  const position = props.position.clone();
  if (source instanceof Square) {
    if (!position.board.at(source)) return;
    position.board.remove(source);
  } else {
    if (source.type === PieceType.KING || position.hand(source.color).count(source.type) === 0) {
      return;
    }
    position.hand(source.color).reduce(source.type, 1);
  }
  updatePosition(position);
};

watch(() => props.position.sfen, clearInteraction);
watch(() => props.flip, clearInteraction);

onMounted(() => {
  const boardArea = boardAreaRef.value;
  if (!boardArea) return;
  resizeObserver = new ResizeObserver((entries) => {
    for (const entry of entries) {
      if (entry.contentRect.width <= 0 || entry.contentRect.height <= 0) continue;
      boardMaxSize.value = new RectSize(
        Math.floor(entry.contentRect.width),
        Math.floor(entry.contentRect.height),
      );
    }
  });
  resizeObserver.observe(boardArea);
});

onBeforeUnmount(() => {
  resizeObserver?.disconnect();
  resizeObserver = null;
});

defineExpose({ clearInteraction });
</script>

<style scoped>
.position-editor-core {
  position: relative;
  display: flex;
  flex: 1;
  flex-direction: column;
  gap: 8px;
  width: 100%;
  min-width: 0;
  min-height: 0;
}

.board-area {
  display: flex;
  flex: 1;
  align-items: flex-end;
  justify-content: center;
  min-width: 0;
  min-height: 0;
}

.piece-box-column {
  display: flex;
  flex: 0 0 auto;
  flex-direction: column;
  gap: 4px;
  align-items: center;
  min-width: 0;
}

.warning-message {
  flex: 0 0 auto;
  padding: 6px 10px;
  color: var(--warn-text-color, #856404);
  background-color: var(--warn-bg-color, #fff3cd);
  border: 1px solid var(--warn-border-color, #ffc107);
  font-size: 14px;
}
</style>
