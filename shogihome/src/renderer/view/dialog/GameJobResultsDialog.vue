<template>
  <DialogFrame limited @cancel="emit('close')">
    <div class="root">
      <h3>{{ t.batchAnalysisDetails }}</h3>
      <p v-if="error" role="alert">{{ error }}</p>
      <ol>
        <li v-for="record in records" :key="record.gameId">
          <div>{{ record.path ?? record.gameId }}</div>
          <div>{{ states[record.state] }}</div>
          <button v-if="record.path" :disabled="!store.canAttachJob" @click="open(record.path)">
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
import type { GameRecordSummary } from "@/common/game/protocol";
import { createGameSessionsClient } from "@/renderer/api/game_sessions";
import { useStore } from "@/renderer/store";
import DialogFrame from "./DialogFrame.vue";

const props = defineProps<{ jobId: string }>();
const emit = defineEmits<{ close: [] }>();
const store = useStore();
const client = createGameSessionsClient();
const records = ref<GameRecordSummary[]>([]);
const error = ref("");
const loading = ref(false);
const states = { saved: t.success, unsaved: t.parallelGameHistoryOnly, failed: t.gameSaveFailed };
async function refresh() {
  loading.value = true;
  error.value = "";
  try {
    records.value = (await client.snapshot(props.jobId)).records;
  } catch (e) {
    error.value = e instanceof Error ? e.message : t.jobsInvalid;
  } finally {
    loading.value = false;
  }
}
async function open(path: string) {
  if (await store.openJobRecordFile(path, "game")) emit("close");
}
onMounted(refresh);
</script>
<style scoped>
.root {
  width: min(540px, calc(95vw - 32px));
  overflow-wrap: anywhere;
}
ol {
  max-height: 50dvh;
  overflow-y: auto;
}
li {
  margin-bottom: 12px;
}
</style>
