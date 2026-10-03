<template>
  <div class="full column" style="overflow: hidden">
    <BoardPane
      :max-size="boardPaneMaxSize"
      :layout-type="boardLayoutType"
      style="flex-shrink: 0"
      @resize="onBoardPaneResize"
    />
    <MobileControls
      v-if="!isEvaluationPuzzle"
      :style="{ height: `${controlPaneHeight}px`, flexShrink: 0 }"
    />
    <PuzzlePane
      v-if="isEvaluationPuzzle"
      :style="{
        height: `${puzzlePaneHeight}px`,
        flexShrink: 0,
      }"
    />
    <RecordPane
      v-show="bottomUIType === BottomUIType.RECORD && !isEvaluationPuzzle"
      :style="{
        width: `${windowSize.width}px`,
        height: `${bottomViewSize.height}px`,
        flexShrink: 0,
      }"
      :show-top-control="false"
      :show-bottom-control="false"
      :show-elapsed-time="true"
      :show-comment="true"
    />
    <RecordComment
      v-show="bottomUIType === BottomUIType.COMMENT && !isEvaluationPuzzle"
      class="bottom-element"
      :style="{
        width: `${windowSize.width}px`,
        height: `${bottomViewSize.height}px`,
        flexShrink: 0,
      }"
    />
    <RecordInfo
      v-show="bottomUIType === BottomUIType.INFO && !isEvaluationPuzzle"
      :style="{ flexShrink: 0 }"
      :size="bottomViewSize"
    />
    <EngineAnalytics
      v-if="bottomUIType === BottomUIType.PV && !isEvaluationPuzzle"
      :style="{ flexShrink: 0 }"
      :size="bottomViewSize"
      :history-mode="false"
      :mobile-layout="true"
      :show-header="true"
      :show-time-column="false"
      :show-multi-pv-column="false"
      :show-depth-column="false"
      :show-nodes-column="false"
      :show-score-column="false"
    />
    <EngineAnalytics
      v-if="
        bottomUIType === BottomUIType.SEARCH &&
        appSettings.showSearchLogOnMobile &&
        !isEvaluationPuzzle
      "
      :style="{ flexShrink: 0 }"
      :size="bottomViewSize"
      :history-mode="true"
      :mobile-layout="true"
      :show-header="true"
      :show-time-column="true"
      :show-multi-pv-column="true"
      :show-depth-column="true"
      :show-nodes-column="true"
      :show-score-column="true"
    />
    <AnalysisDB
      v-if="bottomUIType === BottomUIType.ANALYSIS_DB && !isEvaluationPuzzle"
      :style="{ flexShrink: 0 }"
      :size="bottomViewSize"
      :mobile-layout="true"
    />
    <EvaluationChart
      v-if="bottomUIType === BottomUIType.CHART && !isEvaluationPuzzle"
      :style="{ flexShrink: 0 }"
      :size="bottomViewSize"
      :type="appSettings.evaluationChartType"
      :thema="appSettings.thema"
      :coefficient-in-sigmoid="appSettings.coefficientInSigmoid"
    />
    <BookPane
      v-if="bottomUIType === BottomUIType.BOOK && !isEvaluationPuzzle"
      :size="bottomViewSize"
    />
    <HorizontalSelector
      v-if="!isEvaluationPuzzle"
      v-model:value="bottomUIType"
      :items="bottomUIItems"
      :height="selectorHeight"
      :scroll="true"
      style="flex-shrink: 0"
    />
  </div>
</template>

<script lang="ts">
enum BottomUIType {
  RECORD = "record",
  COMMENT = "comment",
  INFO = "info",
  PV = "pv",
  SEARCH = "search",
  ANALYSIS_DB = "analysisDB",
  CHART = "chart",
  BOOK = "book",
}
</script>

