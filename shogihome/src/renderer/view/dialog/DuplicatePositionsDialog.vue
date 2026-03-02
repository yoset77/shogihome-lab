<template>
  <DialogFrame limited @cancel="onCancel">
    <div class="title">{{ t.duplicatePositions }}</div>
    <div class="frame form-group list-area">
      <div
        v-for="(position, pi) of positions"
        :key="pi"
        class="entry-card"
        :class="{ active: position.active }"
      >
        <div class="entry-header">
          <div class="entry-no">#{{ pi + 1 }}</div>
          <div class="entry-action">
            <span v-if="position.active" class="current-label">{{ t.currentPosition }}</span>
            <button v-else class="go-button" @click="emit('select', position.node)">
              {{ t.goToThisPosition }}
            </button>
          </div>
        </div>
        <div class="entry-body">
          <div class="main-info">
            <div class="label">{{ t.lastMove }}</div>
            <div class="value last-move">{{ position.lastMove }}</div>
          </div>
          <div v-if="position.variation.length > 0" class="sub-info">
            <div class="label">{{ t.via }}</div>
            <div class="variation-path">
              <span v-for="(variation, vi) of position.variation" :key="vi" class="path-item">
                {{ variation }}
              </span>
            </div>
          </div>
          <div v-if="position.nextMoves.length > 0" class="sub-info">
            <div class="label">{{ t.nextMoves }}</div>
            <div class="next-moves-list">
              <span v-for="(nextMove, ni) of position.nextMoves" :key="ni" class="next-move-item">
                {{ nextMove }}
              </span>
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
  </DialogFrame>
</template>

<script setup lang="ts">
import { computed } from "vue";
import DialogFrame from "./DialogFrame.vue";
import { useStore } from "@/renderer/store";
import { t } from "@/common/i18n";
import { ImmutableNode } from "tsshogi";

const props = defineProps({
  sfen: {
    type: String,
    required: true,
  },
});

const emit = defineEmits<{
  select: [node: ImmutableNode];
  close: [];
}>();

const store = useStore();

const positions = computed(() => {
  const positions: {
    lastMove: string;
    variation: string[];
    nextMoves: string[];
    active: boolean;
    node: ImmutableNode;
  }[] = [];
  store.record.forEach((node) => {
    if (node.sfen !== props.sfen) {
      return;
    }
    const lastMove = `${t.plyPrefix}${node.ply}${t.plySuffix} ${node.displayText}`;
    const variation: string[] = [];
    for (let p = node.prev; p; p = p.prev) {
      if (p.hasBranch) {
        variation.unshift(`${t.plyPrefix}${p.ply}${t.plySuffix} ${p.displayText}`);
      }
    }
    const nextMoves: string[] = [];
    for (let branch = node.next; branch; branch = branch.branch) {
      nextMoves.push(branch.displayText);
    }
    const active = node === store.record.current;
    positions.push({ lastMove, variation, nextMoves, active, node });
  });
  return positions;
});

function onCancel() {
  emit("close");
}
</script>

<style scoped>
.frame {
  width: 460px;
  max-width: 80vw;
  min-height: 100px;
}
.list-area {
  overflow-y: auto;
  max-height: 60vh;
  padding: 4px;
}
.entry-card {
  border: 1px solid var(--dialog-border-color);
  border-radius: 8px;
  margin-bottom: 12px;
  background-color: var(--text-bg-color);
  color: var(--dialog-color);
  box-sizing: border-box;
  width: 100%;
  overflow: hidden;
}
.entry-card.active {
  border-color: var(--pushed-selector-bg-color);
  box-shadow: 0 0 4px var(--pushed-selector-bg-color);
}
.entry-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 8px 12px;
  background-color: var(--selector-bg-color);
  border-bottom: 1px solid var(--dialog-border-color);
}
.entry-no {
  font-weight: bold;
  opacity: 0.7;
}
.current-label {
  font-weight: bold;
  color: var(--pushed-selector-bg-color);
  font-size: 0.9em;
}
.go-button {
  padding: 2px 10px;
  font-size: 0.85em;
}
.entry-body {
  padding: 12px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.main-info {
  display: flex;
  align-items: baseline;
  gap: 12px;
}
.sub-info {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.label {
  font-size: 0.75em;
  color: var(--text-separator-color);
  text-transform: uppercase;
  letter-spacing: 0.05em;
}
.value {
  font-size: 0.95em;
}
.last-move {
  font-weight: bold;
  font-size: 1.1em;
}
.variation-path {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  font-size: 0.85em;
}
.path-item:not(:last-child)::after {
  content: " >";
  margin-left: 4px;
  opacity: 0.5;
}
.next-moves-list {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.next-move-item {
  background-color: var(--selector-bg-color);
  padding: 1px 6px;
  border-radius: 4px;
  border: 1px solid var(--dialog-border-color);
  font-size: 0.85em;
}

@media (max-width: 600px) {
  .frame {
    width: 85vw;
    max-width: 100%;
  }
  .entry-body {
    padding: 10px;
  }
  .main-info {
    flex-direction: column;
    gap: 2px;
  }
}
</style>
