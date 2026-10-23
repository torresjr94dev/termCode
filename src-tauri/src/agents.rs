//! Bridge between AI agents running in termCode panes and the app.
//!
//! termCode launches Claude Code with `--settings <file>`. That file points
//! Claude's `statusLine` and its `Notification`/`Stop` hooks back at this same
//! binary (`termcode --claude-statusline`, `termcode --claude-hook <event>`),
//! which drops small JSON files in the state dir. The app polls that directory
//! and turns the files into events. No tokens involved, nothing in `~/.claude`
//! is modified, and only sessions launched from termCode are affected.

use crate::usage::{self, UsageHub};
use serde::Serialize;
use serde_json::{Value, json};
use std::collections::HashMap;
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, Manager};

/// Pane that owns the process (set by the app in every PTY it spawns).
pub const ENV_PANE: &str = "TERMCODE_PANE_ID";
/// Where agent bridge files go (set by the app so CLI and app always agree).
pub const ENV_STATE_DIR: &str = "TERMCODE_STATE_DIR";

const APP_IDENTIFIER: &str = "dev.jorgetorres.termcode";
const MAX_STDIN: u64 = 1 << 20;
const POLL_EVERY: Duration = Duration::from_millis(750);

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

/// Same directory Tauri uses for `app_data_dir()`.
pub fn state_dir() -> PathBuf {
    if let Some(dir) = std::env::var_os(ENV_STATE_DIR).filter(|d| !d.is_empty()) {
        return PathBuf::from(dir);
    }
    dirs::data_dir()
        .unwrap_or_else(std::env::temp_dir)
        .join(APP_IDENTIFIER)
}

fn agents_dir() -> PathBuf {
    state_dir().join("agents")
}

pub fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or_default()
}

/// Pane ids come from the environment: treat them as untrusted file-name input.
pub fn valid_pane_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 64
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

