<template>
  <DialogFrame limited @cancel="store.closeJobsDialog()">
    <div class="root">
      <div class="title">{{ messages.title }}</div>
      <p v-if="list.error" role="alert">{{ errorMessage }}</p>
      <p v-if="!list.error && !list.loading && !list.jobs.length">{{ messages.empty }}</p>
      <ul>
        <li v-for="job in list.jobs" :key="`${job.kind}:${job.serverInstanceId}:${job.id}`">
          <strong>{{ job.kind === "analysis" ? messages.analysis : messages.game }}</strong>
          <div>
            <small>{{ job.id }}</small>
          </div>
          <div>{{ job.engines.join(" / ") }}</div>
          <div>{{ messages.state }}: {{ messages.states[job.state] }}</div>
          <div>{{ messages.progress }}: {{ job.completed }} / {{ job.total }}</div>
          <div>{{ job.attachment.attached ? messages.attached : messages.detached }}</div>
          <button :disabled="!store.canAttachJob" @click="store.attachJob(job)">
            {{ terminal(job) ? messages.results : messages.attach }}
          </button>
        </li>
      </ul>
      <p>{{ messages.retention }}</p>
      <div class="main-buttons">
        <button v-if="store.canDetachJob" @click="store.detachJob()">{{ messages.detach }}</button>
        <button :disabled="list.loading" @click="list.refresh()">{{ messages.refresh }}</button>
        <button data-hotkey="Escape" @click="store.closeJobsDialog()">{{ t.close }}</button>
      </div>
    </div>
  </DialogFrame>
</template>

<script setup lang="ts">
import { computed, onMounted, onBeforeUnmount, reactive } from "vue";
import { t } from "@/common/i18n";
import { jobTexts } from "@/common/i18n/jobs";
import type { JobSummary } from "@/common/jobs/types";
import { useStore } from "@/renderer/store";
import { useAppSettings } from "@/renderer/store/settings";
import { JobListManager } from "@/renderer/store/jobs";
import DialogFrame from "./DialogFrame.vue";

const store = useStore();
const messages = computed(() => jobTexts(useAppSettings().language));
const list = reactive(new JobListManager());
const errorMessage = computed(() =>
  list.error instanceof Error ? list.error.message : messages.value.invalid,
);
const terminal = (job: JobSummary) => ["completed", "cancelled", "failed"].includes(job.state);
onMounted(() => list.start());
onBeforeUnmount(() => list.stop());
</script>

<style scoped>
.root {
  width: min(540px, calc(95vw - 32px));
  max-width: 100%;
  min-height: 0;
  overflow-y: auto;
  overflow-wrap: anywhere;
}
ul {
  padding: 0;
  list-style: none;
}
li {
  padding: 12px 0;
  border-bottom: 1px solid var(--text-separator-color);
}
li button {
  margin-top: 8px;
}
</style>
