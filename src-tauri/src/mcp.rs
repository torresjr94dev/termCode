//! termCode as an MCP server: agents can *read* the other panes ("look at the
//! error in the dev-server pane") through two read-only tools.
//!
//! * The app keeps the last 256 KB of output of every pane (ANSI stripped on
//!   read) and answers on the local channel (`local_ipc`: a 0600 Unix socket,
//!   or an owner-only named pipe on Windows).
//! * `termcode --mcp` is the stdio MCP server Claude Code spawns (via the
//!   `--mcp-config` termCode passes); it forwards each tool call to the app.
//!
//! Nothing can be written to a pane through here.

use crate::agents::ENV_PANE;
use crate::local_ipc::{self, Peer};
use parking_lot::Mutex;
use pty_core::{PtyManager, SessionId};
use serde_json::{Value, json};
use std::collections::{HashMap, VecDeque};
use std::io::{BufRead, Write};
use std::sync::LazyLock;
use tauri::{AppHandle, Manager};

const BUFFER_BYTES: usize = 256 * 1024;
const MAX_LINES: usize = 500;
const PROTOCOL_VERSION: &str = "2025-06-18";
/// Las herramientas de lectura contestan al momento.
const QUICK: std::time::Duration = std::time::Duration::from_secs(5);

struct PaneOutput {
    session: SessionId,
    bytes: VecDeque<u8>,
    title: Option<String>,
}

static PANES: LazyLock<Mutex<HashMap<String, PaneOutput>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

pub fn register(pane: &str, session: SessionId) {
    PANES.lock().insert(
        pane.to_owned(),
        PaneOutput {
            session,
            bytes: VecDeque::with_capacity(16 * 1024),
            title: None,
        },
    );
}

pub fn record(pane: &str, data: &[u8]) {
    let mut panes = PANES.lock();
    let Some(entry) = panes.get_mut(pane) else {
        return;
    };
    entry.bytes.extend(data);
    let excess = entry.bytes.len().saturating_sub(BUFFER_BYTES);
    if excess > 0 {
        entry.bytes.drain(..excess);
    }
}

pub fn forget(pane: &str) {
    PANES.lock().remove(pane);
}

/// Títulos que ve el usuario (los manda el webview).
#[tauri::command]
pub fn pane_set_title(pane_id: String, title: String) {
    if let Some(entry) = PANES.lock().get_mut(&pane_id) {
        entry.title = Some(title.chars().take(120).collect());
    }
}

/// Raw terminal output → plain text: drops escape sequences and resolves
/// carriage returns (progress bars) to their final state.
pub fn strip_ansi(raw: &[u8]) -> String {
    let text = String::from_utf8_lossy(raw);
    let mut out = String::with_capacity(text.len());
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            '\x1b' => match chars.next() {
                // CSI: parameters, then a final byte in @..~
                Some('[') => {
                    for n in chars.by_ref() {
                        if ('@'..='~').contains(&n) {
                            break;
                        }
                    }
                }
                // OSC: until BEL or ESC \
                Some(']') => {
                    while let Some(n) = chars.next() {
                        if n == '\x07' {
                            break;
                        }
                        if n == '\x1b' {
                            chars.next();
                            break;
                        }
                    }
                }
                _ => {}
            },
            '\x07' | '\x08' | '\x00' => {}
            _ => out.push(c),
        }
    }
    out.split('\n')
        .map(|line| line.rsplit('\r').find(|seg| !seg.is_empty()).unwrap_or(""))
        .collect::<Vec<_>>()
        .join("\n")
}

fn last_lines(text: &str, n: usize) -> String {
    let mut lines: Vec<&str> = text.lines().collect();
    // Primero fuera las líneas vacías del final, luego las N últimas con contenido.
    while lines.last().is_some_and(|l| l.trim().is_empty()) {
        lines.pop();
    }
    lines[lines.len().saturating_sub(n)..].join("\n")
}

// ---------------------------------------------------------------------------
// App side: local channel
// ---------------------------------------------------------------------------

