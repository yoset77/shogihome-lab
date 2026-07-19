<template>
  <DialogFrame limited @cancel="onClose">
    <div class="vision-scan-dialog">
      <header class="dialog-header">
        <h2>{{ t.importBoardImage }}</h2>
      </header>

      <div class="input-row">
        <button class="file-button" type="button" @click="onOpenFileDialog">
          <Icon :icon="IconType.OPEN" />
          <span>{{ t.selectImageFile }}</span>
          <input ref="fileInputRef" type="file" accept="image/*" @change="onSelectFile" />
        </button>
        <button class="file-button" type="button" @click="isCameraOpen = true">
          <Icon :icon="IconType.FLIP" />
          <span>{{ t.takePhoto }}</span>
        </button>
      </div>

      <CameraCapture
        v-if="isCameraOpen"
        @capture="onCameraCapture"
        @cancel="isCameraOpen = false"
      />

      <div class="preview-area">
        <img v-if="previewUrl" :src="previewUrl" alt="" />
        <div v-else class="empty-preview">
          {{ t.noImageSelected }}
        </div>
      </div>

      <div class="scan-options">
        <div class="form-item">
          <div class="form-item-label-wide">{{ t.visionBoardViewpoint }}</div>
          <HorizontalSelector v-model:value="viewpoint" :items="viewpointItems" />
        </div>
        <div class="form-item">
          <div class="form-item-label-wide">{{ t.visionSideToMove }}</div>
          <HorizontalSelector v-model:value="sideToMove" :items="sideToMoveItems" />
        </div>
        <div class="form-item">
          <div class="form-item-label-wide">{{ t.visionPositionType }}</div>
          <HorizontalSelector v-model:value="positionType" :items="positionTypeItems" />
        </div>
      </div>

      <div class="main-buttons">
        <button type="button" :disabled="!imageBlob || scanning" @click="scan">
          {{ scanning ? t.scanning : t.importPosition }}
        </button>
        <button type="button" @click="onClose">
          {{ t.cancel }}
        </button>
      </div>
    </div>
  </DialogFrame>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { Color } from "tsshogi";
import { t } from "@/common/i18n";
import type { VisionPositionType, VisionTurn, VisionViewpoint } from "@/common/vision/types";
import { IconType } from "@/renderer/assets/icons";
import CameraCapture from "@/renderer/view/dialog/CameraCapture.vue";
import DialogFrame from "@/renderer/view/dialog/DialogFrame.vue";
import Icon from "@/renderer/view/primitive/Icon.vue";
import HorizontalSelector from "@/renderer/view/primitive/HorizontalSelector.vue";
import { useBusyState } from "@/renderer/store/busy";
import { useErrorStore } from "@/renderer/store/error";
import { useStore } from "@/renderer/store";
import { useAppSettings } from "@/renderer/store/settings";
import { scanPositionImage } from "@/renderer/vision/api";
import { compressImageForVision } from "@/renderer/helpers/image";

const SCAN_TIMEOUT_MS = 30000;

const store = useStore();
const appSettings = useAppSettings();
const busyState = useBusyState();
const imageBlob = ref<Blob>();
const previewUrl = ref("");
const scanning = ref(false);
const isCameraOpen = ref(false);
const fileInputRef = ref<HTMLInputElement>();
let scanAbortController: AbortController | undefined;
let scanTimeout: ReturnType<typeof setTimeout> | undefined;
let scanTimedOut = false;
const sideToMove = ref<VisionTurn>(store.record.position.color === Color.BLACK ? "black" : "white");
const viewpoint = ref<VisionViewpoint>("black");
const positionType = ref<VisionPositionType>("game");

const sideToMoveItems = computed(() => [
  { label: t.sente, value: "black" },
  { label: t.gote, value: "white" },
]);
const viewpointItems = computed(() => [
  { label: t.visionViewpointBlack, value: "black" },
  { label: t.visionViewpointWhite, value: "white" },
]);
const positionTypeItems = computed(() => [
  { label: t.visionPositionTypeGame, value: "game" },
  { label: t.visionPositionTypeMate, value: "mate" },
]);

