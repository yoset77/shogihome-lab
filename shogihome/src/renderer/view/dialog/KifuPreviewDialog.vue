<template>
  <DialogFrame :limited="isMobile" @cancel="onClose">
    <div class="preview-dialog preview-dialog-constrained">
      <div class="file-path" :title="path">{{ fileName }}</div>

      <div v-if="loading" class="status-message">
        {{ t.loadingKifu }}
      </div>
      <div v-else-if="errorMessage" class="status-message error-message">
        {{ errorMessage }}
        <button type="button" data-test="close-error" @click="onClose">
          {{ t.close }}
        </button>
      </div>
      <template v-else-if="record">
        <div v-if="metadataItems.length > 0" class="metadata">
          <span v-for="item in metadataItems" :key="item.label" class="metadata-item">
            <span class="metadata-label">{{ item.label }}:</span> {{ item.value }}
          </span>
        </div>
        <div v-if="matchedPositionNotFound" class="match-warning">
          {{ t.matchedPositionNotFound }}
        </div>

        <div class="preview-content">
          <BoardView
            class="board-view"
            :layout-type="isMobile ? BoardLayoutType.PORTRAIT : BoardLayoutType.STANDARD"
            :mobile="isMobile"
            :board-image-type="appSettings.boardImage"
            :custom-board-image-url="appSettings.boardImageFileURL"
            :board-image-opacity="appSettings.enableTransparent ? appSettings.boardOpacity : 1"
            :board-grid-color="appSettings.boardGridColor || undefined"
            :piece-stand-image-type="appSettings.pieceStandImage"
            :custom-piece-stand-image-url="appSettings.pieceStandImageFileURL"
            :piece-stand-image-opacity="
              appSettings.enableTransparent ? appSettings.pieceStandOpacity : 1
            "
            :promotion-selector-style="appSettings.promotionSelectorStyle"
            :board-label-type="appSettings.boardLabelType"
            :piece-image-url-template="getPieceImageURLTemplate(appSettings)"
            :king-piece-type="appSettings.kingPieceType"
            :max-size="maxSize"
            :position="currentPosition"
            :last-move="lastMove"
            :flip="flip"
            :hide-clock="true"
            :allow-move="false"
            :allow-edit="false"
            :enable-drag-and-drop="false"
            :drop-shadows="!isMobile"
            :black-player-name="blackPlayerName || t.sente"
            :white-player-name="whitePlayerName || t.gote"
          >
            <template #right-control>
              <div v-if="!isMobile" class="full column desktop-controls">
                <div class="row control-row">
                  <button
                    class="control-item"
                    type="button"
                    data-hotkey="Mod+t"
                    :aria-label="t.flipBoard"
                    :title="t.flipBoard"
                    @click="doFlip"
                  >
                    <Icon :icon="IconType.FLIP" />
                  </button>
                  <button
                    class="control-item"
                    type="button"
                    autofocus
                    data-hotkey="Escape"
                    :aria-label="t.close"
                    :title="t.close"
                    @click="onClose"
                  >
                    <Icon :icon="IconType.CLOSE" />
                  </button>
                </div>
                <div class="row control-row">
                  <button
                    class="control-item"
                    type="button"
                    :data-hotkey="shortcutKeys.Begin"
                    :aria-label="t.firstMove"
                    :title="t.firstMove"
                    @click="goBegin"
                  >
                    <Icon :icon="IconType.FIRST" />
                  </button>
                  <button
                    class="control-item"
                    type="button"
                    :data-hotkey="shortcutKeys.End"
                    :aria-label="t.finalPosition"
                    :title="t.finalPosition"
                    @click="goEnd"
                  >
                    <Icon :icon="IconType.LAST" />
                  </button>
                </div>
                <div class="row control-row">
                  <button
                    class="control-item"
                    type="button"
                    :data-hotkey="shortcutKeys.Back"
                    :aria-label="t.previousMove"
                    :title="t.previousMove"
                    @click="goBack"
                  >
                    <Icon :icon="IconType.BACK" />
                  </button>
                  <button
                    class="control-item"
                    type="button"
                    :data-hotkey="shortcutKeys.Forward"
                    :aria-label="t.nextMove"
                    :title="t.nextMove"
                    @click="goForward"
                  >
                    <Icon :icon="IconType.NEXT" />
                  </button>
                </div>
              </div>
            </template>
          </BoardView>
          <div v-if="isMobile" class="mobile-controls">
            <button
              class="control-item"
              type="button"
              :data-hotkey="shortcutKeys.Begin"
              :aria-label="t.firstMove"
              :title="t.firstMove"
              @click="goBegin"
            >
              <Icon :icon="IconType.FIRST" />
            </button>
            <button
              class="control-item"
              type="button"
              :data-hotkey="shortcutKeys.Back"
              :aria-label="t.previousMove"
              :title="t.previousMove"
              @click="goBack"
            >
              <Icon :icon="IconType.BACK" />
            </button>
            <button
              class="control-item"
              type="button"
              :data-hotkey="shortcutKeys.Forward"
              :aria-label="t.nextMove"
              :title="t.nextMove"
              @click="goForward"
            >
              <Icon :icon="IconType.NEXT" />
            </button>
            <button
              class="control-item"
              type="button"
              :data-hotkey="shortcutKeys.End"
              :aria-label="t.finalPosition"
              :title="t.finalPosition"
              @click="goEnd"
            >
              <Icon :icon="IconType.LAST" />
            </button>
            <button
              class="control-item"
              type="button"
              data-hotkey="Mod+t"
              :aria-label="t.flipBoard"
              :title="t.flipBoard"
              @click="doFlip"
            >
              <Icon :icon="IconType.FLIP" />
            </button>
            <button
              class="control-item"
              type="button"
              autofocus
              data-hotkey="Escape"
              :aria-label="t.close"
              :title="t.close"
              @click="onClose"
            >
              <Icon :icon="IconType.CLOSE" />
            </button>
          </div>
          <RecordView
            :key="navigationVersion"
            class="record-list"
            :record="record"
            :operational="true"
            :show-top-control="false"
            :show-bottom-control="false"
            :show-branches="true"
            :show-comment="false"
            :show-elapsed-time="appSettings.showElapsedTimeInRecordView"
            :branch-list-mode="appSettings.branchListMode"
            :shortcut-keys="shortcutKeys"
            @select-move="selectMove"
            @select-branch="selectBranch"
            @select-next-branch="selectNextBranch"
          />
        </div>
      </template>
    </div>
  </DialogFrame>
