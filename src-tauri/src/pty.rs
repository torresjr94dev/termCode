//! PTY IPC commands.
//!
//! Output travels over a per-session `Channel` as raw bytes
//! (`InvokeResponseBody::Raw` arrives as an `ArrayBuffer` in JS): no JSON,
//! no base64. Exit notifications use a regular event.

use crate::agents;
use pty_core::{OutputSink, ProcessInfo, PtyManager, SessionId, SpawnOptions};
use serde::Serialize;
use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::{AppHandle, Emitter, Manager, State};

struct ChannelSink {
    id: SessionId,
    /// Panel de termCode dueño de la sesión (para el MCP de lectura).
    pane: Option<String>,
    channel: Channel<InvokeResponseBody>,
    app: AppHandle,
}

#[derive(Clone, Serialize)]
struct ExitPayload {
    id: SessionId,
    code: Option<u32>,
}

impl OutputSink for ChannelSink {
    fn data(&mut self, bytes: Vec<u8>) -> bool {
        if let Some(pane) = &self.pane {
            crate::mcp::record(pane, &bytes);
        }
        self.channel.send(InvokeResponseBody::Raw(bytes)).is_ok()
    }

    fn exit(&mut self, code: Option<u32>) {
        if let Some(pane) = &self.pane {
            crate::mcp::forget(pane);
        }
        let _ = self.app.emit("pty-exit", ExitPayload { id: self.id, code });
        self.app.state::<PtyManager>().remove(self.id);
    }
}

type CmdResult<T> = Result<T, String>;

// Commands are `async` so they run on Tauri's async runtime instead of the
// main thread. None of them block: input is queued to a per-session writer
// thread inside pty-core.

#[tauri::command]
pub async fn pty_spawn(
    app: AppHandle,
    pty: State<'_, PtyManager>,
    mut options: SpawnOptions,
    on_data: Channel<InvokeResponseBody>,
    shell_integration: Option<bool>,
) -> CmdResult<SessionId> {
    let kind = if options.command.is_some() {
        "agent"
    } else {
        "shell"
    };
    // Agents launched in this PTY report back through files in the state dir.
    options.env.retain(|(k, _)| k != agents::ENV_STATE_DIR);
    options.env.push((
        agents::ENV_STATE_DIR.to_owned(),
        agents::state_dir().to_string_lossy().into_owned(),
    ));
    #[cfg(unix)]
    if shell_integration.unwrap_or(true) && options.program.is_none() {
        options
            .env
            .extend(crate::shell_integration::env_for(&pty_core::user_shell()));
    }
    // Windows: PowerShell con la integración y el agente dentro, sin cmd.exe.
    #[cfg(windows)]
    crate::winlaunch::prepare(&mut options, shell_integration.unwrap_or(true))?;
    #[cfg(not(any(unix, windows)))]
    let _ = shell_integration;
    let pane = options
        .env
        .iter()
        .find(|(k, _)| k == agents::ENV_PANE)
        .map(|(_, v)| v.clone());
    let id = pty
        .spawn(options, |id| {
            if let Some(pane) = &pane {
                crate::mcp::register(pane, id);
            }
            ChannelSink {
                id,
                pane: pane.clone(),
                channel: on_data,
                app,
            }
        })
        .map_err(|e| e.to_string())?;
    log::info!("pty {id}: {kind} spawned");
    Ok(id)
}

#[tauri::command]
pub async fn pty_write(pty: State<'_, PtyManager>, id: SessionId, data: String) -> CmdResult<()> {
    pty.write(id, data.as_bytes()).map_err(|e| e.to_string())
}

/// Raw bytes that are not valid UTF-8 (xterm `onBinary`, e.g. legacy mouse reports).
#[tauri::command]
pub async fn pty_write_bytes(
    pty: State<'_, PtyManager>,
    id: SessionId,
    data: Vec<u8>,
) -> CmdResult<()> {
    pty.write(id, &data).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn pty_resize(
    pty: State<'_, PtyManager>,
    id: SessionId,
    cols: u16,
    rows: u16,
) -> CmdResult<()> {
    pty.resize(id, cols, rows).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn pty_ack(pty: State<'_, PtyManager>, id: SessionId, bytes: usize) -> CmdResult<()> {
    pty.ack(id, bytes);
    Ok(())
}

/// Foreground process, its working directory and whether it is busy.
#[tauri::command]
pub async fn pty_info(pty: State<'_, PtyManager>, id: SessionId) -> CmdResult<ProcessInfo> {
    pty.info(id).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn pty_kill(pty: State<'_, PtyManager>, id: SessionId) -> CmdResult<()> {
    pty.remove(id);
    Ok(())
}
