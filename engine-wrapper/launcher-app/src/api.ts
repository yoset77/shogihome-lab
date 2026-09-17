// Typed Tauri command bindings. Window scoping is enforced backend-side
// (permissions::is_command_allowed); these wrappers only shape payloads.

import { invoke } from "@tauri-apps/api/core";

export type LauncherState = "stopped" | "starting" | "running" | "stopping" | "failed" | "quitting";

export interface StatusPayload {
  state: LauncherState;
  services: Record<string, "pending" | "ready" | "failed">;
}

export interface SettingsSchema {
  sections: string[];
  settings: {
    id: string;
    type: "int" | "bool" | "text" | "choice" | "list";
    section: string;
    default: string | boolean;
    min: number | null;
    max: number | null;
    choices: string[];
    listRule: "origin" | "domain" | "none";
  }[];
}

export type SettingValues = Record<string, string | boolean>;

export interface EngineEntry {
  id: string;
  name: string;
  path: string;
  type?: string[];
  options?: Record<string, string | number | boolean>;
  skipAnalysisDB?: boolean;
  analysisDBGroupId?: string;
  analysisDBGroupName?: string;
  [key: string]: unknown;
}

export interface ProbeOptionDef {
  type: "check" | "spin" | "combo" | "string" | "button" | "filename";
  default: string;
  min?: number;
  max?: number;
  vars?: string[];
}

export const api = {
  startServices: () => invoke<number>("start_services"),
  stopServices: () => invoke<void>("stop_services"),
  restartServices: () => invoke<number>("restart_services"),
  stopAndExit: () => invoke<void>("stop_and_exit"),
  getStatus: () => invoke<StatusPayload>("get_status"),
  getSettingsSchema: () => invoke<SettingsSchema>("get_settings_schema"),
  loadSettings: () => invoke<{ values: SettingValues; mismatches: string[] }>("load_settings"),
  saveSettings: (values: SettingValues) => invoke<void>("save_settings", { values }),
  generateToken: () => invoke<string>("generate_token"),
  getPcUrl: () => invoke<{ url: string; allowed: boolean; qrUrl: string | null; bind: string; autoOrigins: boolean }>("get_pc_url"),
  readLogs: () => invoke<{ server: string; wrapper: string }>("read_logs"),
  checkUpdate: () => invoke<{ version: string; tag: string; url: string } | null>("check_update"),
  snoozeUpdate: (version: string) => invoke<void>("snooze_update", { version }),
  getUiLanguage: () => invoke<string | null>("get_ui_language"),
  setUiLanguage: (lang: string) => invoke<void>("set_ui_language", { lang }),
  openEditor: () => invoke<void>("open_editor"),
  openSettingsWindow: () => invoke<void>("open_settings_window"),
  openLogsWindow: () => invoke<void>("open_logs_window"),
  closeSettingsWindow: () => invoke<void>("close_settings_window"),
  closeLogsWindow: () => invoke<void>("close_logs_window"),
  migrationPlan: (selected: string) =>
    invoke<{ oldRoot: string; hasData: boolean; hasEngines: boolean; hasAnyEnv: boolean; missing: string[]; empty: boolean }>(
      "migration_plan",
      { selected },
    ),
  migrationStatus: () => invoke<{ needed: boolean; pendingSource: string | null }>("migration_status"),
  migrationRun: (selected: string) => invoke<{ migrated: boolean; reason?: string }>("migration_run", { selected }),
  editorLoad: () => invoke<{ engines: EngineEntry[] }>("editor_load"),
  editorSave: (engines: EngineEntry[]) => invoke<void>("editor_save", { engines }),
  editorBrowse: () => invoke<string | null>("editor_browse"),
  editorProbe: (path: string) => invoke<[number, Record<string, ProbeOptionDef>, string[]]>("editor_probe", { path }),
  editorRefresh: (
    existing: Record<string, string | number | boolean>,
    discovered: Record<string, ProbeOptionDef>,
    order: string[],
  ) =>
    invoke<{ values: Record<string, string | number | boolean>; order: string[] }>("editor_refresh", {
      existing,
      discovered,
      order,
    }),
  editorProbeCancel: (id: number) => invoke<void>("editor_probe_cancel", { id }),
};
