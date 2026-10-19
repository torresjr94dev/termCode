//! Quick terminal: a borderless window that drops from the top of the screen
//! with a global shortcut (registered by the webview from the user's settings)
//! and hides again with the same shortcut.

use tauri::{
    AppHandle, LogicalPosition, LogicalSize, Manager, WebviewUrl, WebviewWindow,
    WebviewWindowBuilder,
};

const LABEL: &str = "quick";
const HEIGHT_RATIO: f64 = 0.42;

fn window(app: &AppHandle) -> tauri::Result<WebviewWindow> {
    if let Some(existing) = app.get_webview_window(LABEL) {
        return Ok(existing);
    }
    WebviewWindowBuilder::new(app, LABEL, WebviewUrl::App("index.html".into()))
        .title("termCode")
        .decorations(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .resizable(true)
        .visible(false)
        .background_color(tauri::window::Color(15, 14, 12, 255))
        .build()
}

/// Full width of the monitor under the cursor, a fixed share of its height.
fn place(app: &AppHandle, win: &WebviewWindow) -> tauri::Result<()> {
    let monitor = app
        .cursor_position()
        .ok()
        .and_then(|p| app.monitor_from_point(p.x, p.y).ok().flatten())
        .or(app.primary_monitor()?);
    if let Some(m) = monitor {
        let scale = m.scale_factor();
        let size = m.size().to_logical::<f64>(scale);
        let pos = m.position().to_logical::<f64>(scale);
        win.set_size(LogicalSize::new(
            size.width,
            (size.height * HEIGHT_RATIO).round(),
        ))?;
        win.set_position(LogicalPosition::new(pos.x, pos.y))?;
    }
    Ok(())
}

#[tauri::command]
pub fn quick_toggle(app: AppHandle) -> Result<bool, String> {
    let win = window(&app).map_err(|e| e.to_string())?;
    let visible = win.is_visible().unwrap_or(false);
    let focused = win.is_focused().unwrap_or(false);
    if visible && focused {
        win.hide().map_err(|e| e.to_string())?;
        return Ok(false);
    }
    place(&app, &win).map_err(|e| e.to_string())?;
    win.show().map_err(|e| e.to_string())?;
    win.set_focus().map_err(|e| e.to_string())?;
    Ok(true)
}

#[tauri::command]
pub fn quick_hide(app: AppHandle) -> Result<(), String> {
    if let Some(win) = app.get_webview_window(LABEL) {
        win.hide().map_err(|e| e.to_string())?;
    }
    Ok(())
}
