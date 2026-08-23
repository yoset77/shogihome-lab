<template>
  <div>
    <div class="full column">
      <div v-if="bookStore.books.length === 0" class="book-area">
        <BookView
          class="book-list"
          :position="store.record.position"
          :moves="bookStore.moves"
          :path="bookStore.path"
          :format="bookStore.format"
          :playable="store.isMovableByUser"
          :editable="bookEditable"
          @play="playBookMove"
          @edit="editBookMove"
          @remove="removeBookMove"
          @order="updateBookMoveOrder"
        />
      </div>
      <div v-else class="book-columns">
        <BookComparisonColumn
          v-for="book in bookStore.books"
          :key="book.sessionId"
          :book="book"
          :active="book.sessionId === bookStore.activeBookId"
          @activate="bookStore.setActiveBook($event)"
          @close="bookStore.closeBook($event)"
          @play="playBookMove"
          @edit="editBookMove"
          @remove="removeBookMove"
          @order="updateBookMoveOrder"
        />
      </div>
      <div class="row control">
        <button @click="onResetBook">{{ t.clear }}</button>
        <button @click="onOpenBook">{{ t.open }}</button>
        <button :disabled="!isBookOperational" @click="onSaveBook">{{ t.saveAs }}</button>
        <button :disabled="!isBookOperational" @click="onAddBookMoves">{{ t.addMoves }}</button>
        <ToggleButton
          :value="appSettings.flippedBook"
          :label="t.flippedBook"
          @update:value="onUpdateFlippedBook"
        />
      </div>
      <BookMoveDialog
        v-if="editingData"
        :move="editingData.move"
        :score="editingData.score"
        :depth="editingData.depth"
        :count="editingData.count"
        :comment="editingData.comment"
        :evaluation="editingData.evaluation"
        :format="editingData.format"
        :book-path="editingData.bookPath"
        @ok="onEditBookMove"
        @cancel="onCancelEditBookMove"
      />
    </div>
  </div>
</template>

<script setup lang="ts">
import { BookFormat, BookMove } from "@/common/book";
import { AppState } from "@/common/control/state";
import { useStore } from "@/renderer/store";
import { useBookStore } from "@/renderer/store/book";
import { computed, ref } from "vue";
import BookMoveDialog, { Result as EditResult } from "@/renderer/view/dialog/BookMoveDialog.vue";
import { formatMove, Move } from "tsshogi";
import { humanPlayer } from "@/renderer/players/human";
import { t } from "@/common/i18n";
import { useConfirmationStore } from "@/renderer/store/confirm";
import BookView from "@/renderer/view/primitive/BookView.vue";
import { useErrorStore } from "@/renderer/store/error";
import ToggleButton from "@/renderer/view/primitive/ToggleButton.vue";
import { useAppSettings } from "@/renderer/store/settings";
import BookComparisonColumn from "./BookComparisonColumn.vue";

const store = useStore();
const bookStore = useBookStore();
const appSettings = useAppSettings();

const isBookOperational = computed(() => store.appState === AppState.NORMAL);
const bookEditable = computed(() => true);
const editingData = ref<
  BookMove & {
    sfen: string;
    move: string;
    bookId?: string;
    bookPath?: string;
    format: BookFormat;
  }
>();

const onResetBook = () => {
  bookStore.reset();
};

const onOpenBook = () => {
  bookStore.openBookFile();
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

const playBookMove = (move: Move) => {
  if (store.appState === AppState.GAME) {
    humanPlayer.doMove(move);
  } else {
    store.doMove(move);
  }
};

const editBookMove = (move: Move) => {
  const target = bookStore.moves.find((bm) => bm.usi === move.usi);
  if (!target) {
    return;
  }
  editingData.value = {
    sfen: store.record.position.sfen,
    move: formatMove(store.record.position, move),
    bookId: bookStore.activeBookId,
    bookPath: bookStore.path,
    format: bookStore.format,
    ...target,
  };
};

const removeBookMove = (move: Move) => {
  const sfen = store.record.position.sfen;
  const bookId = bookStore.activeBookId;
  const name = formatMove(store.record.position, move);
  useConfirmationStore().show({
    message: t.doYouReallyWantToRemoveBookMove(name),
    onOk: () => {
      bookStore.removeMove(sfen, move.usi, bookId);
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
    await bookStore.updateMove(
      editingData.value.sfen,
      {
        usi: editingData.value.usi,
        ...data,
      },
      editingData.value.bookId,
    );
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
.control > button {
  height: 25px;
  font-size: 14px;
  padding: 0 1em;
  white-space: nowrap;
  overflow: hidden;
}
.control > button:not(:first-child) {
  margin-left: 2px;
}
.control > :not(:first-child) {
  margin-left: 8px;
}
.book-area {
  height: calc(100% - 27px);
  margin-bottom: 2px;
}
.book-list {
  height: 100%;
}
.book-columns {
  display: flex;
  height: calc(100% - 27px);
  margin-bottom: 2px;
  min-height: 0;
  gap: 4px;
}
</style>
