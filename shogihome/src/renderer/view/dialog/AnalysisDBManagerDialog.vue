<template>
  <DialogFrame @cancel="onClose">
    <div class="root column">
      <div class="title">{{ t.analysisDBManager }}</div>

      <!-- Stats Area -->
      <div class="stats-area column">
        <div v-if="stats.length === 0" class="no-data">
          {{ t.noDataInAnalysisDB }}
        </div>

        <!-- Desktop Table Layout -->
        <div v-if="stats.length > 0" class="table-container desktop-only">
          <table class="stats-table">
            <thead>
              <tr>
                <th>{{ t.engineName }}</th>
                <th class="number">{{ t.recordCount }}</th>
                <th class="number">{{ t.minDepth }}</th>
                <th class="number">{{ t.maxDepth }}</th>
                <th>{{ t.lastUpdated }}</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="stat in stats" :key="stat.id">
                <td class="engine-name">
                  <div class="name-text" :title="stat.name">{{ stat.name }}</div>
                </td>
                <td class="number">{{ stat.record_count.toLocaleString() }}</td>
                <td class="number">{{ stat.min_depth }}</td>
                <td class="number">{{ stat.max_depth }}</td>
                <td class="date">{{ formatDate(stat.last_updated) }}</td>
                <td class="actions">
                  <button class="small" @click="exportEngine(stat)">
                    <Icon :icon="IconType.SAVE_AS" />
                    <span>{{ t.analysisDBExport }}</span>
                  </button>
                  <button class="small" @click="deleteEngine(stat)">
                    <Icon :icon="IconType.DELETE" />
                    <span>{{ t.remove }}</span>
                  </button>
                </td>
              </tr>
            </tbody>
          </table>
        </div>

        <!-- Mobile Card Layout -->
        <div v-if="stats.length > 0" class="list-container mobile-only">
          <div v-for="stat in stats" :key="stat.id" class="stat-card column">
            <div class="stat-header column">
              <div class="engine-name" :title="stat.name">{{ stat.name }}</div>
            </div>
            <div class="stat-body row">
              <div class="stat-item column center">
                <span class="label">{{ t.recordCount }}</span>
                <span class="value">{{ stat.record_count.toLocaleString() }}</span>
              </div>
              <div class="stat-item column center">
                <span class="label">{{ t.minDepth }}</span>
                <span class="value">{{ stat.min_depth }}</span>
              </div>
              <div class="stat-item column center">
                <span class="label">{{ t.maxDepth }}</span>
                <span class="value">{{ stat.max_depth }}</span>
              </div>
            </div>
            <div class="stat-footer row">
              <div class="date">{{ t.lastUpdated }}: {{ formatDate(stat.last_updated) }}</div>
            </div>
            <div class="stat-actions row">
              <button class="action-btn" @click="exportEngine(stat)">
                <Icon :icon="IconType.SAVE_AS" />
                <span>{{ t.analysisDBExport }}</span>
              </button>
              <button class="action-btn" @click="deleteEngine(stat)">
                <Icon :icon="IconType.DELETE" />
                <span>{{ t.remove }}</span>
              </button>
            </div>
          </div>
        </div>
      </div>

      <!-- Integration Section -->
      <div class="integration-area row center">
        <button class="migrate-button" @click="migrate">
          <span>{{ t.integrateDataBasedOnSettings }}</span>
        </button>
      </div>

      <!-- Cleanup Section -->
      <div class="cleanup-area row center">
        <span class="label">{{ t.cleanup }}: {{ t.minDepth }}</span>
        <input v-model.number="minDepth" type="number" min="1" max="100" class="depth-input" />
        <button class="cleanup-button" @click="cleanup">
          <Icon :icon="IconType.TRASH" />
        </button>
      </div>

      <hr />

      <div class="main-buttons">
        <button class="close-button" autofocus @click="onClose">
          {{ t.close }}
        </button>
      </div>
    </div>
  </DialogFrame>
</template>

<script setup lang="ts">
import { ref, onMounted } from "vue";
import { useStore } from "@/renderer/store";
import { t } from "@/common/i18n";
import { IconType } from "@/renderer/assets/icons";
import Icon from "@/renderer/view/primitive/Icon.vue";
import DialogFrame from "@/renderer/view/dialog/DialogFrame.vue";
import { useBusyState } from "@/renderer/store/busy";
import { useMessageStore } from "@/renderer/store/message";
import { useConfirmationStore } from "@/renderer/store/confirm";
import { useErrorStore } from "@/renderer/store/error";
import { useLanStore } from "@/renderer/store/lan";

