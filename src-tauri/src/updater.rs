//! Self-update through tauri-plugin-updater.
//!
//! Only builds whose bundled config carries `plugins.updater.pubkey` enable it:
//! the release workflow injects the public key and the endpoint
//! (`releases/latest/download/latest.json`) when the signing secrets exist.
//! Local and dev builds report "not supported" instead of failing.
//!
//! Every downloaded artifact is verified against that public key by the
//! plugin before it is installed.

use parking_lot::Mutex;
use serde::Serialize;
use tauri::{AppHandle, Emitter, State};
use tauri_plugin_updater::{Update, UpdaterExt};

const MAX_NOTES: usize = 8 * 1024;

#[derive(Default)]
pub struct PendingUpdate(Mutex<Option<Update>>);

fn configured(app: &AppHandle) -> bool {
    app.config()
        .plugins
        .0
        .get("updater")
        .and_then(|c| c.get("pubkey"))
        .and_then(|k| k.as_str())
        .is_some_and(|k| !k.trim().is_empty())
}

/// Registers the plugin when this build was configured for updates.
pub fn init(app: &AppHandle) {
    if !configured(app) {
        log::info!("updater: no configurado en esta compilación");
        return;
    }
    if let Err(e) = app.plugin(tauri_plugin_updater::Builder::new().build()) {
        log::error!("updater: no se pudo iniciar: {e}");
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    pub version: String,
    pub current_version: String,
    pub notes: Option<String>,
    /// Unix seconds of the release, when the manifest says.
    pub date: Option<i64>,
}

#[tauri::command]
pub fn update_supported(app: AppHandle) -> bool {
    configured(&app) && app.updater().is_ok()
}

#[tauri::command]
pub async fn update_check(
    app: AppHandle,
    pending: State<'_, PendingUpdate>,
) -> Result<Option<UpdateInfo>, String> {
    let updater = app
        .updater()
        .map_err(|_| "Esta compilación no busca actualizaciones.".to_owned())?;
    let update = updater
        .check()
        .await
        .map_err(|e| format!("No se pudo consultar si hay versión nueva: {e}"))?;
    let info = update.as_ref().map(|u| UpdateInfo {
        version: u.version.clone(),
        current_version: u.current_version.clone(),
        notes: u.body.as_ref().map(|b| b.chars().take(MAX_NOTES).collect()),
        date: u.date.map(|d| d.unix_timestamp()),
    });
    *pending.0.lock() = update;
    Ok(info)
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Progress {
    downloaded: u64,
    total: Option<u64>,
}

/// Downloads, verifies and installs the update found by [`update_check`],
/// then restarts the app (the PTYs are killed on exit, like a normal quit).
#[tauri::command]
pub async fn update_install(
    app: AppHandle,
    pending: State<'_, PendingUpdate>,
) -> Result<(), String> {
    let update = pending
        .0
        .lock()
        .take()
        .ok_or("No hay ninguna actualización pendiente: búscala otra vez.")?;
    let mut downloaded: u64 = 0;
    let mut last_percent = None;
    let emitter = app.clone();
    update
        .download_and_install(
            move |chunk, total| {
                downloaded += chunk as u64;
                // Un evento por punto porcentual (o por MiB si no hay total), no por fragmento.
                let mark = match total {
                    Some(t) if t > 0 => downloaded * 100 / t,
                    _ => downloaded >> 20,
                };
                if last_percent != Some(mark) {
                    last_percent = Some(mark);
                    let _ = emitter.emit("update-progress", Progress { downloaded, total });
                }
            },
            || log::info!("updater: descarga verificada, instalando"),
        )
        .await
        .map_err(|e| format!("La actualización falló: {e}"))?;
    log::info!("updater: instalada, reiniciando");
    app.restart();
}
