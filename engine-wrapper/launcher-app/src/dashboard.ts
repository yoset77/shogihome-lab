// Main dashboard wiring: status, service control, PC URL + QR, update
// banner, startup migration. Server control goes through backend commands;
// the UI keeps no process handles. Settings and logs live in dedicated
// windows (open_settings_window / open_logs_window).
import { openUrl } from "@tauri-apps/plugin-opener";
import { ask, message, open as openDialog } from "@tauri-apps/plugin-dialog";
import { listen } from "@tauri-apps/api/event";
import QRCode from "qrcode";
import { api } from "./api";
import { detectLang, normalizeLang, storeLang, text, type Lang } from "./i18n";
import { startAfterMigration, type MigrationStatus } from "./startup";

export function initDashboard(): void {
  let lang: Lang = detectLang();
  let lastUpdate: { version: string; tag: string; url: string } | null = null;
  let preparing = true;
  const $ = <T extends HTMLElement = HTMLElement>(id: string): T => {
    const el = document.getElementById(id);
    if (!el) throw new Error(`missing element #${id}`);
    return el as T;
  };

  function applyTexts(): void {
    $<HTMLSelectElement>("langSelect").value = lang;
    $("openPcBtn").textContent = text("openOnPc", lang);
    $("restartBtn").textContent = text("restartServer", lang);
    $("editorBtn").textContent = text("engineSettings", lang);
    $("settingsBtn").textContent = text("serverSettings", lang);
    $("logsBtn").textContent = text("showLogs", lang);
    $("exitBtn").textContent = text("stopAndExit", lang);
    $("updateOpenBtn").textContent = text("updateDownload", lang);
    $("updateLaterBtn").textContent = text("updateRemindLater", lang);
    if (lastUpdate) $("updateLabel").textContent = text("latestVersionReleased", lang, lastUpdate.version);
    // Re-render the custom-network notice so a language switch applies
    // even without refetching (Python setup_info_panel parity).
    if (lastNetwork && !lastNetwork.hasQr) renderCustomNetwork(lastNetwork.bind, lastNetwork.autoOrigins);
  }

  async function setLang(next: Lang): Promise<void> {
    lang = next;
    storeLang(next);
    try {
      await api.setUiLanguage(next);
    } catch {
      // Persistence is best-effort; the in-memory language still applies.
    }
    applyTexts();
    await refreshStatus();
    await refreshPcUrl();
  }

  async function refreshStatus(): Promise<void> {
    try {
      const status = await api.getStatus();
      const label = $("statusLabel");
      label.textContent =
        status.state === "running"
          ? `● ${text("statusRunning", lang)}`
          : status.state === "starting"
            ? `⟳ ${text("statusStarting", lang)}`
            : status.state === "stopping"
              ? text("statusStopping", lang)
              : status.state === "failed"
                ? `● ${text("statusError", lang)}`
                : `○ ${text("statusStopped", lang)}`;
      $("restartBtn").toggleAttribute("disabled", preparing || status.state === "starting" || status.state === "stopping");
    } catch {
      $("statusLabel").textContent = `● ${text("statusError", lang)}`;
    }
  }

  // Displayed URL follows the QR payload (LAN URL) when available so the
  // QR code and the text always match. The PC opener uses the same value.
  // Without a QR (127.0.0.1 bind, strict origins, ...), show the Python
  // parity notice instead of leaving a blank space.
  let displayedUrl = "";
  let lastNetwork: { bind: string; autoOrigins: boolean; hasQr: boolean } | null = null;
  function renderCustomNetwork(bind: string, autoOrigins: boolean): void {
    const box = $("customNetwork");
    box.hidden = false;
    $("customNetworkTitle").textContent = text("customNetworkActive", lang);
    $("customNetworkBody").textContent = text("networkInfo", lang, bind, autoOrigins ? "on" : "off");
  }
  async function refreshPcUrl(): Promise<void> {
    try {
      const info = await api.getPcUrl();
      const { url, allowed, qrUrl } = info;
      const bind = info.bind ?? "0.0.0.0";
      const autoOrigins = info.autoOrigins ?? true;
      lastNetwork = { bind, autoOrigins, hasQr: !!qrUrl };
      displayedUrl = qrUrl ?? url;
      const pcUrlEl = $("pcUrl");
      pcUrlEl.textContent = displayedUrl;
      pcUrlEl.onclick = () => void openUrl(displayedUrl);
      pcUrlEl.style.cursor = "pointer";
      $("openPcBtn").toggleAttribute("disabled", !allowed);
      const image = $<HTMLImageElement>("qrImg");
      image.hidden = !qrUrl;
      if (qrUrl) {
        $("customNetwork").hidden = true;
        image.src = await QRCode.toDataURL(qrUrl, { width: 160, margin: 1 });
      } else {
        image.removeAttribute("src");
        renderCustomNetwork(bind, autoOrigins);
      }
    } catch {
      $("pcUrl").textContent = text("statusError", lang);
    }
  }

  async function refreshUpdate(): Promise<void> {
    try {
      const info = await api.checkUpdate();
      lastUpdate = info;
      const banner = $("updateBanner");
      if (!info) {
        banner.style.display = "none";
        return;
      }
      banner.style.display = "block";
      $("updateLabel").textContent = text("latestVersionReleased", lang, info.version);
      $("updateOpenBtn").onclick = () => void openUrl(info.url);
      $("updateLaterBtn").onclick = () => {
        void api.snoozeUpdate(info.version).then(() => {
          banner.style.display = "none";
        });
      };
    } catch {
      $("updateBanner").style.display = "none";
    }
  }

  async function openSettingsWindow(): Promise<void> {
    try {
      await api.openSettingsWindow();
    } catch (e) {
      await showError(e);
    }
  }

  async function openLogsWindow(): Promise<void> {
    try {
      await api.openLogsWindow();
    } catch (e) {
      await showError(e);
    }
  }

  // Startup-only migration: called via startAfterMigration when the backend
  // reports a fresh install (or a resumed partial run). No manual button:
  // overwriting an existing data dir is never offered.
  async function maybeMigrate(status: MigrationStatus): Promise<boolean> {
    const go = await ask(text(status.pendingSource ? "migrationResume" : "migrationPrompt", lang), { title: text("migrationTitle", lang) });
    if (!go) return !status.pendingSource;
    const picked = status.pendingSource ?? await openDialog({ directory: true, title: text("migrationSelect", lang) });
    if (!picked) return !status.pendingSource;
    const plan = await api.migrationPlan(picked);
    if (plan.empty) {
      await message(text("migrationEmpty", lang), { title: text("migrationTitle", lang) });
      return false;
    }
    if (plan.missing.length > 0) {
      const go = await ask(text("migrationMissing", lang, plan.missing.join(", ")), { title: text("migrationTitle", lang) });
      if (!go) return false;
    }
    const result = await api.migrationRun(picked);
    if (!result.migrated) throw new Error(text("migrationUnavailable", lang));
    return true;
  }

  async function showError(error: unknown): Promise<void> {
    await message(String(error), { title: text("statusError", lang), kind: "error" });
  }

  async function init(): Promise<void> {
    // Backend cache wins over localStorage so the language follows the
    // installation across browsers/profiles.
    try {
      const saved = normalizeLang(await api.getUiLanguage());
      if (saved && saved !== lang) {
        lang = saved;
        storeLang(saved);
      }
    } catch {
      // Standalone/dev mode without the backend: keep detected language.
    }
    applyTexts();
    $("langSelect").addEventListener("change", (e) => {
      const next = normalizeLang((e.target as HTMLSelectElement).value) ?? "ja";
      void setLang(next);
    });
    $("openPcBtn").addEventListener("click", async () => {
      if (displayedUrl) await openUrl(displayedUrl);
      else {
        const { url, qrUrl } = await api.getPcUrl();
        await openUrl(qrUrl ?? url);
      }
    });
    $("restartBtn").addEventListener("click", () => void api.restartServices().then(refreshStatus).catch(showError));
    $("logsBtn").addEventListener("click", () => void openLogsWindow());
    $("editorBtn").addEventListener("click", () => void api.openEditor());
    $("settingsBtn").addEventListener("click", () => void openSettingsWindow());
    $("exitBtn").addEventListener("click", () => void api.stopAndExit().catch(showError));

    await listen("launcher-status", () => void refreshStatus());
    // The settings window emits this after saving (and an optional restart).
    await listen("settings-saved", () => void (async () => {
      await refreshStatus();
      await refreshPcUrl();
    })());
    await listen("tray-open-browser", () => void $("openPcBtn").click());
    await listen("tray-open-editor", () => void api.openEditor());
    await listen("tray-exit", () => void api.stopAndExit().catch(showError));

    await refreshStatus();
    window.setInterval(refreshStatus, 2000);
    try {
      await startAfterMigration(api, maybeMigrate);
    } catch (error) {
      await showError(error);
    } finally {
      preparing = false;
      await refreshStatus();
      await refreshPcUrl();
    }
    void refreshUpdate();
  }

  void init();
}
