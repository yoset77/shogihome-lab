//! All native and IPC quit paths drain owned processes before allowing exit.
use crate::state::state;
use shogihome_launcher::{editor, lifecycle::Phase, native_text::text};
use std::time::{Duration, Instant};
use tauri::Manager;

pub fn probe_drain_deadline() -> Instant {
    Instant::now()
        + editor::PROBE_USIOK_TIMEOUT
        + editor::PROBE_QUIT_TIMEOUT
        + Duration::from_secs(1)
}

pub fn request_native(handle: tauri::AppHandle) {
    tauri::async_runtime::spawn(async move {
        if let Err(error) = request(handle.clone()).await {
            // A native close has no IPC caller to display a cleanup failure.
            use tauri_plugin_dialog::DialogExt;
            if let Some(main) = handle.get_webview_window("main") {
                let _ = main.show();
                let _ = main.set_focus();
            }
            handle
                .dialog()
                .message(error)
                .title("ShogiHome Lab")
                .show(|_| {});
        }
    });
}

pub async fn request(handle: tauri::AppHandle) -> Result<(), String> {
    let st = state(&handle);
    if !st.lifecycle.lock().unwrap().request_exit() {
        return Ok(());
    }
    let session = st.editor.session.clone();
    let generation = session.lock().unwrap().close();
    let controller = st.controller.clone();
    let standalone = st.is_editor();
    let drained = tauri::async_runtime::spawn_blocking(move || {
        if let Some(controller) = controller {
            controller.quit();
        }
        let deadline = probe_drain_deadline();
        loop {
            let mut session = session.lock().unwrap();
            if session.is_idle() {
                session.release_if_idle(generation);
                return true;
            }
            drop(session);
            if Instant::now() >= deadline {
                return false;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
    })
    .await;
    // A failed worker must not leave the shell permanently stuck in Closing.
    let drained = drained.unwrap_or(false);
    let exit_code = state(&handle)
        .lifecycle
        .lock()
        .unwrap()
        .cleanup_finished(drained, standalone);
    match exit_code {
        Some(code) => {
            if code != 0 {
                eprintln!("{}", text("cleanupFailed"));
            }
            handle.exit(code);
            Ok(())
        }
        None => Err(text("cleanupFailed").into()),
    }
}

pub fn exit_requested(handle: &tauri::AppHandle, api: tauri::ExitRequestApi) {
    let st = state(handle);
    let lifecycle = st.lifecycle.lock().unwrap();
    if lifecycle.phase == Phase::ReadyToExit {
        return;
    }
    api.prevent_exit();
    // Tray residency is handled by preventing the main window's close. An
    // ExitRequested with code=None can also be a native Quit (e.g. Cmd+Q),
    // so every exit request must pass through cleanup regardless of its code.
    drop(lifecycle);
    request_native(handle.clone());
}