const onClose = () => {
  abortScan();
  revokePreviewUrl();
  store.destroyModalDialog();
};

const onOpenFileDialog = () => {
  fileInputRef.value?.click();
};

const onSelectFile = async (event: Event) => {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  if (!file) {
    return;
  }
  input.value = "";
  try {
    const blob = await compressImageForVision(file);
    setImage(blob);
  } catch (e) {
    useErrorStore().add(e);
  }
};

const onCameraCapture = async (blob: Blob) => {
  isCameraOpen.value = false;
  try {
    const compressed = await compressImageForVision(blob);
    setImage(compressed);
  } catch (e) {
    useErrorStore().add(e);
  }
};

const scan = async () => {
  if (!imageBlob.value || scanning.value) {
    return;
  }
  const sourceImage = imageBlob.value;
  scanning.value = true;
  busyState.retain();
  scanAbortController = new AbortController();
  scanTimedOut = false;
  scanTimeout = setTimeout(() => {
    scanTimedOut = true;
    scanAbortController?.abort();
  }, SCAN_TIMEOUT_MS);
  try {
    const result = await scanPositionImage(
      sourceImage,
      sideToMove.value,
      viewpoint.value,
      scanAbortController.signal,
    );
    store.showVisionPositionEditDialog({
      sourceImage,
      response: result,
      viewpoint: viewpoint.value,
      positionType: positionType.value,
    });
  } catch (e) {
    if (scanTimedOut) {
      useErrorStore().add(new Error(t.timeout));
    } else if (!isAbortError(e)) {
      useErrorStore().add(e);
    }
  } finally {
    clearScanTimeout();
    scanAbortController = undefined;
    scanTimedOut = false;
    busyState.release();
    scanning.value = false;
  }
};

const setImage = (blob: Blob) => {
  imageBlob.value = blob;
  revokePreviewUrl();
  previewUrl.value = URL.createObjectURL(blob);
};

const revokePreviewUrl = () => {
  if (previewUrl.value) {
    URL.revokeObjectURL(previewUrl.value);
    previewUrl.value = "";
  }
};

const abortScan = () => {
  scanAbortController?.abort();
  clearScanTimeout();
};

const clearScanTimeout = () => {
  if (scanTimeout) {
    clearTimeout(scanTimeout);
    scanTimeout = undefined;
  }
};

const isAbortError = (error: unknown): boolean => {
  return error instanceof DOMException && error.name === "AbortError";
};

onMounted(() => {
  if (appSettings.enableVisionCameraAutoOpen) {
    isCameraOpen.value = true;
  }
});

onBeforeUnmount(() => {
  abortScan();
  revokePreviewUrl();
});
</script>

<style scoped>
.vision-scan-dialog {
  display: flex;
  flex-direction: column;
  gap: 12px;
  width: min(680px, calc(95vw - 30px));
}
.dialog-header {
  display: flex;
  align-items: center;
  justify-content: center;
}
h2 {
  margin: 0;
  font-size: 120%;
}
.input-row,
.main-buttons {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
.scan-options .form-item {
  margin: 4px 0;
}
.scan-options .form-item > * {
  vertical-align: top;
}
.scan-options .form-item-label-wide {
  width: 120px;
}
.file-button {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  border: 1px solid var(--main-color);
  border-radius: 0;
  padding: 4px 10px;
  cursor: pointer;
  background-color: var(--main-bg-color);
}
.file-button .icon {
  width: 18px;
  height: 18px;
}
.file-button input {
  display: none;
}
.preview-area {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 100%;
  aspect-ratio: 4 / 3;
  min-height: 220px;
  overflow: hidden;
  border: 1px solid var(--dialog-border-color);
  background-color: var(--main-bg-color);
}
.preview-area img {
  width: 100%;
  height: 100%;
  object-fit: contain;
}
.empty-preview {
  color: var(--main-color);
  opacity: 0.75;
}
button:disabled {
  opacity: 0.5;
}
</style>