</template>

<script setup lang="ts">
import {
  getBlackPlayerName,
  getWhitePlayerName,
  ImmutableNode,
  ImmutablePosition,
  Move,
  Record,
  RecordMetadataKey,
} from "tsshogi";
import { computed, markRaw, onBeforeUnmount, onMounted, reactive, ref, shallowRef } from "vue";
import { t } from "@/common/i18n";
import { BoardLayoutType } from "@/common/settings/layout";
import { TextDecodingRule, getPieceImageURLTemplate } from "@/common/settings/app";
import { normalizeSfen } from "@/common/usi/sfen";
import { detectRecordFileFormatByPath, importRecordFromBuffer } from "@/common/file/record";
import { getRecordTitleFromMetadata } from "@/common/helpers/metadata";
import { useAppSettings } from "@/renderer/store/settings";
import { useBusyState } from "@/renderer/store/busy";
import api, { isMobileWebApp } from "@/renderer/ipc/api";
import DialogFrame from "./DialogFrame.vue";
import BoardView from "@/renderer/view/primitive/BoardView.vue";
import RecordView from "@/renderer/view/primitive/RecordView.vue";
import Icon from "@/renderer/view/primitive/Icon.vue";
import { IconType } from "@/renderer/assets/icons";
import { RectSize } from "@/common/assets/geometry";
import { getRecordShortcutKeys } from "@/renderer/view/primitive/board/shortcut";

const props = defineProps<{
  path: string;
  matchedPly?: number;
  matchedSfen?: string;
}>();

const emit = defineEmits<{
  close: [];
}>();

const appSettings = useAppSettings();
const busyState = useBusyState();
const isMobile = isMobileWebApp();
const loading = ref(true);
const errorMessage = ref<string>();
const matchedPositionNotFound = ref(false);
const record = shallowRef<Record>();
const navigationVersion = ref(0);
const currentPosition = shallowRef<ImmutablePosition>(new Record().position);
const lastMove = shallowRef<Move | null>(null);
const flip = ref(appSettings.boardFlipping);
const maxSize = reactive(new RectSize(0, 0));
let cancelled = false;

