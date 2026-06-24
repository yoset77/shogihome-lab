<template>
  <div class="camera-overlay">
    <div v-if="error" class="camera-error">
      <p>{{ errorMessage }}</p>
      <button type="button" @click="$emit('cancel')">{{ t.ok }}</button>
    </div>
    <template v-else>
      <video ref="videoRef" class="camera-preview" autoplay playsinline muted />
      <div class="camera-controls">
        <button class="close-button" type="button" @click="onCancel">
          <Icon :icon="IconType.CLOSE" />
        </button>
        <button class="shutter-button" type="button" :disabled="!ready" @click="onCapture" />
      </div>
    </template>
  </div>
</template>

<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from "vue";
import { t } from "@/common/i18n";
import { IconType } from "@/renderer/assets/icons";
import Icon from "@/renderer/view/primitive/Icon.vue";
import { getCameraStream, stopCameraStream, captureVideoFrame } from "@/renderer/helpers/camera";

const emit = defineEmits<{
  capture: [blob: Blob];
  cancel: [];
}>();

const videoRef = ref<HTMLVideoElement>();
const stream = ref<MediaStream>();
const ready = ref(false);
const error = ref<string | undefined>();
const errorMessage = ref("");
let disposed = false;

onMounted(async () => {
  try {
    const cameraStream = await getCameraStream();
    if (disposed) {
      stopCameraStream(cameraStream);
      return;
    }
    stream.value = cameraStream;
    if (videoRef.value) {
      videoRef.value.srcObject = stream.value;
      videoRef.value.onloadedmetadata = () => {
        ready.value = true;
      };
    }
  } catch (e) {
    if (disposed) {
      return;
    }
    error.value = String(e);
    errorMessage.value = t.cameraCaptureFailed;
  }
});

const onCapture = async () => {
  if (!videoRef.value) {
    return;
  }
  try {
    const blob = await captureVideoFrame(videoRef.value);
    stop();
    emit("capture", blob);
  } catch (e) {
    error.value = String(e);
    errorMessage.value = t.cameraCaptureFailed;
  }
};

const onCancel = () => {
  stop();
  emit("cancel");
};

const stop = () => {
  if (stream.value) {
    stopCameraStream(stream.value);
    stream.value = undefined;
  }
};

onBeforeUnmount(() => {
  disposed = true;
  stop();
});
</script>

<style scoped>
.camera-overlay {
  position: fixed;
  inset: 0;
  z-index: 200;
  display: flex;
  flex-direction: column;
  background-color: #000;
}
.camera-preview {
  flex: 1;
  width: 100%;
  height: 100%;
  object-fit: contain;
}
.camera-controls {
  position: absolute;
  bottom: 0;
  left: 0;
  right: 0;
  display: flex;
  align-items: center;
  justify-content: space-around;
  padding: 16px 24px;
  padding-bottom: max(16px, env(safe-area-inset-bottom));
  background: linear-gradient(transparent, rgba(0, 0, 0, 0.6));
}
.close-button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 44px;
  height: 44px;
  padding: 0;
  border: none;
  border-radius: 50%;
  background-color: rgba(255, 255, 255, 0.2);
  color: #fff;
  cursor: pointer;
}
.close-button .icon {
  width: 24px;
  height: 24px;
}
.shutter-button {
  width: 64px;
  height: 64px;
  padding: 0;
  border: 4px solid #fff;
  border-radius: 50%;
  background-color: rgba(255, 255, 255, 0.3);
  cursor: pointer;
  transition: background-color 0.15s;
}
.shutter-button:not(:disabled):hover,
.shutter-button:not(:disabled):active {
  background-color: rgba(255, 255, 255, 0.6);
}
.shutter-button:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}
.camera-error {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 16px;
  color: #fff;
}
</style>
