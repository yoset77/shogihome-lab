<template>
  <div ref="rootEl" class="piece-box" @pointerdown="onRootPointerDown">
    <div class="piece-box-header">{{ t.pieceBox }}</div>
    <div class="piece-box-grid">
      <div
        v-for="pieceType in pieceTypes"
        :key="pieceType"
        class="piece-box-item"
        :class="{
          empty: getCount(pieceType) === 0,
          draggable: getCount(pieceType) > 0,
          selected: selection === pieceType,
        }"
        @pointerdown="onPointerDown($event, pieceType)"
      >
        <img :src="getPieceImagePath(pieceType)" :alt="pieceType" draggable="false" />
        <span class="piece-count">{{ getCount(pieceType) }}</span>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from "vue";
import { PieceType, Position, Piece, Color } from "tsshogi";
import { t } from "@/common/i18n";
import {
  computePieceBoxCounts,
  pieceTypeToPieceBoxKey,
  type PieceBoxCounts,
} from "@/common/game/pieceBox";
import { useAppSettings } from "@/renderer/store/settings";
import { getPieceImageURLTemplate } from "@/common/settings/app";
import { getPieceImageAssetName } from "@/common/assets/pieces";

const props = defineProps<{
  position: Position;
  acceptTapDrop?: boolean;
  selection?: PieceType | null;
}>();

const emit = defineEmits<{
  dragstart: [
    piece: Piece,
    pieceImagePath: string,
    pointerId: number,
    clientX: number,
    clientY: number,
  ];
  tapDrop: [];
}>();

const appSettings = useAppSettings();
const rootEl = ref<HTMLElement | null>(null);

const pieceTypes = [
  PieceType.ROOK,
  PieceType.BISHOP,
  PieceType.GOLD,
  PieceType.SILVER,
  PieceType.KNIGHT,
  PieceType.LANCE,
  PieceType.PAWN,
  PieceType.KING,
];

const pieceBoxCounts = computed<PieceBoxCounts>(() => {
  return computePieceBoxCounts(props.position);
});

const getCount = (pieceType: PieceType): number => {
  const key = pieceTypeToPieceBoxKey(pieceType);
  return pieceBoxCounts.value[key];
};

const getPieceImagePath = (pieceType: PieceType): string => {
  const template = getPieceImageURLTemplate(appSettings);
  const assetName = getPieceImageAssetName(Color.BLACK, pieceType);
  return template.replace("${piece}", assetName);
};

const onPointerDown = (e: PointerEvent, pieceType: PieceType) => {
  if (e.button !== 0) return;
  if (props.acceptTapDrop) {
    e.preventDefault();
    e.stopPropagation();
    emit("tapDrop");
    return;
  }
  if (getCount(pieceType) === 0) return;
  e.preventDefault();
  e.stopPropagation();
  const piece = new Piece(props.position.color, pieceType);
  const imagePath = getPieceImagePath(pieceType);
  emit("dragstart", piece, imagePath, e.pointerId, e.clientX, e.clientY);
};

const onRootPointerDown = (e: PointerEvent) => {
  if (e.button !== 0) return;
  if (!props.acceptTapDrop) return;
  e.preventDefault();
  e.stopPropagation();
  emit("tapDrop");
};

const containsPoint = (clientX: number, clientY: number): boolean => {
  const rect = rootEl.value?.getBoundingClientRect();
  if (!rect) return false;
  return (
    clientX >= rect.left && clientX <= rect.right && clientY >= rect.top && clientY <= rect.bottom
  );
};

defineExpose({ containsPoint });
</script>

<style scoped>
.piece-box {
  display: flex;
  flex-direction: column;
  gap: 4px;
  box-sizing: border-box;
  padding: 4px;
  max-width: 100%;
  background: var(--main-bg-color);
  border: 1px solid var(--main-color);
}

.piece-box-header {
  font-size: 14px;
  font-weight: bold;
  text-align: center;
}

.piece-box-grid {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  justify-content: center;
}

.piece-box-item {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 2px;
  padding: 2px;
  min-width: 48px;
  touch-action: none;
}

.piece-box-item.empty {
  opacity: 0.3;
}

.piece-box-item.draggable {
  cursor: grab;
}

.piece-box-item.selected {
  background-color: var(--main-color);
  border-radius: 4px;
}

.piece-box-item.selected .piece-count {
  color: var(--control-button-color);
}

.piece-box-item img {
  width: 40px;
  height: 40px;
}

.piece-count {
  font-size: 12px;
  font-weight: bold;
}
</style>
