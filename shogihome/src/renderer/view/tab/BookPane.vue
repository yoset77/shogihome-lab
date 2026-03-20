<template>
  <div
    class="full column book-tab-content"
    :style="{ width: `${size.width}px`, height: `${size.height}px` }"
  >
    <div v-if="bookStore.path" class="column full">
      <div class="row book-header">
        <div class="book-path grow">{{ bookStore.path }}</div>
        <div class="row header-controls">
          <button class="thin" @click="isMenuVisible = true">
            {{ t.edit }}
          </button>
        </div>
      </div>
      <BookView
        style="flex: 1; min-height: 0"
        :position="store.record.position"
        :moves="bookStore.moves"
        :playable="store.isMovableByUser"
        :editable="bookEditable"
        @play="onPlayBookMove"
        @edit="editBookMove"
        @remove="removeBookMove"
        @order="updateBookMoveOrder"
      />
      <BookMoveDialog
        v-if="editingData"
        :move="editingData.move"
        :score="editingData.score"
        :depth="editingData.depth"
        :count="editingData.count"
        :comment="editingData.comment"
        @ok="onEditBookMove"
        @cancel="onCancelEditBookMove"
      />
      <BookMenu
        v-if="isMenuVisible"
        :is-book-operational="isBookOperational"
        :flipped-book="appSettings.flippedBook"
        @close="isMenuVisible = false"
        @open="onOpenBook"
        @save-as="onSaveBook"
        @add-moves="onAddBookMoves"
        @clear="onResetBook"
        @toggle-flipped-book="onUpdateFlippedBook(!appSettings.flippedBook)"
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
import { BookMove } from "@/common/book";
import { RectSize } from "@/common/assets/geometry";
import { AppState } from "@/common/control/state";
import { t } from "@/common/i18n";
import { humanPlayer } from "@/renderer/players/human";
import { useStore } from "@/renderer/store";
import { useBookStore } from "@/renderer/store/book";
import BookView from "@/renderer/view/primitive/BookView.vue";
import { formatMove, Move } from "tsshogi";
import { computed, ref } from "vue";
import BookMoveDialog, { Result as EditResult } from "@/renderer/view/dialog/BookMoveDialog.vue";
import { useConfirmationStore } from "@/renderer/store/confirm";
import { useErrorStore } from "@/renderer/store/error";
import { useAppSettings } from "@/renderer/store/settings";
import BookMenu from "@/renderer/view/menu/BookMenu.vue";

defineProps({
  size: {
    type: RectSize,
    required: true,
  },
});

const store = useStore();
const bookStore = useBookStore();
const appSettings = useAppSettings();

const isBookOperational = computed(() => store.appState === AppState.NORMAL);
const bookEditable = computed(() => true);
const editingData = ref<
  BookMove & {
    sfen: string;
    move: string;
  }
>();
const isMenuVisible = ref(false);

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

const onSaveBook = () => {
  bookStore.saveBookFileAs();
};

const onAddBookMoves = () => {
  store.showAddBookMovesDialog();
};

const onUpdateFlippedBook = (value: boolean) => {
  appSettings.updateAppSettings({ flippedBook: value }).then(() => {
    bookStore.reloadBookMoves();
  });
};

const editBookMove = (move: Move) => {
  const target = bookStore.moves.find((bm) => bm.usi === move.usi);
  if (!target) {
    return;
  }
  editingData.value = {
    sfen: store.record.position.sfen,
    move: formatMove(store.record.position, move),
    ...target,
  };
};

const removeBookMove = (move: Move) => {
  const sfen = store.record.position.sfen;
  const name = formatMove(store.record.position, move);
  useConfirmationStore().show({
    message: t.doYouReallyWantToRemoveBookMove(name),
    onOk: () => {
      bookStore.removeMove(sfen, move.usi);
    },
  });
};

const updateBookMoveOrder = (move: Move, order: number) => {
  bookStore.updateMoveOrder(store.record.position.sfen, move.usi, order);
};

const onEditBookMove = async (data: EditResult) => {
  if (!editingData.value) {
    return;
  }
  try {
    await bookStore.updateMove(editingData.value.sfen, {
      usi: editingData.value.usi,
      ...data,
    });
    editingData.value = undefined;
  } catch (e) {
    useErrorStore().add(e);
  }
};

const onCancelEditBookMove = () => {
  editingData.value = undefined;
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

.header-controls {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  gap: 4px;
}

.header-controls > button {
  white-space: nowrap;
}
</style>
