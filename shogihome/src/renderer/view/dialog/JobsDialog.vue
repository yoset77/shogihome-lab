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
              <strong>{{
                job.batch ? t.batchAnalysis : job.kind === "analysis" ? t.jobsAnalysis : t.jobsGame
              }}</strong>
              <span class="actions">
                <button
                  v-if="!job.batch?.parallel && !job.parallelGame"
                  :disabled="!store.canAttachJob"
                  @click="onAttach(job)"
                >
                  {{ terminal(job) ? t.jobsOpenResults : t.jobsAttach }}
                </button>
                <button v-if="store.canDetachListedJob(job)" @click="onDetach(job)">
                  {{ t.jobsDetach }}
                </button>
                <button v-if="job.batch" @click="resultsJob = job.id">
                  {{ t.batchAnalysisDetails }}
                </button>
                <button v-if="job.parallelGame" @click="gameResultsJob = job.id">
                  {{ t.batchAnalysisDetails }}
                </button>
                <button
                  v-if="(job.batch?.parallel || job.parallelGame) && !terminal(job)"
                  :disabled="!list.canCancel(job)"
                  @click="list.cancel(job)"
                >
                  {{ job.kind === "game" ? t.interrupt : t.stopAnalysis }}
                </button>
              </span>
            </div>
            <div class="form-item">
              <span class="form-item-label">{{ t.jobsState }}</span>
              <span>{{ states[job.state] }}</span>
            </div>
            <div class="form-item">
              <span class="form-item-label">{{ t.jobsProgress }}</span>
              <span>{{
                job.batch || job.kind === "game"
                  ? t.jobsProgressGames(job.completed, job.total)
                  : t.jobsProgressMoves(job.completed, job.total)
              }}</span>
            </div>
            <div>{{ job.engines.join(" / ") }}</div>
            <template v-if="job.parallelGame">
              <div>
                {{
                  t.parallelGameProgress(job.parallelGame.activeGames, job.parallelGame.parallelism)
                }}
              </div>
              <div>{{ gameResultLine(job.parallelGame.results) }}</div>
              <div v-if="job.parallelGame.error" role="alert">
                {{ gameErrors[job.parallelGame.error] }}
              </div>
            </template>
            <template v-if="job.batch">
              <div v-if="job.batch.parallel">
                {{
                  t.batchAnalysisParallelProgress(
                    job.batch.parallel.activeFiles,
                    job.batch.parallel.parallelism,
                  )
                }}
              </div>
              <div>
                {{
                  t.batchAnalysisSummary(
                    job.batch.successTotal,
                    job.batch.failedTotal,
                    job.batch.skippedTotal,
                  )
                }}
              </div>
            </template>
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
  <BatchAnalysisResultsDialog
    v-if="resultsJob"
    :key="resultsJob"
    :job-id="resultsJob"
    @close="resultsJob = undefined"
  />
  <GameJobResultsDialog
    v-if="gameResultsJob"
    :key="gameResultsJob"
    :job-id="gameResultsJob"
    @close="gameResultsJob = undefined"
  />
</template>

<script setup lang="ts">
import { computed, onMounted, onBeforeUnmount, reactive, ref } from "vue";
import { t } from "@/common/i18n";
import type { JobSummary } from "@/common/jobs/types";
import type { GameResults } from "@/common/game/results";
import { useStore } from "@/renderer/store";
import { JobListManager } from "@/renderer/store/jobs";
import DialogFrame from "./DialogFrame.vue";
import BatchAnalysisResultsDialog from "./BatchAnalysisResultsDialog.vue";
import GameJobResultsDialog from "./GameJobResultsDialog.vue";

const store = useStore();
const list = reactive(new JobListManager());
const resultsJob = ref<string>();
const gameResultsJob = ref<string>();
const gameErrors = { engine: t.gameEngineError, capacity: t.gameCapacity, save: t.gameSaveFailed };
const gameResultLine = (results: GameResults) => {
  const { player1, player2, draw, invalid } = results;
  return t.parallelGameResults(player1.name, player1.win, player2.name, player2.win, draw, invalid);
};
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
  flex-wrap: wrap;
  gap: 4px;
}
</style>