/// Ids de sesión de Claude (UUID hoy). Acaban en una línea de comandos al
/// reanudar: solo caracteres que no necesitan escaparse.
fn valid_session_id(id: &str) -> bool {
    (8..=128).contains(&id.len())
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

fn write_atomic(path: &Path, value: &Value) -> std::io::Result<()> {
    let dir = path
        .parent()
        .ok_or_else(|| std::io::Error::other("path without parent"))?;
    fs::create_dir_all(dir)?;
    let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("file");
    let tmp = dir.join(format!(".{name}.{}.tmp", std::process::id()));
    fs::write(&tmp, serde_json::to_vec(value)?)?;
    fs::rename(&tmp, path)
}

// ---------------------------------------------------------------------------
// CLI side (runs inside Claude Code's process tree, must be fast and silent)
// ---------------------------------------------------------------------------

/// Handles `termcode --claude-statusline` and `termcode --claude-hook <Event>`.
/// Returns the exit code when argv was one of those invocations.
pub fn run_cli() -> Option<i32> {
    let mut args = std::env::args().skip(1);
    match args.next().as_deref() {
        Some("--claude-statusline") => Some(statusline_cli()),
        Some("--claude-hook") => Some(hook_cli(&args.next().unwrap_or_default())),
        Some("--mcp") => Some(crate::mcp::stdio_server()),
        // En Windows los hooks van en forma exec (`command` + `args`). Un Claude
        // Code que no la conozca nos ejecutaría sin argumentos desde un hook:
        // abrir otra ventana de termCode por cada evento sería mucho peor que
        // perder ese evento.
        None if cfg!(windows)
            && std::env::var_os("CLAUDE_PROJECT_DIR").is_some()
            && std::env::var_os(ENV_PANE).is_some() =>
        {
            Some(0)
        }
        _ => None,
    }
}

fn read_stdin_json() -> Option<Value> {
    let mut buf = String::new();
    std::io::stdin()
        .take(MAX_STDIN)
        .read_to_string(&mut buf)
        .ok()?;
    serde_json::from_str(&buf).ok()
}

fn pane_from_env() -> Option<String> {
    std::env::var(ENV_PANE).ok().filter(|p| valid_pane_id(p))
}

fn statusline_cli() -> i32 {
    let Some(status) = read_stdin_json() else {
        return 0;
    };
    if let Some(pane) = pane_from_env() {
        let record = json!({ "receivedAt": now_ms(), "status": status });
        let _ = write_atomic(&agents_dir().join(format!("status-{pane}.json")), &record);
    }
    println!("{}", render_statusline(&status));
    0
}

fn truncate(text: &str, max: usize) -> String {
    let one_line = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if one_line.chars().count() <= max {
        one_line
    } else {
        format!("{}…", one_line.chars().take(max - 1).collect::<String>())
    }
}

/// "Bash: npm test", "Edit: schema.ts"… lo que el agente está haciendo ahora.
pub fn describe_tool(tool: &str, input: &Value) -> String {
    let field = |k: &str| input.get(k).and_then(Value::as_str).unwrap_or_default();
    let file = |k: &str| {
        let path = field(k);
        path.rsplit(['/', '\\']).next().unwrap_or(path).to_owned()
    };
    let detail = match tool {
        "Bash" => truncate(field("command"), 90),
        "Edit" | "MultiEdit" | "Write" | "Read" | "NotebookEdit" => file("file_path"),
        "Grep" | "Glob" => truncate(field("pattern"), 60),
        "WebFetch" => truncate(field("url"), 70),
        "WebSearch" => truncate(field("query"), 70),
        "Task" | "Agent" => truncate(field("description"), 70),
        _ => String::new(),
    };
    if detail.is_empty() {
        tool.to_owned()
    } else {
        format!("{tool}: {detail}")
    }
}

/// Foto del repo antes de que el agente toque nada: `git stash create` no
/// modifica el índice, las ramas ni los archivos; si no hay cambios, HEAD.
fn capture_baseline(cwd: &Path) -> Option<Value> {
    let root = crate::git::git(cwd, &["rev-parse", "--show-toplevel"]).ok()?;
    let root = PathBuf::from(root.trim());
    let stash = crate::git::git(&root, &["stash", "create"]).unwrap_or_default();
    let sha = match stash.trim() {
        "" => crate::git::git(&root, &["rev-parse", "HEAD"])
            .ok()?
            .trim()
            .to_owned(),
        s => s.to_owned(),
    };
    let untracked: Vec<String> =
        crate::git::git(&root, &["ls-files", "--others", "--exclude-standard", "-z"])
            .unwrap_or_default()
            .split('\0')
            .filter(|p| !p.is_empty())
            .take(5000)
            .map(str::to_owned)
            .collect();
    Some(json!({ "root": root, "sha": sha, "untracked": untracked, "at": now_ms() }))
}

fn hook_cli(event: &str) -> i32 {
    // A hook must never get in Claude's way: always exit 0, and print nothing
    // except an explicit decision from the approvals tray.
    let input = read_stdin_json().unwrap_or(Value::Null);
    let Some(pane) = pane_from_env() else {
        return 0;
    };
    let dir = agents_dir();
    let activity = |state: &str, detail: String| {
        let record = json!({ "at": now_ms(), "state": state, "detail": detail });
        let _ = write_atomic(&dir.join(format!("activity-{pane}.json")), &record);
    };
    // Con el id de sesión, el panel se puede reanudar (`claude --resume`) tras reiniciar la app.
    let session = |prompt: Option<String>| {
        if let Some(id) = input
            .get("session_id")
            .and_then(Value::as_str)
            .filter(|id| valid_session_id(id))
        {
            let record = json!({ "at": now_ms(), "sessionId": id, "prompt": prompt });
            let _ = write_atomic(&dir.join(format!("session-{pane}.json")), &record);
        }
    };

    match event {
        "SessionStart" => session(None),
        "UserPromptSubmit" => {
            let prompt = input
                .get("prompt")
                .and_then(Value::as_str)
                .unwrap_or_default();
            activity("working", truncate(prompt, 140));
            session(Some(truncate(prompt, 140)));
            let cwd = input
                .get("cwd")
                .and_then(Value::as_str)
                .map(PathBuf::from)
                .or_else(|| std::env::current_dir().ok());
            if let Some(turn) = cwd.as_deref().and_then(capture_baseline) {
                let path = dir.join(format!("baseline-{pane}.json"));
                let previous: Value = fs::read(&path)
                    .ok()
                    .and_then(|b| serde_json::from_slice(&b).ok())
                    .unwrap_or(Value::Null);
                // La base de la sesión es la primera foto; la del turno, la más reciente.
                let session = match previous.get("session") {
                    Some(s) if s.get("root") == turn.get("root") => s.clone(),
                    _ => turn.clone(),
                };
                let _ = write_atomic(&path, &json!({ "session": session, "turn": turn }));
            }
        }
        "PreToolUse" => {
            let tool = input
                .get("tool_name")
                .and_then(Value::as_str)
                .unwrap_or("herramienta");
            activity(
                "working",
                describe_tool(tool, input.get("tool_input").unwrap_or(&Value::Null)),
            );
        }
        // La única salida que imprime algo: tu decisión desde la bandeja de termCode.
        // Sin decisión (o ante cualquier fallo) no imprime nada y Claude pregunta en su panel.
        "PermissionRequest" => {
            let tool = input
                .get("tool_name")
                .and_then(Value::as_str)
                .unwrap_or("herramienta");
            activity(
                "needs-input",
                describe_tool(tool, input.get("tool_input").unwrap_or(&Value::Null)),
            );
            if let Some(output) = crate::approvals::ask_from_hook(&pane, &input) {
                println!("{output}");
            }
        }
        "Notification" | "Stop" => {
            let kind = if event == "Notification" {
                "needs-input"
            } else {
                "done"
            };
            // Stop no trae `message`: su resumen útil es la última respuesta del agente.
            let message = input
                .get("message")
                .or_else(|| input.get("last_assistant_message"))
                .and_then(Value::as_str)
                .map(|m| truncate(m, 300))
                .unwrap_or_default();
            activity(
                if kind == "done" {
                    "idle"
                } else {
                    "needs-input"
                },
                message.clone(),
            );
            let record = json!({ "at": now_ms(), "kind": kind, "message": message });
            let _ = write_atomic(&dir.join(format!("event-{pane}.json")), &record);
        }
        _ => {}
    }
    0
}

/// Writes the `--settings` file termCode passes to Claude Code. Regenerated on
/// every start so it always points at the current executable.
pub fn write_claude_settings() -> std::io::Result<PathBuf> {
    let exe = std::env::current_exe()?;
    let hook = |event: &str| hook_command(&exe, event);
    let mut permission = hook_command(&exe, "PermissionRequest");
    // Espera tu decisión: timeout propio, mayor que lo que esperan la app y el CLI.
    permission["timeout"] = json!(crate::approvals::HOOK_TIMEOUT_SECS);
    let settings = json!({
        "statusLine": { "type": "command", "command": statusline_command(&exe), "padding": 0 },
        "hooks": {
            "SessionStart": [{ "hooks": [hook("SessionStart")] }],
            "UserPromptSubmit": [{ "hooks": [hook("UserPromptSubmit")] }],
            "PreToolUse": [{ "hooks": [hook("PreToolUse")] }],
            "Notification": [{ "hooks": [hook("Notification")] }],
            "Stop": [{ "hooks": [hook("Stop")] }],
            "PermissionRequest": [{ "hooks": [permission] }],
        },
        // Las herramientas de solo lectura del MCP de termCode no piden permiso cada vez.
        "permissions": { "allow": ["mcp__termcode__list_panes", "mcp__termcode__read_pane"] },
    });
    let path = state_dir().join("claude-settings.json");
    write_atomic(&path, &settings)?;

    let mcp = json!({
        "mcpServers": { "termcode": { "command": std::env::current_exe()?, "args": ["--mcp"] } }
    });
    write_atomic(&state_dir().join("mcp.json"), &mcp)?;
    Ok(path)
}

// ---------------------------------------------------------------------------
// Statusline JSON → summary (shared by the CLI renderer and the app watcher)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentStatus {
    pub pane_id: String,
    pub model: Option<String>,
    pub context_percent: Option<f64>,
    pub cost_usd: Option<f64>,
}

