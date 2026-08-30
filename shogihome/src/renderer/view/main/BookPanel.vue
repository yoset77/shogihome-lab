<template>
  <div>
    <div class="full column">
      <div v-if="bookStore.hasActiveBook" class="book-columns">
        <BookComparisonColumn
          v-for="book in bookStore.books"
          :key="book.sessionId"
          :book="book"
          :active="book.sessionId === bookStore.activeBookId"
          @activate="onActivateBook"
          @close="onCloseBook"
          @play="playBookMove"
          @edit="editBookMove"
          @remove="removeBookMove"
          @order="updateBookMoveOrder"
        />
        <BookComparisonColumn
          v-if="bookStore.isNewBookOpen"
          :book="bookStore.newBook"
          :active="!bookStore.activeBookId"
          @activate="onActivateBook"
          @close="onCloseBook"
          @play="playBookMove"
          @edit="editBookMove"
          @remove="removeBookMove"
          @order="updateBookMoveOrder"
        />
      </div>
      <div v-else class="book-area empty">
        <div class="empty-message">{{ t.noBookSelected }}</div>
      </div>
      <div class="row control">
        <button :disabled="!bookStore.hasActiveBook" @click="onResetBook">{{ t.clear }}</button>
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
import { BookSession, useBookStore } from "@/renderer/store/book";
import { computed, ref } from "vue";
import BookMoveDialog, { Result as EditResult } from "@/renderer/view/dialog/BookMoveDialog.vue";
import { formatMove, Move } from "tsshogi";
import { humanPlayer } from "@/renderer/players/human";
import { t } from "@/common/i18n";
import { useConfirmationStore } from "@/renderer/store/confirm";
import { useErrorStore } from "@/renderer/store/error";
import ToggleButton from "@/renderer/view/primitive/ToggleButton.vue";
import { useAppSettings } from "@/renderer/store/settings";
import BookComparisonColumn from "./BookComparisonColumn.vue";

const store = useStore();
const bookStore = useBookStore();
const appSettings = useAppSettings();

const isBookOperational = computed(
  () => store.appState === AppState.NORMAL && bookStore.hasActiveBook,
);
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

const onActivateBook = (sessionId?: string) => {
  if (sessionId) {
    bookStore.setActiveBook(sessionId);
  } else {
    bookStore.activateNewBook();
  }
};

const onCloseBook = (sessionId?: string) => {
  if (sessionId) {
    bookStore.closeBook(sessionId);
  } else {
    bookStore.closeNewBook();
  }
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

const editBookMove = (book: BookSession, move: Move) => {
  const target = book.moves.find((bm) => bm.usi === move.usi);
  if (!target) {
    return;
  }
  editingData.value = {
    sfen: store.record.position.sfen,
    move: formatMove(store.record.position, move),
    bookId: book.sessionId,
    bookPath: book.path,
    format: book.format,
    ...target,
  };
};

const removeBookMove = (book: BookSession, move: Move) => {
  const sfen = store.record.position.sfen;
  const name = formatMove(store.record.position, move);
  useConfirmationStore().show({
    message: t.doYouReallyWantToRemoveBookMove(name),
    onOk: () => {
      bookStore.removeMove(sfen, move.usi, book.sessionId);
    },
  });
};

const updateBookMoveOrder = (book: BookSession, move: Move, order: number) => {
  bookStore.updateMoveOrder(store.record.position.sfen, move.usi, order, book.sessionId);
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
.book-area.empty {
  display: flex;
  align-items: center;
  justify-content: center;
  background-color: var(--text-bg-color);
}
.empty-message {
  font-size: 0.9em;
  color: var(--text-color);
  opacity: 0.5;
  user-select: none;
}
</style>
