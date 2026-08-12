<template>
  <DialogFrame limited @cancel="close">
    <div class="root column">
      <div class="title">
        {{ showProgress ? t.convertingToSfen : t.exportSearchResultsAsSfen }}
      </div>
      <template v-if="showProgress">
        <div class="progress form-group column">
          <div>{{ t.exportingKifuProgress(job!.processedFiles, job!.totalFiles) }}</div>
          <div class="note">{{ t.nSfenLinesExported(job!.exportedLines) }}</div>
        </div>
        <div class="main-buttons">
          <button @click="cancelExport">{{ t.cancel }}</button>
          <button @click="close">{{ t.close }}</button>
        </div>
      </template>
      <template v-else>
        <div class="settings form-group column">
          <div class="setting-row row align-center">
            <div class="label">{{ t.saveDestination }}</div>
            <input v-model.trim="destination" class="flex-1" />
          </div>
          <div class="setting-row row align-center">
            <div class="label">{{ t.maximumMoves }}</div>
            <input v-model.number="maxMoves" class="number" type="number" min="1" />
            <span class="note">{{ t.leaveBlankForUnlimited }}</span>
          </div>
          <div class="setting-row row align-center">
            <div class="label">{{ t.standardInitialPositionOnly }}</div>
            <ToggleButton v-model:value="sfenExportStandardInitialOnly" />
          </div>
          <div class="setting-row row align-center">
            <div class="label">{{ t.overwrite }}</div>
            <ToggleButton v-model:value="overwrite" />
          </div>
        </div>
        <div class="main-buttons">
          <button @click="close">{{ t.cancel }}</button>
          <button :disabled="!destination || starting || isRunning" @click="startExport">
            {{ t.exportSearchResultsAsSfen }}
          </button>
        </div>
      </template>
    </div>
  </DialogFrame>
</template>

<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref } from "vue";
import { t } from "@/common/i18n";
import api from "@/renderer/ipc/api";
import { ApiResponseError } from "@/renderer/api/client";
import { useErrorStore } from "@/renderer/store/error";
import { useMessageStore } from "@/renderer/store/message";
import { useServerKifuStore } from "@/renderer/store/serverKifu";
import DialogFrame from "./DialogFrame.vue";
import ToggleButton from "@/renderer/view/primitive/ToggleButton.vue";

const POLL_INTERVAL_MS = 250;
const MAX_POLL_RETRY_DELAY_MS = 5000;

const emit = defineEmits<{
  close: [];
  completed: [];
}>();

const {
  lastExecutedSearch,
  sfenExportJob: job,
  sfenExportStandardInitialOnly,
} = useServerKifuStore();
const destination = ref(`kifu-search-${new Date().toISOString().slice(0, 10)}.sfen`);
const maxMoves = ref<number | "">("");
const overwrite = ref(false);
const starting = ref(false);
const showProgress = ref(false);
let pollTimer: ReturnType<typeof setTimeout> | null = null;
let pollPending = false;
let pollRetryCount = 0;
let isMounted = false;

const isRunning = computed(() =>
  job.value ? ["queued", "running"].includes(job.value.state) : false,
);

async function startExport() {
  if (!lastExecutedSearch.value || !destination.value) return;
  try {
    const parsedMaxMoves = maxMoves.value === "" ? undefined : Number(maxMoves.value);
    if (
      parsedMaxMoves !== undefined &&
      (!Number.isInteger(parsedMaxMoves) || parsedMaxMoves <= 0)
    ) {
      throw new Error(t.maximumMovesMustBePositive);
    }
    starting.value = true;
    job.value = await api.startServerKifuSfenExport({
      filename: destination.value.toLowerCase().endsWith(".sfen")
        ? destination.value
        : destination.value + ".sfen",
      search: lastExecutedSearch.value,
      maxMoves: parsedMaxMoves,
      standardInitialOnly: sfenExportStandardInitialOnly.value,
      overwrite: overwrite.value,
    });
    pollRetryCount = 0;
    showProgress.value = true;
    poll();
  } catch (e) {
    useErrorStore().add(e);
  } finally {
    starting.value = false;
  }
}

async function poll() {
  if (!job.value || pollPending) return;
  pollPending = true;
  const jobId = job.value.jobId;
  try {
    const status = await api.getServerKifuSfenExport(jobId);
    if (!isMounted || !job.value || job.value.jobId !== jobId) return;
    job.value = status;
    pollRetryCount = 0;
    if (isRunning.value) {
      schedulePoll(POLL_INTERVAL_MS);
      return;
    }
    await nextTick();
    if (!isMounted || !job.value || job.value.jobId !== jobId) return;
    if (job.value.state === "completed") {
      const text =
        job.value.failedFiles > 0
          ? t.sfenExportCompletedWithWarnings(job.value.failedFiles)
          : t.sfenExportCompleted(job.value.outputPath);
      useMessageStore().enqueue({ text });
      emit("completed");
      emit("close");
    } else if (job.value.state === "failed") {
      useErrorStore().add(new Error(job.value.error || t.sfenExportFailed));
      showProgress.value = false;
    } else if (job.value.state === "cancelled") {
      emit("close");
    }
  } catch (e) {
    if (!isMounted || !job.value || job.value.jobId !== jobId) return;
    if (e instanceof ApiResponseError && e.status === 404) {
      job.value = undefined;
      showProgress.value = false;
      useErrorStore().add(new Error(t.sfenExportJobNotFound));
    } else if (e instanceof ApiResponseError && e.status >= 400 && e.status < 500) {
      job.value = undefined;
      showProgress.value = false;
      useErrorStore().add(e);
    } else {
      schedulePoll(getPollRetryDelay());
    }
  } finally {
    pollPending = false;
  }
}

function getPollRetryDelay(): number {
  const delay = Math.min(POLL_INTERVAL_MS * 2 ** pollRetryCount, MAX_POLL_RETRY_DELAY_MS);
  pollRetryCount += 1;
  return delay;
}

function schedulePoll(delay: number) {
  if (!isMounted) return;
  if (pollTimer) clearTimeout(pollTimer);
  pollTimer = setTimeout(() => {
    pollTimer = null;
    void poll();
  }, delay);
}

async function cancelExport() {
  if (!job.value) return;
  try {
    await api.cancelServerKifuSfenExport(job.value.jobId);
    schedulePoll(0);
  } catch (e) {
    if (e instanceof ApiResponseError && e.status === 404) {
      schedulePoll(0);
    } else {
      useErrorStore().add(e);
    }
  }
}

function close() {
  emit("close");
}

onMounted(() => {
  isMounted = true;
  if (isRunning.value) {
    showProgress.value = true;
    poll();
  }
});

onUnmounted(() => {
  isMounted = false;
  if (pollTimer) clearTimeout(pollTimer);
  pollTimer = null;
});
</script>

<style scoped>
.root {
  width: clamp(320px, 50vw, 620px);
  gap: 18px;
}
.settings,
.progress {
  gap: 12px;
}
.setting-row {
  gap: 10px;
}
.setting-row .label {
  width: 190px;
  flex-shrink: 0;
  text-align: left;
}
.number {
  width: 7em;
}
@media (max-width: 600px) {
  .setting-row {
    align-items: stretch;
    flex-direction: column;
  }
  .setting-row .label {
    width: auto;
  }
}
</style>