fn model_name(status: &Value) -> Option<String> {
    let model = status.get("model")?;
    model
        .get("display_name")
        .or_else(|| model.get("id"))
        .and_then(Value::as_str)
        .map(str::to_owned)
}

/// Field names have changed across Claude Code versions: accept both the
/// precomputed percentage and the raw token counts. Always 0–100 and never
/// `-0` (Claude can report it, and `{:.0}` would print "-0%").
fn context_percent(status: &Value) -> Option<f64> {
    let cw = status.get("context_window")?;
    if let Some(p) = cw.get("used_percentage").and_then(Value::as_f64) {
        return Some(p.clamp(0.0, 100.0) + 0.0);
    }
    let size = cw.get("context_window_size").and_then(Value::as_f64)?;
    let usage = cw.get("current_usage")?;
    let used: f64 = [
        "input_tokens",
        "cache_creation_input_tokens",
        "cache_read_input_tokens",
    ]
    .iter()
    .filter_map(|k| usage.get(*k).and_then(Value::as_f64))
    .sum();
    (size > 0.0).then(|| (used / size * 100.0).clamp(0.0, 100.0))
}

fn summarize(pane_id: &str, status: &Value) -> AgentStatus {
    AgentStatus {
        pane_id: pane_id.to_owned(),
        model: model_name(status),
        context_percent: context_percent(status),
        cost_usd: status
            .get("cost")
            .and_then(|c| c.get("total_cost_usd"))
            .and_then(Value::as_f64),
    }
}

