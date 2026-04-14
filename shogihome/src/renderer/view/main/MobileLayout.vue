<template>
  <div class="full">
    <div class="full row">
      <div class="column" style="overflow: hidden">
        <BoardPane
          :max-size="boardPaneMaxSize"
          :layout-type="boardLayoutType"
          style="flex-shrink: 0"
          @resize="onBoardPaneResize"
        />
        <MobileControls
          v-if="showRecordViewOnBottom && !isEvaluationPuzzle"
          :style="{ height: `${controlPaneHeight}px`, flexShrink: 0 }"
        />
        <PuzzlePane
          v-if="showRecordViewOnBottom && isEvaluationPuzzle"
          :style="{
            height: `${bottomViewSize.height + controlPaneHeight + selectorHeight}px`,
            flexShrink: 0,
          }"
        />
        <RecordPane
          v-if="showRecordViewOnBottom && !isEvaluationPuzzle"
          v-show="bottomUIType === BottomUIType.RECORD"
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
          v-if="showRecordViewOnBottom && !isEvaluationPuzzle"
          v-show="bottomUIType === BottomUIType.COMMENT"
          class="bottom-element"
          :style="{
            width: `${windowSize.width}px`,
            height: `${bottomViewSize.height}px`,
            flexShrink: 0,
          }"
        />
        <RecordInfo
          v-if="showRecordViewOnBottom && !isEvaluationPuzzle"
          v-show="bottomUIType === BottomUIType.INFO"
          :style="{ flexShrink: 0 }"
          :size="bottomViewSize"
        />
        <EngineAnalytics
          v-if="showRecordViewOnBottom && !isEvaluationPuzzle"
          v-show="bottomUIType === BottomUIType.PV"
          :style="{ flexShrink: 0 }"
          :size="bottomViewSize"
          :history-mode="false"
          :mobile-layout="true"
          :show-header="false"
          :show-time-column="false"
          :show-multi-pv-column="false"
          :show-depth-column="false"
          :show-nodes-column="false"
          :show-score-column="false"
        />
        <EngineAnalytics
          v-if="showRecordViewOnBottom && !isEvaluationPuzzle"
          v-show="bottomUIType === BottomUIType.SEARCH"
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
          v-if="showRecordViewOnBottom && !isEvaluationPuzzle"
          v-show="bottomUIType === BottomUIType.ANALYSIS_DB"
          :style="{ flexShrink: 0 }"
          :size="bottomViewSize"
          :mobile-layout="true"
        />
        <EvaluationChart
          v-if="showRecordViewOnBottom && !isEvaluationPuzzle"
          v-show="bottomUIType === BottomUIType.CHART"
          :style="{ flexShrink: 0 }"
          :size="bottomViewSize"
          :type="appSettings.evaluationChartType"
          :thema="appSettings.thema"
          :coefficient-in-sigmoid="appSettings.coefficientInSigmoid"
        />
        <BookPane
          v-if="showRecordViewOnBottom && !isEvaluationPuzzle"
          v-show="bottomUIType === BottomUIType.BOOK"
          :size="bottomViewSize"
        />
        <HorizontalSelector
          v-if="showRecordViewOnBottom && !isEvaluationPuzzle"
          v-model:value="bottomUIType"
          :items="bottomUIItems"
          :height="selectorHeight"
          :scroll="true"
          style="flex-shrink: 0"
        />
      </div>
      <div
        v-if="!showRecordViewOnBottom"
        class="column"
        :style="{ width: `${windowSize.width - boardPaneSize.width}px`, overflow: 'hidden' }"
      >
        <MobileControls
          v-if="!isEvaluationPuzzle"
          :style="{ height: `${controlPaneHeight}px`, flexShrink: 0 }"
        />
        <PuzzlePane v-if="isEvaluationPuzzle" class="full" style="flex-shrink: 0" />
        <RecordPane
          v-if="!isEvaluationPuzzle"
          v-show="sideUIType === SideUIType.RECORD"
          :style="{ height: `${sideViewSize.height * 0.6}px`, flexShrink: 0 }"
          :show-top-control="false"
          :show-bottom-control="false"
          :show-elapsed-time="true"
          :show-comment="true"
        />
        <RecordComment
          v-if="!isEvaluationPuzzle"
          v-show="sideUIType === SideUIType.RECORD"
          :style="{
            'margin-top': '5px',
            height: `${sideViewSize.height * 0.4 - 5}px`,
            flexShrink: 0,
          }"
        />
        <RecordInfo
          v-if="!isEvaluationPuzzle"
          v-show="sideUIType === SideUIType.INFO"
          :style="{ flexShrink: 0 }"
          :size="sideViewSize"
        />
        <EngineAnalytics
          v-if="!isEvaluationPuzzle"
          v-show="sideUIType === SideUIType.PV"
          :style="{ flexShrink: 0 }"
          :size="sideViewSize"
          :history-mode="false"
          :mobile-layout="true"
          :show-header="false"
          :show-time-column="false"
          :show-multi-pv-column="false"
          :show-depth-column="false"
          :show-nodes-column="false"
          :show-score-column="false"
        />
        <EngineAnalytics
          v-if="!isEvaluationPuzzle"
          v-show="sideUIType === SideUIType.SEARCH"
          :style="{ flexShrink: 0 }"
          :size="sideViewSize"
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
          v-if="!isEvaluationPuzzle"
          v-show="sideUIType === SideUIType.ANALYSIS_DB"
          :style="{ flexShrink: 0 }"
          :size="sideViewSize"
          :mobile-layout="true"
        />
        <EvaluationChart
          v-if="!isEvaluationPuzzle"
          v-show="sideUIType === SideUIType.CHART"
          :style="{ flexShrink: 0 }"
          :size="sideViewSize"
          :type="EvaluationChartType.RAW"
          :thema="appSettings.thema"
          :coefficient-in-sigmoid="appSettings.coefficientInSigmoid"
        />
        <BookPane
          v-if="!showRecordViewOnBottom && !isEvaluationPuzzle"
          v-show="sideUIType === SideUIType.BOOK"
          :size="sideViewSize"
        />
        <HorizontalSelector
          v-if="!isEvaluationPuzzle"
          v-model:value="sideUIType"
          :items="sideUIItems"
          :height="selectorHeight"
          :scroll="true"
          style="flex-shrink: 0"
        />
      </div>
    </div>
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

