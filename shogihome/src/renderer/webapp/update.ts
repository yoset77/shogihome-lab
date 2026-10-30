import type { registerSW } from "virtual:pwa-register";
import { LogLevel } from "@/common/log";
import api from "@/renderer/ipc/api";
import { usePwaUpdateStore } from "@/renderer/store/pwa";

export function setupPwaUpdates(
  register: typeof registerSW,
  store = usePwaUpdateStore(),
): () => void {
  if (!("serviceWorker" in navigator)) return () => {};

  let registration: ServiceWorkerRegistration | undefined;
  let controller = navigator.serviceWorker.controller;
  let lastCheckedAt = Date.now();
  const isControlled = () => !!navigator.serviceWorker.controller;
  const warn = (error: unknown) => api.log(LogLevel.WARN, `service worker update: ${error}`);
  store.setUpdater(
    register({
      immediate: true,
      onNeedRefresh: () => {
        // An uncontrolled page cannot observe the controller change and reload.
        if (isControlled()) store.onNeedRefresh();
      },
      onNeedReload: () => store.onNeedReload(),
      onRegisteredSW: (_, value) => {
        registration = value;
        if (value?.waiting && isControlled()) store.onNeedRefresh();
      },
      onRegisterError: warn,
    }),
  );

  const onControllerChange = () => {
    const next = navigator.serviceWorker.controller;
    if (controller && next && controller !== next) store.onNeedReload();
    controller = next;
  };
  navigator.serviceWorker.addEventListener("controllerchange", onControllerChange);
  const check = () => {
    if (!registration || !navigator.onLine || Date.now() - lastCheckedAt < 5 * 60_000) return;
    lastCheckedAt = Date.now();
    registration.update().catch(warn);
  };
  const onVisible = () => {
    if (document.visibilityState === "visible") check();
  };
  const timer = window.setInterval(check, 60 * 60_000);
  document.addEventListener("visibilitychange", onVisible);
  // Some dialogs have component-local state, so their closure must also refresh the notice.
  const syncDialogs = () => {
    store.dialogOpen = !!document.querySelector("dialog[open]");
  };
  const dialogs = new MutationObserver(syncDialogs);
  dialogs.observe(document.body, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ["open"],
  });
  syncDialogs();
  return () => {
    window.clearInterval(timer);
    document.removeEventListener("visibilitychange", onVisible);
    navigator.serviceWorker.removeEventListener("controllerchange", onControllerChange);
    dialogs.disconnect();
    store.dispose();
  };
}
