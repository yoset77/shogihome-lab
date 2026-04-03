<template>
  <div class="player-setting-list" :class="{ disabled }">
    <!-- Player Selection Row -->
    <div class="list-item">
      <div class="item-label">{{ t.player }}</div>
      <div class="item-value">
        <DropdownList
          class="player-select"
          :value="playerUri"
          :items="playerItems"
          :tags="[]"
          :disabled="disabled"
          @update:value="onPlayerChange"
        />
      </div>
      <div class="item-icon-placeholder"></div>
    </div>

    <!-- Time Limit Row -->
    <div class="list-item clickable" @click="!disabled && (showTimeDialog = true)">
      <div class="item-label">{{ t.timeLimit }}</div>
      <div class="item-value highlight">
        <span class="time-text">{{ getTimeDescription() }}</span>
      </div>
      <button class="action-btn" :disabled="disabled">{{ t.settings }}</button>
    </div>

    <!-- Extra Book Row (LAN Engine only) -->
    <template v-if="isLanEngine">
      <div class="list-item">
        <div class="item-label">{{ t.frontendBook }}</div>
        <div class="item-value">
          <ToggleButton v-model:value="extraBook.enabled" :disabled="disabled" />
        </div>
        <div class="item-icon-placeholder"></div>
      </div>
      <div v-if="extraBook.enabled" class="list-item-full book-file-row">
        <DropdownList
          :value="extraBook.filePath"
          :items="bookFileList"
          :tags="[]"
          :disabled="disabled"
          @update:value="(val: string) => (extraBook.filePath = val)"
        />
        <button
          class="book-settings-btn"
          :disabled="disabled"
          @click="showBookSettingsDialog = true"
        >
          {{ t.settings }}
        </button>
      </div>
    </template>

    <MobileTimeSettingDialog
      v-if="showTimeDialog"
      :initial-settings="timeLimit"
      @ok="onTimeOk"
      @cancel="showTimeDialog = false"
    />
    <ExtraBookSettingsDialog
      v-if="showBookSettingsDialog"
      :config="extraBook"
      @ok="onBookSettingsOk"
      @cancel="showBookSettingsDialog = false"
    />
  </div>
</template>

<script setup lang="ts">
import { t } from "@/common/i18n";
import * as uri from "@/common/uri";
import { useLanStore } from "@/renderer/store/lan";
import { ref, computed } from "vue";
import { TimeLimitSettings } from "@/common/settings/game";
import MobileTimeSettingDialog from "./MobileTimeSettingDialog.vue";
import ExtraBookSettingsDialog from "@/renderer/view/dialog/ExtraBookSettingsDialog.vue";
import ToggleButton from "@/renderer/view/primitive/ToggleButton.vue";
import DropdownList from "@/renderer/view/primitive/DropdownList.vue";
import { USIEngineExtraBookConfig } from "@/common/settings/usi";

defineProps({
  disabled: {
    type: Boolean,
    default: false,
  },
  bookFileList: {
    type: Array as () => { label: string; value: string }[],
    required: true,
  },
});

const lanStore = useLanStore();

const playerUri = defineModel<string>("playerUri", { required: true });
const playerName = defineModel<string>("playerName", { required: true });
const timeLimit = defineModel<TimeLimitSettings>("timeLimit", { required: true });
const extraBook = defineModel<USIEngineExtraBookConfig>("extraBook", { required: true });

const showTimeDialog = ref(false);
const showBookSettingsDialog = ref(false);

const isLanEngine = computed(() => playerUri.value.startsWith("lan-engine"));

const playerItems = computed(() => {
  const items = [{ value: uri.ES_HUMAN, label: t.human }];
  if (lanStore.engineList.value.length > 0) {
    lanStore.engineList.value
      .filter((e) => !e.type || e.type === "game" || e.type === "both")
      .forEach((info) => {
        items.push({ value: `lan-engine:${info.id}`, label: info.name });
      });
  } else {
    items.push({ value: "lan-engine", label: "LAN Engine" });
  }
  items.push({
    value: uri.ES_BASIC_ENGINE_STATIC_ROOK_V1,
    label: `${t.beginner} (${t.staticRook})`,
  });
  items.push({
    value: uri.ES_BASIC_ENGINE_RANGING_ROOK_V1,
    label: `${t.beginner} (${t.rangingRook})`,
  });
  return items;
});

const onPlayerChange = (val: string) => {
  playerUri.value = val;
  const item = playerItems.value.find((i) => i.value === val);
  if (item) {
    playerName.value = item.label;
  }
};

const onTimeOk = (newSettings: TimeLimitSettings) => {
  timeLimit.value = { ...newSettings };
  showTimeDialog.value = false;
};

const onBookSettingsOk = (config: USIEngineExtraBookConfig) => {
  extraBook.value = config;
  showBookSettingsDialog.value = false;
};

const getTimeDescription = () => {
  const h = Math.floor(timeLimit.value.timeSeconds / 3600);
  const m = Math.floor((timeLimit.value.timeSeconds % 3600) / 60);
  let text = "";
  if (h > 0) text += `${h}${t.hoursSuffix}`;
  if (m > 0 || h === 0) text += `${m}${t.minutesSuffix}`;
  if (timeLimit.value.byoyomi > 0) text += ` / ${timeLimit.value.byoyomi}s`;
  if (timeLimit.value.increment > 0) text += ` / +${timeLimit.value.increment}s`;
  return text;
};
</script>

<style scoped>
.player-setting-list {
  display: flex;
  flex-direction: column;
}
.list-item {
  display: grid;
  grid-template-columns: 110px 1fr auto;
  align-items: center;
  padding: 12px 0;
  border-bottom: 1px solid var(--text-separator-color);
}
.list-item-full {
  padding: 12px 0;
  border-bottom: 1px solid var(--text-separator-color);
}
.list-item:last-child,
.list-item-full:last-child {
  border-bottom: none;
}
.list-item.clickable:active {
  background-color: var(--selector-bg-color);
  opacity: 0.7;
}
.item-label {
  font-size: 0.9em;
  color: var(--text-color);
  opacity: 0.8;
  text-align: left;
}
.item-value {
  flex: 1;
  text-align: right;
  display: flex;
  justify-content: flex-end;
  align-items: center;
  gap: 8px;
}
.time-text {
  font-size: 1em;
  font-weight: bold;
  color: var(--text-color);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.player-select {
  width: 100%;
}
.item-icon-placeholder {
  width: 30px;
}
.action-btn {
  padding: 4px 12px;
  font-size: 0.85em;
  background-color: var(--control-bg-color);
  color: var(--control-button-color);
  border: 1px solid var(--control-border-color);
  cursor: pointer;
  white-space: nowrap;
}
.action-btn:active:not(:disabled) {
  background-color: var(--selector-bg-color);
  opacity: 0.7;
}
.action-btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}
.book-file-row {
  display: flex;
  gap: 6px;
  align-items: center;
  padding: 8px 0;
}
.book-file-row > :first-child {
  flex: 1;
}
.book-settings-btn {
  flex-shrink: 0;
  padding: 4px 12px;
  font-size: 0.85em;
  background-color: var(--control-bg-color);
  color: var(--control-button-color);
  border: 1px solid var(--control-border-color);
  cursor: pointer;
  white-space: nowrap;
}
.book-settings-btn:active:not(:disabled) {
  background-color: var(--selector-bg-color);
  opacity: 0.7;
}
.book-settings-btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}
</style>
