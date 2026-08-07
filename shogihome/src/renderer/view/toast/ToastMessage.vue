<template>
  <Teleport v-if="isActiveDialog(dialogTarget)" :to="dialogTarget">
    <ToastContainer inside-dialog />
  </Teleport>
  <ToastContainer v-else />
</template>

<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from "vue";
import ToastContainer from "./ToastContainer.vue";

const dialogTarget = ref<HTMLDialogElement | null>(null);
let dialogObserver: MutationObserver | undefined;

const isActiveDialog = (target: HTMLDialogElement | null): target is HTMLDialogElement =>
  !!target?.isConnected && target.open;

const updateDialogTarget = () => {
  const activeElement = document.activeElement;
  const focusedDialog = activeElement?.closest<HTMLDialogElement>("dialog[open]");
  if (focusedDialog?.isConnected) {
    dialogTarget.value = focusedDialog;
    return;
  }

  const dialogs = document.querySelectorAll<HTMLDialogElement>("dialog[open]");
  dialogTarget.value = dialogs.item(dialogs.length - 1) || null;
};

const containsDialog = (node: Node): boolean =>
  node instanceof HTMLDialogElement ||
  (node instanceof Element && node.querySelector("dialog") !== null);

const handleDialogMutations: MutationCallback = (mutations) => {
  const dialogChanged = mutations.some(
    (mutation) =>
      (mutation.type === "attributes" && mutation.target instanceof HTMLDialogElement) ||
      [...mutation.addedNodes, ...mutation.removedNodes].some(containsDialog),
  );
  if (dialogChanged) {
    updateDialogTarget();
  }
};

onMounted(() => {
  updateDialogTarget();
  dialogObserver = new MutationObserver(handleDialogMutations);
  dialogObserver.observe(document.body, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ["open"],
  });
});

onBeforeUnmount(() => {
  dialogObserver?.disconnect();
});
</script>
