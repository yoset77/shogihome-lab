// Config editor DOM wiring. All configuration-derived text uses textContent;
// no innerHTML is built from engine data. Probe results flow through the
// backend `editor_refresh` merge so manual options are never dropped.
import { api, type EngineEntry } from "./api";
import { confirmAction } from "./confirm";
import {
  addGroup,
  applyEngineEdit,
  collectOptions,
  deleteEngineIfConfirmed,
  deleteGroup,
  duplicateEngine,
  generateId,
  moveEngine,
  isImeComposingKey,
  normalizeGroupName,
  normalizeType,
  ProbeSession,
  renameGroup,
  uniqueGroups,
  validateRegistry,
  type Group,
  type OptionRow,
  type OptionRowType,
} from "./editor-state";
import { detectLang, normalizeLang, storeLang, text, type Lang } from "./i18n";

export function initEditor(): void {
  let lang: Lang = detectLang();
  let engines: EngineEntry[] = [];
  let virtualGroups: Group[] = [];
  let editingIndex = -1;
  const probeSession = new ProbeSession();

  // Close the engine modal and invalidate any in-flight probe so a late
  // result cannot populate the next session's form. Shared by cancel,
  // backdrop click, and post-save close.
  function closeEngineModal(): void {
    probeSession.next();
    $("modalLoading").style.display = "none";
    $("engineModal").style.display = "none";
  }

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

  function actionButton(label: string, cls: string, onClick: () => void | Promise<void>, disabled = false): HTMLButtonElement {
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
        actionButton(text("editor.moveUp", lang), "", () => { moveEngine(engines, idx, -1); renderTable(); }, idx === 0),
        document.createTextNode(" "),
        actionButton(text("editor.moveDown", lang), "", () => { moveEngine(engines, idx, 1); renderTable(); }, idx === engines.length - 1),
        document.createTextNode(" "),
        actionButton(text("editor.duplicate", lang), "btn-info", () => { duplicateEngine(engines, idx, generateId); renderTable(); }),
        document.createTextNode(" "),
        actionButton(text("editor.edit", lang), "btn-primary", () => openEngineModal(idx)),
        document.createTextNode(" "),
        actionButton(text("editor.delete", lang), "btn-danger", async () => {
          if (await deleteEngineIfConfirmed(engines, idx, () => confirmAction(text("editor.confirmDelete", lang)))) {
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
    const typeLabels: Record<OptionRowType, string> = {
      string: text("editor.optString", lang),
      boolean: text("editor.optBool", lang),
      spin: text("editor.optSpin", lang),
      combo: text("editor.optCombo", lang),
    };

    const keyInput = document.createElement("input");
    keyInput.type = "text";
    keyInput.placeholder = text("editor.optName", lang);
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
      container.classList.add("bool");
      // Wide click target: the whole box toggles. Direct clicks on the
      // checkbox itself fall through to avoid a double toggle.
      container.addEventListener("click", (e) => {
        if (e.target === input) return;
        (input as HTMLInputElement).checked = !(input as HTMLInputElement).checked;
        input.dispatchEvent(new Event("change"));
      });
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
    resetBtn.title = text("editor.resetOne", lang);
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
    // A new editing session: drop results from any previous form.
    probeSession.next();
    $("optionsList").replaceChildren();
    $("resetAllBtn").style.display = "none";
    if (index >= 0) {
      $("modalTitle").textContent = text("editor.editTitle", lang);
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
      $("modalTitle").textContent = text("editor.addTitle", lang);
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
    const myProbe = probeSession.next();
    $("loadingText").textContent = text("editor.probing", lang);
    $("modalLoading").style.display = "flex";
    try {
      const [probeId, discovered, arrivalOrder] = await api.editorProbe(path);
      if (!probeSession.isCurrent(myProbe)) {
        await api.editorProbeCancel(probeId).catch(() => undefined);
        return;
      }
      // Merge on the backend: current row values win, manual entries survive.
      // Display order follows the engine's arrival order, not key sorting.
      const existing: Record<string, string | number | boolean> = {};
      const existingDomOrder: string[] = [];
      for (const row of readOptionRows()) {
        if (row.key) {
          existing[row.key] = row.type === "boolean" ? row.value === true : row.type === "spin" ? Number(row.value) : String(row.value);
          existingDomOrder.push(row.key);
        }
      }
      const { values: merged, order: discoveredOrder } = await api.editorRefresh(existing, discovered, arrivalOrder);
      if (!probeSession.isCurrent(myProbe)) return;
      $("optionsList").replaceChildren();
      const defs = new Map(Object.entries(discovered));
      const manualOrder = existingDomOrder.filter((k) => !defs.has(k) && k in merged);
      const order = [...discoveredOrder.filter((k) => k in merged), ...manualOrder.filter((k) => !discoveredOrder.includes(k))];
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
      if (probeSession.isCurrent(myProbe)) $("modalLoading").style.display = "none";
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

    const original = editingIndex >= 0 ? engines[editingIndex] : undefined;
    const entry = applyEngineEdit(original, {
      id,
      name,
      type,
      path,
      options,
      saveAnalysisDB,
      groupId,
      groupName,
    });
    if (editingIndex >= 0) engines[editingIndex] = entry;
    else engines.push(entry);
    renderTable();
    closeEngineModal();
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
      renameBtn.textContent = text("editor.rename", lang);
      renameBtn.addEventListener("click", () => {
        openGroupNameModal({ kind: "rename", groupId: group.id }, group.name);
      });
      const delBtn = document.createElement("button");
      delBtn.className = "btn btn-sm btn-danger";
      delBtn.textContent = text("editor.delete", lang);
      delBtn.addEventListener("click", async () => {
        if (!(await confirmAction(text("editor.groupDeleteConfirm", lang, group.name, String(count))))) return;
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

  // Group-name input uses an in-app modal, never window.prompt(): Wry's macOS
  // WKUIDelegate does not implement the JavaScript text-input panel, so
  // prompt() always resolves to null there and create/rename silently no-ops.
  let groupNameMode: { kind: "create" } | { kind: "rename"; groupId: string } | null = null;

  function openGroupNameModal(mode: NonNullable<typeof groupNameMode>, initial = ""): void {
    groupNameMode = mode;
    $("groupNameModalTitle").textContent = text(
      mode.kind === "create" ? "editor.groupNameTitle" : "editor.groupRenameTitle",
      lang,
    );
    const input = $<HTMLInputElement>("groupNameInput");
    input.value = initial;
    $("groupNameModal").style.display = "block";
    input.focus();
    input.select();
  }

  function closeGroupNameModal(): void {
    groupNameMode = null;
    $("groupNameModal").style.display = "none";
  }

  function submitGroupNameModal(): void {
    if (!groupNameMode) return;
    const name = normalizeGroupName($<HTMLInputElement>("groupNameInput").value);
    if (name === null) {
      toast(text("editor.groupNameRequired", lang), "error");
      return;
    }
    if (groupNameMode.kind === "create") {
      const { id, created } = addGroup(engines, virtualGroups, name, generateId);
      toast(text(created ? "editor.groupCreated" : "editor.groupExists", lang), created ? "success" : "info");
      updateGroupSelect(id);
    } else {
      renameGroup(engines, virtualGroups, groupNameMode.groupId, name);
      toast(text("editor.groupRenamed", lang), "success");
    }
    closeGroupNameModal();
    renderGroupTable();
    renderTable();
  }

  function applyStaticTexts(): void {
    $<HTMLSelectElement>("langSelect").value = lang;
    document.title = text("editor.title", lang);
    $("editorTitle").textContent = text("editor.title", lang);
    $("loadErrorTitle").textContent = text("editor.loadError", lang);
    $("retryLoadBtn").textContent = text("editor.retry", lang);
    $("newEmptyBtn").textContent = text("editor.startEmpty", lang);
    $("loadErrorHint").textContent = text("editor.loadErrorHint", lang);
    $("listTitle").textContent = text("editor.listTitle", lang);
    $("manageGroupsBtn").textContent = text("editor.manageGroups", lang);
    $("addEngineBtn").textContent = text("editor.addEngine", lang);
    $("saveBtn").textContent = text("editor.save", lang);
    $("colName").textContent = text("editor.colName", lang);
    $("colType").textContent = text("editor.colType", lang);
    $("colActions").textContent = text("editor.colActions", lang);
    $("editNameLabel").textContent = text("editor.nameLabel", lang);
    $("editTypeLabel").textContent = text("editor.typeLabel", lang);
    $("typeGameLabel").textContent = text("editor.typeGame", lang);
    $("typeResearchLabel").textContent = text("editor.typeResearch", lang);
    $("typeMateLabel").textContent = text("editor.typeMate", lang);
    $("editPathLabel").textContent = text("editor.pathLabel", lang);
    $("pathHint").textContent = text("editor.pathHint", lang);
    $("browseBtn").textContent = text("editor.browse", lang);
    $("analyzeBtn").textContent = text("editor.probe", lang);
    $("saveDbLabel").textContent = text("editor.saveDbLabel", lang);
    $("groupLabel").textContent = text("editor.groupLabel", lang);
    $("noGroupOption").textContent = text("editor.noGroup", lang);
    $("addGroupBtn").textContent = text("editor.newGroup", lang);
    $("groupHint").textContent = text("editor.groupHint", lang);
    $("optionsLabel").textContent = text("editor.optionsLabel", lang);
    $("addStringOptionBtn").textContent = text("editor.addString", lang);
    $("addSpinOptionBtn").textContent = text("editor.addSpin", lang);
    $("addBoolOptionBtn").textContent = text("editor.addBool", lang);
    $("resetAllBtn").textContent = text("editor.resetAll", lang);
    $("cancelModalBtn").textContent = text("editor.cancel", lang);
    $("saveEngineBtn").textContent = text("editor.apply", lang);
    $("groupModalTitle").textContent = text("editor.groupTitle", lang);
    $("groupModalDesc").textContent = text("editor.groupDesc", lang);
    $("groupNameLabel").textContent = text("editor.groupNameLabel", lang);
    $("groupNameCancelBtn").textContent = text("editor.cancel", lang);
    $("groupNameSaveBtn").textContent = text("editor.apply", lang);
    if ($("groupNameModal").style.display === "block" && groupNameMode) {
      $("groupNameModalTitle").textContent = text(
        groupNameMode.kind === "create" ? "editor.groupNameTitle" : "editor.groupRenameTitle",
        lang,
      );
    }
    $("groupColName").textContent = text("editor.groupColName", lang);
    $("groupColCount").textContent = text("editor.groupColCount", lang);
    $("groupColActions").textContent = text("editor.colActions", lang);
    $("closeGroupModalBtn").textContent = text("editor.close", lang);
    // Dynamic content follows the new language on next open; refresh the
    // visible tables and modal title immediately.
    $("modalTitle").textContent = text(editingIndex >= 0 ? "editor.editTitle" : "editor.addTitle", lang);
    renderTable();
    if ($("groupModal").style.display === "block") renderGroupTable();
  }

  async function setLang(next: Lang): Promise<void> {
    lang = next;
    storeLang(next);
    try {
      await api.setUiLanguage(next);
    } catch {
      // Persistence is best-effort; the in-memory language still applies.
    }
    applyStaticTexts();
  }

  // Load state: saving is only possible after a successful load or an
  // explicit "start empty" action. A failed load must never leave `engines`
  // as [] behind an enabled save button (that would overwrite engines.json
  // with an empty array).
  let loaded = false;

  function setLoaded(value: boolean): void {
    loaded = value;
    $<HTMLButtonElement>("saveBtn").disabled = !value;
    $("editorSection").style.display = value ? "block" : "none";
    $("loadErrorSection").style.display = value ? "none" : "block";
  }

  async function loadRegistry(): Promise<void> {
    try {
      const data = await api.editorLoad();
      engines = data.engines || [];
      virtualGroups = [];
      renderTable();
      setLoaded(true);
    } catch (e) {
      setLoaded(false);
      const detail = e instanceof Error ? e.message : String(e);
      $("loadErrorText").textContent = text("editor.loadFailed", lang, detail);
      toast(text("editor.loadFailed", lang, detail), "error", 0);
    }
  }

  async function init(): Promise<void> {
    // Hide both sections until the load outcome is known; the save button
    // starts disabled so a failed load cannot overwrite the registry.
    $("editorSection").style.display = "none";
    $("loadErrorSection").style.display = "none";
    $<HTMLButtonElement>("saveBtn").disabled = true;
    try {
      const saved = normalizeLang(await api.getUiLanguage());
      if (saved && saved !== lang) {
        lang = saved;
        storeLang(saved);
      }
    } catch {
      // Standalone/dev mode without the backend: keep detected language.
    }
    applyStaticTexts();
    $("langSelect").addEventListener("change", (e) => {
      const next = normalizeLang((e.target as HTMLSelectElement).value) ?? "ja";
      void setLang(next);
    });
    await loadRegistry();

    $("saveBtn").addEventListener("click", async () => {
      if (!loaded) return;
      const btn = $<HTMLButtonElement>("saveBtn");
      btn.disabled = true;
      try {
        await api.editorSave(engines);
        toast(text("editor.saved", lang), "success");
      } catch (e) {
        toast(text("editor.saveFailed", lang, e instanceof Error ? e.message : String(e)), "error");
      } finally {
        btn.disabled = !loaded;
      }
    });
    $("retryLoadBtn").addEventListener("click", () => void loadRegistry());
    $("newEmptyBtn").addEventListener("click", async () => {
      if (!(await confirmAction(text("editor.confirmNew", lang)))) return;
      engines = [];
      virtualGroups = [];
      renderTable();
      setLoaded(true);
      toast(text("editor.startedEmpty", lang), "info");
    });
    $("analyzeBtn").addEventListener("click", () => void analyzeEngine(true));
    $("addStringOptionBtn").addEventListener("click", () => addOptionRow("", "", "string"));
    $("addSpinOptionBtn").addEventListener("click", () => addOptionRow("", 0, "spin"));
    $("addBoolOptionBtn").addEventListener("click", () => addOptionRow("", true, "boolean"));
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
    $("cancelModalBtn").addEventListener("click", closeEngineModal);
    $("regenerateIdBtn").addEventListener("click", async () => {
      if (await confirmAction(text("editor.confirmRegenId", lang))) $<HTMLInputElement>("editId").value = generateId();
    });
    $("resetAllBtn").addEventListener("click", async () => {
      if (!(await confirmAction(text("editor.confirmResetAll", lang)))) return;
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
      openGroupNameModal({ kind: "create" });
    });
    $("manageGroupsBtn").addEventListener("click", () => {
      renderGroupTable();
      $("groupModal").style.display = "block";
    });
    $("closeGroupModalBtn").addEventListener("click", () => { $("groupModal").style.display = "none"; });
    $("groupNameSaveBtn").addEventListener("click", submitGroupNameModal);
    $("groupNameCancelBtn").addEventListener("click", closeGroupNameModal);
    $("groupNameInput").addEventListener("keydown", (e) => {
      // IME conversion confirm/cancel also fires keydown: never submit or
      // close the modal while a composition is in progress.
      if (isImeComposingKey(e as KeyboardEvent)) return;
      const key = (e as KeyboardEvent).key;
      if (key === "Enter") submitGroupNameModal();
      else if (key === "Escape") closeGroupNameModal();
    });
    window.addEventListener("click", (event) => {
      if (event.target === $("engineModal")) closeEngineModal();
      if (event.target === $("groupModal")) $("groupModal").style.display = "none";
      if (event.target === $("groupNameModal")) closeGroupNameModal();
    });
    window.addEventListener("beforeunload", () => {
      // Best effort: cancel any running probe so no engine is orphaned.
      probeSession.next();
    });
  }

  void init();
}
