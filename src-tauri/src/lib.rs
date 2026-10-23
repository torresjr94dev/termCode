//! termCode desktop app: Tauri commands bridging the webview and `pty-core`.

pub mod agents;
mod approvals;
mod cloud;
mod codex_status;
mod editor;
mod fs;
mod git;
mod local_ipc;
mod mcp;
mod ports;
mod proc;
mod proctree;
mod pty;
mod quick;
mod shell_integration;
mod shells;
mod ssh;
mod sysmon;
mod updater;
mod usage;
mod winlaunch;

use pty_core::PtyManager;
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::webview::PageLoadEvent;
use tauri::{AppHandle, Emitter, Manager, RunEvent, WindowEvent};
use tauri_plugin_log::{RotationStrategy, Target, TargetKind};
use usage::UsageHub;

/// The file editor has unsaved changes: closing the window or quitting asks first.
static UNSAVED: AtomicBool = AtomicBool::new(false);
/// The user already confirmed quitting without saving.
static QUIT_CONFIRMED: AtomicBool = AtomicBool::new(false);

#[tauri::command]
fn editor_set_unsaved(unsaved: bool) {
    UNSAVED.store(unsaved, Ordering::Relaxed);
}

/// Quit after the webview confirmed discarding unsaved edits.
#[tauri::command]
fn app_quit(app: AppHandle) {
    QUIT_CONFIRMED.store(true, Ordering::Relaxed);
    app.exit(0);
}

fn must_ask_before_quitting() -> bool {
    UNSAVED.load(Ordering::Relaxed) && !QUIT_CONFIRMED.load(Ordering::Relaxed)
}

/// Windows: DLLs only from the app folder and System32, never from the current
/// folder or the PATH. portable-pty loads `conpty.dll` by name and Windows has
/// none in System32, so the default search would reach both: a `conpty.dll`
/// planted in the folder termCode starts in would run inside it.
#[cfg(windows)]
pub fn harden_dll_search() {
    use windows_sys::Win32::System::LibraryLoader::{
        LOAD_LIBRARY_SEARCH_DEFAULT_DIRS, SetDefaultDllDirectories,
    };
    // SAFETY: only changes the process-wide search order; no pointers involved.
    if unsafe { SetDefaultDllDirectories(LOAD_LIBRARY_SEARCH_DEFAULT_DIRS) } == 0 {
        log::warn!(
            "SetDefaultDllDirectories failed: {}",
            std::io::Error::last_os_error()
        );
    }
}

/// Windows: Ctrl+C vuelve a interrumpir dentro de las shells. "Ignorar
/// Ctrl+C" se hereda de padre a hijo: si a termCode lo abrió un proceso que lo
/// ignora (un lanzador o una tarea en segundo plano creada con
/// `CREATE_NEW_PROCESS_GROUP`), ningún programa de sus paneles se podría cortar.
#[cfg(windows)]
pub fn restore_ctrl_c() {
    use windows_sys::Win32::System::Console::SetConsoleCtrlHandler;
    // SAFETY: sin manejador: solo cambia el atributo (heredable) del proceso.
    unsafe { SetConsoleCtrlHandler(None, 0) };
}