const RECORD_LIST_WIDTH = 300;
const PREVIEW_CONTENT_GAP = 15;
const DIALOG_CONTENT_MARGIN = 30;

const shortcutKeys = computed(() => getRecordShortcutKeys(appSettings.recordShortcutKeys));
const fileName = computed(() => props.path.split(/[\\/]/).pop() || props.path);

const blackPlayerName = computed(() =>
  record.value ? getBlackPlayerName(record.value.metadata) : undefined,
);

const whitePlayerName = computed(() =>
  record.value ? getWhitePlayerName(record.value.metadata) : undefined,
);

const metadataItems = computed(() => {
  const currentRecord = record.value;
  if (!currentRecord) return [];

  const items: { label: string; value: string }[] = [];
  const date =
    currentRecord.metadata.getStandardMetadata(RecordMetadataKey.START_DATETIME) ||
    currentRecord.metadata.getStandardMetadata(RecordMetadataKey.DATE);
  const title = getRecordTitleFromMetadata(currentRecord.metadata);
  if (date) items.push({ label: t.gameDate, value: date });
  if (title) items.push({ label: t.gameTitle, value: title });
  if (blackPlayerName.value || whitePlayerName.value) {
    items.push({
      label: t.playerName,
      value: `${blackPlayerName.value || "?"} vs ${whitePlayerName.value || "?"}`,
    });
  }
  return items;
});

function updateSize() {
  if (isMobile) {
    maxSize.width = Math.min(window.innerWidth * 0.95 - 34, 600);
    maxSize.height = Math.max(
      160,
      Math.min(
        window.innerHeight * 0.95 - 220,
        window.innerHeight * 0.58,
        window.innerHeight - 300,
      ),
    );
  } else {
    const maxDialogContentWidth = window.innerWidth * 0.95 - DIALOG_CONTENT_MARGIN;
    const maxBoardWidth = maxDialogContentWidth - RECORD_LIST_WIDTH - PREVIEW_CONTENT_GAP;
    maxSize.width = Math.min(window.innerWidth * 0.8, Math.max(1, maxBoardWidth));
    maxSize.height = window.innerHeight * 0.8 - 80;
  }
}

function findMatchedNode(target: Record): ImmutableNode | undefined {
  if (props.matchedPly == null) return undefined;

  let matchedNode: ImmutableNode | undefined;
  target.forEach((node) => {
    if (node.ply !== props.matchedPly) return;
    if (props.matchedSfen && normalizeSfen(node.sfen) !== props.matchedSfen) return;
    matchedNode = node;
  });
  return matchedNode;
}

function selectInitialPosition(target: Record) {
  const matchedNode = findMatchedNode(target);
  if (matchedNode) {
    target.gotoNode(matchedNode);
    return;
  }

  if (props.matchedPly != null) {
    target.goto(props.matchedPly);
    matchedPositionNotFound.value = true;
  }
}

function touchNavigation() {
  navigationVersion.value++;
  if (record.value) {
    currentPosition.value = record.value.position.clone();
    const move = record.value.current.move;
    lastMove.value = move instanceof Move ? move : null;
  }
}

function goBegin() {
  if (!record.value) return;
  record.value.goto(0);
  touchNavigation();
}

function goBack() {
  if (!record.value) return;
  record.value.goBack();
  touchNavigation();
}

function goForward() {
  if (!record.value) return;
  record.value.goForward();
  touchNavigation();
}

function goEnd() {
  if (!record.value) return;
  record.value.goto(Number.MAX_SAFE_INTEGER);
  touchNavigation();
}

function doFlip() {
  flip.value = !flip.value;
}

function selectMove(ply: number) {
  if (!record.value) return;
  record.value.goto(ply);
  touchNavigation();
}

function selectBranch(index: number) {
  if (!record.value) return;
  record.value.switchBranchByIndex(index);
  touchNavigation();
}

function selectNextBranch(index: number) {
  if (!record.value) return;
  record.value.goForward();
  record.value.switchBranchByIndex(index);
  touchNavigation();
}

function onClose() {
  emit("close");
}

