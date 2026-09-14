use shogihome_launcher::native_text::text;
use tauri::{Emitter, Manager};

pub fn build(handle: &tauri::AppHandle) -> tauri::Result<()> {
    use tauri::menu::{MenuBuilder, MenuItemBuilder};
    use tauri::tray::TrayIconBuilder;
    let open = MenuItemBuilder::with_id("open", text("trayOpen")).build(handle)?;
    let dashboard = MenuItemBuilder::with_id("dashboard", text("trayDashboard")).build(handle)?;
    let editor = MenuItemBuilder::with_id("editor", text("trayEditor")).build(handle)?;
    let exit = MenuItemBuilder::with_id("exit", text("trayExit")).build(handle)?;
    let menu = MenuBuilder::new(handle)
        .items(&[&open, &dashboard, &editor, &exit])
        .build()?;
    let icon = handle
        .default_window_icon()
        .cloned()
        .unwrap_or_else(|| tauri::image::Image::new_owned(vec![0, 0, 0, 0], 1, 1));
    TrayIconBuilder::new()
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
            "exit" => crate::shutdown::request_native(app.clone()),
            _ => {}
        })
        .build(handle)?;
    Ok(())
}
