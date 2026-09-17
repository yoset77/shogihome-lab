//! Editor IPC and window lifecycle, shared by embedded and standalone modes.
use crate::state::{check, state};
use shogihome_launcher::{
    editor, editor_session::EditorSession, lifecycle::Phase, native_text::text,
};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use tauri::Manager;

pub struct EditorState {
    pub config_dir: PathBuf,
    pub session: Arc<Mutex<EditorSession>>,
    /// Serializes the check-then-create sequence in `open_editor` so
    /// concurrent invokes cannot both observe "no editor window" and race
    /// `WebviewWindowBuilder` on the same label.
    opening: Mutex<()>,
}

impl EditorState {
    pub fn new(config_dir: PathBuf) -> Self {
        Self {
            config_dir,
            session: Arc::new(Mutex::new(EditorSession::default())),
            opening: Mutex::new(()),
        }
    }
}

pub fn create_window(handle: &tauri::AppHandle) -> Result<(), String> {
    let st = state(handle);
    let lifecycle = st.lifecycle.lock().unwrap();
    if lifecycle.phase != Phase::Running {
        return Err(text("launcherQuitting").into());
    }
    let owned_generation = {
        let mut session = st.editor.session.lock().unwrap();
        session.open(&st.editor.config_dir)?;
        session.generation()
    };
    // Window creation must not hold a mutex needed by native event callbacks.
    drop(lifecycle);
    let result = tauri::WebviewWindowBuilder::new(
        handle,
        "editor",
        tauri::WebviewUrl::App("editor.html".into()),
    )
    .title("ShogiHome Lab Config Editor")
    .inner_size(800.0, 900.0)
    .min_inner_size(600.0, 600.0)
    .build();
    if let Err(error) = result {
        // A concurrent opener may have won the race and own the live window;
        // only tear down the session when this request still owns it and no
        // editor window exists. Never close the winner's session.
        let owned = st
            .editor
            .session
            .lock()
            .unwrap()
            .should_release_after_build_failure(
                handle.get_webview_window("editor").is_some(),
                owned_generation,
            );
        if owned {
            let generation = st.editor.session.lock().unwrap().close();
            release_when_idle(handle.clone(), generation);
        }
        return Err(error.to_string());
    }
    Ok(())
}

#[tauri::command]
pub async fn open_editor(window: tauri::Window, handle: tauri::AppHandle) -> Result<(), String> {
    // Creating a WebView inside synchronous IPC deadlocks WebView2.
    check(&window, "open_editor")?;
    if state(&handle).lifecycle.lock().unwrap().phase != Phase::Running {
        return Err(text("launcherQuitting").into());
    }
    // Serialize check-then-create: without this, concurrent invokes
    // (double-click, tray + dashboard) can both observe "no editor window",
    // race the builder on the same label, and let the loser close() the
    // winner's shared session. No await runs under this guard.
    let st = state(&handle);
    let _opening = st.editor.opening.lock().unwrap();
    if let Some(editor) = handle.get_webview_window("editor") {
        let _ = editor.show();
        let _ = editor.set_focus();
        Ok(())
    } else {
        create_window(&handle)
    }
}

pub fn close_window(window: &tauri::Window) {
    let handle = window.app_handle();
    let generation = state(handle).editor.session.lock().unwrap().close();
    let _ = window.destroy();
    release_when_idle(handle.clone(), generation);
}

