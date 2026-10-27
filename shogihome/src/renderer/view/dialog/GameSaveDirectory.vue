<template>
  <ServerDirectoryField
    :value="value"
    :disabled="disabled"
    :label="t.autoSavingDirectory"
    @update:value="emit('update:value', $event)"
  />
</template>

<script setup lang="ts">
import { t } from "@/common/i18n";
import ServerDirectoryField from "./ServerDirectoryField.vue";

defineProps<{ value: string; disabled: boolean }>();
const emit = defineEmits<{ "update:value": [value: string] }>();
</script>
