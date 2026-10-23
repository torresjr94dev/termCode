//! Contexto de Codex por panel.
//!
//! Codex no tiene statusLine: lo que sabe de su conversación lo escribe en su
//! rollout (`~/.codex/sessions/AAAA/MM/DD/rollout-*.jsonl`, eventos
//! `token_count` y `turn_context`). El proceso de Codex de un panel tiene ese
//! archivo abierto mientras dura la sesión, así que sus descriptores dicen
//! cuál es: sin adivinar por carpeta ni por hora, y con dos Codex en la misma
//! carpeta cada panel lee el suyo.

use crate::agents::AgentStatus;
use crate::proctree::descendants;
use crate::usage::codex::codex_home;
use parking_lot::Mutex;
use pty_core::{PtyManager, SessionId};
use serde_json::Value;
use std::collections::HashMap;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::LazyLock;
use std::time::SystemTime;
use tauri::State;

/// Lo último del rollout basta: Codex escribe `token_count` en cada turno.
const TAIL_BYTES: u64 = 1024 * 1024;
/// Prompts, herramientas y espacio para compactar: Codex no los cuenta como libres.
const BASELINE_TOKENS: f64 = 12_000.0;

#[derive(Debug, Clone, Default, PartialEq)]
struct Summary {
    model: Option<String>,
    /// Contexto usado, 0–100, con la misma cuenta que muestra Codex ("X% context left").
    used_percent: Option<f64>,
}

/// Rollout → resumen, por (ruta, mtime, tamaño): un archivo que no cambió no se relee.
type Cache = HashMap<PathBuf, (SystemTime, u64, Summary)>;
static CACHE: LazyLock<Mutex<Cache>> = LazyLock::new(|| Mutex::new(HashMap::new()));

/// Modelo y contexto usado del Codex que corre en la sesión `id`, o `None` si no hay.
#[tauri::command]
pub async fn codex_status(
    pty: State<'_, PtyManager>,
    id: SessionId,
    pane_id: String,
) -> Result<Option<AgentStatus>, String> {
    let info = pty.info(id).map_err(|e| e.to_string())?;
    let Some(shell) = info.shell_pid.and_then(|p| i32::try_from(p).ok()) else {
        return Ok(None);
    };
    tauri::async_runtime::spawn_blocking(move || {
        // Los descriptores dan la ruta real (sin enlaces): se compara con la real.
        let sessions = codex_home()?.join("sessions").canonicalize().ok()?;
        let path = descendants(shell)
            .into_iter()
            .flat_map(open_files)
            .find(|p| is_rollout(p, &sessions))?;
        let summary = summary_of(&path)?;
        Some(AgentStatus {
            pane_id,
            model: summary.model,
            context_percent: summary.used_percent,
            cost_usd: None,
        })
    })
    .await
    .map_err(|e| e.to_string())
}

fn is_rollout(path: &Path, sessions: &Path) -> bool {
    path.starts_with(sessions)
        && path
            .file_name()
            .and_then(|n| n.to_str())
            .is_some_and(|n| n.starts_with("rollout-") && n.ends_with(".jsonl"))
}

fn summary_of(path: &Path) -> Option<Summary> {
    let meta = std::fs::metadata(path).ok()?;
    let (modified, len) = (meta.modified().ok()?, meta.len());
    if let Some((m, l, summary)) = CACHE.lock().get(path)
        && *m == modified
        && *l == len
    {
        return Some(summary.clone());
    }
    let mut file = std::fs::File::open(path).ok()?;
    let start = len.saturating_sub(TAIL_BYTES);
    file.seek(SeekFrom::Start(start)).ok()?;
    let mut tail = Vec::new();
    file.take(TAIL_BYTES).read_to_end(&mut tail).ok()?;
    let summary = parse_tail(&String::from_utf8_lossy(&tail));
    let mut cache = CACHE.lock();
    // Rollouts de sesiones cerradas: la caché no crece sin límite.
    if cache.len() > 64 {
        cache.clear();
    }
    cache.insert(path.to_owned(), (modified, len, summary.clone()));
    Some(summary)
}

