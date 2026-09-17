<template>
  <Teleport to="body">
    <div
      class="branch-popup-overlay"
      @pointerdown="emit('close')"
      @contextmenu.prevent="emit('close')"
    ></div>
    <div
      ref="popup"
      class="branch-popup"
      :style="{ left: `${adjustedX}px`, top: `${adjustedY}px` }"
      @pointerdown.stop
      @contextmenu.prevent
    >
      <div
        v-for="branch in branches"
        :key="branch.branchIndex"
        class="row move-element"
        @click="emit('select', branch)"
      >
        <div class="check">{{ branch.branchIndex === selectedBranchIndex ? "✓" : "" }}</div>
        <div class="move-text">{{ branch.displayText }}</div>
        <div v-if="showComment" class="move-comment">
          <span v-if="branch.bookmark" class="bookmark">{{ branch.bookmark }}</span>
          {{ branch.comment }}
        </div>
      </div>
    </div>
  </Teleport>
</template>

<script setup lang="ts">
import { ImmutableNode } from "tsshogi";
import { computed, onBeforeUnmount, onMounted, PropType, ref } from "vue";

const props = defineProps({
  branches: {
    type: Array as PropType<ImmutableNode[]>,
    required: true,
  },
  selectedBranchIndex: {
    type: Number,
    required: true,
  },
  x: {
    type: Number,
    required: true,
  },
  y: {
    type: Number,
    required: true,
  },
  showComment: {
    type: Boolean,
    required: false,
    default: false,
  },
});

const emit = defineEmits<{
  select: [node: ImmutableNode];
  close: [];
}>();

const popup = ref(null as HTMLDivElement | null);
const popupSize = ref({ width: 220, height: 200 });
const scrollListenerOptions = { capture: true, passive: true } as const;

onMounted(() => {
  const rect = popup.value?.getBoundingClientRect();
  if (rect) {
    popupSize.value = { width: rect.width, height: rect.height };
  }
  window.addEventListener("keydown", onKeyDown);
  window.addEventListener("scroll", onScroll, scrollListenerOptions);
  window.addEventListener("resize", onClose);
});

onBeforeUnmount(() => {
  window.removeEventListener("keydown", onKeyDown);
  window.removeEventListener("scroll", onScroll, scrollListenerOptions);
  window.removeEventListener("resize", onClose);
});

const onKeyDown = (event: KeyboardEvent) => {
  if (event.key === "Escape") {
    emit("close");
  }
};

const onScroll = (event: Event) => {
  // Ignore scrolls inside the popup itself.
  if (popup.value?.contains(event.target as Node)) {
    return;
  }
  emit("close");
};

const onClose = () => {
  emit("close");
};

const adjustedX = computed(() => {
  return Math.max(0, Math.min(props.x, window.innerWidth - popupSize.value.width - 4));
});

const adjustedY = computed(() => {
  return Math.max(0, Math.min(props.y, window.innerHeight - popupSize.value.height - 4));
});
</script>

<style scoped>
.branch-popup-overlay {
  position: fixed;
  top: 0;
  left: 0;
  width: 100vw;
  height: 100vh;
  z-index: 1000;
}
.branch-popup {
  position: fixed;
  z-index: 1001;
  min-width: 160px;
  max-width: 256px;
  max-height: 240px;
  overflow-x: hidden;
  overflow-y: auto;
  color: var(--text-color);
  background-color: var(--text-bg-color);
  border: 1px solid var(--text-separator-color);
  border-radius: 4px;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3);
  padding: 2px 0;
  user-select: none;
}
.move-element {
  height: 1.4em;
  width: 100%;
  line-height: 1.4em;
  font-size: 0.85em;
  display: flex;
}
.move-element:hover {
  background-color: var(--text-bg-color-selected);
}
.check {
  min-width: 1.2em;
  height: 100%;
  padding-left: 4px;
  text-align: center;
  vertical-align: baseline;
  white-space: nowrap;
  overflow: hidden;
}
.move-text {
  min-width: 80px;
  height: 100%;
  padding-right: 5px;
  padding-left: 8px;
  text-align: left;
  vertical-align: baseline;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: clip;
}
.move-comment {
  height: 100%;
  padding-right: 8px;
  text-align: left;
  vertical-align: baseline;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.bookmark {
  display: inline-block;
  height: 100%;
  color: var(--main-color);
  background-color: var(--main-bg-color);
  padding-left: 5px;
  padding-right: 5px;
  box-sizing: border-box;
  border: 1px solid var(--text-separator-color);
  border-radius: 5px;
}
</style>