/// With `panic = "abort"` a panic takes every session down with it: make sure
/// it reaches the log file first.
fn install_panic_logger() {
    let default_hook = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        log::error!("panic: {info}");
        default_hook(info);
    }));
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    install_panic_logger();

    let app = tauri::Builder::default()
        .plugin(
            tauri_plugin_log::Builder::new()
                .clear_targets()
                .targets([
                    Target::new(TargetKind::Stdout),
                    Target::new(TargetKind::LogDir {
                        file_name: Some("termcode".into()),
                    }),
                ])
                .level(log::LevelFilter::Info)
                .max_file_size(2 * 1024 * 1024)
                .rotation_strategy(RotationStrategy::KeepSome(3))
                .build(),
        )
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .manage(PtyManager::default())
        .manage(pty::SessionOwners::default())
        .manage(UsageHub::default())
        .manage(sysmon::SysMon::default())
        .manage(updater::PendingUpdate::default())
        .setup(|app| {
            agents::reset_bridge_dir();
            if let Err(e) = agents::write_claude_settings() {
                log::error!("agents: cannot write Claude settings: {e}");
            }
            if let Err(e) = shell_integration::install() {
                log::error!("shell integration: cannot install: {e}");
            }
            agents::spawn_watcher(app.handle().clone());
            mcp::spawn_socket(app.handle().clone());
            usage::spawn(app.handle().clone());
            updater::init(app.handle());
            Ok(())
        })
        // Una vista que se recarga deja huérfanos sus PTYs: se cierran antes de
        // que la vista nueva restaure la sesión con shells nuevas.
        .on_page_load(|webview, payload| {
            if payload.event() == PageLoadEvent::Started {
                pty::release_webview(webview.app_handle(), webview.label());
            }
        })
        .invoke_handler(tauri::generate_handler![
            pty::pty_spawn,
            pty::pty_write,
            pty::pty_write_bytes,
            pty::pty_resize,
            pty::pty_ack,
            pty::pty_info,
            pty::pty_kill,
            pty::windows_build,
            ports::pty_ports,
            sysmon::system_stats,
            shells::shells_available,
            ssh::ssh_hosts,
            sysmon::system_processes,
            sysmon::process_terminate,
            sysmon::pty_children,
            codex_status::codex_status,
            cloud::fs_cloud_provider,
            usage::usage_get,
            usage::usage_refresh,
            agents::agents_info,
            git::worktree::git_worktree_create,
            git::worktree::git_worktree_list,
            git::worktree::git_worktree_apply,
            git::worktree::git_worktree_remove,
            git::worktree::git_worktree_verify,
            git::review::git_apply_patch,
            git::review::review_files,
            git::review::review_diff,
            git::git_repo,
            git::git_status,
            git::git_diff,
            git::git_stage,
            git::git_unstage,
            git::git_discard,
            git::git_commit,
            git::git_last_commit,
            git::git_push,
            git::git_pull,
            git::git_log,
            git::git_commit_detail,
            git::git_commit_diff,
            git::branches::git_branches,
            git::branches::git_switch,
            git::branches::git_stash_list,
            git::branches::git_stash_push,
            git::branches::git_stash_action,
            git::branches::git_operation_finish,
            git::branches::git_resolve_conflict,
            git::ci::ci_status,
            git::pr::pr_status,
            git::pr::pr_create,
            git::ai::ai_commit_message,
            git::ai::ai_pr_description,
            fs::fs_list,
            fs::fs_read,
            fs::fs_files,
            fs::fs_read_image,
            fs::fs_version,
            fs::fs_write,
            editor::open_in_editor,
            editor::fs_existing_files,
            quick::quick_toggle,
            quick::quick_hide,
            mcp::pane_set_title,
            agents::agent_baseline,
            approvals::approval_decide,
            approvals::approvals_set_enabled,
            approvals::approvals_pending,
            updater::update_supported,
            updater::update_check,
            updater::update_install,
            editor_set_unsaved,
            app_quit,
        ])
        .build(tauri::generate_context!())
        .expect("error while building termCode");

    app.run(|handle, event| match event {
        // Cerrar la ventana principal o salir con cambios sin guardar: la vista pregunta.
        RunEvent::WindowEvent {
            label,
            event: WindowEvent::CloseRequested { api, .. },
            ..
        } if label == "main" && must_ask_before_quitting() => {
            api.prevent_close();
            let _ = handle.emit_to("main", "quit-requested", ());
        }
        RunEvent::ExitRequested { api, .. } if must_ask_before_quitting() => {
            api.prevent_exit();
            let _ = handle.emit_to("main", "quit-requested", ());
        }
        RunEvent::Exit => handle.state::<PtyManager>().kill_all(),
        _ => {}
    });
}

#[cfg(test)]
mod tests {
    /// `tauri.windows.conf.json` reemplaza la lista de ventanas entera (JSON
    /// Merge Patch no mezcla arrays): fuera de la apariencia, que es propia de
    /// cada sistema (vibrancy y barra superpuesta en macOS; Mica y sin marco en
    /// Windows), debe ser la misma ventana.
    #[test]
    fn windows_window_config_matches_the_main_one() {
        let parse = |text: &str| serde_json::from_str::<serde_json::Value>(text).unwrap();
        let main = parse(include_str!("../tauri.conf.json"));
        let windows = parse(include_str!("../tauri.windows.conf.json"));
        let (main, windows) = (&main["app"]["windows"], &windows["app"]["windows"]);
        assert_eq!(
            main.as_array().map(Vec::len),
            windows.as_array().map(Vec::len)
        );
        let without = |window: &serde_json::Value, keys: &[&str]| {
            let mut map = window.as_object().cloned().unwrap_or_default();
            keys.iter().for_each(|k| {
                map.remove(*k);
            });
            map
        };
        let appearance = [
            "titleBarStyle",
            "hiddenTitle",
            "transparent",
            "windowEffects",
            "trafficLightPosition",
            "decorations",
        ];
        assert_eq!(
            without(&main[0], &appearance),
            without(&windows[0], &appearance)
        );
        // Sin marco: la barra de pestañas es la de título y trae sus botones.
        assert_eq!(windows[0]["decorations"], false);
        // Transparente solo para que se vea Mica; donde no hay Mica (Windows 10)
        // la vista se pinta opaca, así que nunca se ve el escritorio.
        assert_eq!(windows[0]["transparent"], true);
        assert_eq!(
            windows[0]["windowEffects"]["effects"],
            serde_json::json!(["mica"])
        );
    }
}
