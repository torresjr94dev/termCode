//! termCode desktop app: Tauri commands bridging the webview and `pty-core`.

pub mod agents;
mod editor;
mod fs;
mod git;
mod mcp;
mod proc;
mod pty;
mod quick;
mod shell_integration;
mod updater;
mod usage;

use pty_core::PtyManager;
use std::sync::atomic::{AtomicBool, Ordering};
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
        .manage(UsageHub::default())
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
            #[cfg(unix)]
            mcp::spawn_socket(app.handle().clone());
            usage::spawn(app.handle().clone());
            updater::init(app.handle());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            pty::pty_spawn,
            pty::pty_write,
            pty::pty_write_bytes,
            pty::pty_resize,
            pty::pty_ack,
            pty::pty_info,
            pty::pty_kill,
            usage::usage_get,
            usage::usage_refresh,
            agents::agents_info,
            git::worktree::git_worktree_create,
            git::worktree::git_worktree_list,
            git::worktree::git_worktree_apply,
            git::worktree::git_worktree_remove,
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
