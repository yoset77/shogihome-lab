<template>
  <div
    class="toast-container"
    :class="{ mobile: isMobile, 'mobile-bottom': isMobile && !insideDialog }"
    aria-live="polite"
  >
    <TransitionGroup name="toast" tag="div">
      <div
        v-for="toast in displayedToasts"
        :key="toast.id"
        class="toast"
        :class="`toast-${toast.type}`"
        :role="toast.type === 'warning' || toast.type === 'error' ? 'alert' : 'status'"
        tabindex="0"
        @click="store.dismiss(toast.id)"
        @keydown.enter="store.dismiss(toast.id)"
        @keydown.space.prevent="store.dismiss(toast.id)"
      >
        <Icon :icon="iconFor(toast.type)" />
        <span class="toast-text">
          {{ toast.message
          }}<span v-if="toast.count > 1" class="toast-count"> ({{ toast.count }})</span>
        </span>
      </div>
    </TransitionGroup>
  </div>
</template>

<script setup lang="ts">
import { IconType } from "@/renderer/assets/icons";
import Icon from "@/renderer/view/primitive/Icon.vue";
import { computed } from "vue";
import { ToastType, useToastStore } from "@/renderer/store/toast";
import { isMobileWebApp } from "@/renderer/ipc/api";

defineProps<{
  insideDialog?: boolean;
}>();

const store = useToastStore();
const isMobile = isMobileWebApp();
const displayedToasts = computed(() => (isMobile ? store.toasts.slice(-2) : store.toasts));

const iconFor = (type: ToastType): IconType => {
  switch (type) {
    case "success":
      return IconType.CHECK;
    case "error":
      return IconType.ERROR;
    case "info":
    case "warning":
      return IconType.INFO;
  }
};
</script>

<style scoped>
.toast-container {
  position: fixed;
  top: max(12px, env(safe-area-inset-top));
  right: max(12px, env(safe-area-inset-right));
  z-index: 1100;
  width: min(420px, calc(100vw - 24px));
  pointer-events: none;
}

.toast-container.mobile {
  top: max(8px, env(safe-area-inset-top));
  right: max(8px, env(safe-area-inset-right));
  left: max(8px, env(safe-area-inset-left));
  width: auto;
}

.toast-container.mobile-bottom {
  top: auto;
  /* Keep mobile toasts above MobileLayout's 30px HorizontalSelector. */
  bottom: calc(30px + max(8px, env(safe-area-inset-bottom)) + 8px);
}

.toast-container.mobile > div {
  gap: 4px;
}

.toast-container.mobile .toast {
  min-height: 44px;
  gap: 8px;
  padding: 8px 10px;
}

.toast-container > div {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.toast {
  display: flex;
  align-items: center;
  gap: 10px;
  box-sizing: border-box;
  width: 100%;
  min-height: 48px;
  padding: 10px 14px;
  border: 1px solid var(--toast-border-color);
  border-radius: 10px;
  color: var(--toast-color);
  box-shadow: 0 3px 10px var(--shadow-color);
  cursor: pointer;
  pointer-events: auto;
  user-select: none;
  touch-action: manipulation;
}

.toast:focus-visible {
  outline: 2px solid var(--toast-color);
  outline-offset: 2px;
}

.toast-info {
  background-color: var(--toast-info-bg-color);
}

.toast-success {
  background-color: var(--toast-success-bg-color);
}

.toast-warning {
  background-color: var(--toast-warning-bg-color);
}

.toast-error {
  background-color: var(--toast-error-bg-color);
}

.toast .icon {
  flex: 0 0 24px;
  width: 24px;
  height: 24px;
}

.toast-text {
  min-width: 0;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.toast-count {
  white-space: nowrap;
}

.toast-enter-active,
.toast-leave-active {
  transition:
    opacity 160ms ease,
    transform 160ms ease;
}

.toast-enter-from,
.toast-leave-to {
  opacity: 0;
  transform: translateY(-8px);
}

.toast-container.mobile-bottom .toast-enter-from,
.toast-container.mobile-bottom .toast-leave-to {
  transform: translateY(8px);
}

@media (prefers-reduced-motion: reduce) {
  .toast-enter-active,
  .toast-leave-active {
    transition: none;
  }
}
</style>