/// Lo más reciente de cada cosa, leyendo de abajo hacia arriba. La primera
/// línea puede venir cortada por el recorte del final: no parsea y se ignora.
fn parse_tail(tail: &str) -> Summary {
    let mut summary = Summary::default();
    for line in tail.lines().rev() {
        if summary.used_percent.is_none() && line.contains("\"token_count\"") {
            summary.used_percent = serde_json::from_str::<Value>(line)
                .ok()
                .and_then(|v| used_percent(v.get("payload")?.get("info")?));
        }
        if summary.model.is_none() && line.contains("\"turn_context\"") {
            summary.model = serde_json::from_str::<Value>(line).ok().and_then(|v| {
                let payload = v.get("payload")?;
                payload
                    .get("model")
                    .and_then(Value::as_str)
                    .map(str::to_owned)
            });
        }
        if summary.used_percent.is_some() && summary.model.is_some() {
            break;
        }
    }
    summary
}

/// La cuenta de Codex (`percent_of_context_window_remaining`) sobre el último
/// turno, que es lo que ocupa la conversación ahora; devuelve lo *usado*.
fn used_percent(info: &Value) -> Option<f64> {
    let window = info.get("model_context_window").and_then(Value::as_f64)?;
    let tokens = info
        .get("last_token_usage")?
        .get("total_tokens")
        .and_then(Value::as_f64)?;
    if window <= BASELINE_TOKENS {
        return None;
    }
    let effective = window - BASELINE_TOKENS;
    let used = (tokens - BASELINE_TOKENS).max(0.0);
    let remaining = ((effective - used).max(0.0) / effective * 100.0).clamp(0.0, 100.0);
    Some(100.0 - remaining.round())
}

#[cfg(target_os = "macos")]
fn open_files(pid: i32) -> Vec<PathBuf> {
    use std::ffi::CStr;
    use std::mem::{MaybeUninit, size_of};
    use std::os::unix::ffi::OsStrExt;

    /// `struct proc_fileinfo` y `struct vnode_fdinfowithpath` de sys/proc_info.h
    /// (libc no las trae): la misma disposición que usa libproc-rs.
    #[repr(C)]
    struct ProcFileInfo {
        fi_openflags: u32,
        fi_status: u32,
        fi_offset: i64,
        fi_type: i32,
        fi_guardflags: u32,
    }
    #[repr(C)]
    struct VnodeFdInfoWithPath {
        pfi: ProcFileInfo,
        pvip: libc::vnode_info_path,
    }
    const PROC_PIDFDVNODEPATHINFO: libc::c_int = 2;

    let fd_size = size_of::<libc::proc_fdinfo>();
    // SAFETY: sin búfer, proc_pidinfo devuelve cuántos bytes necesita.
    let needed =
        unsafe { libc::proc_pidinfo(pid, libc::PROC_PIDLISTFDS, 0, std::ptr::null_mut(), 0) };
    if needed <= 0 {
        return Vec::new();
    }
    // Margen por si abre archivos entre las dos llamadas.
    let mut fds: Vec<libc::proc_fdinfo> = Vec::with_capacity(needed as usize / fd_size + 16);
    let capacity = (fds.capacity() * fd_size) as libc::c_int;
    // SAFETY: el búfer tiene `capacity` bytes reservados; solo se usan los que el kernel escribe.
    let written = unsafe {
        libc::proc_pidinfo(
            pid,
            libc::PROC_PIDLISTFDS,
            0,
            fds.as_mut_ptr().cast(),
            capacity,
        )
    };
    if written <= 0 {
        return Vec::new();
    }
    // SAFETY: el kernel escribió `written` bytes de `proc_fdinfo` completos.
    unsafe { fds.set_len(written as usize / fd_size) };

    let info_size = size_of::<VnodeFdInfoWithPath>() as libc::c_int;
    fds.iter()
        .filter(|fd| fd.proc_fdtype == libc::PROX_FDTYPE_VNODE as u32)
        .filter_map(|fd| {
            let mut info = MaybeUninit::<VnodeFdInfoWithPath>::zeroed();
            // SAFETY: búfer de exactamente `info_size` bytes.
            let got = unsafe {
                libc::proc_pidfdinfo(
                    pid,
                    fd.proc_fd,
                    PROC_PIDFDVNODEPATHINFO,
                    info.as_mut_ptr().cast(),
                    info_size,
                )
            };
            if got != info_size {
                return None;
            }
            // SAFETY: escritura completa reportada por el kernel.
            let info = unsafe { info.assume_init() };
            // SAFETY: `vip_path` son 32×32 bytes contiguos dentro de `info`.
            let bytes: &[u8] = unsafe {
                std::slice::from_raw_parts(info.pvip.vip_path.as_ptr().cast::<u8>(), 32 * 32)
            };
            let path = CStr::from_bytes_until_nul(bytes).ok()?;
            Some(PathBuf::from(std::ffi::OsStr::from_bytes(path.to_bytes())))
        })
        .collect()
}

