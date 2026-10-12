<template>
  <DialogFrame limited @cancel="emit('close')">
    <div class="root">
      <h3>{{ t.batchAnalysisDetails }}</h3>
      <p v-if="error" role="alert">{{ error }}</p>
      <ol>
        <li v-for="file in files" :key="file.index">
          <div>{{ file.path }}</div>
          <div>
            {{ states[file.state] }}
            <template v-if="file.reason">: {{ t.batchAnalysisReason(file.reason) }}</template>
          </div>
          <button
            v-if="file.state === 'saved'"
            :disabled="!store.canAttachJob"
            @click="open(file.path)"
          >
            {{ t.open }}
          </button>
        </li>
      </ol>
      <div class="main-buttons">
        <button :disabled="loading" @click="refresh">{{ t.jobsRefresh }}</button>
        <button @click="emit('close')">{{ t.close }}</button>
      </div>
    </div>
  </DialogFrame>
</template>
<script setup lang="ts">
import { onMounted, ref } from "vue";
import { t } from "@/common/i18n";
import type { BatchFileResult } from "@/common/analysis/batch";
import { createAnalysisJobsClient } from "@/renderer/api/analysis_jobs";
import DialogFrame from "./DialogFrame.vue";
import { useStore } from "@/renderer/store";
const store = useStore();
const props = defineProps<{ jobId: string }>();
const emit = defineEmits<{ close: [] }>();
const files = ref<BatchFileResult[]>([]);
const error = ref("");
const loading = ref(false);
const states: Record<BatchFileResult["state"], string> = {
  pending: t.jobsStatePreparing,
  running: t.jobsStateRunning,
  saved: t.success,
  failed: t.failed,
  skipped: t.skipped,
  cancelled: t.jobsStateCancelled,
};
const refresh = async () => {
  loading.value = true;
  try {
    files.value = await createAnalysisJobsClient().files(props.jobId);
    error.value = "";
  } catch (e) {
    error.value = e instanceof Error ? e.message : t.jobsInvalid;
  } finally {
    loading.value = false;
  }
};
const open = async (path: string) => {
  if (await store.openBatchAnalysisFile(path)) emit("close");
};
onMounted(refresh);
</script>
<style scoped>
.root {
  width: min(540px, calc(95vw - 32px));
  overflow-wrap: anywhere;
}
ol {
  max-height: 60dvh;
  overflow-y: auto;
  padding-left: 28px;
}
li {
  padding: 6px 0;
}
</style>