fn answer(app: &AppHandle, request: &Value) -> Value {
    let pty = app.state::<PtyManager>();
    match request.get("op").and_then(Value::as_str) {
        Some("list") => {
            let panes = PANES.lock();
            let list: Vec<Value> = panes
                .iter()
                .map(|(id, p)| {
                    let info = pty.info(p.session).ok();
                    json!({
                        "pane": id,
                        "title": p.title,
                        "cwd": info.as_ref().and_then(|i| i.cwd.clone()),
                        "process": info.as_ref().and_then(|i| i.foreground_name.clone()),
                        "busy": info.map(|i| i.busy).unwrap_or(false),
                        "preview": last_lines(&strip_ansi(&contiguous(&p.bytes)), 3),
                    })
                })
                .collect();
            json!({ "panes": list })
        }
        Some("read") => {
            let wanted = request
                .get("pane")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_lowercase();
            let lines = request
                .get("lines")
                .and_then(Value::as_u64)
                .unwrap_or(120)
                .clamp(1, MAX_LINES as u64) as usize;
            let panes = PANES.lock();
            // Por id exacto o por un trozo del título ("dev", "tests"…).
            let found = panes
                .iter()
                .find(|(id, _)| id.to_lowercase() == wanted)
                .or_else(|| {
                    panes.iter().find(|(_, p)| {
                        p.title
                            .as_deref()
                            .is_some_and(|t| t.to_lowercase().contains(&wanted))
                    })
                });
            match found {
                Some((id, p)) => json!({
                    "pane": id,
                    "title": p.title,
                    "text": last_lines(&strip_ansi(&contiguous(&p.bytes)), lines),
                }),
                None => {
                    json!({ "error": format!("No hay un panel «{wanted}». Usa list_panes para ver los disponibles.") })
                }
            }
        }
        _ => json!({ "error": "operación desconocida" }),
    }
}

fn contiguous(bytes: &VecDeque<u8>) -> Vec<u8> {
    let (a, b) = bytes.as_slices();
    [a, b].concat()
}

/// Atiende al MCP de lectura y a la bandeja de aprobaciones por el canal local.
pub fn spawn_socket(app: AppHandle) {
    local_ipc::serve(move |request: Value, peer: &dyn Peer| {
        // Un permiso espera tu decisión; lo demás se contesta al momento.
        if request.get("op").and_then(Value::as_str) == Some("permission") {
            crate::approvals::serve(&app, &request, peer)
        } else {
            answer(&app, &request)
        }
    });
}

// ---------------------------------------------------------------------------
// CLI side: `termcode --mcp` (stdio MCP server spawned by the agent)
// ---------------------------------------------------------------------------

/// Del lado del auxiliar (`termcode --mcp`, hooks): una petición a la app.
pub(crate) fn ask_app(request: &Value, timeout: std::time::Duration) -> Result<Value, String> {
    local_ipc::request(request, timeout)
}

fn tools() -> Value {
    json!([
        {
            "name": "list_panes",
            "description": "Lista los paneles abiertos en termCode (la terminal del usuario): id, título, carpeta, proceso en primer plano y las últimas líneas de cada uno. Úsalo para encontrar el servidor de desarrollo, los tests o los logs.",
            "inputSchema": { "type": "object", "properties": {} },
            "annotations": { "readOnlyHint": true }
        },
        {
            "name": "read_pane",
            "description": "Lee las últimas líneas de salida de un panel de termCode (texto plano). Acepta el id exacto o parte del título.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "pane": { "type": "string", "description": "Id del panel o un trozo de su título" },
                    "lines": { "type": "integer", "minimum": 1, "maximum": MAX_LINES, "description": "Cuántas líneas finales (por defecto 120)" }
                },
                "required": ["pane"]
            },
            "annotations": { "readOnlyHint": true }
        }
    ])
}

