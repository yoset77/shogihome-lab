<template>
  <div
    class="full column book-tab-content"
    :style="{ width: `${size.width}px`, height: `${size.height}px` }"
  >
    <div v-if="bookStore.path" class="column full">
      <div class="row book-header">
        <div class="book-path grow">{{ bookStore.path }}</div>
        <button class="thin" @click="onResetBook">{{ t.clear }}</button>
      </div>
      <BookView
        style="flex: 1; min-height: 0"
        :position="store.record.position"
        :moves="bookStore.moves"
        :playable="store.isMovableByUser"
        :editable="false"
        @play="onPlayBookMove"
      />
    </div>
    <div
      v-else
      class="full row center"
      style="display: flex; align-items: center; justify-content: center"
    >
      <button class="thin" @click="onOpenBook">{{ t.openBook }}</button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { RectSize } from "@/common/assets/geometry";
import { AppState } from "@/common/control/state";
import { t } from "@/common/i18n";
import { humanPlayer } from "@/renderer/players/human";
import { useStore } from "@/renderer/store";
import { useBookStore } from "@/renderer/store/book";
import BookView from "@/renderer/view/primitive/BookView.vue";
import { Move } from "tsshogi";

defineProps({
  size: {
    type: RectSize,
    required: true,
  },
});

const store = useStore();
const bookStore = useBookStore();

const onPlayBookMove = (move: Move) => {
  if (store.appState === AppState.GAME || store.appState === AppState.CSA_GAME) {
    humanPlayer.doMove(move);
  } else {
    store.doMove(move);
  }
};

const onOpenBook = () => {
  bookStore.openBookFile();
};

const onResetBook = () => {
  bookStore.reset();
};
</script>

<style scoped>
.book-tab-content {
  overflow: hidden;
  background-color: var(--text-bg-color);
}

.book-header {
  padding: 5px;
  background-color: var(--text-bg-color);
  border-bottom: 1px solid var(--text-separator-color);
  align-items: center;
}

.book-path {
  font-size: 0.9em;
  font-weight: bold;
  color: var(--text-color);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  margin-right: 10px;
}
</style>
