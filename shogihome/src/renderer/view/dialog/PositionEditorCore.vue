<template>
  <div class="position-editor-core">
    <div v-if="hasViolation" class="warning-message">
      {{ t.pieceCountExceeded }}
    </div>
    <div ref="editorAreaRef" class="editor-area" :style="editorLayout.areaStyle">
      <div class="editor-layout" :class="{ pending: !availableSize }" :style="editorLayout.style">
        <BoardView
          :layout-type="layoutType"
          :board-image-type="appSettings.boardImage"
          :board-image-opacity="appSettings.enableTransparent ? appSettings.boardOpacity : 1"
          :board-grid-color="appSettings.boardGridColor || undefined"
          :piece-stand-image-type="appSettings.pieceStandImage"
          :piece-stand-image-opacity="
            appSettings.enableTransparent ? appSettings.pieceStandOpacity : 1
          "
          :promotion-selector-style="appSettings.promotionSelectorStyle"
          :board-label-type="appSettings.boardLabelType"
          :piece-image-url-template="getPieceImageURLTemplate(appSettings)"
          :king-piece-type="appSettings.kingPieceType"
          :max-size="editorLayout.boardSize"
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
        <PieceBox
          ref="pieceBoxRef"
          :position="position"
          :scale="editorLayout.scale"
          :mobile="mobile"
          :accept-tap-drop="editSelection !== null"
          :selection="pieceBoxSelection"
          @dragstart="onPieceBoxDragStart"
          @tap-drop="onPieceBoxTapDrop"
        />
      </div>
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
import { pieceBoxSize } from "@/renderer/view/primitive/pieceBoxLayout";
import { portraitViewParams, standardViewParams } from "@/renderer/view/primitive/board/params";

const EDITOR_GAP = 8;

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
const editorAreaRef = ref<HTMLElement | null>(null);
const pieceBoxRef = ref<PieceBoxExpose | null>(null);
const availableSize = shallowRef<RectSize | null>(null);
const externalDrag = ref<ExternalDrag | null>(null);
const pieceBoxSelection = ref<PieceType | null>(null);
const editSelection = shallowRef<Square | Piece | null>(null);
const hasViolation = computed(() => detectPieceCountViolations(props.position).length > 0);
const editorLayout = computed(() => {
  const frame =
    props.layoutType === BoardLayoutType.PORTRAIT
      ? portraitViewParams.frame
      : standardViewParams.frame;
  const boardRatio = Math.min(800 / frame.width, 600 / frame.height);
  const boardWidth = frame.width * boardRatio;
  const boardHeight = frame.height * boardRatio;
  const width = Math.max(boardWidth, pieceBoxSize.width);
  const height = boardHeight + EDITOR_GAP + pieceBoxSize.height;
  const scale = availableSize.value
    ? Math.min(availableSize.value.width / width, availableSize.value.height / height)
    : 1;
  return {
    scale,
    boardSize: new RectSize(boardWidth * scale, boardHeight * scale),
    areaStyle: {
      aspectRatio: `${width} / ${height}`,
    },
    style: {
      width: `${width * scale}px`,
      height: `${height * scale}px`,
      gap: `${EDITOR_GAP * scale}px`,
    },
  };
});
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

const onEdit = (changes: PositionChange[]) => {
  const position = props.position.clone();
  for (const change of changes) {
    position.edit(change);
  }
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
  const editorArea = editorAreaRef.value;
  if (!editorArea) return;
  resizeObserver = new ResizeObserver((entries) => {
    for (const entry of entries) {
      if (entry.contentRect.width <= 0 || entry.contentRect.height <= 0) continue;
      const size = new RectSize(entry.contentRect.width, entry.contentRect.height);
      if (!availableSize.value?.equals(size)) availableSize.value = size;
    }
  });
  resizeObserver.observe(editorArea);
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

.editor-area {
  position: relative;
  flex: 1;
  width: 100%;
  min-width: 0;
  min-height: 0;
}

.editor-layout {
  /* Keep the measured area's size independent of its contents. */
  position: absolute;
  bottom: 0;
  left: 50%;
  transform: translateX(-50%);
  display: flex;
  flex-direction: column;
  align-items: center;
}

.editor-layout > * {
  flex: 0 0 auto;
}

.editor-layout.pending {
  display: none;
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
