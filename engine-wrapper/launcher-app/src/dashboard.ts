// Main dashboard wiring: status, service control, PC URL + QR, settings
// dialog, log viewer, update banner, migration prompt. Server control goes
// through backend commands; the UI keeps no process handles.
import { openUrl } from "@tauri-apps/plugin-opener";
import { ask, message, open as openDialog } from "@tauri-apps/plugin-dialog";
import { listen } from "@tauri-apps/api/event";
import QRCode from "qrcode";
import { api, type SettingValues } from "./api";
import { detectLang, text, type Lang } from "./i18n";
import { startAfterMigration, type MigrationStatus } from "./startup";

export function initDashboard(): void {
  const lang: Lang = detectLang();
  let preparing = true;
  const $ = <T extends HTMLElement = HTMLElement>(id: string): T => {
    const el = document.getElementById(id);
    if (!el) throw new Error(`missing element #${id}`);
    return el as T;
  };

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

  async function refreshPcUrl(): Promise<void> {
    try {
      const { url, allowed, qrUrl } = await api.getPcUrl();
      $("pcUrl").textContent = url;
      $("openPcBtn").toggleAttribute("disabled", !allowed);
      const image = $<HTMLImageElement>("qrImg");
      image.hidden = !qrUrl;
      if (qrUrl) image.src = await QRCode.toDataURL(qrUrl, { width: 160, margin: 1 });
      else image.removeAttribute("src");
    } catch {
      $("pcUrl").textContent = text("statusError", lang);
    }
  }

  async function refreshUpdate(): Promise<void> {
    try {
      const info = await api.checkUpdate();
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

  async function openSettingsDialog(): Promise<void> {
    const schema = await api.getSettingsSchema();
    const { values, mismatches } = await api.loadSettings();
    if (mismatches.length > 0) {
      await message(text("settingsMismatch", lang, mismatches.join(", ")), {
        title: text("serverSettings", lang),
      });
    }
    const form = $("settingsForm");
    form.replaceChildren();
    for (const section of schema.sections) {
      const header = document.createElement("h3");
      header.textContent = text(`settingsSection_${section}`, lang);
      form.append(header);
      for (const setting of schema.settings.filter((s) => s.section === section)) {
        const current = values[setting.id] ?? setting.default;
        const group = document.createElement("div");
        group.className = "form-group";
        const label = document.createElement("label");
        label.textContent = setting.id;
        const desc = document.createElement("div");
        desc.className = "hint";
        desc.textContent = text(`settingsDesc_${setting.id}`, lang);
        group.append(label, desc);
        if (setting.type === "bool") {
          const input = document.createElement("input");
          input.type = "checkbox";
          input.checked = current === true;
          input.dataset.settingId = setting.id;
          group.append(input);
        } else if (setting.type === "choice") {
          const select = document.createElement("select");
          select.dataset.settingId = setting.id;
          for (const choice of setting.choices) {
            const opt = document.createElement("option");
            opt.value = choice;
            opt.textContent = choice;
            if (choice === current) opt.selected = true;
            select.append(opt);
          }
          group.append(select);
        } else {
          const input = document.createElement("input");
          input.type = "text";
          input.value = String(current);
          input.dataset.settingId = setting.id;
          if (setting.id === "KIFU_DIR") {
            const browse = document.createElement("button");
            browse.className = "btn btn-sm";
            browse.textContent = text("settingsBrowse", lang);
            browse.addEventListener("click", async () => {
              const picked = await openDialog({ directory: true });
              if (picked) input.value = picked;
            });
            group.append(input, browse);
          } else if (setting.id === "WRAPPER_ACCESS_TOKEN") {
            const gen = document.createElement("button");
            gen.className = "btn btn-sm";
            gen.textContent = text("settingsTokenGenerate", lang);
            gen.addEventListener("click", async () => {
              input.value = await api.generateToken();
            });
            group.append(input, gen);
          } else {
            group.append(input);
          }
        }
        form.append(group);
      }
    }
    $("settingsModal").style.display = "block";
  }

  async function saveSettingsDialog(): Promise<void> {
    const values: SettingValues = {};
    document.querySelectorAll<HTMLInputElement | HTMLSelectElement>("#settingsForm [data-setting-id]").forEach((el) => {
      const id = el.dataset.settingId as string;
      values[id] = el instanceof HTMLInputElement && el.type === "checkbox" ? el.checked : el.value;
    });
    try {
      await api.saveSettings(values);
      $("settingsModal").style.display = "none";
      const restart = await ask(text("settingsRestartPrompt", lang), { title: text("serverSettings", lang) });
      if (restart) await api.restartServices();
      await refreshPcUrl();
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      // Backend returns a JSON map of id -> error code on validation failure.
      try {
        const codes = JSON.parse(message) as Record<string, string>;
        const first = Object.entries(codes)[0];
        alert(text(`settingsError_${first[1]}`, lang, first[0], "", ""));
      } catch {
        alert(message);
      }
    }
  }

  async function openLogs(): Promise<void> {
    try {
      const logs = await api.readLogs();
      $("serverLogPre").textContent = logs.server;
      $("wrapperLogPre").textContent = logs.wrapper;
      $("logsModal").style.display = "block";
    } catch (e) {
      alert(text("logReadError", lang, e instanceof Error ? e.message : String(e)));
    }
  }

  async function maybeMigrate(status: MigrationStatus): Promise<boolean> {
    if (!status.needed) {
      await message(text("migrationUnavailable", lang), { title: text("migrationTitle", lang) });
      return false;
    }
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
    $("openPcBtn").addEventListener("click", async () => {
      const { url } = await api.getPcUrl();
      await openUrl(url);
    });
    $("restartBtn").addEventListener("click", () => void api.restartServices().then(refreshStatus).catch(showError));
    $("logsBtn").addEventListener("click", () => void openLogs());
    $("refreshLogsBtn").addEventListener("click", () => void openLogs());
    $("closeLogsBtn").addEventListener("click", () => { $("logsModal").style.display = "none"; });
    $("editorBtn").addEventListener("click", () => void api.openEditor());
    $("settingsBtn").addEventListener("click", () => void openSettingsDialog());
    $("saveSettingsBtn").addEventListener("click", () => void saveSettingsDialog());
    $("cancelSettingsBtn").addEventListener("click", () => { $("settingsModal").style.display = "none"; });
    $("exitBtn").addEventListener("click", () => void api.stopAndExit().catch(showError));
    $("migrateBtn").addEventListener("click", () => void (async () => {
      if (await maybeMigrate(await api.migrationStatus())) {
        await api.startServices();
        await refreshPcUrl();
        await refreshStatus();
      }
    })().catch(showError));

    await listen("launcher-status", () => void refreshStatus());
    await listen("tray-open-browser", () => void $("openPcBtn").click());
    await listen("tray-open-editor", () => void api.openEditor());
    await listen("tray-exit", () => void api.stopAndExit().catch(showError));

    await refreshStatus();
    window.setInterval(refreshStatus, 2000);
    $("migrateBtn").toggleAttribute("disabled", true);
    try {
      await startAfterMigration(api, maybeMigrate);
    } catch (error) {
      await showError(error);
    } finally {
      preparing = false;
      $("migrateBtn").toggleAttribute("disabled", false);
      await refreshStatus();
      await refreshPcUrl();
    }
    void refreshUpdate();
  }

  void init();
}
