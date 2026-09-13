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
    editor, logs, migration, network, permissions, service, settings, supervisor, update,
};
use tauri::{Emitter, Manager};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

struct LauncherState {
    dist_root: PathBuf,
    supervisor: Mutex<supervisor::Supervisor>,
    services: Mutex<HashMap<String, service::RunningService>>,
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
        Err(format!("command '{command}' is not allowed from this window"))
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
fn start_services(window: tauri::Window, handle: tauri::AppHandle) -> Result<u64, String> {
    check(&window, "start_services")?;
    let st = state(&handle);
    let mut sup = st.supervisor.lock().map_err(|e| e.to_string())?;
    let generation = sup.request(supervisor::SupervisorRequest::Start).ok_or("already running")?;
    drop(sup);
    let handle_clone = handle.clone();
    std::thread::spawn(move || run_services(handle_clone, generation));
    Ok(generation)
}

fn service_specs(handle: &tauri::AppHandle) -> Result<(service::ServiceSpec, service::ServiceSpec, service::ReadyExpectation, service::ReadyExpectation), String> {
    let st = state(handle);
    let root = &st.dist_root;
    let (values, _) = settings::load_settings(&env_paths(handle));
    let text = |id: &str, fallback: &str| match values.get(id) {
        Some(settings::SettingValue::Text(t)) => t.clone(),
        _ => fallback.to_string(),
    };
    let server_port: u16 = text("PORT", "8140").parse().unwrap_or(8140);
    let bind = text("BIND_ADDRESS", "0.0.0.0");
    let wrapper_port: u16 = text("LISTEN_PORT", "4082").parse().unwrap_or(4082);

    let server_exe = root.join("shogihome").join("shogihome-server.exe");
    let server_entry = root.join("shogihome").join("dist").join("server").join("server.js");
    let server = service::ServiceSpec {
        name: "server".to_string(),
        program: server_exe,
        args: vec![server_entry.to_string_lossy().into_owned()],
        cwd: root.join("shogihome"),
        env: vec![],
        inherit_env: true,
    };
    let wrapper_bin = std::env::current_exe()
        .map_err(|e| e.to_string())?
        .parent()
        .ok_or("no exe dir")?
        .join("wrapper.exe");
    let wrapper = service::ServiceSpec {
        name: "wrapper".to_string(),
        program: wrapper_bin,
        args: vec!["--config-dir".to_string(), root.join("engine-wrapper").to_string_lossy().into_owned()],
        cwd: root.join("engine-wrapper"),
        env: vec![],
        inherit_env: true,
    };
    let server_host = if bind == "0.0.0.0" { "127.0.0.1".to_string() } else { bind };
    Ok((
        server,
        wrapper,
        service::ReadyExpectation { host: server_host, port: server_port },
        service::ReadyExpectation { host: "127.0.0.1".to_string(), port: wrapper_port },
    ))
}

fn run_services(handle: tauri::AppHandle, generation: u64) {
    let st = state(&handle);
    if let Err(e) = logs::rotate_logs(&log_dir(&handle)) {
        finish_generation(&handle, generation, false);
        eprintln!("log rotation failed: {e}");
        return;
    }
    let (server_spec, wrapper_spec, server_exp, wrapper_exp) = match service_specs(&handle) {
        Ok(v) => v,
        Err(e) => {
            eprintln!("service spec failed: {e}");
            finish_generation(&handle, generation, false);
            return;
        }
    };
    let dir = log_dir(&handle);
    let mut services = st.services.lock().unwrap();
    let mut ok = true;
    for spec in [server_spec, wrapper_spec] {
        match service::spawn_service(&spec, &dir) {
            Ok(running) => {
                services.insert(running.name.clone(), running);
            }
            Err(e) => {
                eprintln!("spawn {} failed: {e}", spec.name);
                let mut sup = st.supervisor.lock().unwrap();
                sup.service_failed(generation, &spec.name);
                ok = false;
            }
        }
    }
    if ok {
        let mut expectations = HashMap::new();
        expectations.insert("server".to_string(), server_exp);
        expectations.insert("wrapper".to_string(), wrapper_exp);
        match service::wait_ready(&mut services, &expectations, service::READY_TIMEOUT) {
            Ok(()) => {
                let mut sup = st.supervisor.lock().unwrap();
                sup.service_ready(generation, "server");
                sup.service_ready(generation, "wrapper");
            }
            Err(failed) => {
                eprintln!("services not ready: {failed:?}");
                for name in &failed {
                    let mut sup = st.supervisor.lock().unwrap();
                    sup.service_failed(generation, name);
                }
                ok = false;
            }
        }
    }
    drop(services);
    if !ok {
        // Partial-start rollback: never leave a live sibling behind.
        let mut services = st.services.lock().unwrap();
        service::stop_all(&mut services);
    }
    finish_generation(&handle, generation, ok);
}

fn finish_generation(handle: &tauri::AppHandle, generation: u64, success: bool) {
    let st = state(handle);
    let mut sup = st.supervisor.lock().unwrap();
    sup.complete(generation, success);
    if let Some(main) = handle.get_webview_window("main") {
        let _ = main.emit("launcher-status", status_payload(handle));
    }
}

#[tauri::command]
fn stop_services(window: tauri::Window, handle: tauri::AppHandle) -> Result<(), String> {
    check(&window, "stop_services")?;
    let st = state(&handle);
    let mut sup = st.supervisor.lock().map_err(|e| e.to_string())?;
    let generation = sup.request(supervisor::SupervisorRequest::Stop).ok_or("not running")?;
    drop(sup);
    let handle_clone = handle.clone();
    std::thread::spawn(move || {
        let st = state(&handle_clone);
        let mut services = st.services.lock().unwrap();
        service::stop_all(&mut services);
        drop(services);
        std::thread::sleep(service::RESTART_SETTLE);
        finish_generation(&handle_clone, generation, true);
    });
    Ok(())
}

#[tauri::command]
fn restart_services(window: tauri::Window, handle: tauri::AppHandle) -> Result<u64, String> {
    check(&window, "restart_services")?;
    let st = state(&handle);
    {
        let mut sup = st.supervisor.lock().map_err(|e| e.to_string())?;
        if matches!(
            sup.state(),
            supervisor::SupervisorState::Running | supervisor::SupervisorState::Failed
        ) {
            let gen = sup.request(supervisor::SupervisorRequest::Stop).ok_or("cannot stop")?;
            drop(sup);
            let mut services = st.services.lock().unwrap();
            service::stop_all(&mut services);
            drop(services);
            std::thread::sleep(service::RESTART_SETTLE);
            let _ = gen;
        }
    }
    start_services(window, handle)
}

#[tauri::command]
fn stop_and_exit(window: tauri::Window, handle: tauri::AppHandle) -> Result<(), String> {
    check(&window, "stop_and_exit")?;
    let st = state(&handle);
    st.quitting.store(true, Ordering::SeqCst);
    {
        let mut sup = st.supervisor.lock().map_err(|e| e.to_string())?;
        let _ = sup.request(supervisor::SupervisorRequest::Quit);
    }
    cancel_all_probes(handle.clone());
    let mut services = st.services.lock().unwrap();
    service::stop_all(&mut services);
    drop(services);
    handle.exit(0);
    Ok(())
}

#[tauri::command]
fn get_status(window: tauri::Window, handle: tauri::AppHandle) -> Result<serde_json::Value, String> {
    check(&window, "get_status")?;
    Ok(status_payload(&handle))
}

fn status_payload(handle: &tauri::AppHandle) -> serde_json::Value {
    let st = state(handle);
    let sup = st.supervisor.lock().unwrap();
    let state_name = match sup.state() {
        supervisor::SupervisorState::Stopped => "stopped",
        supervisor::SupervisorState::Starting => "starting",
        supervisor::SupervisorState::Running => "running",
        supervisor::SupervisorState::Stopping => "stopping",
        supervisor::SupervisorState::Failed => "failed",
        supervisor::SupervisorState::Quitting => "quitting",
    };
    serde_json::json!({
        "state": state_name,
        "server": format!("{:?}", sup.service_status("server")),
        "wrapper": format!("{:?}", sup.service_status("wrapper")),
    })
}

// --- Settings ---

#[tauri::command]
fn get_settings_schema(window: tauri::Window) -> Result<serde_json::Value, String> {
    check(&window, "get_settings_schema")?;
    Ok(settings::settings_schema())
}

#[tauri::command]
fn load_settings(window: tauri::Window, handle: tauri::AppHandle) -> Result<serde_json::Value, String> {
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
        let value = values.get(setting.id).cloned().unwrap_or(serde_json::Value::Null);
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
fn get_pc_url(window: tauri::Window, handle: tauri::AppHandle) -> Result<serde_json::Value, String> {
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
    let strict = matches!(values.get("DISABLE_AUTO_ALLOWED_ORIGINS"), Some(settings::SettingValue::Bool(true)));
    let port: u16 = text("PORT").parse().unwrap_or(8140);
    let (url, allowed) = network::pc_url_config(&text("BIND_ADDRESS"), port, strict, &origins, &network::local_ip());
    Ok(serde_json::json!({"url": url, "allowed": allowed}))
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
fn check_update(window: tauri::Window, handle: tauri::AppHandle) -> Result<Option<update::UpdateInfo>, String> {
    check(&window, "check_update")?;
    let st = state(&handle);
    let version_path = st.dist_root.join("engine-wrapper").join("VERSION");
    let current = update::load_current_version(&version_path).ok_or("no VERSION file")?;
    let payload = update::fetch_releases_json(update::DEFAULT_REPO_OWNER, update::DEFAULT_REPO_NAME, &current)?;
    Ok(update::select_best_release(&current, &payload))
}

#[tauri::command]
fn snooze_update(window: tauri::Window, handle: tauri::AppHandle, version: String) -> Result<(), String> {
    check(&window, "snooze_update")?;
    let path = state(&handle).dist_root.join("engine-wrapper").join(".update_cache.json");
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
fn open_editor(window: tauri::Window, handle: tauri::AppHandle) -> Result<(), String> {
    check(&window, "open_editor")?;
    match handle.get_webview_window("editor") {
        Some(editor) => {
            let _ = editor.show();
            let _ = editor.set_focus();
        }
        None => {
            tauri::WebviewWindowBuilder::new(&handle, "editor", tauri::WebviewUrl::App("editor.html".into()))
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
    state(handle).dist_root.join("engine-wrapper").join("engines.json")
}

#[tauri::command]
fn editor_load(window: tauri::Window, handle: tauri::AppHandle) -> Result<serde_json::Value, String> {
    check(&window, "editor_load")?;
    let engines = editor::load_engines_file(&engines_path(&handle))?;
    Ok(serde_json::json!({"engines": engines}))
}

#[tauri::command]
fn editor_save(window: tauri::Window, handle: tauri::AppHandle, engines: serde_json::Value) -> Result<(), String> {
    check(&window, "editor_save")?;
    editor::save_engines_file(&engines_path(&handle), &engines)
}

#[tauri::command]
fn editor_browse(window: tauri::Window, handle: tauri::AppHandle) -> Result<Option<String>, String> {
    check(&window, "editor_browse")?;
    use tauri_plugin_dialog::DialogExt;
    let picked = handle
        .dialog()
        .file()
        .add_filter("Executable", &["exe"])
        .blocking_pick_file();
    Ok(picked.map(|p| p.to_string()))
}

#[tauri::command]
fn editor_probe(
    window: tauri::Window,
    handle: tauri::AppHandle,
    path: String,
) -> Result<(u64, serde_json::Value), String> {
    check(&window, "editor_probe")?;
    let st = state(&handle);
    let id = st.next_probe.fetch_add(1, Ordering::SeqCst) + 1;
    let cancel = Arc::new(AtomicBool::new(false));
    st.probes.lock().map_err(|e| e.to_string())?.insert(id, cancel.clone());
    let base = st.dist_root.join("engine-wrapper");
    let found = shogihome_launcher::editor::probe_usi_options(std::path::Path::new(&path), &base, &cancel)
        .map_err(|e| e.to_string())?;
    st.probes.lock().map_err(|e| e.to_string())?.remove(&id);
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
            value.insert("type".to_string(), serde_json::Value::String(option_type.to_string()));
            value.insert("default".to_string(), serde_json::Value::String(opt.default));
            if let Some(min) = opt.min {
                value.insert("min".to_string(), serde_json::Value::from(min));
            }
            if let Some(max) = opt.max {
                value.insert("max".to_string(), serde_json::Value::from(max));
            }
            if !opt.vars.is_empty() {
                value.insert("vars".to_string(), serde_json::Value::Array(opt.vars.into_iter().map(serde_json::Value::String).collect()));
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
                default: def.get("default").and_then(|v| v.as_str()).unwrap_or("").to_string(),
                min: def.get("min").and_then(|v| v.as_i64()),
                max: def.get("max").and_then(|v| v.as_i64()),
                vars: def
                    .get("vars")
                    .and_then(|v| v.as_array())
                    .map(|a| a.iter().filter_map(|v| v.as_str().map(str::to_string)).collect())
                    .unwrap_or_default(),
            },
        );
    }
    Ok(serde_json::Value::Object(editor::refresh_options(&existing_map, &defs)))
}

#[tauri::command]
fn editor_probe_cancel(window: tauri::Window, handle: tauri::AppHandle, id: u64) -> Result<(), String> {
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
fn migration_plan(
    window: tauri::Window,
    handle: tauri::AppHandle,
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
fn migration_run(
    window: tauri::Window,
    handle: tauri::AppHandle,
    selected: String,
) -> Result<serde_json::Value, String> {
    check(&window, "migration_run")?;
    let st = state(&handle);
    if !migration::MigrationPaths::new(&st.dist_root).needs_migration() {
        return Ok(serde_json::json!({"migrated": false, "reason": "data dir already present"}));
    }
    let root = migration::resolve_old_root(std::path::Path::new(&selected));
    let plan = migration::plan_migration(&root);
    migration::execute_migration(&plan, &migration::MigrationPaths::new(&st.dist_root))?;
    Ok(serde_json::json!({"migrated": true}))
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
    let _tray = TrayIconBuilder::new()
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
    let dist_root = exe.parent().map(|p| p.to_path_buf()).unwrap_or_else(|| PathBuf::from("."));
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(LauncherState {
            dist_root,
            supervisor: Mutex::new(supervisor::Supervisor::new(&["server", "wrapper"])),
            services: Mutex::new(HashMap::new()),
            quitting: AtomicBool::new(false),
            next_probe: AtomicU64::new(0),
            probes: Mutex::new(HashMap::new()),
        })
        .setup(|app| {
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
                        cancel_all_probes(window.app_handle());
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
