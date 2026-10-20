<template>
  <div ref="root" class="root">
    <div class="main row" @click="show = !show">
      <div class="current item">{{ items.find((item) => item.value === value)?.label }}</div>
      <Icon :icon="IconType.ARROW_DROP" />
    </div>
    <div v-show="show" class="dropdown">
      <ul>
        <li v-for="item of items" :key="item.value" class="item" @click="onSelect(item.value)">
          {{ item.label }}
        </li>
      </ul>
      <div v-if="!items.length" class="not-found">Not Found</div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { IconType } from "@/renderer/assets/icons";
import Icon from "./Icon.vue";
import { onBeforeUnmount, onMounted, PropType, ref } from "vue";

defineProps({
  value: {
    type: String,
    required: true,
  },
  items: {
    type: Array as PropType<
      {
        label: string;
        value: string;
      }[]
    >,
    required: true,
  },
});
const emit = defineEmits<{
  "update:value": [value: string];
}>();

const root = ref<HTMLElement | null>();
const show = ref(false);

const handleClickOutside = (event: Event) => {
  if (!root.value?.contains(event.target as Node)) {
    show.value = false;
  }
};

const onSelect = (value: string) => {
  emit("update:value", value);
  show.value = false;
};

onMounted(() => {
  document.addEventListener("click", handleClickOutside);
});

onBeforeUnmount(() => {
  document.removeEventListener("click", handleClickOutside);
});
</script>

<style scoped>
.root {
  position: relative;
  font-size: 0.9em;
}
.main {
  width: 100%;
  height: 1.6em;
  box-sizing: border-box;
  border: 1px solid var(--input-border-color);
}
.main > .current {
  width: 100%;
}
.main > .icon {
  width: auto;
  height: 100%;
  background-color: gray;
}
.dropdown {
  position: absolute;
  top: 100%;
  left: 0;
  width: 100%;
  box-sizing: border-box;
  background-color: var(--text-bg-color);
  border: 1px solid var(--input-border-color);
  box-shadow: 1px 4px 8px 0 var(--control-shadow-color);
  z-index: 1000;
}
.item {
  line-height: 1.5;
  padding-left: 0.2em;
  color: var(--text-color);
  background-color: var(--text-bg-color);
  text-align: left;
  white-space: nowrap;
  overflow: hidden;
  user-select: none;
}
ul {
  list-style: none;
  padding: 0;
  margin: 0;
}
li:hover {
  background-color: var(--text-bg-color-selected);
}
.not-found {
  padding: 0.2em;
  color: var(--text-color);
  background-color: var(--text-bg-color);
  text-align: center;
  white-space: nowrap;
  overflow: hidden;
  user-select: none;
}
</style>
