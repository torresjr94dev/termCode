//! termCode desktop app: Tauri commands bridging the webview and `pty-core`.

mod pty;

use pty_core::PtyManager;
use tauri::{Manager, RunEvent};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(PtyManager::default())
        .invoke_handler(tauri::generate_handler![
            pty::pty_spawn,
            pty::pty_write,
            pty::pty_resize,
            pty::pty_ack,
            pty::pty_kill,
        ])
        .build(tauri::generate_context!())
        .expect("error while building termCode");

    app.run(|handle, event| {
        if let RunEvent::Exit = event {
            handle.state::<PtyManager>().kill_all();
        }
    });
}
