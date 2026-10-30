<template>
  <aside
    v-if="store.available && store.expanded"
    class="pwa-update"
    role="status"
    aria-live="polite"
  >
    <div>{{ t.webUpdateReady }}</div>
    <div v-if="store.failed">{{ t.webUpdateFailed }}</div>
    <div v-else-if="!store.canApply && !store.applying">{{ t.webUpdateBlocked }}</div>
    <div class="actions">
      <button :disabled="!store.canApply" @click="store.apply()">{{ t.update }}</button>
      <button :disabled="store.applying" @click="store.dismiss()">
        {{ t.webUpdateLater }}
      </button>
    </div>
  </aside>
</template>

<script setup lang="ts">
import { t } from "@/common/i18n";
import { usePwaUpdateStore } from "@/renderer/store/pwa";

const store = usePwaUpdateStore();
</script>

<style scoped>
.pwa-update {
  position: fixed;
  right: 12px;
  bottom: calc(36px + env(safe-area-inset-bottom));
  z-index: 1001;
  box-sizing: border-box;
  max-width: min(420px, calc(100vw - 24px));
  padding: 10px;
  color: var(--text-color);
  background: var(--text-bg-color);
  border: 1px solid var(--control-button-border-color);
}
.actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 8px;
}
button {
  min-height: 36px;
  padding: 4px 12px;
}
</style>