async function loadRecord() {
  try {
    busyState.retain();
    const fileURI = await api.loadServerKifu(props.path);
    const data = await api.openRecord(fileURI);
    const format = detectRecordFileFormatByPath(fileURI);
    if (!format) {
      throw new Error(t.failedToDetectRecordFormat);
    }

    const autoDetect = appSettings.textDecodingRule === TextDecodingRule.AUTO_DETECT;
    const parsed = importRecordFromBuffer(data, format, { autoDetect });
    if (parsed instanceof Error) {
      throw parsed;
    }
    if (cancelled) return;

    selectInitialPosition(parsed);
    record.value = markRaw(parsed);
    touchNavigation();
  } catch {
    if (!cancelled) {
      errorMessage.value = t.failedToLoadKifu;
    }
  } finally {
    loading.value = false;
    busyState.release();
  }
}

onMounted(() => {
  updateSize();
  window.addEventListener("resize", updateSize);
  void loadRecord();
});

onBeforeUnmount(() => {
  cancelled = true;
  window.removeEventListener("resize", updateSize);
});
</script>

<style scoped>
.preview-dialog {
  width: fit-content;
  max-width: calc(95vw - 30px);
  min-width: 0;
}

.preview-dialog-constrained {
  display: flex;
  max-height: 100%;
  min-height: 0;
  box-sizing: border-box;
  flex-direction: column;
}

.file-path {
  margin: 0 0 8px;
  overflow: hidden;
  color: var(--text-color-sub);
  font-size: 1.2em;
  text-overflow: ellipsis;
  text-align: left;
  white-space: nowrap;
}

.status-message {
  display: flex;
  min-height: 180px;
  align-items: center;
  justify-content: center;
  color: var(--text-color-sub);
}

.error-message {
  flex-direction: column;
  gap: 15px;
  color: var(--text-color-warning);
}

.metadata {
  display: flex;
  flex-wrap: wrap;
  gap: 5px 15px;
  margin-bottom: 8px;
  color: var(--text-color-sub);
  font-size: 0.8em;
  text-align: left;
}

.metadata-item {
  white-space: nowrap;
}

.metadata-label {
  color: var(--text-color);
}

.match-warning {
  margin-bottom: 8px;
  color: var(--text-color-warning);
  font-size: 0.8em;
  text-align: left;
}

.preview-content {
  display: flex;
  flex: 1 1 auto;
  min-height: 0;
  gap: 15px;
  align-items: stretch;
  overflow: hidden;
}

.board-view {
  flex: 1 1 auto;
  min-width: 0;
}

.record-list {
  width: 300px;
  min-width: 220px;
  height: min(65vh, 650px);
  min-height: 0;
  max-height: min(65vh, 650px);
  overflow: hidden;
}

.record-list :deep(.branch-side-control) {
  display: none;
}

.record-list :deep(.branch-bottom-control) {
  display: none;
}

.control-row {
  width: 100%;
  height: 25%;
  margin: 0;
}

.control-row:not(:last-child) {
  margin-bottom: 2%;
}

.control-item {
  display: inline-flex;
  width: 50%;
  height: 100%;
  align-items: center;
  justify-content: center;
  margin: 0;
  padding: 0 5%;
}

.control-item:not(:last-child) {
  margin-right: 2%;
}

.control-item .icon {
  width: auto;
  height: 80%;
}

.mobile-controls {
  display: flex;
  justify-content: center;
  flex-shrink: 0;
  margin-top: 5px;
}

.mobile-controls .control-item {
  width: 15%;
  height: 40px;
  margin: 0 1%;
  padding: 0;
}

@media (max-width: 600px) {
  :deep(> .frame.limited) {
    display: flex;
    height: 100%;
    max-height: calc(100dvh - 2em - 33px);
    flex-direction: column;
    overflow: hidden;
  }

  .preview-dialog {
    width: 100%;
    height: 100%;
    max-height: 100%;
    overflow: hidden;
  }

  .preview-content {
    flex-direction: column;
    gap: 6px;
  }

  .board-view {
    flex: 0 0 auto;
  }

  .record-list {
    width: 100%;
    min-width: 0;
    height: 0;
    flex: 1 1 0;
    min-height: clamp(64px, 12vh, 100px);
  }

  .record-list :deep(.branch-list-area) {
    height: auto;
    max-height: 30%;
    min-height: 0;
  }

  .mobile-controls {
    margin-top: 4px;
  }

  .mobile-controls .control-item .icon {
    height: 80%;
  }
}
</style>
