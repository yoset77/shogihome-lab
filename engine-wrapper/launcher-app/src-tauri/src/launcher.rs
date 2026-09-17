//! Dashboard IPC. The controller owns all service and persistence operations.
use crate::state::{check, state};
use shogihome_launcher::{
    controller::Controller, error::LauncherError, logs, migration, network, server_env, service,
    settings, update,
};
use std::collections::HashMap;
use std::sync::Arc;
use tauri::{Emitter, Manager};

fn controller(handle: &tauri::AppHandle) -> Result<Arc<Controller>, String> {
    state(handle)
        .controller
        .clone()
        .ok_or_else(|| "launcher mode is required".into())
}

pub fn create_window(handle: &tauri::AppHandle) -> tauri::Result<()> {
    tauri::WebviewWindowBuilder::new(handle, "main", tauri::WebviewUrl::App("index.html".into()))
        .title("ShogiHome Lab")
        .inner_size(400.0, 540.0)
        .resizable(false)
        .build()?;
    Ok(())
}

fn emit_status(handle: &tauri::AppHandle) {
    if let Some(main) = handle.get_webview_window("main") {
        if let Ok(controller) = controller(handle) {
            let _ = main.emit("launcher-status", controller.status());
        }
    }
}

fn focus_or_create(
    handle: &tauri::AppHandle,
    label: &str,
    url: &str,
    title: &str,
    width: f64,
    height: f64,
) -> Result<(), String> {
    if let Some(window) = handle.get_webview_window(label) {
        let _ = window.show();
        let _ = window.set_focus();
        return Ok(());
    }
    tauri::WebviewWindowBuilder::new(handle, label, tauri::WebviewUrl::App(url.into()))
        .title(title)
        .inner_size(width, height)
        .min_inner_size(480.0, 360.0)
        .build()
        .map(|_| ())
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn open_settings_window(
    window: tauri::Window,
    handle: tauri::AppHandle,
) -> Result<(), String> {
    check(&window, "open_settings_window")?;
    focus_or_create(
        &handle,
        "settings",
        "settings.html",
        "ShogiHome Lab Server Settings",
        620.0,
        640.0,
    )
}

#[tauri::command]
pub async fn open_logs_window(
    window: tauri::Window,
    handle: tauri::AppHandle,
) -> Result<(), String> {
    check(&window, "open_logs_window")?;
    focus_or_create(
        &handle,
        "logs",
        "logs.html",
        "ShogiHome Lab Logs",
        600.0,
        640.0,
    )
}

fn close_window(handle: &tauri::AppHandle, label: &str) -> Result<(), String> {
    // Backend-side destroy needs no frontend window permission (same pattern
    // as editor::close_window); the CloseRequested handler also destroys, so
    // either path ends with the window gone.
    if let Some(window) = handle.get_webview_window(label) {
        window.destroy().map_err(|e| e.to_string())
    } else {
        Ok(())
    }
}

#[tauri::command]
pub async fn close_settings_window(
    window: tauri::Window,
    handle: tauri::AppHandle,
) -> Result<(), String> {
    check(&window, "close_settings_window")?;
    close_window(&handle, "settings")
}

#[tauri::command]
pub async fn close_logs_window(
    window: tauri::Window,
    handle: tauri::AppHandle,
) -> Result<(), String> {
    check(&window, "close_logs_window")?;
    close_window(&handle, "logs")
}

#[tauri::command]
pub async fn start_services(
    window: tauri::Window,
    handle: tauri::AppHandle,
) -> Result<u64, String> {
    check(&window, "start_services")?;
    let controller = controller(&handle)?;
    let root = state(&handle).paths.root.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        controller.start(|| service::portable_services(&root))
    })
    .await
    .map_err(|e| e.to_string())?;
    emit_status(&handle);
    result.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn stop_services(window: tauri::Window, handle: tauri::AppHandle) -> Result<(), String> {
    check(&window, "stop_services")?;
    let controller = controller(&handle)?;
    let result = tauri::async_runtime::spawn_blocking(move || controller.stop())
        .await
        .map_err(|e| e.to_string())?;
    emit_status(&handle);
    result.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn restart_services(
    window: tauri::Window,
    handle: tauri::AppHandle,
) -> Result<u64, String> {
    check(&window, "restart_services")?;
    let controller = controller(&handle)?;
    let root = state(&handle).paths.root.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        controller.restart(|| service::portable_services(&root))
    })
    .await
    .map_err(|e| e.to_string())?;
    emit_status(&handle);
    result.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn stop_and_exit(window: tauri::Window, handle: tauri::AppHandle) -> Result<(), String> {
    check(&window, "stop_and_exit")?;
    crate::shutdown::request(handle).await
}