fn call_tool(name: &str, args: &Value) -> (String, bool) {
    let own = std::env::var(ENV_PANE).ok();
    let result = match name {
        "list_panes" => ask_app(&json!({ "op": "list" }), QUICK).map(|v| {
            let panes = v["panes"].as_array().cloned().unwrap_or_default();
            if panes.is_empty() {
                return "No hay paneles abiertos.".to_owned();
            }
            panes
                .iter()
                .map(|p| {
                    let id = p["pane"].as_str().unwrap_or_default();
                    let mine = if own.as_deref() == Some(id) { " (este eres tú)" } else { "" };
                    format!(
                        "- {id}{mine}\n  título: {}\n  carpeta: {}\n  proceso: {}{}\n  últimas líneas:\n{}",
                        p["title"].as_str().unwrap_or("—"),
                        p["cwd"].as_str().unwrap_or("—"),
                        p["process"].as_str().unwrap_or("—"),
                        if p["busy"].as_bool() == Some(true) { " (ocupado)" } else { "" },
                        p["preview"].as_str().unwrap_or("").lines().map(|l| format!("    {l}")).collect::<Vec<_>>().join("\n"),
                    )
                })
                .collect::<Vec<_>>()
                .join("\n")
        }),
        "read_pane" => ask_app(&json!({ "op": "read", "pane": args.get("pane"), "lines": args.get("lines") }), QUICK).and_then(|v| {
            if let Some(err) = v.get("error").and_then(Value::as_str) {
                return Err(err.to_owned());
            }
            Ok(format!(
                "Panel {} ({}):\n{}",
                v["pane"].as_str().unwrap_or_default(),
                v["title"].as_str().unwrap_or("sin título"),
                v["text"].as_str().unwrap_or_default()
            ))
        }),
        other => Err(format!("Herramienta desconocida: {other}")),
    };
    match result {
        Ok(text) => (text, false),
        Err(e) => (e, true),
    }
}

/// Minimal JSON-RPC 2.0 over stdio, one message per line (MCP stdio transport).
pub fn stdio_server() -> i32 {
    let stdin = std::io::stdin();
    let mut stdout = std::io::stdout();
    for line in stdin.lock().lines() {
        let Ok(line) = line else { break };
        let Ok(msg) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        let Some(id) = msg.get("id").cloned() else {
            continue; // notificaciones (p. ej. notifications/initialized): sin respuesta
        };
        let result = match msg.get("method").and_then(Value::as_str) {
            Some("initialize") => json!({
                "protocolVersion": msg["params"]["protocolVersion"].as_str().unwrap_or(PROTOCOL_VERSION),
                "capabilities": { "tools": {} },
                "serverInfo": { "name": "termcode", "version": env!("CARGO_PKG_VERSION") },
                "instructions": "Herramientas de solo lectura para ver la salida de las otras terminales del usuario en termCode."
            }),
            Some("ping") => json!({}),
            Some("tools/list") => json!({ "tools": tools() }),
            Some("tools/call") => {
                let name = msg["params"]["name"].as_str().unwrap_or_default();
                let (text, is_error) = call_tool(name, &msg["params"]["arguments"]);
                json!({ "content": [{ "type": "text", "text": text }], "isError": is_error })
            }
            _ => {
                let error = json!({ "jsonrpc": "2.0", "id": id, "error": { "code": -32601, "message": "Método no soportado" } });
                let _ = writeln!(stdout, "{error}");
                let _ = stdout.flush();
                continue;
            }
        };
        let _ = writeln!(
            stdout,
            "{}",
            json!({ "jsonrpc": "2.0", "id": id, "result": result })
        );
        let _ = stdout.flush();
    }
    0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strips_escapes_and_progress_redraws() {
        let raw =
            b"\x1b[1;32mok\x1b[0m listo\r\n\x1b]0;titulo\x07Cargando 10%\rCargando 100%\nfin\x1b[K";
        assert_eq!(strip_ansi(raw), "ok listo\nCargando 100%\nfin");
    }

    #[test]
    fn keeps_only_the_tail() {
        let text = (1..=10)
            .map(|n| n.to_string())
            .collect::<Vec<_>>()
            .join("\n")
            + "\n\n";
        assert_eq!(last_lines(&text, 3), "8\n9\n10");
    }

    #[test]
    fn ring_buffer_is_bounded() {
        register("pane-ring", 1);
        record("pane-ring", &vec![b'x'; BUFFER_BYTES + 100]);
        assert_eq!(PANES.lock()["pane-ring"].bytes.len(), BUFFER_BYTES);
        forget("pane-ring");
        assert!(!PANES.lock().contains_key("pane-ring"));
    }

    #[test]
    fn advertises_read_only_tools() {
        let names: Vec<_> = tools()
            .as_array()
            .unwrap()
            .iter()
            .map(|t| t["name"].as_str().unwrap().to_owned())
            .collect();
        assert_eq!(names, vec!["list_panes", "read_pane"]);
    }
}