interface DBEngineStats {
  id: number;
  engine_key: string;
  name: string;
  record_count: number;
  min_depth: number;
  max_depth: number;
  last_updated: number;
}

const store = useStore();
const stats = ref<DBEngineStats[]>([]);
const minDepth = ref(10);

const fetchStats = async () => {
  try {
    const response = await fetch("/api/analysis/stats");
    if (response.ok) {
      stats.value = await response.json();
    } else {
      useErrorStore().add(new Error(`Failed to fetch DB stats: ${await response.text()}`));
    }
  } catch (e) {
    useErrorStore().add(e);
  }
};

onMounted(fetchStats);

const formatDate = (ts: number) => {
  return new Date(ts).toLocaleString();
};

const onClose = () => {
  store.closeAnalysisDBManagerDialog();
};

const exportEngine = async (stat: DBEngineStats) => {
  const defaultName = `${stat.name}.db`;
  const rawName = window.prompt(t.enterFileName, defaultName);
  if (!rawName) return;
  const name = rawName.endsWith(".db") ? rawName : rawName + ".db";

  useBusyState().retain();
  try {
    const response = await fetch("/api/analysis/export", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ engineId: stat.id, filename: name }),
    });
    if (response.ok) {
      useMessageStore().enqueue({ text: t.success });
    } else {
      useErrorStore().add(new Error(`Failed to export engine data: ${await response.text()}`));
    }
  } catch (e) {
    useErrorStore().add(e);
  } finally {
    useBusyState().release();
  }
};

const deleteEngine = (stat: DBEngineStats) => {
  useConfirmationStore().show({
    message: t.confirmDeleteEngineData,
    onOk: async () => {
      useBusyState().retain();
      try {
        const response = await fetch("/api/analysis/delete_by_engine", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ engineId: stat.id }),
        });
        if (response.ok) {
          await fetchStats();
          useMessageStore().enqueue({ text: t.success });
        } else {
          useErrorStore().add(new Error(`Failed to delete engine data: ${await response.text()}`));
        }
      } catch (e) {
        useErrorStore().add(e);
      } finally {
        useBusyState().release();
      }
    },
  });
};

const cleanup = () => {
  useConfirmationStore().show({
    message: t.confirmCleanupData,
    onOk: async () => {
      useBusyState().retain();
      try {
        const response = await fetch("/api/analysis/cleanup", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ minDepth: minDepth.value }),
        });
        if (response.ok) {
          await fetchStats();
          useMessageStore().enqueue({ text: t.success });
        } else {
          useErrorStore().add(new Error(`Failed to cleanup DB: ${await response.text()}`));
        }
      } catch (e) {
        useErrorStore().add(e);
      } finally {
        useBusyState().release();
      }
    },
  });
};

interface MigrationSummary {
  sourceEngineKey: string;
  sourceEngineName: string;
  targetEngineKey: string;
  targetEngineName: string;
  recordCount: number;
}

const migrate = async () => {
  useBusyState().retain();
  try {
    await useLanStore().fetchEngineList(true);
    const dryRunResponse = await fetch("/api/analysis/migrate/dry-run");
    if (!dryRunResponse.ok) {
      throw new Error(`Failed to dry-run migration: ${await dryRunResponse.text()}`);
    }
    const summary = (await dryRunResponse.json()) as MigrationSummary[];
    useBusyState().release();

    if (summary.length === 0) {
      useMessageStore().enqueue({ text: t.noDataToIntegrate });
      return;
    }

    const lines = summary.map((s) =>
      t.nRecordsOfEngineWillBeIntegratedToGroup(
        s.sourceEngineName,
        s.recordCount,
        s.targetEngineName,
      ),
    );
    const message = lines.join("\n") + "\n\n" + t.areYouSureWantToIntegrateData;

    useConfirmationStore().show({
      message,
      onOk: async () => {
        useBusyState().retain();
        try {
          const response = await fetch("/api/analysis/migrate/execute", { method: "POST" });
          if (response.ok) {
            await fetchStats();
            useMessageStore().enqueue({ text: t.dataIntegrationCompleted });
          } else {
            useErrorStore().add(new Error(`Failed to migrate data: ${await response.text()}`));
          }
        } catch (e) {
          useErrorStore().add(e);
        } finally {
          useBusyState().release();
        }
      },
    });
  } catch (e) {
    useErrorStore().add(e);
    useBusyState().release();
  }
};
</script>