<script setup lang="ts">
import { RectSize } from "@/common/assets/geometry";
import { BoardLayoutType } from "@/common/settings/layout";
import { Lazy } from "@/renderer/helpers/lazy";
import BoardPane from "@/renderer/view/main/BoardPane.vue";
import RecordPane from "@/renderer/view/main/RecordPane.vue";
import { computed, onMounted, onUnmounted, reactive, ref } from "vue";
import MobileControls from "./MobileControls.vue";
import RecordComment from "@/renderer/view/tab/RecordComment.vue";
import HorizontalSelector from "@/renderer/view/primitive/HorizontalSelector.vue";
import { t } from "@/common/i18n";
import RecordInfo from "@/renderer/view/tab/RecordInfo.vue";
import EngineAnalytics from "@/renderer/view/tab/EngineAnalytics.vue";
import AnalysisDB from "@/renderer/view/tab/AnalysisDB.vue";
import EvaluationChart from "@/renderer/view/tab/EvaluationChart.vue";
import PuzzlePane from "@/renderer/view/tab/PuzzlePane.vue";
import BookPane from "@/renderer/view/tab/BookPane.vue";
import { useAppSettings } from "@/renderer/store/settings";
import { useStore } from "@/renderer/store";
import { AppState } from "@/common/control/state";
import { isIOS } from "@/renderer/ipc/api";

const lazyUpdateDelay = 80;
const selectorHeight = 30;
const minRecordViewHeight = 130;

// Reserve the iOS bottom inset or a small margin for drop shadows.
const safeAreaMarginY = isIOS() ? 21 : 10;

const windowSize = reactive(
  new RectSize(window.innerWidth, Math.max(0, window.innerHeight - safeAreaMarginY)),
);
const bottomUIType = ref(BottomUIType.RECORD);
const appSettings = useAppSettings();
const store = useStore();

const windowLazyUpdate = new Lazy();
const updateSize = () => {
  windowLazyUpdate.after(() => {
    windowSize.width = window.innerWidth;
    windowSize.height = Math.max(0, window.innerHeight - safeAreaMarginY);
  }, lazyUpdateDelay);
};

const isEvaluationPuzzle = computed(() => {
  return store.appState === AppState.PUZZLE && store.puzzle?.type === "evaluation";
});

const controlPaneHeight = computed(() =>
  Math.min(windowSize.height * 0.08, windowSize.width * 0.12),
);
const boardPaneMaxSize = computed(
  () =>
    new RectSize(
      windowSize.width,
      Math.max(0, windowSize.height - controlPaneHeight.value - minRecordViewHeight),
    ),
);
const boardLayoutType = computed(() => {
  return appSettings.boardLayoutType === BoardLayoutType.STANDARD
    ? BoardLayoutType.COMPACT
    : appSettings.boardLayoutType;
});

const boardPaneSize = ref(new RectSize(0, 0));
const onBoardPaneResize = (size: RectSize) => {
  boardPaneSize.value = size;
};

const bottomViewSize = computed(() => {
  return new RectSize(
    windowSize.width,
    Math.max(
      0,
      windowSize.height - boardPaneSize.value.height - controlPaneHeight.value - selectorHeight,
    ),
  );
});
const puzzlePaneHeight = computed(() =>
  Math.min(
    windowSize.height,
    bottomViewSize.value.height + controlPaneHeight.value + selectorHeight,
  ),
);

const bottomUIItems = computed(() => {
  const items: { label: string; value: BottomUIType }[] = [];
  if (appSettings.showSearchLogOnMobile) {
    items.push({ label: t.searchLog, value: BottomUIType.SEARCH });
  }
  items.push({ label: t.pv, value: BottomUIType.PV });
  items.push(
    { label: t.analysisDB, value: BottomUIType.ANALYSIS_DB },
    { label: t.chart, value: BottomUIType.CHART },
  );
  if (appSettings.showBookTableOnMobile) {
    items.push({ label: t.book, value: BottomUIType.BOOK });
  }
  items.push(
    { label: t.record, value: BottomUIType.RECORD },
    { label: t.comments, value: BottomUIType.COMMENT },
    { label: t.recordProperties, value: BottomUIType.INFO },
  );
  return items;
});

onMounted(() => {
  window.addEventListener("resize", updateSize);
});

onUnmounted(() => {
  window.removeEventListener("resize", updateSize);
  windowLazyUpdate.clear();
});
</script>

<style scoped>
.controls button {
  font-size: 100%;
  width: 100%;
  height: 100%;
}
.controls button .icon {
  height: 68%;
}

.bottom-element :deep(textarea) {
  border-top: none;
}
</style>