enum SideUIType {
  RECORD = "record",
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
import { BoardLayoutType, EvaluationChartType } from "@/common/settings/layout";
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
const minRecordViewWidth = 250;
const minRecordViewHeight = 130;

// iOS の多くのバージョンでは safe-area-inset-bottom が 21px になる。
// それ以外の環境もドロップシャドウの高さを考慮してマージンを持たせる。
const safeAreaMarginY = isIOS() ? 21 : 10;

const windowSize = reactive(new RectSize(window.innerWidth, window.innerHeight - safeAreaMarginY));
const bottomUIType = ref(BottomUIType.RECORD);
const sideUIType = ref(SideUIType.RECORD);
const appSettings = useAppSettings();
const store = useStore();

const windowLazyUpdate = new Lazy();
const updateSize = () => {
  windowLazyUpdate.after(() => {
    windowSize.width = window.innerWidth;
    windowSize.height = window.innerHeight - safeAreaMarginY;
  }, lazyUpdateDelay);
};

const isEvaluationPuzzle = computed(() => {
  return store.appState === AppState.PUZZLE && store.puzzle?.type === "evaluation";
});

const showRecordViewOnBottom = computed(() => windowSize.height >= windowSize.width);
const controlPaneHeight = computed(() =>
  Math.min(windowSize.height * 0.08, windowSize.width * 0.12),
);
const boardPaneMaxSize = computed(() => {
  const maxSize = new RectSize(windowSize.width, windowSize.height);
  if (showRecordViewOnBottom.value) {
    maxSize.height -= controlPaneHeight.value + minRecordViewHeight;
  } else {
    maxSize.width -= minRecordViewWidth;
  }
  return maxSize;
});
const boardLayoutType = computed(() => {
  return appSettings.boardLayoutType === BoardLayoutType.STANDARD
    ? BoardLayoutType.COMPACT
    : appSettings.boardLayoutType;
});

const boardPaneSize = ref(windowSize);
const onBoardPaneResize = (size: RectSize) => {
  boardPaneSize.value = size;
};

const bottomViewSize = computed(() => {
  return new RectSize(
    windowSize.width,
    windowSize.height - boardPaneSize.value.height - controlPaneHeight.value - selectorHeight,
  );
});
const sideViewSize = computed(() => {
  return new RectSize(
    windowSize.width - boardPaneSize.value.width,
    windowSize.height - controlPaneHeight.value - selectorHeight,
  );
});

const bottomUIItems = computed(() => {
  const items = [];
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

const sideUIItems = computed(() => {
  const items = [];
  if (appSettings.showSearchLogOnMobile) {
    items.push({ label: t.searchLog, value: SideUIType.SEARCH });
  }
  items.push({ label: t.pv, value: SideUIType.PV });
  items.push(
    { label: t.analysisDB, value: SideUIType.ANALYSIS_DB },
    { label: t.chart, value: SideUIType.CHART },
  );
  if (appSettings.showBookTableOnMobile) {
    items.push({ label: t.book, value: SideUIType.BOOK });
  }
  items.push(
    { label: t.record, value: SideUIType.RECORD },
    { label: t.recordProperties, value: SideUIType.INFO },
  );
  return items;
});

onMounted(() => {
  window.addEventListener("resize", updateSize);
});

onUnmounted(() => {
  window.removeEventListener("resize", updateSize);
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