<style scoped>
/* Common Layout & Dialog */
.root {
  width: 800px;
  max-width: 90vw;
  min-height: 300px;
  max-height: 80vh;
}
.title {
  font-size: 1.2rem;
  font-weight: bold;
  margin-bottom: 16px;
  text-align: center;
}
.stats-area {
  flex: 1;
  overflow: hidden;
  background-color: var(--text-bg-color);
  border: 1px solid var(--text-separator-color);
  border-radius: 4px;
}
.no-data {
  text-align: center;
  padding: 20px;
  color: var(--text-color-sub);
}

/* Media Queries for Responsive Toggling */
@media (max-width: 600px) {
  .desktop-only {
    display: none !important;
  }
}
@media (min-width: 601px) {
  .mobile-only {
    display: none !important;
  }
}

/* --- Desktop Table Styles --- */
.table-container {
  flex: 1;
  overflow-y: auto;
}
.stats-table {
  width: 100%;
  border-collapse: separate;
  border-spacing: 0;
}
.stats-table th,
.stats-table td {
  padding: 8px;
  text-align: left;
  border-bottom: 1px solid var(--text-separator-color);
  font-size: 0.9rem;
}
.stats-table th {
  background-color: var(--text-bg-color);
  position: sticky;
  top: 0;
  z-index: 1;
}
.stats-table th.number,
.stats-table td.number {
  text-align: right;
}
.stats-table td.engine-name {
  max-width: 200px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.stats-table td.engine-name .name-text {
  font-weight: bold;
}
.stats-table td.date {
  font-size: 0.8rem;
  white-space: nowrap;
}
.actions {
  display: flex;
  gap: 4px;
  justify-content: flex-end;
}
.actions button.small {
  padding: 2px 8px;
  font-size: 0.8rem;
  display: flex;
  align-items: center;
  gap: 4px;
}

/* --- Mobile Card Styles --- */
.list-container {
  flex: 1;
  height: 100%;
  overflow-y: auto;
  padding: 10px;
}
.stat-card {
  background-color: var(--dialog-bg-color);
  border: 1px solid var(--text-separator-color);
  border-radius: 6px;
  margin-bottom: 10px;
  padding: 12px;
  box-shadow: 0 2px 4px rgba(0, 0, 0, 0.1);
}
.stat-card:last-child {
  margin-bottom: 0;
}
.stat-header {
  border-bottom: 1px dashed var(--text-dashed-separator-color);
  padding-bottom: 8px;
  margin-bottom: 8px;
  justify-content: space-between;
}
.engine-name {
  font-weight: bold;
  font-size: 1.05rem;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.stat-body {
  justify-content: space-around;
  margin-bottom: 8px;
  flex-wrap: wrap;
  gap: 10px;
}
.stat-item {
  background-color: var(--text-bg-color-transparent);
  padding: 4px 12px;
  border-radius: 4px;
  min-width: 80px;
}
.stat-item .label {
  font-size: 0.75rem;
  color: var(--text-color-sub);
}
.stat-item .value {
  font-size: 1.1rem;
  font-weight: bold;
}
.stat-footer {
  justify-content: flex-end;
  font-size: 0.8rem;
  color: var(--text-color-sub);
  margin-bottom: 8px;
}
.stat-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  justify-content: flex-end;
}
.action-btn {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 6px 12px;
  font-size: 0.85rem;
  flex: 1;
  min-width: fit-content;
  white-space: normal; /* Allow text wrapping */
  text-align: center;
  justify-content: center;
  line-height: 1.2;
}

/* Cleanup & Footer */
.integration-area {
  padding: 16px 0 8px 0;
}
.migrate-button {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 16px;
}
.cleanup-area {
  padding: 8px 0 16px 0;
  gap: 12px;
  flex-wrap: wrap;
}
.depth-input {
  width: 60px;
  height: 24px;
  box-sizing: border-box;
}
.cleanup-button {
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 2px 8px;
  height: 24px;
  box-sizing: border-box;
}
.main-buttons {
  margin-top: 16px;
  text-align: center;
}
.close-button {
  width: 100px;
}
</style>