fn release_when_idle(handle: tauri::AppHandle, generation: u64) {
    std::thread::spawn(move || {
        let deadline = crate::shutdown::probe_drain_deadline();
        loop {
            let st = state(&handle);
            let mut session = st.editor.session.lock().unwrap();
            if session.generation() != generation {
                return;
            }
            if handle.get_webview_window("editor").is_none() && session.release_if_idle(generation)
            {
                return;
            }
            // Retain the lock on timeout; a reopen or app quit can retry.
            if std::time::Instant::now() >= deadline {
                return;
            }
            drop(session);
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
    });
}

fn engines_path(handle: &tauri::AppHandle) -> PathBuf {
    state(handle).editor.config_dir.join("engines.json")
}

#[tauri::command]
pub fn editor_load(
    window: tauri::Window,
    handle: tauri::AppHandle,
) -> Result<serde_json::Value, String> {
    check(&window, "editor_load")?;
    let engines = editor::load_engines_file(&engines_path(&handle))?;
    Ok(serde_json::json!({"engines": engines}))
}

#[tauri::command]
pub fn editor_save(
    window: tauri::Window,
    handle: tauri::AppHandle,
    engines: serde_json::Value,
) -> Result<(), String> {
    check(&window, "editor_save")?;
    // Keep the session lock alive through the entire atomic save.
    let st = state(&handle);
    let session = st.editor.session.lock().unwrap();
    session.ensure_open()?;
    editor::save_engines_file(&engines_path(&handle), &engines).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn editor_browse(
    window: tauri::Window,
    handle: tauri::AppHandle,
) -> Result<Option<String>, String> {
    check(&window, "editor_browse")?;
    use tauri_plugin_dialog::DialogExt;
    tauri::async_runtime::spawn_blocking(move || {
        let dialog = handle.dialog().file().set_title(text("chooseEngine"));
        #[cfg(windows)]
        let dialog = dialog
            .add_filter(text("executables"), &["exe", "bat", "cmd"])
            .add_filter(text("allFiles"), &["*"]);
        // Unix engines often have no extension. Let the OS select any file;
        // the existing probe reports exec/permission errors without a shell.
        dialog.blocking_pick_file().map(|path| path.to_string())
    })
    .await
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn editor_probe(
    window: tauri::Window,
    handle: tauri::AppHandle,
    path: String,
) -> Result<(u64, serde_json::Value, Vec<String>), String> {
    check(&window, "editor_probe")?;
    let (registration, base) = {
        let st = state(&handle);
        let lifecycle = st.lifecycle.lock().unwrap();
        if lifecycle.phase != Phase::Running {
            return Err(text("launcherQuitting").into());
        }
        (
            EditorSession::begin_probe(&st.editor.session)?,
            st.editor.config_dir.clone(),
        )
    };
    let id = registration.id;
    let (found, order) = tauri::async_runtime::spawn_blocking(move || {
        let result =
            editor::probe_usi_options(std::path::Path::new(&path), &base, &registration.cancel);
        drop(registration);
        result
    })
    .await
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
            value.insert("type".into(), serde_json::Value::String(option_type.into()));
            value.insert("default".into(), serde_json::Value::String(opt.default));
            if let Some(min) = opt.min {
                value.insert("min".into(), min.into());
            }
            if let Some(max) = opt.max {
                value.insert("max".into(), max.into());
            }
            if !opt.vars.is_empty() {
                value.insert("vars".into(), serde_json::json!(opt.vars));
            }
            (name, serde_json::Value::Object(value))
        })
        .collect();
    Ok((id, serde_json::Value::Object(options), order))
}

#[tauri::command]
pub fn editor_refresh(
    window: tauri::Window,
    existing: serde_json::Value,
    discovered: serde_json::Value,
    order: Vec<String>,
) -> Result<serde_json::Value, String> {
    check(&window, "editor_probe")?;
    let existing = existing.as_object().cloned().unwrap_or_default();
    let discovered = discovered.as_object().cloned().unwrap_or_default();
    let mut defs = std::collections::BTreeMap::new();
    for (name, def) in &discovered {
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
    let (values, display_order) = editor::refresh_options(&existing, &defs, &order);
    Ok(serde_json::json!({
        "values": serde_json::Value::Object(values),
        "order": display_order,
    }))
}

#[tauri::command]
pub fn editor_probe_cancel(
    window: tauri::Window,
    handle: tauri::AppHandle,
    id: u64,
) -> Result<(), String> {
    check(&window, "editor_probe_cancel")?;
    state(&handle).editor.session.lock().unwrap().cancel(id);
    Ok(())
}
