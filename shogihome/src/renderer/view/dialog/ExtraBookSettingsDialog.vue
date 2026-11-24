<template>
  <DialogFrame @cancel="onCancel">
    <form class="root" @submit.prevent="onOk">
      <div class="title">{{ t.settings }}</div>
      <div class="form-group">
        <div class="form-item">
          <div class="form-item-label">{{ t.bookMoveSelection }}</div>
          <div class="form-item-value selection-rule-value">
            <HorizontalSelector
              v-model:value="localConfig.moveSelectionRule"
              :items="[
                { value: BookMoveSelectionRule.UNIFORM, label: t.bookMoveSelectionUniform },
                { value: BookMoveSelectionRule.WEIGHTED_BY_COUNT, label: t.frequency },
                { value: BookMoveSelectionRule.WEIGHTED_BY_SCORE, label: t.evaluation },
              ]"
            />
          </div>
        </div>
        <div
          v-if="localConfig.moveSelectionRule === BookMoveSelectionRule.WEIGHTED_BY_SCORE"
          class="form-item"
        >
          <div class="form-item-label">{{ t.bookMoveScoreTemperature }}</div>
          <div class="form-item-value">
            <input
              v-model.number="localConfig.scoreTemperature"
              class="number"
              type="number"
              :min="Number.MIN_VALUE"
              :max="MAX_BOOK_SETTING_VALUE"
              step="any"
            />
          </div>
        </div>
        <div class="form-item">
          <label :for="maxMovesId" class="form-item-label with-note">{{ t.bookMaxMoves }}</label>
          <div class="form-item-value">
            <input
              :id="maxMovesId"
              v-model.number="localConfig.maxMoves"
              class="number"
              type="number"
              min="0"
              :max="MAX_BOOK_SETTING_VALUE"
              step="1"
              :placeholder="t.noLimit"
            />
          </div>
        </div>
        <div class="form-item">
          <div class="form-item-label">{{ t.bookMinEvalBlack }}</div>
          <div class="form-item-value">
            <input
              v-model.number="localConfig.minEvalBlack"
              :disabled="filterCapabilities?.score === false"
              class="number"
              type="number"
              :min="-MAX_BOOK_SETTING_VALUE"
              :max="MAX_BOOK_SETTING_VALUE"
              step="any"
              :placeholder="t.noLimit"
            />
          </div>
        </div>
        <div class="form-item">
          <div class="form-item-label">{{ t.bookMinEvalWhite }}</div>
          <div class="form-item-value">
            <input
              v-model.number="localConfig.minEvalWhite"
              :disabled="filterCapabilities?.score === false"
              class="number"
              type="number"
              :min="-MAX_BOOK_SETTING_VALUE"
              :max="MAX_BOOK_SETTING_VALUE"
              step="any"
              :placeholder="t.noLimit"
            />
          </div>
        </div>
        <div class="form-item">
          <div class="form-item-label">{{ t.bookMaxEvalDiff }}</div>
          <div class="form-item-value">
            <input
              v-model.number="localConfig.maxEvalDiff"
              :disabled="filterCapabilities?.score === false"
              class="number"
              type="number"
              min="0"
              :max="MAX_BOOK_SETTING_VALUE"
              step="1"
              :placeholder="t.noLimit"
            />
          </div>
        </div>
        <div class="form-item">
          <label :for="bookDepthLimitId" class="form-item-label with-note">
            {{ t.bookDepthLimit }}
          </label>
          <div class="form-item-value">
            <input
              :id="bookDepthLimitId"
              v-model.number="localConfig.bookDepthLimit"
              :disabled="filterCapabilities?.depth === false"
              class="number"
              type="number"
              min="0"
              :max="MAX_BOOK_SETTING_VALUE"
              step="1"
              :placeholder="t.noLimit"
            />
          </div>
        </div>
        <div class="form-item">
          <div class="form-item-label">{{ t.bookIgnoreRate }}</div>
          <div class="form-item-value">
            <input
              v-model.number="localConfig.ignoreRate"
              class="number short"
              type="number"
              min="0"
              max="100"
              step="1"
            />
            <span class="percent-sign">%</span>
          </div>
        </div>
      </div>
      <div class="main-buttons">
        <button type="submit" data-hotkey="Enter" autofocus>
          {{ t.ok }}
        </button>
        <button type="button" data-hotkey="Escape" @click="onCancel">
          {{ t.cancel }}
        </button>
      </div>
    </form>
  </DialogFrame>
</template>

<script setup lang="ts">
import type { BookFilterCapabilities } from "@/common/book";
import { t } from "@/common/i18n";
import { onMounted, ref, useId } from "vue";
import {
  BookMoveSelectionRule,
  MAX_BOOK_SETTING_VALUE,
  normalizeUSIEngineExtraBookConfig,
  USIEngineExtraBookConfig,
} from "@/common/settings/usi";
import api from "@/renderer/ipc/api";
import DialogFrame from "./DialogFrame.vue";
import HorizontalSelector from "@/renderer/view/primitive/HorizontalSelector.vue";

const props = defineProps<{
  config: USIEngineExtraBookConfig;
}>();

const emit = defineEmits<{
  ok: [config: USIEngineExtraBookConfig];
  cancel: [];
}>();

const maxMovesId = useId();
const bookDepthLimitId = useId();
const initialConfig = normalizeUSIEngineExtraBookConfig(props.config);
const localConfig = ref({ ...initialConfig });
const filterCapabilities = ref<BookFilterCapabilities>();

onMounted(async () => {
  if (!initialConfig.filePath.startsWith("server://")) return;
  try {
    filterCapabilities.value = await api.getBookFilterCapabilities(initialConfig.filePath);
  } catch {
    // Keep settings editable when the file's capabilities are unknown.
  }
});

const onOk = () => {
  emit("ok", normalizeUSIEngineExtraBookConfig(localConfig.value));
};

const onCancel = () => {
  emit("cancel");
};
</script>

<style scoped>
.root {
  width: 560px;
  max-width: 100%;
  box-sizing: border-box;
}
.form-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 8px;
  gap: 16px;
}
.form-item-label {
  flex: 1;
  text-align: left;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.form-item-label.with-note {
  white-space: normal;
}
.form-item-value {
  display: flex;
  align-items: center;
  justify-content: flex-start;
  gap: 4px;
  width: 120px;
  flex-shrink: 0;
}
.form-item-value.selection-rule-value {
  width: 300px;
}
input.number {
  text-align: right;
  width: 100px;
}
input.number.short {
  width: 82px;
}
.percent-sign {
  width: 14px;
  text-align: center;
}
.main-buttons {
  margin-top: 15px;
}
.main-buttons button {
  margin-right: 10px;
  padding: 8px 20px;
  cursor: pointer;
}
@media (max-width: 600px) {
  .root {
    width: 340px;
  }
  .form-item-label {
    font-size: 0.9em;
  }
  .form-item-value {
    width: 100px;
  }
  .form-item-value.selection-rule-value {
    width: 190px;
  }
  input.number {
    width: 80px;
  }
  input.number.short {
    width: 62px;
  }
}
</style>
