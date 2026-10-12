<template>
  <section v-if="status?.batch" class="batch-progress" aria-live="polite">
    <strong
      >{{ t.batchAnalysis }} {{ status.batch.currentFile }} / {{ status.batch.totalFiles }}</strong
    >
    <div>{{ status.batch.currentPath }}</div>
    <div>{{ t.jobsProgress }}: {{ status.completedPositions }} / {{ status.totalPositions }}</div>
    <div>
      {{
        t.batchAnalysisSummary(
          status.batch.successTotal,
          status.batch.failedTotal,
          status.batch.skippedTotal,
        )
      }}
    </div>
    <button @click="store.resumeAnalysisFollowing()">{{ t.batchAnalysisFollow }}</button>
    <button @click="store.showJobsDialog()">{{ t.batchAnalysisDetails }}</button>
  </section>
</template>
<script setup lang="ts">
import { computed } from "vue";
import { t } from "@/common/i18n";
import { useStore } from "@/renderer/store";
const store = useStore();
const status = computed(() => store.analysisStatus);
</script>
<style scoped>
.batch-progress {
  padding: 8px;
  overflow-wrap: anywhere;
  font-size: 0.85em;
}
</style>
