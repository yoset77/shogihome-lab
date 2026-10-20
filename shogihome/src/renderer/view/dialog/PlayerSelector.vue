<template>
  <DropdownList v-model:value="selectedPlayerURI" class="player-select" :items="listItems" />
  <div v-if="$slots['extra-buttons']" class="horizontal-buttons">
    <slot name="extra-buttons"></slot>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted } from "vue";
import { t } from "@/common/i18n";
import { ES_HUMAN } from "@/common/uri";
import type { LanEngineType } from "@/common/engine/relay_protocol";
import DropdownList from "@/renderer/view/primitive/DropdownList.vue";
import { useLanStore } from "@/renderer/store/lan";

const selectedPlayerURI = defineModel<string>("playerUri", { required: true });
const props = defineProps<{
  engineType: LanEngineType;
  containsHuman?: boolean;
  showNone?: boolean;
}>();
const lanStore = useLanStore();

onMounted(() => {
  if (lanStore.status.value === "disconnected") {
    void lanStore.fetchEngineList();
  }
});

const listItems = computed(() => {
  const items = [];
  if (props.showNone) items.push({ label: t.none, value: "" });
  if (props.containsHuman) items.push({ label: t.human, value: ES_HUMAN });
  if (lanStore.status.value === "connecting") {
    items.push({ label: t.connecting, value: "", disabled: true });
  } else {
    for (const engine of lanStore.engineList.value) {
      if (engine.type && !engine.type.includes(props.engineType)) continue;
      items.push({ label: engine.name, value: `lan-engine:${engine.id}` });
    }
  }
  return items;
});
</script>

<style scoped>
.player-select {
  width: 100%;
  margin-bottom: 5px;
}
.horizontal-buttons {
  display: flex;
  justify-content: center;
  align-items: center;
  gap: 5px;
  margin-top: 5px;
}
</style>
