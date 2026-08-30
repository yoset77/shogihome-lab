<template>
  <section class="column book-column" :class="{ active }" @click.capture="activate">
    <header class="row column-header" :title="book.path || t.newBook">
      <span class="grow path">{{ book.path || t.newBook }}</span>
      <button class="thin" :disabled="book.closing" @click.stop="onClose">&#x2715;</button>
    </header>
    <BookView
      class="book-view"
      :position="store.record.position"
      :moves="book.moves"
      :format="book.format"
      :playable="store.isMovableByUser && !book.closing"
      :editable="!book.closing"
      @play="onPlay"
      @edit="onEdit"
      @remove="onRemove"
      @order="onOrder"
    />
  </section>
</template>

<script setup lang="ts">
import { t } from "@/common/i18n";
import { useStore } from "@/renderer/store";
import { BookSession } from "@/renderer/store/book";
import BookView from "@/renderer/view/primitive/BookView.vue";
import { Move } from "tsshogi";

const props = defineProps<{
  book: BookSession;
  active: boolean;
}>();

const emit = defineEmits<{
  activate: [sessionId?: string];
  close: [sessionId?: string];
  play: [move: Move];
  edit: [book: BookSession, move: Move];
  remove: [book: BookSession, move: Move];
  order: [book: BookSession, move: Move, order: number];
}>();

const store = useStore();

const activate = (event?: MouseEvent) => {
  if (event?.target instanceof Element && event.target.closest(".column-header button")) {
    return;
  }
  if (!props.book.closing) {
    emit("activate", props.book.sessionId);
  }
};

const onClose = () => {
  emit("close", props.book.sessionId);
};

const onPlay = (move: Move) => {
  activate();
  emit("play", move);
};

const onEdit = (move: Move) => {
  activate();
  emit("edit", props.book, move);
};

const onRemove = (move: Move) => {
  activate();
  emit("remove", props.book, move);
};

const onOrder = (move: Move, order: number) => {
  activate();
  emit("order", props.book, move, order);
};
</script>

<style scoped>
.book-column {
  flex: 1 1 0;
  min-width: 0;
  min-height: 0;
  background-color: var(--text-bg-color);
  border: 2px solid transparent;
}
.book-column.active {
  border-color: var(--text-dashed-separator-color);
}
.column-header {
  gap: 3px;
  min-width: 0;
  padding: 3px;
  border-bottom: 1px solid var(--text-separator-color);
  align-items: center;
}
.path {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-weight: bold;
  font-size: 0.9em;
  color: var(--text-color);
  text-align: left;
}
.book-view {
  flex: 1;
  min-height: 0;
}
</style>
