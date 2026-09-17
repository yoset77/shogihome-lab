//! Window-scoped command allowlist.
//!
//! Tauri capabilities grant plugin permissions; app-command scoping is
//! enforced here, keyed on the calling window label, so the editor WebView
//! can never invoke service control and the dashboard can never touch the
//! engine registry. Pure string logic, unit-tested without Tauri.

const MAIN_COMMANDS: &[&str] = &[
    "start_services",
    "stop_services",
    "restart_services",
    "stop_and_exit",
    "get_status",
    "get_settings_schema",
    "load_settings",
    "save_settings",
    "generate_token",
    "get_pc_url",
    "read_logs",
    "check_update",
    "snooze_update",
    "get_ui_language",
    "set_ui_language",
    "open_editor",
    "open_settings_window",
    "open_logs_window",
    "migration_plan",
    "migration_run",
    "migration_status",
];

const EDITOR_COMMANDS: &[&str] = &[
    "editor_load",
    "editor_save",
    "editor_browse",
    "editor_probe",
    "editor_refresh",
    "editor_probe_cancel",
    "get_ui_language",
    "set_ui_language",
];

const SETTINGS_COMMANDS: &[&str] = &[
    "get_settings_schema",
    "load_settings",
    "save_settings",
    "generate_token",
    "restart_services",
    "get_status",
    "get_ui_language",
    "set_ui_language",
    "close_settings_window",
];

const LOGS_COMMANDS: &[&str] = &[
    "read_logs",
    "get_ui_language",
    "set_ui_language",
    "close_logs_window",
];

/// True when `window` may invoke `command`.
pub fn is_command_allowed(command: &str, window: &str) -> bool {
    match window {
        "main" => MAIN_COMMANDS.contains(&command),
        "editor" => EDITOR_COMMANDS.contains(&command),
        "settings" => SETTINGS_COMMANDS.contains(&command),
        "logs" => LOGS_COMMANDS.contains(&command),
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn windows_are_isolated() {
        assert!(is_command_allowed("stop_services", "main"));
        assert!(!is_command_allowed("stop_services", "editor"));
        assert!(is_command_allowed("editor_probe", "editor"));
        assert!(!is_command_allowed("editor_save", "main"));
        assert!(!is_command_allowed("start_services", "unknown"));
        assert!(!is_command_allowed("anything", "main"));
        // UI language is shared state: both windows may read and persist it.
        assert!(is_command_allowed("get_ui_language", "main"));
        assert!(is_command_allowed("set_ui_language", "editor"));
        // Settings/logs windows are scoped to their own commands.
        assert!(is_command_allowed("save_settings", "settings"));
        assert!(!is_command_allowed("save_settings", "logs"));
        assert!(is_command_allowed("read_logs", "logs"));
        assert!(!is_command_allowed("read_logs", "settings"));
        assert!(is_command_allowed("open_settings_window", "main"));
        assert!(!is_command_allowed("open_settings_window", "editor"));
        assert!(!is_command_allowed("stop_services", "settings"));
        // Each auxiliary window may only close itself.
        assert!(is_command_allowed("close_settings_window", "settings"));
        assert!(!is_command_allowed("close_settings_window", "logs"));
        assert!(is_command_allowed("close_logs_window", "logs"));
        assert!(!is_command_allowed("close_logs_window", "settings"));
    }
}
