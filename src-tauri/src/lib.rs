//! termCode desktop app: Tauri commands bridging the webview and `pty-core`.

pub mod agents;
mod fs;
mod git;
mod proc;
mod pty;
mod usage;

use pty_core::PtyManager;
use tauri::{Manager, RunEvent};
use tauri_plugin_log::{RotationStrategy, Target, TargetKind};
use usage::UsageHub;

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
        .manage(PtyManager::default())
        .manage(UsageHub::default())
        .setup(|app| {
            agents::reset_bridge_dir();
            if let Err(e) = agents::write_claude_settings() {
                log::error!("agents: cannot write Claude settings: {e}");
            }
            agents::spawn_watcher(app.handle().clone());
            usage::spawn(app.handle().clone());
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
            git::pr::pr_status,
            git::pr::pr_create,
            git::ai::ai_commit_message,
            git::ai::ai_pr_description,
            fs::fs_list,
            fs::fs_read,
        ])
        .build(tauri::generate_context!())
        .expect("error while building termCode");

    app.run(|handle, event| {
        if let RunEvent::Exit = event {
            handle.state::<PtyManager>().kill_all();
        }
    });
}
