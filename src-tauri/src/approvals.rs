//! Bandeja de aprobaciones: los permisos que pide Claude Code se aprueban o
//! deniegan desde cualquier parte de termCode, sin ir a su panel.
//!
//! * Claude Code llama al hook `PermissionRequest` (`termcode --claude-hook
//!   PermissionRequest`) cuando está a punto de preguntarte.
//! * El hook pregunta a la app por el canal local (`local_ipc`: socket Unix
//!   0600, o un named pipe solo del usuario en Windows) y espera.
//! * La app muestra la solicitud completa; tu respuesta vuelve por el socket.
//!
//! Regla de oro: **ante cualquier duda, Claude pregunta en su panel**. App
//! cerrada, bandeja desactivada, socket caído, respuesta rara, tiempo agotado
//! o el agente que se fue: el hook sale sin imprimir nada y Claude sigue con su
//! flujo normal de permisos. Nunca se aprueba nada por omisión.
//!
//! Tres esperas escalonadas (app < CLI < hook), así ninguna capa depende de
//! cómo corta la de arriba (el comportamiento de Claude al agotar el timeout
//! de un hook no está documentado).

use crate::agents::{now_ms, valid_pane_id};
use parking_lot::Mutex;
use serde::Serialize;
use serde_json::{Value, json};
use std::collections::HashMap;
use std::sync::LazyLock;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc;
use std::time::Duration;

/// Lo que la app sostiene una solicitud antes de soltarla.
pub const APP_WAIT: Duration = Duration::from_secs(90);
/// Lo que el CLI del hook espera la respuesta de la app.
pub const CLI_WAIT: Duration = Duration::from_secs(100);
/// `timeout` del hook en los settings de Claude (segundos).
pub const HOOK_TIMEOUT_SECS: u64 = 120;
/// Algo más grande no se puede revisar con calma en una bandeja: que pregunte Claude.
const MAX_REQUEST_BYTES: usize = 256 * 1024;
const MAX_MESSAGE_CHARS: usize = 1000;
const DEFAULT_DENY: &str = "El usuario lo denegó desde termCode.";

/// La vista dice que la bandeja está activa (ajuste) y escuchando.
static ENABLED: AtomicBool = AtomicBool::new(false);
static SEQ: AtomicU64 = AtomicU64::new(1);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Decision {
    Allow,
    Deny,
    /// Sin decisión: Claude pregunta en su panel.
    Ask,
}

