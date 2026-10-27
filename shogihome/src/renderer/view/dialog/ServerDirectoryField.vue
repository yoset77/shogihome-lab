<template>
  <fieldset class="server-directory-field" :disabled="disabled" :aria-label="label">
    <div class="row align-center">
      <span class="server-prefix" aria-hidden="true">server://</span>
      <input
        class="grow"
        type="text"
        :aria-label="label"
        :aria-description="value || t.directoryNotSelected"
        :value="relativePath"
        :placeholder="value ? '' : t.directoryNotSelected"
        @input="onInput"
      />
      <button ref="selectButton" class="thin" type="button" @click="onOpen">{{ t.select }}</button>
    </div>
  </fieldset>
  <Teleport to="body">
    <ServerDirectoryPickerDialog
      v-if="pickerOpen"
      :initial-path="trimTrailingPathSeparators(relativePath)"
      :title="label"
      @select="onConfirm"
      @cancel="closePicker"
    />
  </Teleport>
</template>

<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue";
import { t } from "@/common/i18n";
import { trimTrailingPathSeparators } from "@/common/helpers/path";
import ServerDirectoryPickerDialog from "./ServerDirectoryPickerDialog.vue";

const props = defineProps<{ value: string; disabled: boolean; label: string }>();
const emit = defineEmits<{ "update:value": [value: string] }>();
const pickerOpen = ref(false);
const selectButton = ref<HTMLButtonElement>();
const relativePath = computed(() =>
  props.value.startsWith("server://") ? props.value.substring(9) : props.value,
);

const closePicker = async () => {
  pickerOpen.value = false;
  await nextTick();
  if (!props.disabled) selectButton.value?.focus();
};
const onOpen = () => {
  if (!props.disabled) pickerOpen.value = true;
};
const onConfirm = (directory: string) => {
  if (props.disabled) return;
  emit("update:value", "server://" + directory);
  void closePicker();
};
const onInput = (event: Event) => {
  if (props.disabled) return;
  const target = event.target as HTMLInputElement;
  const input = target.value;
  // Normalize URI pastes even when the underlying model value does not change.
  if (input.startsWith("server://")) target.value = input.substring(9);
  emit("update:value", !input || input.startsWith("server://") ? input : "server://" + input);
};

watch(
  () => props.disabled,
  (disabled) => {
    if (disabled) pickerOpen.value = false;
  },
);
</script>

<style scoped>
.server-directory-field {
  width: 100%;
  min-width: 0;
  margin: 0;
  padding: 0;
  border: none;
}
.server-directory-field input {
  min-width: 0;
  width: 100%;
}
.server-prefix {
  font-size: 0.9em;
  opacity: 0.6;
}
</style>
