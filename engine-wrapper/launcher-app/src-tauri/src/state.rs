use shogihome_launcher::{
    controller::Controller, lifecycle::Lifecycle, paths::PortablePaths, permissions,
};
use std::sync::{Arc, Mutex};
use tauri::Manager;

pub struct AppState {
    pub paths: PortablePaths,
    pub editor: crate::editor::EditorState,
    // Standalone editors never construct service supervision state.
    pub controller: Option<Arc<Controller>>,
    pub lifecycle: Mutex<Lifecycle>,
}

impl AppState {
    pub fn is_editor(&self) -> bool {
        self.controller.is_none()
    }
}

pub fn state(handle: &tauri::AppHandle) -> tauri::State<'_, AppState> {
    handle.state::<AppState>()
}

pub fn check(window: &tauri::Window, command: &str) -> Result<(), String> {
    if permissions::is_command_allowed(command, window.label()) {
        Ok(())
    } else {
        Err(format!(
            "command '{command}' is not allowed from this window"
        ))
    }
}
