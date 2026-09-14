// Server settings in a dedicated window (Python parity: 620x640 dialog).
// Reads/writes through backend commands; notifies the dashboard via the
// "settings-saved" event so it can refresh the QR/URL panel. Closing goes
// through the backend (close_settings_window); failures are reported,
// never swallowed.
import { ask, message, open as openDialog } from "@tauri-apps/plugin-dialog";
import { emit } from "@tauri-apps/api/event";
import { api, type SettingsSchema, type SettingValues } from "./api";
import { detectLang, normalizeLang, storeLang, text, type Lang } from "./i18n";
import { joinListValue, splitListValue } from "./settings-list";

export function initSettingsWindow(): void {
  let lang: Lang = detectLang();
  let schema: SettingsSchema | null = null;
  const $ = <T extends HTMLElement = HTMLElement>(id: string): T => {
    const el = document.getElementById(id);
    if (!el) throw new Error(`missing element #${id}`);
    return el as T;
  };

  function applyTexts(): void {
    document.title = text("serverSettings", lang);
    $("settingsTitle").textContent = text("serverSettings", lang);
    $("cancelSettingsBtn").textContent = text("settingsCancel", lang);
    $("saveSettingsBtn").textContent = text("settingsSave", lang);
  }

  function collectValues(): SettingValues {
    const values: SettingValues = {};
    document.querySelectorAll<HTMLElement>("#settingsForm [data-setting-id]").forEach((el) => {
      const id = el.dataset.settingId as string;
      // List settings render one input per row inside a container; join the
      // rows back into the comma-joined backend representation.
      if (el.dataset.settingKind === "list") {
        const items: string[] = [];
        el.querySelectorAll<HTMLInputElement>('input[type="text"]').forEach((item) => {
          if (item.value.trim()) items.push(item.value);
        });
        values[id] = joinListValue(items);
        return;
      }
      if (el instanceof HTMLInputElement && el.type === "checkbox") values[id] = el.checked;
      else if (el instanceof HTMLInputElement || el instanceof HTMLSelectElement) values[id] = el.value;
    });
    return values;
  }

  async function buildForm(preserve?: SettingValues): Promise<void> {
    if (!schema) {
      schema = await api.getSettingsSchema();
      const loaded = await api.loadSettings();
      if (loaded.mismatches.length > 0) {
        await message(text("settingsMismatch", lang, loaded.mismatches.join(", ")), {
          title: text("serverSettings", lang),
        });
      }
      preserve = loaded.values;
    }
    const values = preserve ?? collectValues();
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
        } else if (setting.type === "list") {
          // One input row per item with a remove button, plus an add button
          // below (Python _build_setting_row parity). Stored comma-joined.
          const listBox = document.createElement("div");
          listBox.dataset.settingId = setting.id;
          listBox.dataset.settingKind = "list";
          const rows = document.createElement("div");
          rows.className = "list-rows";
          const addRow = (value = ""): void => {
            const row = document.createElement("div");
            row.className = "row";
            const input = document.createElement("input");
            input.type = "text";
            input.value = value;
            const del = document.createElement("button");
            del.className = "btn btn-sm btn-danger";
            del.textContent = "×";
            del.setAttribute("aria-label", text("settingsListRemove", lang, setting.id));
            del.addEventListener("click", () => row.remove());
            row.append(input, del);
            rows.append(row);
          };
          for (const item of splitListValue(current)) addRow(item);
          const add = document.createElement("button");
          add.className = "btn btn-sm";
          add.textContent = text("settingsListAdd", lang);
          add.addEventListener("click", () => {
            addRow();
            const last = rows.querySelector(":scope > .row:last-child input") as HTMLInputElement | null;
            last?.focus();
          });
          listBox.append(rows, add);
          group.append(listBox);
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
  }

  async function closeWindow(): Promise<void> {
    try {
      await api.closeSettingsWindow();
    } catch (e) {
      await message(String(e), { title: text("statusError", lang), kind: "error" });
    }
  }

  async function save(): Promise<void> {
    const values = collectValues();
    try {
      await api.saveSettings(values);
      const restart = await ask(text("settingsRestartPrompt", lang), { title: text("serverSettings", lang) });
      if (restart) await api.restartServices();
      await emit("settings-saved", {});
      await closeWindow();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // Backend returns a JSON map of id -> error code on validation failure.
      try {
        const codes = JSON.parse(msg) as Record<string, string>;
        const first = Object.entries(codes)[0];
        alert(text(`settingsError_${first[1]}`, lang, first[0], "", ""));
      } catch {
        alert(msg);
      }
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
    $("saveSettingsBtn").addEventListener("click", () => void save());
    $("cancelSettingsBtn").addEventListener("click", () => void closeWindow());
    try {
      await buildForm();
    } catch (e) {
      await message(String(e), { title: text("statusError", lang), kind: "error" });
    }
  }

  void init();
}