fn render_statusline(status: &Value) -> String {
    let mut parts = Vec::new();
    if let Some(model) = model_name(status) {
        parts.push(model);
    }
    if let Some(ctx) = context_percent(status) {
        parts.push(format!("ctx {}%", ctx.round() as u8));
    }
    if let Some(session) = usage::claude::windows_from_statusline(status)
        .and_then(|w| w.into_iter().find(|w| w.kind == "session"))
    {
        parts.push(format!("5h {:.0}%", session.used_percent));
    }
    parts.join(" · ")
}

// ---------------------------------------------------------------------------
// App side: directory watcher
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct AgentAttention {
    pane_id: String,
    kind: String,
    message: String,
}

/// Files left over by a previous run refer to panes that no longer exist (or
/// that will be restored with the same id): start clean.
pub fn reset_bridge_dir() {
    let dir = agents_dir();
    if let Ok(entries) = fs::read_dir(&dir) {
        for entry in entries.flatten() {
            let _ = fs::remove_file(entry.path());
        }
    }
    let _ = fs::create_dir_all(dir);
}

pub fn spawn_watcher(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        let mut seen: HashMap<PathBuf, SystemTime> = HashMap::new();
        let mut tick = tokio::time::interval(POLL_EVERY);
        loop {
            tick.tick().await;
            scan(&app, &mut seen);
        }
    });
}

fn scan(app: &AppHandle, seen: &mut HashMap<PathBuf, SystemTime>) {
    let Ok(entries) = fs::read_dir(agents_dir()) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let Some(name) = path.file_name().and_then(|n| n.to_str()).map(str::to_owned) else {
            continue;
        };
        if name.starts_with('.') || !name.ends_with(".json") {
            continue;
        }
        let Ok(modified) = entry.metadata().and_then(|m| m.modified()) else {
            continue;
        };
        if seen.get(&path) == Some(&modified) {
            continue;
        }
        seen.insert(path.clone(), modified);

        let Ok(value) = fs::read(&path)
            .map_err(|_| ())
            .and_then(|b| serde_json::from_slice::<Value>(&b).map_err(|_| ()))
        else {
            continue;
        };
        let stem = name.trim_end_matches(".json");

        if let Some(pane) = stem.strip_prefix("status-").filter(|p| valid_pane_id(p)) {
            let status = value.get("status").unwrap_or(&Value::Null);
            let _ = app.emit("agent-status", summarize(pane, status));
            if let Some(windows) = usage::claude::windows_from_statusline(status) {
                let at = value
                    .get("receivedAt")
                    .and_then(Value::as_u64)
                    .unwrap_or_else(now_ms);
                app.state::<UsageHub>()
                    .record_claude_statusline(app, windows, at);
            }
        } else if let Some(pane) = stem.strip_prefix("activity-").filter(|p| valid_pane_id(p)) {
            let field = |k: &str| {
                value
                    .get(k)
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_owned()
            };
            let _ = app.emit(
                "agent-activity",
                json!({
                    "paneId": pane,
                    "state": field("state"),
                    "detail": field("detail"),
                    "at": value.get("at").and_then(Value::as_u64).unwrap_or_else(now_ms),
                }),
            );
        } else if let Some(pane) = stem.strip_prefix("session-").filter(|p| valid_pane_id(p)) {
            let Some(id) = value
                .get("sessionId")
                .and_then(Value::as_str)
                .filter(|id| valid_session_id(id))
            else {
                continue;
            };
            let _ = app.emit(
                "agent-session",
                json!({
                    "paneId": pane,
                    "sessionId": id,
                    "prompt": value.get("prompt").and_then(Value::as_str),
                    "at": value.get("at").and_then(Value::as_u64).unwrap_or_else(now_ms),
                }),
            );
        } else if let Some(pane) = stem.strip_prefix("event-").filter(|p| valid_pane_id(p)) {
            let field = |k: &str| {
                value
                    .get(k)
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_owned()
            };
            let _ = app.emit(
                "agent-attention",
                AgentAttention {
                    pane_id: pane.to_owned(),
                    kind: field("kind"),
                    message: field("message"),
                },
            );
        }
    }
}

