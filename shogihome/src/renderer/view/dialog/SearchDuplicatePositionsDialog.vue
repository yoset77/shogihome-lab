<template>
  <DialogFrame limited @cancel="onCancel">
    <div class="title">{{ t.duplicatePositionSearch }}</div>
    <div class="form-group scroll">
      <div v-if="positions.length === 0">{{ t.noDuplicatePositions }}</div>
      <div v-else>{{ t.nDuplicatePositionsFound(positions.length) }}</div>
      <div class="row wrap space-evenly">
        <div
          v-for="entry of positions as DuplicatePositionEntry[]"
          :key="entry.sfen"
          class="row entry"
        >
          <SimpleBoardView
            class="board"
            :max-size="boardSize"
            :position="entry.position"
            :header="entry.turn"
          />
          <div class="column info">
            <div class="turn-label">{{ entry.turn }}</div>
            <div v-if="entry.minPly === entry.maxPly">
              {{ t.plyPrefix }}{{ entry.minPly }}{{ t.plySuffix }}
            </div>
            <div v-else>
              {{ t.fromPrefix }}
              {{ t.plyPrefix }}{{ entry.minPly }}{{ t.plySuffix }}
              {{ t.fromSuffix }}
              {{ t.toPrefix }}
              {{ t.plyPrefix }}{{ entry.maxPly }}{{ t.plySuffix }}
              {{ t.toSuffix }}
            </div>
            <div>{{ t.appearanceCount }}: {{ entry.count }}</div>
            <div>
              <button @click="showList(entry.sfen)">{{ t.showList }}</button>
            </div>
          </div>
        </div>
      </div>
    </div>
    <div class="main-buttons">
      <button data-hotkey="Escape" @click="onCancel">
        {{ t.cancel }}
      </button>
    </div>
    <DuplicatePositionsDialog
      v-if="duplicatePositionsDialog"
      :sfen="duplicatePositionsDialog"
      @select="changeNode"
      @close="duplicatePositionsDialog = ''"
    />
  </DialogFrame>
</template>

<script setup lang="ts">
import { useStore } from "@/renderer/store";
import DialogFrame from "@/renderer/view/dialog/DialogFrame.vue";
import { computed, ref } from "vue";
import { Color, ImmutableNode, ImmutablePosition, Position } from "tsshogi";
import { RectSize } from "@/common/assets/geometry";
import { t } from "@/common/i18n";
import DuplicatePositionsDialog from "./DuplicatePositionsDialog.vue";
import SimpleBoardView from "@/renderer/view/primitive/SimpleBoardView.vue";
import { isMobileWebApp } from "@/renderer/ipc/api";

const store = useStore();
const duplicatePositionsDialog = ref("");

const boardSize = computed(() =>
  isMobileWebApp() ? new RectSize(250, 250) : new RectSize(280, 280),
);

interface DuplicatePositionEntry {
  position: ImmutablePosition;
  minPly: number;
  maxPly: number;
  sfen: string;
  count: number;
  turn: string;
}

const positions = computed((): DuplicatePositionEntry[] => {
  const minPlyMap = new Map<string, number>();
  const maxPlyMap = new Map<string, number>();
  store.record.forEach((node) => {
    minPlyMap.set(node.sfen, Math.min(node.ply, minPlyMap.get(node.sfen) ?? Infinity));
    maxPlyMap.set(node.sfen, Math.max(node.ply, maxPlyMap.get(node.sfen) ?? 0));
  });
  return Array.from(store.positionCounts.entries())
    .map(([sfen, count]): DuplicatePositionEntry => {
      const position = Position.newBySFEN(sfen);
      const minPly = minPlyMap.get(sfen) ?? 0;
      const maxPly = maxPlyMap.get(sfen) ?? 0;
      const turn = position?.color === Color.BLACK ? t.sente : t.gote;
      return {
        position: position as ImmutablePosition,
        minPly,
        maxPly,
        sfen,
        count,
        turn,
      } as DuplicatePositionEntry;
    })
    .filter(({ position, count }) => !!position && count >= 2)
    .sort((a: DuplicatePositionEntry, b: DuplicatePositionEntry) => {
      if (a.count !== b.count) {
        return b.count - a.count;
      }
      if (a.minPly !== b.minPly) {
        return a.minPly - b.minPly;
      }
      return a.sfen.localeCompare(b.sfen);
    });
});

function showList(sfen: string) {
  duplicatePositionsDialog.value = sfen;
}

function changeNode(node: ImmutableNode) {
  store.destroyModalDialog();
  store.changeNode(node);
}

function onCancel() {
  store.destroyModalDialog();
}
</script>

<style scoped>
.scroll {
  max-height: calc(100vh - 200px);
  max-width: calc(100vw - 80px);
  overflow-y: auto;
  overflow-x: hidden;
}
.entry {
  align-items: start;
  margin: 10px 5px;
  padding: 10px;
  border: 1px solid var(--dialog-border-color);
  border-radius: 8px;
  background-color: var(--text-bg-color);
  color: var(--text-color);
}
.entry > .info {
  margin-left: 10px;
  min-width: 120px;
}
.entry > .info > * {
  align-items: start;
  text-align: left;
  margin-bottom: 4px;
}
.turn-label {
  font-weight: bold;
  border-bottom: 1px solid var(--dialog-border-color);
  margin-bottom: 8px;
  color: var(--text-color);
}

@media (max-width: 600px) {
  .scroll {
    max-width: calc(100vw - 40px);
  }
  .entry {
    flex-direction: column;
    align-items: center;
    width: 100%;
  }
  .entry > .info {
    margin-left: 0;
    margin-top: 10px;
    width: 100%;
    align-items: center;
  }
  .entry > .info > * {
    text-align: center;
    width: 100%;
  }
}
</style>
