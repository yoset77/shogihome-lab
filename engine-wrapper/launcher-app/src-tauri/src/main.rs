#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
//! ShogiHomeLab launcher (Tauri v2 shell).
//!
//! Thin IPC layer over `shogihome-launcher`: every command first enforces
//! the window allowlist (`permissions::is_command_allowed`), then delegates
//! to the tested backend. Service processes are spawned by the backend with
//! explicit paths (no shell), so Windows Job-Object assignment can use
//! suspended creation without fighting the shell plugin.
//!
//! NOTE: this crate is compiled for Windows targets in Phase 4; it is
//! excluded from the Linux workspace because it needs WebView system libs.

use shogihome_launcher::{
    controller, editor, logs, migration, network, permissions, service, settings, update,
};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use tauri::{Emitter, Manager};

struct LauncherState {
    dist_root: PathBuf,
    controller: Arc<controller::Controller>,
    quitting: AtomicBool,
    next_probe: AtomicU64,
    probes: Mutex<HashMap<u64, Arc<AtomicBool>>>,
}

fn state(handle: &tauri::AppHandle) -> tauri::State<'_, LauncherState> {
    handle.state::<LauncherState>()
}

fn check(window: &tauri::Window, command: &str) -> Result<(), String> {
    if permissions::is_command_allowed(command, window.label()) {
        Ok(())
    } else {
        Err(format!(
            "command '{command}' is not allowed from this window"
        ))
    }
}

fn env_paths(handle: &tauri::AppHandle) -> settings::EnvPaths {
    let st = state(handle);
    let root = &st.dist_root;
    settings::EnvPaths::new(&root.join("shogihome"), &root.join("engine-wrapper"))
}

fn log_dir(handle: &tauri::AppHandle) -> PathBuf {
    state(handle).dist_root.join("engine-wrapper").join("logs")
}

// --- Service control ---

#[tauri::command]
async fn start_services(window: tauri::Window, handle: tauri::AppHandle) -> Result<u64, String> {
    check(&window, "start_services")?;
    let controller = state(&handle).controller.clone();
    let root = state(&handle).dist_root.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        controller.start(|| service::portable_services(&root))
    })
    .await
    .map_err(|e| e.to_string())?;
    emit_status(&handle);
    result
}

fn emit_status(handle: &tauri::AppHandle) {
    if let Some(main) = handle.get_webview_window("main") {
        let _ = main.emit("launcher-status", status_payload(handle));
    }
}

#[tauri::command]
async fn stop_services(window: tauri::Window, handle: tauri::AppHandle) -> Result<(), String> {
    check(&window, "stop_services")?;
    let controller = state(&handle).controller.clone();
    let result = tauri::async_runtime::spawn_blocking(move || controller.stop())
        .await
        .map_err(|e| e.to_string())?;
    emit_status(&handle);
    result
}

#[tauri::command]
async fn restart_services(window: tauri::Window, handle: tauri::AppHandle) -> Result<u64, String> {
    check(&window, "restart_services")?;
    let controller = state(&handle).controller.clone();
    let root = state(&handle).dist_root.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        controller.restart(|| service::portable_services(&root))
    })
    .await
    .map_err(|e| e.to_string())?;
    emit_status(&handle);
    result
}