impl Decision {
    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "allow" => Some(Self::Allow),
            "deny" => Some(Self::Deny),
            "ask" => Some(Self::Ask),
            _ => None,
        }
    }

    fn as_str(self) -> &'static str {
        match self {
            Self::Allow => "allow",
            Self::Deny => "deny",
            Self::Ask => "ask",
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApprovalRequest {
    pub id: String,
    pub pane_id: String,
    pub tool: String,
    /// Completo: lo que apruebas es exactamente lo que ves.
    pub input: Value,
    pub cwd: Option<String>,
    pub at: u64,
    pub expires_at: u64,
}

struct Pending {
    request: ApprovalRequest,
    reply: mpsc::Sender<(Decision, Option<String>)>,
}

static PENDING: LazyLock<Mutex<HashMap<String, Pending>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

/// Lo que Claude Code espera en stdout del hook. `None` = no imprimir nada
/// (sin decisión: flujo normal de permisos).
pub fn hook_output(decision: Decision, message: Option<&str>) -> Option<String> {
    let decision = match decision {
        Decision::Ask => return None,
        Decision::Allow => json!({ "behavior": "allow" }),
        Decision::Deny => {
            let reason = message
                .map(str::trim)
                .filter(|m| !m.is_empty())
                .unwrap_or(DEFAULT_DENY);
            json!({ "behavior": "deny", "message": reason })
        }
    };
    Some(
        json!({ "hookSpecificOutput": { "hookEventName": "PermissionRequest", "decision": decision } })
            .to_string(),
    )
}

// ---------------------------------------------------------------------------
// CLI: dentro del hook de Claude Code
// ---------------------------------------------------------------------------

/// Pregunta a la app y devuelve lo que el hook debe imprimir (o nada).
pub fn ask_from_hook(pane: &str, input: &Value) -> Option<String> {
    let tool = input.get("tool_name").and_then(Value::as_str)?;
    let request = json!({
        "op": "permission",
        "pane": pane,
        "tool": tool,
        "input": input.get("tool_input").cloned().unwrap_or(Value::Null),
        "cwd": input.get("cwd").and_then(Value::as_str),
    });
    if request.to_string().len() > MAX_REQUEST_BYTES {
        return None;
    }
    let response = crate::mcp::ask_app(&request, CLI_WAIT).ok()?;
    let decision = response
        .get("decision")
        .and_then(Value::as_str)
        .and_then(Decision::parse)?;
    hook_output(decision, response.get("message").and_then(Value::as_str))
}

// ---------------------------------------------------------------------------
// App: el hilo del socket sostiene la solicitud hasta que decides
// ---------------------------------------------------------------------------

/// Atiende `op: "permission"`. Bloquea el hilo de esa conexión (no el de la app).
pub fn serve(app: &tauri::AppHandle, request: &Value, peer: &dyn crate::local_ipc::Peer) -> Value {
    use tauri::Emitter;
    let ask = json!({ "decision": "ask" });
    if !ENABLED.load(Ordering::Relaxed) {
        return ask;
    }
    let Some(pane) = request
        .get("pane")
        .and_then(Value::as_str)
        .filter(|p| valid_pane_id(p))
    else {
        return ask;
    };
    let at = now_ms();
    let id = format!("ap-{at}-{}", SEQ.fetch_add(1, Ordering::Relaxed));
    let pending = ApprovalRequest {
        id: id.clone(),
        pane_id: pane.to_owned(),
        tool: request
            .get("tool")
            .and_then(Value::as_str)
            .unwrap_or("herramienta")
            .chars()
            .take(200)
            .collect(),
        input: request.get("input").cloned().unwrap_or(Value::Null),
        cwd: request
            .get("cwd")
            .and_then(Value::as_str)
            .map(str::to_owned),
        at,
        expires_at: at + APP_WAIT.as_millis() as u64,
    };
    let (reply, decided) = mpsc::channel();
    PENDING.lock().insert(
        id.clone(),
        Pending {
            request: pending.clone(),
            reply,
        },
    );
    let _ = app.emit("approval-request", &pending);

    let deadline = std::time::Instant::now() + APP_WAIT;
    let outcome = loop {
        match decided.recv_timeout(Duration::from_millis(250)) {
            Ok(answer) => break Some(answer),
            Err(mpsc::RecvTimeoutError::Disconnected) => break None,
            Err(mpsc::RecvTimeoutError::Timeout) => {}
        }
        // El hook se fue (Claude canceló, el usuario interrumpió…): nadie leerá la respuesta.
        if std::time::Instant::now() >= deadline || peer.closed() {
            break None;
        }
    };
    PENDING.lock().remove(&id);
    let _ = app.emit("approval-closed", json!({ "id": id }));

    match outcome {
        Some((decision, message)) => json!({ "decision": decision.as_str(), "message": message }),
        None => ask,
    }
}

/// Entrega tu decisión al hilo que la espera.
fn decide(id: &str, decision: Decision, message: Option<String>) -> Result<(), String> {
    let pending = PENDING
        .lock()
        .remove(id)
        .ok_or("Esa solicitud ya no está pendiente: Claude te la pregunta en su panel.")?;
    let message = message.map(|m| m.chars().take(MAX_MESSAGE_CHARS).collect());
    pending
        .reply
        .send((decision, message))
        .map_err(|_| "El agente ya no espera la respuesta.".to_owned())
}

#[tauri::command]
pub fn approval_decide(
    id: String,
    decision: String,
    message: Option<String>,
) -> Result<(), String> {
    let decision = Decision::parse(&decision).ok_or("Decisión inválida.")?;
    decide(&id, decision, message)
}

/// La vista avisa si la bandeja está activa. Mientras no lo diga (arranque,
/// recarga), cada solicitud vuelve al panel al instante en vez de colgarse.
#[tauri::command]
pub fn approvals_set_enabled(enabled: bool) {
    ENABLED.store(enabled, Ordering::Relaxed);
}

/// Lo que sigue pendiente (la vista se recargó y perdió los eventos).
#[tauri::command]
pub fn approvals_pending() -> Vec<ApprovalRequest> {
    let mut list: Vec<_> = PENDING.lock().values().map(|p| p.request.clone()).collect();
    list.sort_by_key(|r| r.at);
    list
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hook_output_matches_claude_code_contract() {
        let allow: Value =
            serde_json::from_str(&hook_output(Decision::Allow, None).unwrap()).unwrap();
        assert_eq!(
            allow,
            json!({ "hookSpecificOutput": { "hookEventName": "PermissionRequest", "decision": { "behavior": "allow" } } })
        );
        let deny: Value =
            serde_json::from_str(&hook_output(Decision::Deny, Some("  usa pnpm  ")).unwrap())
                .unwrap();
        assert_eq!(deny["hookSpecificOutput"]["decision"]["behavior"], "deny");
        assert_eq!(
            deny["hookSpecificOutput"]["decision"]["message"],
            "usa pnpm"
        );
        let blank: Value =
            serde_json::from_str(&hook_output(Decision::Deny, Some(" ")).unwrap()).unwrap();
        assert_eq!(
            blank["hookSpecificOutput"]["decision"]["message"],
            DEFAULT_DENY
        );
    }

    #[test]
    fn no_decision_prints_nothing() {
        assert_eq!(hook_output(Decision::Ask, Some("x")), None);
    }

    #[test]
    fn only_known_decisions_parse() {
        assert_eq!(Decision::parse("allow"), Some(Decision::Allow));
        assert_eq!(Decision::parse("ALLOW"), None);
        assert_eq!(Decision::parse("yes"), None);
    }

    #[test]
    fn a_decision_reaches_its_waiter_once() {
        let (reply, decided) = mpsc::channel();
        let request = ApprovalRequest {
            id: "ap-test".into(),
            pane_id: "pane-1".into(),
            tool: "Bash".into(),
            input: json!({ "command": "ls" }),
            cwd: None,
            at: 1,
            expires_at: 2,
        };
        PENDING
            .lock()
            .insert("ap-test".into(), Pending { request, reply });
        assert_eq!(approvals_pending().len(), 1);
        decide("ap-test", Decision::Deny, Some("x".repeat(5000))).unwrap();
        let (decision, message) = decided.recv().unwrap();
        assert_eq!(decision, Decision::Deny);
        assert_eq!(message.unwrap().chars().count(), MAX_MESSAGE_CHARS);
        assert!(
            decide("ap-test", Decision::Allow, None).is_err(),
            "no se decide dos veces"
        );
        assert!(approvals_pending().iter().all(|r| r.id != "ap-test"));
    }
}
