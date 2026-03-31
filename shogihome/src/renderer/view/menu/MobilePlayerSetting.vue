<template>
  <div class="player-setting-list" :class="{ disabled }">
    <!-- Player Selection Row -->
    <div class="list-item">
      <div class="item-label">{{ t.player }}</div>
      <div class="item-value">
        <select
          v-model="playerUri"
          class="standard-select"
          :disabled="disabled"
          @change="onPlayerChange"
        >
          <option :value="uri.ES_HUMAN">{{ t.human }}</option>
          <template v-if="lanStore.engineList.value.length > 0">
            <option
              v-for="info in lanStore.engineList.value.filter(
                (e) => !e.type || e.type === 'game' || e.type === 'both',
              )"
              :key="info.id"
              :value="`lan-engine:${info.id}`"
            >
              {{ info.name }}
            </option>
          </template>
          <option v-else value="lan-engine">LAN Engine</option>
          <option :value="uri.ES_BASIC_ENGINE_STATIC_ROOK_V1">
            {{ t.beginner }} ({{ t.staticRook }})
          </option>
          <option :value="uri.ES_BASIC_ENGINE_RANGING_ROOK_V1">
            {{ t.beginner }} ({{ t.rangingRook }})
          </option>
        </select>
      </div>
      <div class="item-icon-placeholder"></div>
    </div>

    <!-- Time Limit Row -->
    <div class="list-item clickable" @click="!disabled && (showTimeDialog = true)">
      <div class="item-label">{{ t.timeLimit }}</div>
      <div class="item-value highlight">
        <span class="time-text">{{ getTimeDescription() }}</span>
        <Icon :icon="IconType.SETTINGS" class="edit-icon" />
      </div>
    </div>

    <!-- Extra Book Row (Engine only) -->
    <template v-if="isEngine">
      <div class="list-item">
        <div class="item-label">{{ t.frontendBook }}</div>
        <div class="item-value">
          <ToggleButton v-model:value="extraBook.enabled" :disabled="disabled" />
        </div>
        <div class="item-icon-placeholder"></div>
      </div>
      <div v-if="extraBook.enabled" class="list-item-full">
        <DropdownList
          :value="extraBook.filePath"
          :items="bookFileList"
          :tags="[]"
          :disabled="disabled"
          @update:value="(val: string) => (extraBook.filePath = val)"
        />
      </div>
    </template>

    <MobileTimeSettingDialog
      v-if="showTimeDialog"
      :initial-settings="timeLimit"
      @ok="onTimeOk"
      @cancel="showTimeDialog = false"
    />
  </div>
</template>

<script setup lang="ts">
import { t } from "@/common/i18n";
import * as uri from "@/common/uri";
import Icon from "@/renderer/view/primitive/Icon.vue";
import { IconType } from "@/renderer/assets/icons";
import { useLanStore } from "@/renderer/store/lan";
import { ref, computed } from "vue";
import { TimeLimitSettings } from "@/common/settings/game";
import MobileTimeSettingDialog from "./MobileTimeSettingDialog.vue";
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

const isEngine = computed(() => playerUri.value !== uri.ES_HUMAN);

const onPlayerChange = (event: Event) => {
  const select = event.target as HTMLSelectElement;
  const option = select.options[select.selectedIndex];
  playerName.value = option.text;
};

const onTimeOk = (newSettings: TimeLimitSettings) => {
  timeLimit.value = { ...newSettings };
  showTimeDialog.value = false;
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
  grid-template-columns: 110px 1fr 30px;
  align-items: center;
  padding: 10px 0;
  border-bottom: 1px solid var(--text-separator-color);
}
.list-item-full {
  padding: 10px 0;
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
.standard-select {
  width: 100%;
  height: 32px;
  background-color: transparent;
  color: var(--text-color);
  border: none;
  font-size: 1em;
  font-weight: bold;
  padding: 0;
  appearance: none;
  background-image: url("data:image/svg+xml;charset=UTF-8,%3csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='gray'%3e%3cpath d='M7 10l5 5 5-5z'/%3e%3c/svg%3e");
  background-repeat: no-repeat;
  background-position: right center;
  background-size: 20px;
  text-align: right;
}
.standard-select option {
  text-align: left;
  background-color: var(--main-bg-color);
  color: var(--main-color);
}
.item-icon-placeholder {
  width: 30px;
}
.edit-icon {
  font-size: 1.2em;
  color: var(--text-color);
  opacity: 0.6;
}
</style>