#[tauri::command]
pub fn get_status(
    window: tauri::Window,
    handle: tauri::AppHandle,
) -> Result<serde_json::Value, String> {
    check(&window, "get_status")?;
    Ok(serde_json::to_value(controller(&handle)?.status()).expect("status is serializable"))
}

#[tauri::command]
pub fn get_settings_schema(window: tauri::Window) -> Result<serde_json::Value, String> {
    check(&window, "get_settings_schema")?;
    Ok(settings::settings_schema())
}

#[tauri::command]
pub async fn load_settings(
    window: tauri::Window,
    handle: tauri::AppHandle,
) -> Result<serde_json::Value, String> {
    check(&window, "load_settings")?;
    let st = state(&handle);
    let env_paths = st.paths.env_paths();
    let server_program = st.paths.server_program();
    // Node `parseEnv` runs in a short helper process; keep it off the UI loop.
    // Helper failures are surfaced so the UI never shows defaults over the
    // user's files (saving those would overwrite real settings).
    let (values, mismatches) = tauri::async_runtime::spawn_blocking(move || {
        settings::load_settings_with_program(&env_paths, Some(server_program.as_path()))
    })
    .await
    .map_err(|e| e.to_string())?
    .map_err(|e| e.to_string())?;
    let values: serde_json::Map<String, serde_json::Value> = values
        .into_iter()
        .map(|(key, value)| {
            let value = match value {
                settings::SettingValue::Bool(b) => serde_json::Value::Bool(b),
                settings::SettingValue::Text(t) => serde_json::Value::String(t),
            };
            (key, value)
        })
        .collect();
    Ok(serde_json::json!({"values": values, "mismatches": mismatches}))
}

#[tauri::command]
pub async fn save_settings(
    window: tauri::Window,
    handle: tauri::AppHandle,
    values: HashMap<String, serde_json::Value>,
) -> Result<(), String> {
    check(&window, "save_settings")?;
    let mut typed = HashMap::new();
    for setting in settings::SETTINGS {
        let value = values
            .get(setting.id)
            .cloned()
            .unwrap_or(serde_json::Value::Null);
        typed.insert(
            setting.id.to_string(),
            match value {
                serde_json::Value::Bool(b) => settings::SettingValue::Bool(b),
                serde_json::Value::String(s) => settings::SettingValue::Text(s),
                serde_json::Value::Number(n) => settings::SettingValue::Text(n.to_string()),
                _ => settings::SettingValue::Text(String::new()),
            },
        );
    }
    let controller = controller(&handle)?;
    let paths = state(&handle).paths.env_paths();
    let server_program = state(&handle).paths.server_program();
    // Resolve, validate, and persist under the same operation lock as startup.
    tauri::async_runtime::spawn_blocking(move || {
        controller.save_settings(&typed, &paths, &server_program)
    })
    .await
    .map_err(|e| e.to_string())?
    .map_err(|e| match e {
        LauncherError::InvalidSettings(errors) => {
            let codes: HashMap<_, _> = errors
                .into_iter()
                .map(|(id, error)| (id, error.code()))
                .collect();
            serde_json::to_string(&codes).expect("validation codes are serializable")
        }
        error => error.to_string(),
    })
}

#[tauri::command]
pub fn generate_token(window: tauri::Window) -> Result<String, String> {
    check(&window, "generate_token")?;
    Ok(settings::generate_token())
}

#[tauri::command]
pub async fn get_pc_url(
    window: tauri::Window,
    handle: tauri::AppHandle,
) -> Result<serde_json::Value, String> {
    check(&window, "get_pc_url")?;
    let st = state(&handle);
    let env_path = st.paths.env_paths().server;
    let server_program = st.paths.server_program();
    let parent = std::env::vars().collect();
    let urls = tauri::async_runtime::spawn_blocking(move || {
        let file = server_env::load_server_env(&env_path, &server_program)?;
        Ok::<_, LauncherError>(network::access_urls_from_env(
            &file,
            &parent,
            &network::local_ip(),
        ))
    })
    .await
    .map_err(|e| e.to_string())?
    .map_err(|e| e.to_string())?;
    Ok(serde_json::to_value(urls).expect("access URLs are serializable"))
}

