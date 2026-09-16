// Log viewer in a dedicated window.
// Read-only tails of server.log / wrapper.log with a manual refresh.
// Closing goes through the backend (close_logs_window) so no frontend
// window permission is required; failures are reported, never swallowed.
import { message } from "@tauri-apps/plugin-dialog";
import { api } from "./api";
import { detectLang, normalizeLang, storeLang, text, type Lang } from "./i18n";

export function initLogsWindow(): void {
  let lang: Lang = detectLang();
  const $ = <T extends HTMLElement = HTMLElement>(id: string): T => {
    const el = document.getElementById(id);
    if (!el) throw new Error(`missing element #${id}`);
    return el as T;
  };

  function applyTexts(): void {
    document.title = text("logViewerTitle", lang);
    $("logsTitle").textContent = text("logViewerTitle", lang);
    $("serverLogTitle").textContent = text("serverLogTab", lang);
    $("wrapperLogTitle").textContent = text("wrapperLogTab", lang);
    $("refreshLogsBtn").textContent = text("refresh", lang);
    $("closeLogsBtn").textContent = text("close", lang);
  }

  async function load(): Promise<void> {
    try {
      const logs = await api.readLogs();
      $("serverLogPre").textContent = logs.server;
      $("wrapperLogPre").textContent = logs.wrapper;
    } catch (e) {
      await message(text("logReadError", lang, e instanceof Error ? e.message : String(e)), {
        title: text("logViewerTitle", lang),
      });
    }
  }

  async function closeWindow(): Promise<void> {
    try {
      await api.closeLogsWindow();
    } catch (e) {
      await message(String(e), { title: text("statusError", lang), kind: "error" });
    }
  }

  async function init(): Promise<void> {
    try {
      const saved = normalizeLang(await api.getUiLanguage());
      if (saved && saved !== lang) {
        lang = saved;
        storeLang(saved);
      }
    } catch {
      // Dev mode without the backend: keep detected language.
    }
    applyTexts();
    // No language selector here (main + editor only); an external language
    // change applies on next open via the persisted value above.
    $("refreshLogsBtn").addEventListener("click", () => void load());
    $("closeLogsBtn").addEventListener("click", () => void closeWindow());
    await load();
  }

  void init();
}
