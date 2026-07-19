<template>
  <dialog ref="dialog" :class="appSettings.thema">
    <div class="frame" :class="{ limited }">
      <slot />
    </div>
  </dialog>
</template>

<script setup lang="ts">
import { installHotKeyForDialog, uninstallHotKeyForDialog } from "@/renderer/devices/hotkey";
import { showModalDialog } from "@/renderer/helpers/dialog";
import { onBeforeUnmount, onMounted, ref } from "vue";
import { useAppSettings } from "@/renderer/store/settings";

const dialog = ref<HTMLDialogElement | null>(null);
const appSettings = useAppSettings();

defineProps<{
  limited?: boolean;
}>();

const emit = defineEmits<{
  cancel: [];
}>();

onMounted(() => {
  if (!dialog.value) return;
  showModalDialog(dialog.value, () => emit("cancel"));
  installHotKeyForDialog(dialog.value);
});

onBeforeUnmount(() => {
  if (dialog.value) {
    uninstallHotKeyForDialog(dialog.value);
  }
});

defineExpose({ dialog });
</script>

<style scoped>
dialog {
  width: fit-content;
  max-width: 95vw;
  height: calc(100dvh - 3px - 2em);
  border: none;
  margin: auto;
  padding: 0;
  box-shadow: none;
  background-color: transparent;
  display: flex;
  flex-direction: column;
  justify-content: space-evenly;
  scrollbar-gutter: stable;
  box-sizing: border-box;
}

.dialog-position-center dialog {
  align-items: center;
}
.dialog-position-left dialog {
  align-items: flex-start;
}
.dialog-position-right dialog {
  align-items: flex-end;
}

.frame {
  display: flex;
  flex-direction: column;
  box-sizing: border-box;
  background-color: var(--dialog-bg-color);
  border: 1px solid var(--dialog-border-color);
  border-radius: 10px 10px 10px 10px;
  padding: 15px;
  width: 100%;
  max-width: 100%;
  overflow-x: hidden;
}
.frame.limited {
  max-width: 100%;
  max-height: 100%;
}
</style>
