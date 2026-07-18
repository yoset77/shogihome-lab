<template>
  <DialogFrame @cancel="onCancel">
    <div class="root">
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
              min="1"
              step="1"
            />
          </div>
        </div>
        <div class="form-item">
          <div class="form-item-label">{{ t.bookMaxMoves }}</div>
          <div class="form-item-value">
            <input
              v-model.number="localConfig.maxMoves"
              class="number"
              type="number"
              min="0"
              max="100"
              step="1"
              :placeholder="t.unlimited"
            />
          </div>
        </div>
        <div class="form-item">
          <div class="form-item-label">{{ t.bookMinEvalBlack }}</div>
          <div class="form-item-value">
            <input
              v-model.number="localConfig.minEvalBlack"
              class="number"
              type="number"
              step="1"
              :placeholder="t.noLimit"
            />
          </div>
        </div>
        <div class="form-item">
          <div class="form-item-label">{{ t.bookMinEvalWhite }}</div>
          <div class="form-item-value">
            <input
              v-model.number="localConfig.minEvalWhite"
              class="number"
              type="number"
              step="1"
              :placeholder="t.noLimit"
            />
          </div>
        </div>
        <div class="form-item">
          <div class="form-item-label">{{ t.bookMaxEvalDiff }}</div>
          <div class="form-item-value">
            <input
              v-model.number="localConfig.maxEvalDiff"
              class="number"
              type="number"
              min="0"
              step="1"
              :placeholder="t.noLimit"
            />
          </div>
        </div>
        <div class="form-item">
          <div class="form-item-label">{{ t.bookDepthLimit }}</div>
          <div class="form-item-value">
            <input
              v-model.number="localConfig.bookDepthLimit"
              class="number"
              type="number"
              min="0"
              step="1"
              :placeholder="t.unlimited"
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
        <button data-hotkey="Enter" autofocus @click="onOk">
          {{ t.ok }}
        </button>
        <button data-hotkey="Escape" @click="onCancel">
          {{ t.cancel }}
        </button>
      </div>
    </div>
  </DialogFrame>
</template>

<script setup lang="ts">
import { t } from "@/common/i18n";
import { ref } from "vue";
import {
  BookMoveSelectionRule,
  DEFAULT_BOOK_MOVE_SCORE_TEMPERATURE,
  normalizeUSIEngineExtraBookConfig,
  USIEngineExtraBookConfig,
} from "@/common/settings/usi";
import DialogFrame from "./DialogFrame.vue";
import HorizontalSelector from "@/renderer/view/primitive/HorizontalSelector.vue";

const props = defineProps<{
  config: USIEngineExtraBookConfig;
}>();

const emit = defineEmits<{
  ok: [config: USIEngineExtraBookConfig];
  cancel: [];
}>();

const localConfig = ref<USIEngineExtraBookConfig>(normalizeUSIEngineExtraBookConfig(props.config));

const onOk = () => {
  const config = { ...localConfig.value };

  if ((config.minEvalBlack as unknown) === "") config.minEvalBlack = undefined;
  if ((config.minEvalWhite as unknown) === "") config.minEvalWhite = undefined;
  if ((config.maxEvalDiff as unknown) === "") config.maxEvalDiff = undefined;
  if ((config.maxMoves as unknown) === "") config.maxMoves = 0;
  if ((config.ignoreRate as unknown) === "") config.ignoreRate = 0;
  if ((config.bookDepthLimit as unknown) === "") config.bookDepthLimit = 0;
  if ((config.scoreTemperature as unknown) === "") {
    config.scoreTemperature = DEFAULT_BOOK_MOVE_SCORE_TEMPERATURE;
  }

  emit("ok", normalizeUSIEngineExtraBookConfig(config));
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
