<template>
  <DialogFrame limited @cancel="store.closeJobsDialog()">
    <div class="root">
      <div class="title">{{ t.jobsTitle }}</div>
      <p v-if="list.error" class="note" role="alert">{{ errorMessage }}</p>
      <div class="form-group scroll">
        <p v-if="!list.error && !list.loading && !list.jobs.length" class="note">
          {{ t.jobsEmpty }}
        </p>
        <ul>
          <li
            v-for="(job, index) in list.jobs"
            :key="`${job.kind}:${job.serverInstanceId}:${job.id}`"
          >
            <hr v-if="index !== 0" />
            <div class="header">
              <strong>{{ job.kind === "analysis" ? t.jobsAnalysis : t.jobsGame }}</strong>
              <span class="actions">
                <button :disabled="!store.canAttachJob" @click="onAttach(job)">
                  {{ terminal(job) ? t.jobsOpenResults : t.jobsAttach }}
                </button>
                <button v-if="store.canDetachListedJob(job)" @click="onDetach(job)">
                  {{ t.jobsDetach }}
                </button>
              </span>
            </div>
            <div class="form-item">
              <span class="form-item-label">{{ t.jobsState }}</span>
              <span>{{ states[job.state] }}</span>
            </div>
            <div class="form-item">
              <span class="form-item-label">{{ t.jobsProgress }}</span>
              <span>{{ job.completed }} / {{ job.total }}</span>
            </div>
            <div>{{ job.engines.join(" / ") }}</div>
            <div v-if="store.canDetachListedJob(job)">{{ t.jobsAttached }}</div>
          </li>
        </ul>
      </div>
      <p v-if="list.jobs.length" class="note">{{ t.jobsRetention }}</p>
      <div class="main-buttons">
        <button :disabled="list.loading" :aria-busy="list.loading" @click="list.refresh()">
          {{ t.jobsRefresh }}
        </button>
        <button data-hotkey="Escape" @click="store.closeJobsDialog()">{{ t.close }}</button>
      </div>
    </div>
  </DialogFrame>
</template>

<script setup lang="ts">
import { computed, onMounted, onBeforeUnmount, reactive } from "vue";
import { t } from "@/common/i18n";
import type { JobSummary } from "@/common/jobs/types";
import { useStore } from "@/renderer/store";
import { JobListManager } from "@/renderer/store/jobs";
import DialogFrame from "./DialogFrame.vue";

const store = useStore();
const list = reactive(new JobListManager());
const states: Record<JobSummary["state"], string> = {
  preparing: t.jobsStatePreparing,
  running: t.jobsStateRunning,
  paused: t.jobsStatePaused,
  takingBack: t.jobsStateTakingBack,
  finishing: t.jobsStateFinishing,
  cancelling: t.jobsStateCancelling,
  completed: t.jobsStateCompleted,
  cancelled: t.jobsStateCancelled,
  failed: t.jobsStateFailed,
};
const errorMessage = computed(() =>
  list.error instanceof Error ? list.error.message : t.jobsInvalid,
);
const terminal = (job: JobSummary) => ["completed", "cancelled", "failed"].includes(job.state);
const onAttach = async (job: JobSummary) => {
  await store.attachJob(job);
  void list.refresh();
};
const onDetach = (job: JobSummary) => {
  store.detachJob(job);
  void list.refresh();
};
onMounted(() => list.start());
onBeforeUnmount(() => list.stop());
</script>

<style scoped>
.root {
  width: min(540px, calc(95vw - 32px));
  max-width: 100%;
  overflow-wrap: anywhere;
}
.form-group {
  max-height: clamp(160px, calc(100dvh - 240px), 800px);
  box-sizing: border-box;
}
ul {
  padding: 0;
  list-style: none;
}
li {
  padding: 12px 0;
}
li:first-child {
  padding-top: 0;
}
li hr {
  margin-top: 0;
}
li .form-item {
  margin: 5px 0;
}
.header {
  display: flex;
  flex-direction: row;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.actions {
  display: flex;
  flex-direction: row;
}
</style>