/// Fotos del repo guardadas por los hooks para un panel de agente.
#[tauri::command]
pub fn agent_baseline(pane_id: String) -> Option<Value> {
    if !valid_pane_id(&pane_id) {
        return None;
    }
    let bytes = fs::read(agents_dir().join(format!("baseline-{pane_id}.json"))).ok()?;
    serde_json::from_slice(&bytes).ok()
}

/// Un hook que vuelve a este binario. En macOS y Linux, una línea para `sh -c`.
/// En Windows, forma exec (`command` + `args`): Claude Code lo lanza sin shell,
/// así que ni Git Bash ni PowerShell reinterpretan la ruta (espacios, `\`,
/// apóstrofos) y no se paga el arranque de una shell en cada evento.
fn hook_command(exe: &Path, event: &str) -> Value {
    if cfg!(windows) {
        json!({ "type": "command", "command": exe, "args": ["--claude-hook", event] })
    } else {
        let exe = pty_core::shell_quote(&exe.to_string_lossy());
        json!({ "type": "command", "command": format!("{exe} --claude-hook {event}") })
    }
}

#[cfg(unix)]
fn statusline_command(exe: &Path) -> String {
    format!(
        "{} --claude-statusline",
        pty_core::shell_quote(&exe.to_string_lossy())
    )
}

/// El statusLine no tiene forma exec: en Windows lo corre Git Bash si está
/// instalado y, si no, PowerShell.
#[cfg(windows)]
fn statusline_command(exe: &Path) -> String {
    windows_statusline_command(
        &exe.to_string_lossy(),
        win::short_path(exe).as_deref(),
        win::git_bash_installed(),
    )
}

/// Con barras `/` (Git Bash se come las `\` sin comillas) y, si se puede, sin
/// comillas: una ruta sin espacios ni símbolos (o su nombre corto 8.3) funciona
/// igual en las dos shells, así que no importa cuál elija Claude Code. Si no,
/// la sintaxis de la shell que va a usar.
#[cfg_attr(not(windows), allow(dead_code))]
fn windows_statusline_command(exe: &str, short: Option<&str>, git_bash: bool) -> String {
    let slashed = |p: &str| p.replace('\\', "/");
    let bare = |p: &str| {
        !p.is_empty()
            && p.chars()
                .all(|c| c.is_ascii_alphanumeric() || "_./:~-".contains(c))
    };
    let long = slashed(exe);
    if let Some(path) = std::iter::once(long.clone())
        .chain(short.map(slashed))
        .find(|p| bare(p))
    {
        return format!("{path} --claude-statusline");
    }
    if git_bash {
        format!("{} --claude-statusline", pty_core::shell_quote(&long))
    } else {
        format!("& {} --claude-statusline", powershell_quote(&long))
    }
}

/// Comillas simples de PowerShell, que también trata ‘ ’ ‚ ‛ como comillas.
#[cfg_attr(not(windows), allow(dead_code))]
fn powershell_quote(value: &str) -> String {
    let mut out = String::with_capacity(value.len() + 2);
    out.push('\'');
    for c in value.chars() {
        if matches!(c, '\'' | '\u{2018}' | '\u{2019}' | '\u{201A}' | '\u{201B}') {
            out.push(c);
        }
        out.push(c);
    }
    out.push('\'');
    out
}

#[cfg(windows)]
mod win {
    use std::os::windows::ffi::{OsStrExt, OsStringExt};
    use std::path::{Path, PathBuf};
    use windows_sys::Win32::Storage::FileSystem::GetShortPathNameW;

