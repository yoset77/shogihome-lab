use crate::{
    editor, launcher, shutdown,
    state::{state, AppState},
    tray,
};
use shogihome_launcher::{
    controller::Controller,
    launch_mode,
    lifecycle::{Lifecycle, MainCloseAction},
    native_text::text,
    paths::{executable_name, PortablePaths},
};
use std::sync::{Arc, Mutex};
use tauri::Manager;

pub fn run() {
    let args: Vec<String> = std::env::args().collect();
    let launch = launch_mode::parse_args(&args).unwrap_or_else(|error| {
        eprintln!("{error}");
        std::process::exit(2);
    });
    if launch.show_help {
        println!(
            "{}\n\n{}",
            launch_mode::usage(),
            text("help").replace("{wrapper}", &executable_name("wrapper"))
        );
        return;
    }
    let paths = std::env::current_exe()
        .and_then(|exe| PortablePaths::from_executable(&exe))
        .unwrap_or_else(|error| startup_failed(&error));
    let config_dir = paths
        .editor_config_dir(launch.config_dir_override.as_deref())
        .unwrap_or_else(|error| startup_failed(&error));
    let standalone = launch.mode == launch_mode::LaunchMode::ConfigEditor;
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(AppState {
            paths,
            editor: editor::EditorState::new(config_dir),
            controller: (!standalone).then(|| Arc::new(Controller::new(&["server", "wrapper"]))),
            lifecycle: Mutex::new(Lifecycle::default()),
        })
        .setup(move |app| {
            if standalone {
                editor::create_window(app.handle()).map_err(std::io::Error::other)?;
                return Ok(());
            }
            launcher::create_window(app.handle())?;
            let controller = Arc::downgrade(state(app.handle()).controller.as_ref().unwrap());
            std::thread::spawn(move || {
                while let Some(controller) = controller.upgrade() {
                    controller.check_health();
                    drop(controller);
                    std::thread::sleep(std::time::Duration::from_millis(500));
                }
            });
            if launch.tray_enabled {
                match tray::build(app.handle()) {
                    Ok(()) => state(app.handle()).lifecycle.lock().unwrap().tray_active = true,
                    Err(error) => eprintln!("{} {error}", text("trayUnavailable")),
                }
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                match window.label() {
                    "main" => {
                        api.prevent_close();
                        let action = state(window.app_handle())
                            .lifecycle
                            .lock()
                            .unwrap()
                            .main_close_action();
                        match action {
                            MainCloseAction::Hide => {
                                let _ = window.hide();
                            }
                            MainCloseAction::Shutdown => {
                                shutdown::request_native(window.app_handle().clone())
                            }
                            MainCloseAction::Wait => {}
                        }
                    }
                    "editor" => {
                        api.prevent_close();
                        if state(window.app_handle()).is_editor() {
                            // Do not depend on the OS emitting ExitRequested
                            // after the last window closes (notably macOS).
                            shutdown::request_native(window.app_handle().clone());
                        } else {
                            editor::close_window(window);
                        }
                    }
                    "settings" | "logs" => {
                        api.prevent_close();
                        let _ = window.destroy();
                    }
                    _ => {}
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            launcher::start_services,
            launcher::stop_services,
            launcher::restart_services,
            launcher::stop_and_exit,
            launcher::get_status,
            launcher::get_settings_schema,
            launcher::load_settings,
            launcher::save_settings,
            launcher::generate_token,
            launcher::get_pc_url,
            launcher::read_logs,
            launcher::check_update,
            launcher::snooze_update,
            launcher::get_ui_language,
            launcher::set_ui_language,
            launcher::open_settings_window,
            launcher::open_logs_window,
            launcher::close_settings_window,
            launcher::close_logs_window,
            editor::open_editor,
            editor::editor_load,
            editor::editor_save,
            editor::editor_browse,
            editor::editor_probe,
            editor::editor_refresh,
            editor::editor_probe_cancel,
            launcher::migration_plan,
            launcher::migration_run,
            launcher::migration_status,
        ])
        .build(tauri::generate_context!())
        .unwrap_or_else(|error| startup_failed(&error))
        .run(|app, event| match event {
            tauri::RunEvent::ExitRequested { api, .. } => shutdown::exit_requested(app, api),
            #[cfg(target_os = "macos")]
            tauri::RunEvent::Reopen { .. } => {
                let label = if state(app).is_editor() {
                    "editor"
                } else {
                    "main"
                };
                if let Some(window) = app.get_webview_window(label) {
                    let _ = window.show();
                    let _ = window.set_focus();
                }
            }
            _ => {}
        });
}

fn startup_failed(error: &dyn std::fmt::Display) -> ! {
    eprintln!("{} {error}", text("startupFailed"));
    let hint = if cfg!(windows) {
        "webviewWindows"
    } else if cfg!(target_os = "macos") {
        "webviewMacos"
    } else {
        "webviewLinux"
    };
    eprintln!("{}", text(hint));
    std::process::exit(1);
}
