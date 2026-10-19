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
fn valid_pane_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 64
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

fn hook_cli(event: &str) -> i32 {
    // A hook must never get in Claude's way: always exit 0 and print nothing.
    let kind = match event {
        "Notification" => "needs-input",
        "Stop" => "done",
        _ => return 0,
    };
    let input = read_stdin_json().unwrap_or(Value::Null);
    if let Some(pane) = pane_from_env() {
        let message: String = input
            .get("message")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .chars()
            .take(300)
            .collect();
        let record = json!({ "at": now_ms(), "kind": kind, "message": message });
        let _ = write_atomic(&agents_dir().join(format!("event-{pane}.json")), &record);
    }
    0
}

/// Writes the `--settings` file termCode passes to Claude Code. Regenerated on
/// every start so it always points at the current executable.
pub fn write_claude_settings() -> std::io::Result<PathBuf> {
    let exe = std::env::current_exe()?;
    let exe = pty_core::shell_quote(&exe.to_string_lossy());
    let hook = |event: &str| json!([{ "hooks": [{ "type": "command", "command": format!("{exe} --claude-hook {event}") }] }]);
    let settings = json!({
        "statusLine": { "type": "command", "command": format!("{exe} --claude-statusline"), "padding": 0 },
        "hooks": { "Notification": hook("Notification"), "Stop": hook("Stop") },
    });
    let path = state_dir().join("claude-settings.json");
    write_atomic(&path, &settings)?;
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
/// precomputed percentage and the raw token counts.
fn context_percent(status: &Value) -> Option<f64> {
    let cw = status.get("context_window")?;
    if let Some(p) = cw.get("used_percentage").and_then(Value::as_f64) {
        return Some(p);
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
        parts.push(format!("ctx {ctx:.0}%"));
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
    pub path: Option<String>,
}

static TOOLS: parking_lot::Mutex<Option<Tools>> = parking_lot::Mutex::new(None);

#[cfg(unix)]
fn detect_tools() -> Tools {
    let script = r#"printf '\n__TC_claude=%s\n__TC_codex=%s\n__TC_gh=%s\n__TC_path=%s\n' "$(command -v claude)" "$(command -v codex)" "$(command -v gh)" "$PATH""#;
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
        path: find("__TC_path="),
    }
}

#[cfg(not(unix))]
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
    pub claude_settings_path: Option<String>,
}

#[tauri::command]
pub async fn agents_info() -> AgentsInfo {
    let tools = tauri::async_runtime::spawn_blocking(refresh_tools)
        .await
        .unwrap_or_default();
    let settings = state_dir().join("claude-settings.json");
    AgentsInfo {
        claude: tools.claude,
        codex: tools.codex,
        gh: tools.gh,
        claude_settings_path: settings
            .is_file()
            .then(|| settings.to_string_lossy().into_owned()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

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
    fn statusline_without_data_renders_empty() {
        assert_eq!(render_statusline(&json!({})), "");
    }
}