    /// Nombre 8.3 (`C:\Users\JORGET~1\…`), si el volumen los tiene.
    pub fn short_path(path: &Path) -> Option<String> {
        let wide: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
        let mut buf = vec![0u16; 1024];
        // SAFETY: `wide` termina en NUL y `buf` tiene la capacidad que se declara.
        let len = unsafe { GetShortPathNameW(wide.as_ptr(), buf.as_mut_ptr(), buf.len() as u32) };
        let len = usize::try_from(len)
            .ok()
            .filter(|&n| n > 0 && n < buf.len())?;
        Some(
            std::ffi::OsString::from_wide(&buf[..len])
                .to_string_lossy()
                .into_owned(),
        )
    }

    /// Lo mismo que busca Claude Code: `CLAUDE_CODE_GIT_BASH_PATH`, el Git del
    /// PATH (`Git\cmd\git.exe` → `Git\bin\bash.exe`) o la instalación por defecto.
    pub fn git_bash_installed() -> bool {
        if std::env::var_os("CLAUDE_CODE_GIT_BASH_PATH").is_some_and(|p| Path::new(&p).is_file()) {
            return true;
        }
        let dirs = crate::winlaunch::search_dirs();
        let from_path = crate::winlaunch::find_program("git.exe", &dirs)
            .and_then(|git| git.parent()?.parent().map(Path::to_path_buf));
        let defaults = ["ProgramFiles", "ProgramW6432"]
            .into_iter()
            .filter_map(|key| std::env::var_os(key).map(|dir| PathBuf::from(dir).join("Git")))
            .chain(
                std::env::var_os("LOCALAPPDATA")
                    .map(|dir| PathBuf::from(dir).join("Programs").join("Git")),
            );
        from_path
            .into_iter()
            .chain(defaults)
            .any(|root| root.join("bin").join("bash.exe").is_file())
    }
}

// ---------------------------------------------------------------------------
// Tools on the user's PATH (claude, codex, gh)
// ---------------------------------------------------------------------------

/// Where the user's tools live, as seen by their login + interactive shell.
/// GUI apps on macOS do not inherit the PATH set up in .zshrc / nvm / brew,
/// so anything we spawn ourselves (claude -p, gh) uses this PATH.
#[derive(Debug, Clone, Default)]
pub struct Tools {
    pub claude: Option<String>,
    pub codex: Option<String>,
    pub gh: Option<String>,
    /// Editors that can open `file:line` (first found wins for "auto").
    pub cursor: Option<String>,
    pub code: Option<String>,
    pub zed: Option<String>,
    pub subl: Option<String>,
    pub path: Option<String>,
}

static TOOLS: parking_lot::Mutex<Option<Tools>> = parking_lot::Mutex::new(None);

#[cfg(unix)]
fn detect_tools() -> Tools {
    let script = r#"for t in claude codex gh cursor code zed subl; do printf '\n__TC_%s=%s' "$t" "$(command -v $t)"; done; printf '\n__TC_path=%s\n' "$PATH""#;
    let mut cmd = Command::new(pty_core::user_shell());
    cmd.args(["-l", "-i", "-c", script]);
    let Ok(out) = crate::proc::run(cmd, None, Duration::from_secs(8), 64 * 1024) else {
        return Tools::default();
    };
    let text = out.stdout_str();
    let find = |key: &str| {
        text.lines()
            .find_map(|l| l.strip_prefix(key))
            .map(str::trim)
            .filter(|v| v.starts_with('/'))
            .map(str::to_owned)
    };
    Tools {
        claude: find("__TC_claude="),
        codex: find("__TC_codex="),
        gh: find("__TC_gh="),
        cursor: find("__TC_cursor="),
        code: find("__TC_code="),
        zed: find("__TC_zed="),
        subl: find("__TC_subl="),
        path: find("__TC_path="),
    }
}

/// Windows: el PATH de la app más donde instalan Claude Code, npm, pnpm y bun.
/// No hace falta una shell de login: el PATH vive en el registro, no en un rc.
#[cfg(windows)]
fn detect_tools() -> Tools {
    let dirs = crate::winlaunch::search_dirs();
    let find = |name: &str| {
        crate::winlaunch::find_program(name, &dirs).map(|path| path.to_string_lossy().into_owned())
    };
    Tools {
        claude: find("claude"),
        codex: find("codex"),
        gh: find("gh"),
        cursor: find("cursor"),
        code: find("code"),
        zed: find("zed"),
        subl: find("subl"),
        path: None,
    }
}

