<template>
  <div ref="root" class="root" :class="{ scroll }">
    <div ref="container" class="row container">
      <div v-for="item of items" :key="item.value" class="item">
        <input
          type="radio"
          :name="name"
          :checked="item.value === value"
          :value="item.value"
          @change="emit('update:value', item.value)"
        />
        <div class="button" :style="buttonStyle">
          <div class="label">{{ item.label }}</div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { issueDOMID } from "@/renderer/helpers/unique";
import { PropType, Ref, computed, ref } from "vue";

type Item = {
  label: string;
  value: string;
};

const props = defineProps({
  value: {
    type: String,
    required: true,
  },
  items: {
    type: Array as PropType<Item[]>,
    required: true,
  },
  height: {
    type: Number,
    default: 28,
  },
  scroll: {
    type: Boolean,
    default: false,
  },
});
const emit = defineEmits<{
  "update:value": [value: string];
}>();

const root = ref<HTMLDivElement>();
const container = ref() as Ref<HTMLDivElement>;
const name = issueDOMID();
const buttonStyle = computed(() => {
  return {
    height: `${props.height}px`,
    minWidth: `${props.height * 2.5}px`,
    fontSize: `${props.height * 0.5}px`,
    borderRadius: `${props.height * 0.25}px`,
    paddingLeft: `${props.height * 0.25}px`,
    paddingRight: `${props.height * 0.25}px`,
  };
});

const setValue = (value: string) => {
  for (const input of container.value.querySelectorAll("input")) {
    if (input.value === value) {
      input.checked = true;
      emit("update:value", value);
      break;
    }
  }
};
const getValue = () => {
  const checked = Array.from(container.value.querySelectorAll("input")).find((input) => {
    if (input.checked) {
      return input.value;
    }
  });
  return checked ? checked.value : props.value;
};
const scrollToSelected = () => {
  if (!props.scroll || !root.value) {
    return;
  }
  const selected = container.value.querySelector("input:checked")?.parentElement;
  if (!selected) {
    return;
  }
  const viewport = root.value.getBoundingClientRect();
  const item = selected.getBoundingClientRect();
  if (item.left < viewport.left) {
    root.value.scrollLeft += item.left - viewport.left;
  } else if (item.right > viewport.right) {
    root.value.scrollLeft += item.right - viewport.right;
  }
};
defineExpose({ setValue, getValue, scrollToSelected });
</script>

<style scoped>
.root {
  display: inline-block;
  vertical-align: top;
  max-width: 100%;
}
.root.scroll {
  display: block;
  width: 100%;
  overflow-x: auto;
  scrollbar-width: none;
}
.root.scroll::-webkit-scrollbar {
  display: none;
}
div.container {
  display: flex;
  flex-direction: row;
  align-items: center;
  flex-wrap: wrap;
}
.root.scroll div.container {
  flex-wrap: nowrap;
  width: max-content;
}
div.item {
  position: relative;
  margin-top: 1px;
  margin-bottom: 1px;
  flex: 0 0 auto;
}
div.item:not(:last-child) {
  margin-right: 2px;
}
input {
  position: absolute;
  left: 0;
  top: 0;
  width: 100%;
  height: 100%;
  margin: 0;
  opacity: 0;
}
.button {
  pointer-events: none;
  left: 0;
  top: 0;
  display: flex;
  align-items: center;
  box-sizing: border-box;
  border: 2px solid var(--selector-bg-color);
  color: var(--selector-color);
  background-color: var(--selector-bg-color);
  box-shadow: 1px 1px 3px 0 var(--control-shadow-color);
}
input:checked ~ .button {
  color: var(--pushed-selector-color);
  border: 2px solid var(--pushed-selector-bg-color);
  background-color: var(--pushed-selector-bg-color);
}
input:focus ~ .button {
  border: 2px solid white;
}
.label {
  pointer-events: none;
  text-align: center;
  width: 100%;
  white-space: nowrap;
}
</style>
