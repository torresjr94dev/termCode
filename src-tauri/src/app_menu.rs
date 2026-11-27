//! «Acerca de termCode» y «Buscar actualizaciones…».
//!
//! En macOS el menú es el de siempre de Tauri, salvo el «Acerca de»: el panel
//! nativo solo muestra el icono y la versión, y no puede llevar botones. Esos
//! dos elementos abren la ventana propia de la vista (versión, compilación,
//! sistema, enlaces y actualizaciones). En Windows y Linux no hay barra de
//! menú: lo mismo está en la paleta de comandos y en Ajustes.

use serde::Serialize;
use tauri::menu::MenuEvent;
#[cfg(target_os = "macos")]
use tauri::menu::{Menu, MenuItem, MenuItemKind};
use tauri::{AppHandle, Emitter, Manager, Runtime};

const ABOUT: &str = "termcode-about";
const CHECK_UPDATES: &str = "termcode-check-updates";

/// El menú por defecto con nuestro «Acerca de» en lugar del nativo.
#[cfg(target_os = "macos")]
pub fn build<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<Menu<R>> {
    let menu = Menu::default(app)?;
    let Some(MenuItemKind::Submenu(app_menu)) = menu.items()?.into_iter().next() else {
        return Ok(menu);
    };
    // Se busca por su texto («About termCode»), no por posición: si Tauri
    // cambia el orden, el nativo no se queda duplicado.
    let native = app_menu.items()?.iter().position(|item| {
        matches!(item, MenuItemKind::Predefined(p) if p.text().is_ok_and(|t| t.starts_with("About")))
    });
    let at = match native {
        Some(i) => {
            app_menu.remove_at(i)?;
            i
        }
        None => 0,
    };
    let about = MenuItem::with_id(app, ABOUT, "Acerca de termCode", true, None::<&str>)?;
    let updates = MenuItem::with_id(
        app,
        CHECK_UPDATES,
        "Buscar actualizaciones…",
        true,
        None::<&str>,
    )?;
    app_menu.insert_items(&[&about, &updates], at)?;
    Ok(menu)
}

/// Lleva la ventana principal al frente y le pide abrir «Acerca de».
pub fn on_event<R: Runtime>(app: &AppHandle<R>, event: MenuEvent) {
    let name = match event.id().as_ref() {
        ABOUT => "menu-about",
        CHECK_UPDATES => "menu-check-updates",
        _ => return,
    };
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
    if let Err(e) = app.emit_to("main", name, ()) {
        log::warn!("menu: no se pudo avisar a la vista ({name}): {e}");
    }
}

/// Lo que «Acerca de» muestra del sistema (y copia para reportar un problema).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppInfo {
    pub os: String,
    pub os_version: Option<String>,
    pub arch: &'static str,
    pub tauri: &'static str,
    /// WebKit (macOS, Linux) o WebView2 (Windows).
    pub webview: Option<String>,
}

#[tauri::command]
pub fn app_info() -> AppInfo {
    AppInfo {
        os: sysinfo::System::name().unwrap_or_else(|| std::env::consts::OS.to_owned()),
        os_version: sysinfo::System::os_version(),
        arch: std::env::consts::ARCH,
        tauri: tauri::VERSION,
        webview: tauri::webview_version().ok(),
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn reports_the_platform() {
        let info = super::app_info();
        assert!(!info.os.is_empty());
        assert_eq!(info.arch, std::env::consts::ARCH);
        assert!(info.tauri.starts_with('2'), "{}", info.tauri);
    }
}