#[tauri::command]
async fn stop_and_exit(window: tauri::Window, handle: tauri::AppHandle) -> Result<(), String> {
    check(&window, "stop_and_exit")?;
    let st = state(&handle);
    st.quitting.store(true, Ordering::SeqCst);
    cancel_all_probes(handle.clone());
    let controller = st.controller.clone();
    drop(st);
    tauri::async_runtime::spawn_blocking(move || controller.quit())
        .await
        .map_err(|e| e.to_string())?;
    // Probe workers own processes too. Do not terminate the application before
    // their cancellation cleanup has released inherited pipes and Job handles.
    let probes_done = tauri::async_runtime::spawn_blocking(move || {
        let deadline = std::time::Instant::now()
            + editor::PROBE_USIOK_TIMEOUT
            + editor::PROBE_QUIT_TIMEOUT
            + std::time::Duration::from_secs(1);
        loop {
            if state(&handle).probes.lock().unwrap().is_empty() {
                return Ok(handle);
            }
            if std::time::Instant::now() >= deadline {
                state(&handle).quitting.store(false, Ordering::SeqCst);
                return Err("probe cleanup did not complete".to_string());
            }
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
    })
    .await
    .map_err(|e| e.to_string())??;
    probes_done.exit(0);
    Ok(())
}

#[tauri::command]
fn get_status(
    window: tauri::Window,
    handle: tauri::AppHandle,
) -> Result<serde_json::Value, String> {
    check(&window, "get_status")?;
    Ok(status_payload(&handle))
}

fn status_payload(handle: &tauri::AppHandle) -> serde_json::Value {
    serde_json::to_value(state(handle).controller.status()).expect("status is serializable")
}

// --- Settings ---

#[tauri::command]
fn get_settings_schema(window: tauri::Window) -> Result<serde_json::Value, String> {
    check(&window, "get_settings_schema")?;
    Ok(settings::settings_schema())
}

#[tauri::command]
fn load_settings(
    window: tauri::Window,
    handle: tauri::AppHandle,
) -> Result<serde_json::Value, String> {
    check(&window, "load_settings")?;
    let (values, mismatches) = settings::load_settings(&env_paths(&handle));
    let values_json: serde_json::Map<String, serde_json::Value> = values
        .into_iter()
        .map(|(k, v)| {
            let json = match v {
                settings::SettingValue::Bool(b) => serde_json::Value::Bool(b),
                settings::SettingValue::Text(t) => serde_json::Value::String(t),
            };
            (k, json)
        })
        .collect();
    Ok(serde_json::json!({"values": values_json, "mismatches": mismatches}))
}

#[tauri::command]
fn save_settings(
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
    let errors = settings::validate(&typed);
    if !errors.is_empty() {
        let mut out: HashMap<String, String> = HashMap::new();
        for (id, err) in errors {
            out.insert(id, err.code().to_string());
        }
        return Err(serde_json::to_string(&out).unwrap_or_default());
    }
    settings::save(&typed, &env_paths(&handle))
}

#[tauri::command]
fn generate_token(window: tauri::Window) -> Result<String, String> {
    check(&window, "generate_token")?;
    Ok(settings::generate_token())
}

#[tauri::command]
fn get_pc_url(
    window: tauri::Window,
    handle: tauri::AppHandle,
) -> Result<serde_json::Value, String> {
    check(&window, "get_pc_url")?;
    let (values, _) = settings::load_settings(&env_paths(&handle));
    let text = |id: &str| match values.get(id) {
        Some(settings::SettingValue::Text(t)) => t.clone(),
        _ => String::new(),
    };
    let origins: Vec<String> = text("ALLOWED_ORIGINS")
        .split(',')
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .collect();
    let strict = matches!(
        values.get("DISABLE_AUTO_ALLOWED_ORIGINS"),
        Some(settings::SettingValue::Bool(true))
    );
    let port: u16 = text("PORT").parse().unwrap_or(8140);
    Ok(serde_json::to_value(network::access_urls(
        &text("BIND_ADDRESS"),
        port,
        strict,
        &origins,
        &network::local_ip(),
    ))
    .expect("access URLs are serializable"))
}

// --- Logs / updates ---

#[tauri::command]
fn read_logs(window: tauri::Window, handle: tauri::AppHandle) -> Result<serde_json::Value, String> {
    check(&window, "read_logs")?;
    let dir = log_dir(&handle);
    Ok(serde_json::json!({
        "server": logs::read_tail(&dir.join("server.log")),
        "wrapper": logs::read_tail(&dir.join("wrapper.log")),
    }))
}

#[tauri::command]
async fn check_update(
    window: tauri::Window,
    handle: tauri::AppHandle,
) -> Result<Option<update::UpdateInfo>, String> {
    check(&window, "check_update")?;
    let dir = state(&handle).dist_root.join("engine-wrapper");
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
}

#[tauri::command]
fn snooze_update(
    window: tauri::Window,
    handle: tauri::AppHandle,
    version: String,
) -> Result<(), String> {
    check(&window, "snooze_update")?;
    let path = state(&handle)
        .dist_root
        .join("engine-wrapper")
        .join(".update_cache.json");
    let mut cache = update::UpdateCache::load(&path);
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    // Preserve an existing UI language stored by older caches.
    update::snooze(&mut cache, &version, now);
    cache.save(&path)
}

// --- Editor window ---

#[tauri::command]
async fn open_editor(window: tauri::Window, handle: tauri::AppHandle) -> Result<(), String> {
    // WebView2 creation deadlocks inside synchronous IPC handlers on Windows.
    check(&window, "open_editor")?;
    match handle.get_webview_window("editor") {
        Some(editor) => {
            let _ = editor.show();
            let _ = editor.set_focus();
        }
        None => {
            tauri::WebviewWindowBuilder::new(
                &handle,
                "editor",
                tauri::WebviewUrl::App("editor.html".into()),
            )
            .title("ShogiHome Lab Config Editor")
            .inner_size(800.0, 900.0)
            .min_inner_size(600.0, 600.0)
            .build()
            .map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

fn engines_path(handle: &tauri::AppHandle) -> PathBuf {
    state(handle)
        .dist_root
        .join("engine-wrapper")
        .join("engines.json")
}

#[tauri::command]
fn editor_load(
    window: tauri::Window,
    handle: tauri::AppHandle,
) -> Result<serde_json::Value, String> {
    check(&window, "editor_load")?;
    let engines = editor::load_engines_file(&engines_path(&handle))?;
    Ok(serde_json::json!({"engines": engines}))
}

#[tauri::command]
fn editor_save(
    window: tauri::Window,
    handle: tauri::AppHandle,
    engines: serde_json::Value,
) -> Result<(), String> {
    check(&window, "editor_save")?;
    editor::save_engines_file(&engines_path(&handle), &engines)
}

#[tauri::command]
async fn editor_browse(
    window: tauri::Window,
    handle: tauri::AppHandle,
) -> Result<Option<String>, String> {
    check(&window, "editor_browse")?;
    use tauri_plugin_dialog::DialogExt;
    // The blocking dialog API must not occupy the UI or async executor thread.
    tauri::async_runtime::spawn_blocking(move || {
        handle
            .dialog()
            .file()
            .add_filter("Executable", &["exe"])
            .blocking_pick_file()
            .map(|p| p.to_string())
    })
    .await
    .map_err(|e| e.to_string())
}

#[tauri::command]
async fn editor_probe(
    window: tauri::Window,
    handle: tauri::AppHandle,
    path: String,
) -> Result<(u64, serde_json::Value), String> {
    check(&window, "editor_probe")?;
    let st = state(&handle);
    let id = st.next_probe.fetch_add(1, Ordering::SeqCst) + 1;
    let cancel = Arc::new(AtomicBool::new(false));
    {
        let mut probes = st.probes.lock().map_err(|e| e.to_string())?;
        if st.quitting.load(Ordering::SeqCst) {
            return Err("launcher is quitting".into());
        }
        probes.insert(id, cancel.clone());
    }
    let base = st.dist_root.join("engine-wrapper");
    // Blocking child I/O must leave the main thread: Tauri runs non-async
    // commands there, and a probe can take seconds (engine timeout + quit
    // grace). Cancellation still works via the shared flag.
    let result = tauri::async_runtime::spawn_blocking(move || {
        shogihome_launcher::editor::probe_usi_options(std::path::Path::new(&path), &base, &cancel)
    })
    .await;
    st.probes.lock().map_err(|e| e.to_string())?.remove(&id);
    let found = result
        .map_err(|e| format!("probe task failed: {e}"))?
        .map_err(|e| e.to_string())?;
    let options: serde_json::Map<String, serde_json::Value> = found
        .into_iter()
        .map(|(name, opt)| {
            let option_type = match opt.option_type {
                editor::UsiOptionType::Check => "check",
                editor::UsiOptionType::Spin => "spin",
                editor::UsiOptionType::Combo => "combo",
                editor::UsiOptionType::String => "string",
                editor::UsiOptionType::Button => "button",
                editor::UsiOptionType::Filename => "filename",
            };
            let mut value = serde_json::Map::new();
            value.insert(
                "type".to_string(),
                serde_json::Value::String(option_type.to_string()),
            );
            value.insert(
                "default".to_string(),
                serde_json::Value::String(opt.default),
            );
            if let Some(min) = opt.min {
                value.insert("min".to_string(), serde_json::Value::from(min));
            }
            if let Some(max) = opt.max {
                value.insert("max".to_string(), serde_json::Value::from(max));
            }
            if !opt.vars.is_empty() {
                value.insert(
                    "vars".to_string(),
                    serde_json::Value::Array(
                        opt.vars
                            .into_iter()
                            .map(serde_json::Value::String)
                            .collect(),
                    ),
                );
            }
            (name, serde_json::Value::Object(value))
        })
        .collect();
    Ok((id, serde_json::Value::Object(options)))
}

/// Merge probe results over the rows currently shown, preserving manual
/// entries (single source of truth; the UI never reimplements this).
#[tauri::command]
fn editor_refresh(
    window: tauri::Window,
    existing: serde_json::Value,
    discovered: serde_json::Value,
) -> Result<serde_json::Value, String> {
    check(&window, "editor_probe")?;
    let existing_map = existing.as_object().cloned().unwrap_or_default();
    let discovered_map = discovered.as_object().cloned().unwrap_or_default();
    let mut defs = std::collections::BTreeMap::new();
    for (name, def) in &discovered_map {
        let option_type = match def.get("type").and_then(|v| v.as_str()) {
            Some("check") => editor::UsiOptionType::Check,
            Some("spin") => editor::UsiOptionType::Spin,
            Some("combo") => editor::UsiOptionType::Combo,
            Some("button") => editor::UsiOptionType::Button,
            Some("filename") => editor::UsiOptionType::Filename,
            _ => editor::UsiOptionType::String,
        };
        defs.insert(
            name.clone(),
            editor::UsiOption {
                option_type,
                default: def
                    .get("default")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string(),
                min: def.get("min").and_then(|v| v.as_i64()),
                max: def.get("max").and_then(|v| v.as_i64()),
                vars: def
                    .get("vars")
                    .and_then(|v| v.as_array())
                    .map(|a| {
                        a.iter()
                            .filter_map(|v| v.as_str().map(str::to_string))
                            .collect()
                    })
                    .unwrap_or_default(),
            },
        );
    }
    Ok(serde_json::Value::Object(editor::refresh_options(
        &existing_map,
        &defs,
    )))
}

#[tauri::command]
fn editor_probe_cancel(
    window: tauri::Window,
    handle: tauri::AppHandle,
    id: u64,
) -> Result<(), String> {
    check(&window, "editor_probe_cancel")?;
    let st = state(&handle);
    let probes = st.probes.lock().map_err(|e| e.to_string())?;
    if let Some(cancel) = probes.get(&id) {
        cancel.store(true, Ordering::SeqCst);
    }
    Ok(())
}

fn cancel_all_probes(handle: tauri::AppHandle) {
    if let Ok(probes) = state(&handle).probes.lock() {
        for cancel in probes.values() {
            cancel.store(true, Ordering::SeqCst);
        }
    }
}

// --- Migration ---

#[tauri::command]
fn migration_status(
    window: tauri::Window,
    handle: tauri::AppHandle,
) -> Result<serde_json::Value, String> {
    check(&window, "migration_status")?;
    let paths = migration::MigrationPaths::new(&state(&handle).dist_root);
    Ok(
        serde_json::json!({"needed": paths.needs_migration(), "pendingSource": paths.pending_source()}),
    )
}

#[tauri::command]
fn migration_plan(
    window: tauri::Window,
    _handle: tauri::AppHandle,
    selected: String,
) -> Result<serde_json::Value, String> {
    check(&window, "migration_plan")?;
    let root = migration::resolve_old_root(std::path::Path::new(&selected));
    let plan = migration::plan_migration(&root);
    Ok(serde_json::json!({
        "oldRoot": plan.old_root,
        "hasData": plan.has_data,
        "hasEngines": plan.has_engines,
        "hasAnyEnv": plan.has_any_env,
        "missing": plan.missing(),
        "empty": plan.has_nothing(),
    }))
}

#[tauri::command]
async fn migration_run(
    window: tauri::Window,
    handle: tauri::AppHandle,
    selected: String,
) -> Result<serde_json::Value, String> {
    check(&window, "migration_run")?;
    let controller = state(&handle).controller.clone();
    let dest = migration::MigrationPaths::new(&state(&handle).dist_root);
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
}

// --- App setup ---

fn build_tray(handle: &tauri::AppHandle) -> tauri::Result<()> {
    use tauri::menu::{MenuBuilder, MenuItemBuilder};
    use tauri::tray::TrayIconBuilder;
    let open = MenuItemBuilder::with_id("open", "ShogiHomeを開く").build(handle)?;
    let dashboard = MenuItemBuilder::with_id("dashboard", "ダッシュボード").build(handle)?;
    let editor_item = MenuItemBuilder::with_id("editor", "設定").build(handle)?;
    let exit = MenuItemBuilder::with_id("exit", "終了").build(handle)?;
    let menu = MenuBuilder::new(handle)
        .items(&[&open, &dashboard, &editor_item, &exit])
        .build()?;
    // Windows requires an explicit tray icon: prefer the bundled app icon,
    // fall back to a 1x1 transparent pixel so the tray still builds.
    let icon = handle
        .default_window_icon()
        .cloned()
        .unwrap_or_else(|| tauri::image::Image::new_owned(vec![0, 0, 0, 0], 1, 1));
    let _tray = TrayIconBuilder::new()
        .icon(icon)
        .menu(&menu)
        .tooltip("ShogiHome Lab")
        .on_menu_event(|app, event| match event.id().as_ref() {
            "open" => {
                if let Some(main) = app.get_webview_window("main") {
                    let _ = main.emit("tray-open-browser", ());
                }
            }
            "dashboard" => {
                if let Some(main) = app.get_webview_window("main") {
                    let _ = main.show();
                    let _ = main.set_focus();
                }
            }
            "editor" => {
                if let Some(main) = app.get_webview_window("main") {
                    let _ = main.emit("tray-open-editor", ());
                }
            }
            "exit" => {
                if let Some(main) = app.get_webview_window("main") {
                    let _ = main.emit("tray-exit", ());
                }
            }
            _ => {}
        })
        .build(handle)?;
    Ok(())
}

pub fn run() {
    let exe = std::env::current_exe().unwrap_or_else(|_| PathBuf::from("."));
    let dist_root = exe
        .parent()
        .map(|p| p.to_path_buf())
        .unwrap_or_else(|| PathBuf::from("."));
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(LauncherState {
            dist_root,
            controller: Arc::new(controller::Controller::new(&["server", "wrapper"])),
            quitting: AtomicBool::new(false),
            next_probe: AtomicU64::new(0),
            probes: Mutex::new(HashMap::new()),
        })
        .setup(|app| {
            let controller = Arc::downgrade(&state(app.handle()).controller);
            std::thread::spawn(move || {
                while let Some(controller) = controller.upgrade() {
                    controller.check_health();
                    drop(controller);
                    std::thread::sleep(std::time::Duration::from_millis(500));
                }
            });
            // Tray is best-effort: if it cannot be created, the main window
            // stays visible so the app never becomes unreachable.
            if build_tray(app.handle()).is_err() {
                eprintln!("tray unavailable; running with visible dashboard");
                if let Some(main) = app.get_webview_window("main") {
                    let _ = main.show();
                }
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                match window.label() {
                    // Main close hides to tray; explicit exit goes through
                    // stop_and_exit which sets the quitting flag first.
                    "main" => {
                        let quitting = window.state::<LauncherState>().quitting.load(Ordering::SeqCst);
                        if quitting {
                            return;
                        }
                        api.prevent_close();
                        let _ = window.hide();
                    }
                    // The editor owns probes: cancel them, then destroy.
                    "editor" => {
                        cancel_all_probes(window.app_handle().clone());
                        let _ = window.destroy();
                    }
                    _ => {}
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            start_services,
            stop_services,
            restart_services,
            stop_and_exit,
            get_status,
            get_settings_schema,
            load_settings,
            save_settings,
            generate_token,
            get_pc_url,
            read_logs,
            check_update,
            snooze_update,
            open_editor,
            editor_load,
            editor_save,
            editor_browse,
            editor_probe,
            editor_refresh,
            editor_probe_cancel,
            migration_plan,
            migration_run,
            migration_status,
        ])
        .build(tauri::generate_context!())
        .unwrap_or_else(|e| {
            eprintln!("launcher failed to start: {e}");
            eprintln!("If no window appears, install the WebView2 Runtime from https://developer.microsoft.com/microsoft-edge/webview2/");
            std::process::exit(1);
        })
        .run(|app, event| {
            if let tauri::RunEvent::ExitRequested { api, .. } = event {
                let quitting = app.state::<LauncherState>().quitting.load(Ordering::SeqCst);
                if !quitting {
                    // Tray resident: keep running when all windows close.
                    api.prevent_exit();
                }
            }
        });
}

fn main() {
    run();
}