#[cfg(target_os = "linux")]
fn open_files(pid: i32) -> Vec<PathBuf> {
    std::fs::read_dir(format!("/proc/{pid}/fd"))
        .map(|dir| {
            dir.flatten()
                .filter_map(|e| std::fs::read_link(e.path()).ok())
                .collect()
        })
        .unwrap_or_default()
}

/// Windows: no se leen los archivos abiertos de otro proceso sin privilegios.
#[cfg(not(any(target_os = "macos", target_os = "linux")))]
fn open_files(_pid: i32) -> Vec<PathBuf> {
    Vec::new()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn token_count(total: u64, window: Option<u64>) -> String {
        json!({
            "timestamp": "2026-10-23T18:00:00.000Z",
            "type": "event_msg",
            "payload": {
                "type": "token_count",
                "info": {
                    "total_token_usage": { "total_tokens": total * 5 },
                    "last_token_usage": { "total_tokens": total },
                    "model_context_window": window,
                },
            },
        })
        .to_string()
    }

    #[test]
    fn same_numbers_as_codex() {
        // 258 400 de ventana y 12 000 de base: 9 849 tokens caben en la base (0 % usado).
        let tail = token_count(9_849, Some(258_400));
        assert_eq!(parse_tail(&tail).used_percent, Some(0.0));
        // Media ventana efectiva ocupada: 50 %.
        let tail = token_count(12_000 + 123_200, Some(258_400));
        assert_eq!(parse_tail(&tail).used_percent, Some(50.0));
    }

    #[test]
    fn newest_event_wins_and_model_comes_from_turn_context() {
        let turn =
            json!({ "type": "turn_context", "payload": { "model": "gpt-5-codex", "cwd": "/x" } })
                .to_string();
        let tail = [
            "{\"cortada por el recorte".to_owned(),
            turn,
            token_count(12_000 + 24_640, Some(258_400)),
            json!({ "type": "event_msg", "payload": { "type": "token_count", "info": null } })
                .to_string(),
        ]
        .join("\n");
        let summary = parse_tail(&tail);
        assert_eq!(summary.model.as_deref(), Some("gpt-5-codex"));
        assert_eq!(summary.used_percent, Some(10.0));
    }

    #[test]
    fn unknown_window_is_unknown() {
        assert_eq!(parse_tail(&token_count(50_000, None)).used_percent, None);
        assert_eq!(parse_tail("").used_percent, None);
    }

    #[test]
    fn only_rollouts_under_sessions() {
        let sessions = Path::new("/home/x/.codex/sessions");
        assert!(is_rollout(
            Path::new("/home/x/.codex/sessions/2026/10/23/rollout-a.jsonl"),
            sessions
        ));
        assert!(!is_rollout(
            Path::new("/home/x/.codex/history.jsonl"),
            sessions
        ));
        assert!(!is_rollout(Path::new("/tmp/rollout-a.jsonl"), sessions));
    }

    #[cfg(any(target_os = "macos", target_os = "linux"))]
    #[test]
    fn finds_files_this_process_has_open() {
        let dir = std::env::temp_dir().join(format!("termcode-fd-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("rollout-prueba.jsonl");
        let _file = std::fs::File::create(&path).unwrap();
        let me = std::process::id() as i32;
        let canonical = path.canonicalize().unwrap();
        let open = open_files(me);
        assert!(
            open.iter()
                .any(|p| p.canonicalize().ok().as_ref() == Some(&canonical)),
            "{open:?}"
        );
        assert!(descendants(me).contains(&me));
        std::fs::remove_dir_all(&dir).ok();
    }
}
