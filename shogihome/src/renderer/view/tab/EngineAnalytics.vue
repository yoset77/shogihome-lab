<template>
  <div>
    <div class="full column element-list">
      <EngineAnalyticsElement
        v-for="monitor in monitors"
        :key="monitor.sessionID"
        :history-mode="historyMode"
        :monitor="monitor"
        :height="elementHeight"
        :mobile-layout="mobileLayout"
        :show-header="showHeader"
        :show-time-column="showTimeColumn"
        :show-multi-pv-column="showMultiPvColumn"
        :show-depth-column="showDepthColumn"
        :show-nodes-column="showNodesColumn"
        :show-score-column="showScoreColumn"
        :show-play-button="showPlayButton"
        :show-suggestions-count="showSuggestionsCount"
      />
    </div>
  </div>
</template>

<script setup lang="ts">
import { useStore } from "@/renderer/store";
import { computed } from "vue";
import EngineAnalyticsElement from "@/renderer/view/tab/EngineAnalyticsElement.vue";
import { RectSize } from "@/common/assets/geometry.js";
import { USIPlayerMonitor } from "@/renderer/store/usi";

const emptyMonitor = new USIPlayerMonitor(0, "");

const props = defineProps({
  size: { type: RectSize, required: true },
  historyMode: { type: Boolean, required: true },
  mobileLayout: { type: Boolean, default: false },
  showHeader: { type: Boolean, default: true },
  showTimeColumn: { type: Boolean, default: true },
  showMultiPvColumn: { type: Boolean, default: true },
  showDepthColumn: { type: Boolean, default: true },
  showNodesColumn: { type: Boolean, default: true },
  showScoreColumn: { type: Boolean, default: true },
  showPlayButton: { type: Boolean, default: true },
  showSuggestionsCount: { type: Boolean, default: true },
});

const store = useStore();

const monitors = computed(() => {
  if (store.usiMonitors.length === 0) {
    return [emptyMonitor];
  }
  return store.usiMonitors;
});

const elementHeight = computed(() => {
  const rows = monitors.value.length;
  // Keep a 2px gap between stacked elements as a separator.
  return (props.size.height - 2 * (rows - 1)) / (rows || 1);
});
</script>

<style scoped>
.element-list {
  gap: 2px;
}
</style>