#[tauri::command]
pub fn read_logs(
    window: tauri::Window,
    handle: tauri::AppHandle,
) -> Result<serde_json::Value, String> {
    check(&window, "read_logs")?;
    let dir = state(&handle).paths.log_dir();
    Ok(
        serde_json::json!({"server": logs::read_tail(&dir.join("server.log")), "wrapper": logs::read_tail(&dir.join("wrapper.log"))}),
    )
}

#[tauri::command]
pub async fn check_update(
    window: tauri::Window,
    handle: tauri::AppHandle,
) -> Result<Option<update::UpdateInfo>, String> {
    check(&window, "check_update")?;
    let dir = state(&handle).paths.config_dir();
    tauri::async_runtime::spawn_blocking(move || {
        update::check_bundled_update(&dir, |current| {
            update::fetch_releases_json(
                update::DEFAULT_REPO_OWNER,
                update::DEFAULT_REPO_NAME,
                current,
            )
        })
    })
    .await
    .map_err(|e| e.to_string())?
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn snooze_update(
    window: tauri::Window,
    handle: tauri::AppHandle,
    version: String,
) -> Result<(), String> {
    check(&window, "snooze_update")?;
    let path = state(&handle).paths.config_dir().join(".update_cache.json");
    let mut cache = update::UpdateCache::load(&path);
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    update::snooze(&mut cache, &version, now);
    cache.save(&path).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_ui_language(
    window: tauri::Window,
    handle: tauri::AppHandle,
) -> Result<Option<String>, String> {
    check(&window, "get_ui_language")?;
    let path = state(&handle).paths.config_dir().join(".update_cache.json");
    Ok(update::UpdateCache::load(&path).ui_language)
}

#[tauri::command]
pub fn set_ui_language(
    window: tauri::Window,
    handle: tauri::AppHandle,
    lang: String,
) -> Result<(), String> {
    check(&window, "set_ui_language")?;
    if lang != "ja" && lang != "en" {
        return Err("unsupported language".into());
    }
    let path = state(&handle).paths.config_dir().join(".update_cache.json");
    let mut cache = update::UpdateCache::load(&path);
    cache.ui_language = Some(lang);
    cache.save(&path).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn migration_status(
    window: tauri::Window,
    handle: tauri::AppHandle,
) -> Result<serde_json::Value, String> {
    check(&window, "migration_status")?;
    let paths = migration::MigrationPaths::new(&state(&handle).paths.root);
    Ok(
        serde_json::json!({"needed": paths.needs_migration(), "pendingSource": paths.pending_source()}),
    )
}

#[tauri::command]
pub fn migration_plan(
    window: tauri::Window,
    selected: String,
) -> Result<serde_json::Value, String> {
    check(&window, "migration_plan")?;
    let root = migration::resolve_old_root(std::path::Path::new(&selected));
    let plan = migration::plan_migration(&root);
    Ok(
        serde_json::json!({"oldRoot": plan.old_root, "hasData": plan.has_data, "hasEngines": plan.has_engines,
        "hasAnyEnv": plan.has_any_env, "missing": plan.missing(), "empty": plan.has_nothing()}),
    )
}

#[tauri::command]
pub async fn migration_run(
    window: tauri::Window,
    handle: tauri::AppHandle,
    selected: String,
) -> Result<serde_json::Value, String> {
    check(&window, "migration_run")?;
    let controller = controller(&handle)?;
    let dest = migration::MigrationPaths::new(&state(&handle).paths.root);
    tauri::async_runtime::spawn_blocking(move || {
        controller.while_stopped(|| {
            if !dest.needs_migration() {
                return Ok(serde_json::json!({"migrated": false}));
            }
            let root = migration::resolve_old_root(std::path::Path::new(&selected));
            migration::execute_migration(&migration::plan_migration(&root), &dest)?;
            Ok(serde_json::json!({"migrated": true}))
        })
    })
    .await
    .map_err(|e| e.to_string())?
    .map_err(|e| e.to_string())
}
