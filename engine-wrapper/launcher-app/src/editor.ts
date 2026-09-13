// Config editor DOM wiring. All configuration-derived text uses textContent;
// no innerHTML is built from engine data. Probe results flow through the
// backend `editor_refresh` merge so manual options are never dropped.
import { api, type EngineEntry } from "./api";
import {
  addGroup,
  collectOptions,
  deleteGroup,
  duplicateEngine,
  generateId,
  moveEngine,
  normalizeType,
  renameGroup,
  uniqueGroups,
  validateRegistry,
  type Group,
  type OptionRow,
  type OptionRowType,
} from "./editor-state";
import { detectLang, text, type Lang } from "./i18n";

export function initEditor(): void {
  const lang: Lang = detectLang();
  let engines: EngineEntry[] = [];
  let virtualGroups: Group[] = [];
  let editingIndex = -1;
  let probeSeq = 0;

  const $ = <T extends HTMLElement = HTMLElement>(id: string): T => {
    const el = document.getElementById(id);
    if (!el) throw new Error(`missing element #${id}`);
    return el as T;
  };

  function toast(message: string, type: "info" | "success" | "error" = "info", duration = 3000): void {
    const container = $("toastContainer");
    const el = document.createElement("div");
    el.className = `toast toast-${type}`;
    const span = document.createElement("span");
    span.textContent = message;
    const close = document.createElement("span");
    close.className = "toast-close";
    close.textContent = "×";
    close.addEventListener("click", () => {
      el.classList.remove("show");
      window.setTimeout(() => el.remove(), 300);
    });
    el.append(span, close);
    container.append(el);
    window.setTimeout(() => el.classList.add("show"), 10);
    if (duration > 0) {
      window.setTimeout(() => {
        if (el.parentNode) {
          el.classList.remove("show");
          window.setTimeout(() => el.remove(), 300);
        }
      }, duration);
    }
  }

  function badge(label: string, background: string): HTMLSpanElement {
    const span = document.createElement("span");
    span.textContent = label;
    span.style.cssText = `font-size:0.75rem;background:${background};color:white;padding:2px 4px;border-radius:3px;margin-left:5px;`;
    return span;
  }

  function actionButton(label: string, cls: string, onClick: () => void, disabled = false): HTMLButtonElement {
    const btn = document.createElement("button");
    btn.className = `btn btn-sm ${cls}`;
    btn.textContent = label;
    btn.disabled = disabled;
    btn.addEventListener("click", onClick);
    return btn;
  }

  function renderTable(): void {
    const tbody = document.querySelector("#engineTable tbody");
    if (!tbody) return;
    tbody.replaceChildren();
    engines.forEach((eng, idx) => {
      const tr = document.createElement("tr");
      const nameTd = document.createElement("td");
      nameTd.textContent = eng.name;
      if (eng.skipAnalysisDB) nameTd.append(badge("No DB", "#dc3545"));
      if (eng.analysisDBGroupId) {
        nameTd.append(badge(`Group: ${eng.analysisDBGroupName || eng.name}`, "#6f42c1"));
      }
      const typeTd = document.createElement("td");
      typeTd.textContent = Array.isArray(eng.type) ? eng.type.join(", ") : String(eng.type ?? "");
      const actionTd = document.createElement("td");
      actionTd.append(
        actionButton("↑", "", () => { moveEngine(engines, idx, -1); renderTable(); }, idx === 0),
        document.createTextNode(" "),
        actionButton("↓", "", () => { moveEngine(engines, idx, 1); renderTable(); }, idx === engines.length - 1),
        document.createTextNode(" "),
        actionButton("複製", "btn-info", () => { duplicateEngine(engines, idx, generateId); renderTable(); }),
        document.createTextNode(" "),
        actionButton("編集", "btn-primary", () => openEngineModal(idx)),
        document.createTextNode(" "),
        actionButton("削除", "btn-danger", () => {
          if (window.confirm(text("editor.confirmDelete", lang))) {
            engines.splice(idx, 1);
            renderTable();
          }
        }),
      );
      tr.append(nameTd, typeTd, actionTd);
      tbody.append(tr);
    });
  }

  function updateGroupSelect(selectedGroupId = ""): void {
    const select = $<HTMLSelectElement>("editAnalysisDBGroupId");
    while (select.options.length > 1) select.remove(1);
    for (const group of uniqueGroups(engines, virtualGroups)) {
      const opt = document.createElement("option");
      opt.value = group.id;
      opt.textContent = group.name;
      if (group.id === selectedGroupId) opt.selected = true;
      select.append(opt);
    }
  }

  function readOptionRows(): OptionRow[] {
    const rows: OptionRow[] = [];
    document.querySelectorAll("#optionsList .option-row").forEach((row) => {
      const el = row as HTMLElement;
      const key = (row.querySelector(".opt-key") as HTMLInputElement | null)?.value.trim() ?? "";
      const input = row.querySelector(".opt-val") as HTMLInputElement | HTMLSelectElement | null;
      if (!key || !input) return;
      const type = (el.dataset.type ?? "string") as OptionRowType;
      const extra = el.dataset.extra ? (JSON.parse(el.dataset.extra) as { min?: number; max?: number; default?: unknown }) : {};
      rows.push({
        key,
        value: type === "boolean" ? (input as HTMLInputElement).checked : input.value,
        type,
        min: extra.min,
        max: extra.max,
      });
    });
    return rows;
  }

  function addOptionRow(key = "", val: string | number | boolean = "", type: OptionRowType = "string", extra: { default?: unknown; min?: number; max?: number; vars?: string[] } = {}): void {
    const list = $("optionsList");
    const div = document.createElement("div");
    div.className = "option-row";
    div.dataset.type = type;
    div.dataset.extra = JSON.stringify(extra);
    const typeLabels: Record<OptionRowType, string> = { string: "文字", boolean: "真偽", spin: "数値", combo: "選択" };

    const keyInput = document.createElement("input");
    keyInput.type = "text";
    keyInput.placeholder = "名前";
    keyInput.value = key;
    keyInput.className = "opt-key";
    div.append(keyInput);

    const container = document.createElement("div");
    container.className = "opt-val-container";
    let input: HTMLInputElement | HTMLSelectElement;
    if (type === "boolean") {
      const checked = val === true || String(val) === "true";
      input = document.createElement("input");
      input.type = "checkbox";
      input.className = "opt-val";
      input.checked = checked;
      const label = document.createElement("span");
      label.className = "bool-label";
      label.textContent = checked ? "true" : "false";
      input.addEventListener("change", () => { label.textContent = (input as HTMLInputElement).checked ? "true" : "false"; });
      container.append(input, label);
    } else if (type === "spin") {
      input = document.createElement("input");
      input.type = "number";
      input.className = "opt-val";
      input.value = String(val);
      if (extra.min !== undefined) input.min = String(extra.min);
      if (extra.max !== undefined) input.max = String(extra.max);
      container.append(input);
    } else if (type === "combo") {
      const select = document.createElement("select");
      select.className = "opt-val";
      for (const v of extra.vars ?? []) {
        const opt = document.createElement("option");
        opt.value = v;
        opt.textContent = v;
        if (v === val) opt.selected = true;
        select.append(opt);
      }
      input = select;
      container.append(input);
    } else {
      input = document.createElement("input");
      input.type = "text";
      input.className = "opt-val";
      input.value = String(val);
      container.append(input);
    }
    div.append(container);

    const resetBtn = document.createElement("button");
    resetBtn.className = "btn btn-sm btn-warning";
    resetBtn.textContent = "↺";
    resetBtn.title = "既定値に戻す";
    resetBtn.style.display = "none";
    const checkModified = (): void => {
      if (extra.default === undefined) return;
      let modified = false;
      if (type === "boolean") {
        modified = (input as HTMLInputElement).checked !== (String(extra.default).toLowerCase() === "true");
      } else if (type === "spin") {
        modified = Number((input as HTMLInputElement).value) !== Number(extra.default);
      } else {
        modified = String((input as HTMLInputElement | HTMLSelectElement).value) !== String(extra.default);
      }
      div.classList.toggle("modified-option", modified);
      resetBtn.style.display = modified ? "inline-block" : "none";
    };
    input.addEventListener("input", checkModified);
    input.addEventListener("change", checkModified);
    resetBtn.addEventListener("click", () => {
      if (type === "boolean") {
        (input as HTMLInputElement).checked = String(extra.default).toLowerCase() === "true";
        input.dispatchEvent(new Event("change"));
      } else {
        (input as HTMLInputElement).value = String(extra.default ?? "");
        input.dispatchEvent(new Event("input"));
      }
    });
    div.append(resetBtn);

    const typeLabel = document.createElement("span");
    typeLabel.className = "type-label";
    typeLabel.textContent = typeLabels[type];
    div.append(typeLabel);
    const delBtn = document.createElement("button");
    delBtn.className = "btn btn-sm btn-danger";
    delBtn.textContent = "×";
    delBtn.addEventListener("click", () => div.remove());
    div.append(delBtn);
    list.append(div);
    checkModified();
  }

  function openEngineModal(index = -1): void {
    editingIndex = index;
    $("optionsList").replaceChildren();
    $("resetAllBtn").style.display = "none";
    if (index >= 0) {
      $("modalTitle").textContent = "エンジン編集";
      const eng = engines[index];
      $<HTMLInputElement>("editName").value = eng.name || "";
      $<HTMLInputElement>("editId").value = eng.id || generateId();
      const types = normalizeType(eng.type);
      document.querySelectorAll('#editTypeContainer input[name="type"]').forEach((cb) => {
        (cb as HTMLInputElement).checked = types.includes((cb as HTMLInputElement).value);
      });
      const saveDb = !eng.skipAnalysisDB;
      $<HTMLInputElement>("editSaveAnalysisDB").checked = saveDb;
      $("editSaveAnalysisDBLabel").textContent = saveDb ? "true" : "false";
      updateGroupSelect(eng.analysisDBGroupId || "");
      $<HTMLInputElement>("editPath").value = eng.path || "";
      if (eng.options) {
        for (const [k, v] of Object.entries(eng.options)) {
          const type: OptionRowType = typeof v === "boolean" ? "boolean" : typeof v === "number" ? "spin" : "string";
          addOptionRow(k, v, type);
        }
      }
      if (eng.path) void analyzeEngine(false);
    } else {
      $("modalTitle").textContent = "エンジン追加";
      $<HTMLInputElement>("editName").value = "";
      $<HTMLInputElement>("editId").value = generateId();
      document.querySelectorAll('#editTypeContainer input[name="type"]').forEach((cb) => {
        const value = (cb as HTMLInputElement).value;
        (cb as HTMLInputElement).checked = value === "game" || value === "research";
      });
      $<HTMLInputElement>("editSaveAnalysisDB").checked = true;
      $("editSaveAnalysisDBLabel").textContent = "true";
      updateGroupSelect("");
      $<HTMLInputElement>("editPath").value = "";
    }
    $("engineModal").style.display = "block";
  }

  async function analyzeEngine(showAlert = true): Promise<void> {
    const path = $<HTMLInputElement>("editPath").value.trim();
    if (!path) {
      if (showAlert) toast(text("editor.pathRequired", lang), "error");
      return;
    }
    const myProbe = ++probeSeq;
    $("loadingText").textContent = text("editor.probing", lang);
    $("modalLoading").style.display = "flex";
    try {
      const [probeId, discovered] = await api.editorProbe(path);
      if (myProbe !== probeSeq) {
        await api.editorProbeCancel(probeId).catch(() => undefined);
        return;
      }
      // Merge on the backend: current row values win, manual entries survive.
      const existing: Record<string, string | number | boolean> = {};
      for (const row of readOptionRows()) {
        if (row.key) existing[row.key] = row.type === "boolean" ? row.value === true : row.type === "spin" ? Number(row.value) : String(row.value);
      }
      const merged = await api.editorRefresh(existing, discovered);
      if (myProbe !== probeSeq) return;
      $("optionsList").replaceChildren();
      const defs = new Map(Object.entries(discovered));
      const order = [...defs.keys(), ...Object.keys(merged).filter((k) => !defs.has(k))];
      for (const name of order) {
        const def = defs.get(name);
        const val = merged[name];
        if (!def) {
          addOptionRow(name, val, typeof val === "boolean" ? "boolean" : typeof val === "number" ? "spin" : "string");
          continue;
        }
        if (def.type === "button") continue;
        const type: OptionRowType = def.type === "check" ? "boolean" : def.type === "spin" ? "spin" : def.type === "combo" ? "combo" : "string";
        addOptionRow(name, val, type, { default: def.default, min: def.min, max: def.max, vars: def.vars });
      }
      $("resetAllBtn").style.display = "block";
      if (showAlert) toast(text("editor.probeOk", lang, String(Object.keys(discovered).length)), "success");
    } catch (e) {
      if (showAlert) toast(text("editor.probeFailed", lang, e instanceof Error ? e.message : String(e)), "error");
    } finally {
      if (myProbe === probeSeq) $("modalLoading").style.display = "none";
    }
  }

  function saveEngineFromModal(): void {
    const name = $<HTMLInputElement>("editName").value.trim();
    const id = $<HTMLInputElement>("editId").value.trim();
    const path = $<HTMLInputElement>("editPath").value.trim();
    const type = [...document.querySelectorAll('#editTypeContainer input[name="type"]:checked')].map(
      (cb) => (cb as HTMLInputElement).value,
    );
    const saveAnalysisDB = $<HTMLInputElement>("editSaveAnalysisDB").checked;
    const groupId = $<HTMLSelectElement>("editAnalysisDBGroupId").value;
    const errorKey = validateRegistry(engines, editingIndex, { id, name, path, type } as EngineEntry);
    if (errorKey === "typeRequired") { toast(text("editor.typeRequired", lang), "error"); return; }
    if (errorKey === "required") { toast(text("editor.required", lang), "error"); return; }
    if (errorKey === "duplicateId") { toast(text("editor.duplicateId", lang, id), "error"); return; }

    let groupName = "";
    if (groupId) {
      const group = uniqueGroups(engines, virtualGroups).find((g) => g.id === groupId);
      if (group) groupName = group.name;
    }
    const { options, errors } = collectOptions(readOptionRows());
    if (errors.length > 0) { toast(errors.join("\n"), "error", 5000); return; }

    const entry: EngineEntry = { id, name, type, path, options };
    if (!saveAnalysisDB) entry.skipAnalysisDB = true;
    if (groupId) entry.analysisDBGroupId = groupId;
    if (groupName) entry.analysisDBGroupName = groupName;
    if (editingIndex >= 0) engines[editingIndex] = entry;
    else engines.push(entry);
    renderTable();
    $("engineModal").style.display = "none";
  }

  function renderGroupTable(): void {
    const tbody = document.querySelector("#groupTable tbody");
    if (!tbody) return;
    tbody.replaceChildren();
    for (const group of uniqueGroups(engines, virtualGroups)) {
      const count = engines.filter((e) => e.analysisDBGroupId === group.id).length;
      const tr = document.createElement("tr");
      const nameTd = document.createElement("td");
      nameTd.textContent = group.name;
      const countTd = document.createElement("td");
      countTd.textContent = String(count);
      const actionTd = document.createElement("td");
      const renameBtn = document.createElement("button");
      renameBtn.className = "btn btn-sm btn-primary";
      renameBtn.textContent = "リネーム";
      renameBtn.addEventListener("click", () => {
        const next = window.prompt(text("editor.groupRenamePrompt", lang), group.name);
        if (next === null) return;
        if (!next.trim()) { toast(text("editor.groupNameRequired", lang), "error"); return; }
        renameGroup(engines, virtualGroups, group.id, next.trim());
        renderGroupTable();
        renderTable();
        toast(text("editor.groupRenamed", lang), "success");
      });
      const delBtn = document.createElement("button");
      delBtn.className = "btn btn-sm btn-danger";
      delBtn.textContent = "削除";
      delBtn.addEventListener("click", () => {
        if (!window.confirm(text("editor.groupDeleteConfirm", lang, group.name, String(count)))) return;
        virtualGroups = deleteGroup(engines, virtualGroups, group.id);
        renderGroupTable();
        renderTable();
        toast(text("editor.groupDeleted", lang), "success");
      });
      actionTd.append(renameBtn, document.createTextNode(" "), delBtn);
      tr.append(nameTd, countTd, actionTd);
      tbody.append(tr);
    }
  }

  async function init(): Promise<void> {
    try {
      const data = await api.editorLoad();
      engines = data.engines || [];
      virtualGroups = [];
      renderTable();
      $("editorSection").style.display = "block";
    } catch (e) {
      toast(text("editor.loadFailed", lang, e instanceof Error ? e.message : String(e)), "error");
    }

    $("saveBtn").addEventListener("click", async () => {
      const btn = $<HTMLButtonElement>("saveBtn");
      btn.disabled = true;
      try {
        await api.editorSave(engines);
        toast(text("editor.saved", lang), "success");
      } catch (e) {
        toast(text("editor.saveFailed", lang, e instanceof Error ? e.message : String(e)), "error");
      } finally {
        btn.disabled = false;
      }
    });
    $("analyzeBtn").addEventListener("click", () => void analyzeEngine(true));
    $("browseBtn").addEventListener("click", async () => {
      try {
        const path = await api.editorBrowse();
        if (path) $<HTMLInputElement>("editPath").value = path;
      } catch (e) {
        toast(String(e), "error");
      }
    });
    $("addEngineBtn").addEventListener("click", () => openEngineModal(-1));
    $("saveEngineBtn").addEventListener("click", saveEngineFromModal);
    $("cancelModalBtn").addEventListener("click", () => { $("engineModal").style.display = "none"; });
    $("regenerateIdBtn").addEventListener("click", () => {
      if (window.confirm(text("editor.confirmRegenId", lang))) $<HTMLInputElement>("editId").value = generateId();
    });
    $("resetAllBtn").addEventListener("click", () => {
      if (!window.confirm(text("editor.confirmResetAll", lang))) return;
      document.querySelectorAll("#optionsList .option-row").forEach((row) => {
        const extra = (row as HTMLElement).dataset.extra ? JSON.parse((row as HTMLElement).dataset.extra as string) as { default?: unknown } : {};
        if (extra.default === undefined) return;
        const input = row.querySelector(".opt-val") as HTMLInputElement | null;
        if (!input) return;
        if ((row as HTMLElement).dataset.type === "boolean") {
          input.checked = String(extra.default).toLowerCase() === "true";
          input.dispatchEvent(new Event("change"));
        } else {
          input.value = String(extra.default);
          input.dispatchEvent(new Event("input"));
        }
      });
    });
    $("addGroupBtn").addEventListener("click", () => {
      const name = window.prompt(text("editor.groupNamePrompt", lang));
      if (name === null || !name.trim()) return;
      const { id, created } = addGroup(engines, virtualGroups, name.trim(), generateId);
      toast(text(created ? "editor.groupCreated" : "editor.groupExists", lang), created ? "success" : "info");
      updateGroupSelect(id);
      renderGroupTable();
    });
    $("manageGroupsBtn").addEventListener("click", () => {
      renderGroupTable();
      $("groupModal").style.display = "block";
    });
    $("closeGroupModalBtn").addEventListener("click", () => { $("groupModal").style.display = "none"; });
    $("newEngineBtn2")?.addEventListener("click", () => {
      if (window.confirm(text("editor.confirmNew", lang))) {
        engines = [];
        virtualGroups = [];
        renderTable();
        $("editorSection").style.display = "block";
      }
    });
    window.addEventListener("click", (event) => {
      if (event.target === $("engineModal")) $("engineModal").style.display = "none";
      if (event.target === $("groupModal")) $("groupModal").style.display = "none";
    });
    window.addEventListener("beforeunload", () => {
      // Best effort: cancel any running probe so no engine is orphaned.
      probeSeq++;
    });
  }

  void init();
}