#[cfg(not(any(unix, windows)))]
fn detect_tools() -> Tools {
    Tools::default()
}

/// Cached detection (first call blocks ~1 s while the login shell starts).
pub fn tools() -> Tools {
    if let Some(cached) = TOOLS.lock().clone() {
        return cached;
    }
    refresh_tools()
}

fn refresh_tools() -> Tools {
    let fresh = detect_tools();
    *TOOLS.lock() = Some(fresh.clone());
    fresh
}

/// A command for one of the user's tools, with their login PATH.
pub fn tool_command(binary: &str) -> Command {
    #[cfg(windows)]
    let mut cmd = crate::winlaunch::command(binary);
    #[cfg(not(windows))]
    let mut cmd = Command::new(binary);
    if let Some(path) = tools().path {
        cmd.env("PATH", path);
    }
    // Never route helper invocations through the agent bridge.
    cmd.env_remove(ENV_PANE).env_remove(ENV_STATE_DIR);
    cmd
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentsInfo {
    pub claude: Option<String>,
    pub codex: Option<String>,
    pub gh: Option<String>,
    /// Editors found on the user's PATH (`cursor`, `code`, `zed`, `subl`).
    pub editors: Vec<String>,
    pub claude_settings_path: Option<String>,
    pub mcp_config_path: Option<String>,
}

#[tauri::command]
pub async fn agents_info() -> AgentsInfo {
    let tools = tauri::async_runtime::spawn_blocking(refresh_tools)
        .await
        .unwrap_or_default();
    let settings = state_dir().join("claude-settings.json");
    let mcp = state_dir().join("mcp.json");
    let editors = [
        ("cursor", &tools.cursor),
        ("code", &tools.code),
        ("zed", &tools.zed),
        ("subl", &tools.subl),
    ]
    .into_iter()
    .filter(|(_, path)| path.is_some())
    .map(|(name, _)| name.to_owned())
    .collect();
    AgentsInfo {
        claude: tools.claude,
        codex: tools.codex,
        gh: tools.gh,
        editors,
        claude_settings_path: settings
            .is_file()
            .then(|| settings.to_string_lossy().into_owned()),
        mcp_config_path: mcp.is_file().then(|| mcp.to_string_lossy().into_owned()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn windows_statusline_works_in_git_bash_and_powershell() {
        // Sin espacios ni símbolos: sin comillas, vale para las dos shells.
        assert_eq!(
            windows_statusline_command(
                r"C:\Users\jorge\AppData\Local\termCode\termcode.exe",
                None,
                false
            ),
            "C:/Users/jorge/AppData/Local/termCode/termcode.exe --claude-statusline"
        );
        // Con espacios, el nombre 8.3 si existe.
        let long = r"C:\Users\Jorge Torres\AppData\Local\termCode\termcode.exe";
        assert_eq!(
            windows_statusline_command(
                long,
                Some(r"C:\Users\JORGET~1\AppData\Local\termCode\termcode.exe"),
                true
            ),
            "C:/Users/JORGET~1/AppData/Local/termCode/termcode.exe --claude-statusline"
        );
        // Si no, la sintaxis de la shell que usará Claude Code.
        assert_eq!(
            windows_statusline_command(long, None, true),
            "'C:/Users/Jorge Torres/AppData/Local/termCode/termcode.exe' --claude-statusline"
        );
        assert_eq!(
            windows_statusline_command(r"C:\Users\Jorge’s PC\termcode.exe", None, false),
            "& 'C:/Users/Jorge’’s PC/termcode.exe' --claude-statusline"
        );
        assert_eq!(powershell_quote("it's"), "'it''s'");
    }

    #[test]
    fn hooks_point_back_at_this_binary() {
        let exe = Path::new("/Applications/term Code.app/Contents/MacOS/termcode");
        let hook = hook_command(exe, "Stop");
        assert_eq!(hook["type"], "command");
        if cfg!(windows) {
            assert_eq!(hook["command"], exe.to_string_lossy().as_ref());
            assert_eq!(hook["args"], json!(["--claude-hook", "Stop"]));
        } else {
            assert_eq!(
                hook["command"],
                "'/Applications/term Code.app/Contents/MacOS/termcode' --claude-hook Stop"
            );
        }
    }

    #[test]
    fn pane_ids_are_validated() {
        assert!(valid_pane_id("pane-1792429046842-2"));
        assert!(!valid_pane_id("../../etc/passwd"));
        assert!(!valid_pane_id(""));
        assert!(!valid_pane_id(&"a".repeat(65)));
    }

    #[test]
    fn summarizes_statusline_with_precomputed_percentage() {
        let status = json!({
            "model": { "id": "claude-opus", "display_name": "Opus" },
            "cost": { "total_cost_usd": 1.25 },
            "context_window": { "used_percentage": 42.0 },
            "rate_limits": { "five_hour": { "used_percentage": 23, "resets_at": 1760900000 } }
        });
        let s = summarize("pane-1", &status);
        assert_eq!(s.model.as_deref(), Some("Opus"));
        assert_eq!(s.context_percent, Some(42.0));
        assert_eq!(s.cost_usd, Some(1.25));
        assert_eq!(render_statusline(&status), "Opus · ctx 42% · 5h 23%");
    }

    #[test]
    fn computes_context_from_raw_tokens() {
        let status = json!({
            "context_window": {
                "context_window_size": 200000,
                "current_usage": { "input_tokens": 1000, "cache_read_input_tokens": 49000 }
            }
        });
        assert_eq!(context_percent(&status), Some(25.0));
    }

    #[test]
    fn describes_tool_calls() {
        assert_eq!(
            describe_tool("Bash", &json!({ "command": "npm   test\n--watch" })),
            "Bash: npm test --watch"
        );
        assert_eq!(
            describe_tool("Edit", &json!({ "file_path": "/repo/src/db/schema.ts" })),
            "Edit: schema.ts"
        );
        assert_eq!(
            describe_tool("Edit", &json!({ "file_path": r"C:\repo\src\db\schema.ts" })),
            "Edit: schema.ts"
        );
        assert_eq!(describe_tool("TodoWrite", &json!({})), "TodoWrite");
        let long = "x".repeat(200);
        assert!(
            describe_tool("Bash", &json!({ "command": long }))
                .chars()
                .count()
                <= 96
        );
    }

    #[test]
    fn baseline_snapshots_without_touching_the_repo() {
        let dir = std::env::temp_dir().join(format!("termcode-baseline-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let g = |args: &[&str]| crate::git::git(&dir, args).unwrap();
        g(&["init", "-q", "-b", "main"]);
        g(&[
            "-c",
            "user.name=t",
            "-c",
            "user.email=t@t",
            "commit",
            "-q",
            "--allow-empty",
            "-m",
            "init",
        ]);
        let head = g(&["rev-parse", "HEAD"]).trim().to_owned();

        // Árbol limpio: la base es HEAD.
        let clean = capture_baseline(&dir).unwrap();
        assert_eq!(clean["sha"], head);

        // Con cambios: un objeto de stash, sin crear una entrada en la lista de stashes.
        fs::write(dir.join("a.txt"), "hola\n").unwrap();
        g(&["add", "a.txt"]);
        fs::write(dir.join("nuevo.txt"), "x").unwrap();
        let dirty = capture_baseline(&dir).unwrap();
        assert_ne!(dirty["sha"], head);
        assert_eq!(dirty["untracked"], json!(["nuevo.txt"]));
        assert_eq!(g(&["stash", "list"]), "", "stash create no deja rastro");
        assert!(
            g(&["status", "--porcelain"]).contains("A  a.txt"),
            "el índice sigue igual"
        );
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn session_ids_are_validated() {
        assert!(valid_session_id("0b6f2a43-1c1e-4e57-9d0e-6b8f1c2d3e4f"));
        assert!(!valid_session_id("abc"), "demasiado corto");
        assert!(
            !valid_session_id("x'; rm -rf ~; '"),
            "nada que una shell interprete"
        );
        assert!(!valid_session_id(&"a".repeat(129)));
    }

    #[test]
    fn context_is_never_negative_zero_or_out_of_range() {
        let ctx =
            |p: f64| render_statusline(&json!({ "context_window": { "used_percentage": p } }));
        assert_eq!(ctx(-0.0), "ctx 0%");
        assert_eq!(ctx(-3.0), "ctx 0%");
        assert_eq!(ctx(140.0), "ctx 100%");
        assert_eq!(ctx(41.6), "ctx 42%");
    }

    #[test]
    fn statusline_without_data_renders_empty() {
        assert_eq!(render_statusline(&json!({})), "");
    }
}
