//! Puertos TCP en escucha de cada panel: el `:3000` de tu servidor de
//! desarrollo, para abrirlo con un clic. Una sola llamada a `lsof` para todos
//! los paneles (los procesos de cada uno, juntos), con tope de tiempo.

use crate::proctree::descendants;
use pty_core::{PtyManager, SessionId};
use std::collections::{BTreeSet, HashMap};
use std::time::Duration;
use tauri::State;

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionPorts {
    pub id: SessionId,
    /// Ordenados, sin repetir (IPv4 e IPv6 del mismo puerto cuentan una vez).
    pub ports: Vec<u16>,
}

/// Puertos en escucha de cada sesión pedida (las que no tienen, no aparecen).
#[tauri::command]
pub async fn pty_ports(
    pty: State<'_, PtyManager>,
    ids: Vec<SessionId>,
) -> Result<Vec<SessionPorts>, String> {
    // pid → sesión dueña (el árbol de cada shell).
    let mut owner: HashMap<i32, SessionId> = HashMap::new();
    for id in ids {
        let Ok(info) = pty.info(id) else { continue };
        let Some(shell) = info.shell_pid.and_then(|p| i32::try_from(p).ok()) else {
            continue;
        };
        // La shell sola no escucha puertos: sin hijos, nada que preguntar.
        let tree = descendants(shell);
        if tree.len() > 1 {
            for pid in tree {
                owner.insert(pid, id);
            }
        }
    }
    if owner.is_empty() {
        return Ok(Vec::new());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let pids: Vec<i32> = owner.keys().copied().collect();
        let mut by_session: HashMap<SessionId, BTreeSet<u16>> = HashMap::new();
        for (pid, port) in listening(&pids) {
            if let Some(id) = owner.get(&pid) {
                by_session.entry(*id).or_default().insert(port);
            }
        }
        let mut out: Vec<SessionPorts> = by_session
            .into_iter()
            .map(|(id, ports)| SessionPorts {
                id,
                ports: ports.into_iter().collect(),
            })
            .collect();
        out.sort_by_key(|s| s.id);
        out
    })
    .await
    .map_err(|e| e.to_string())
}

/// (pid, puerto) de los sockets TCP en escucha de esos procesos.
#[cfg(unix)]
fn listening(pids: &[i32]) -> Vec<(i32, u16)> {
    let list = pids
        .iter()
        .map(i32::to_string)
        .collect::<Vec<_>>()
        .join(",");
    let mut cmd = std::process::Command::new(if cfg!(target_os = "macos") {
        "/usr/sbin/lsof"
    } else {
        "lsof"
    });
    // -a: todas las condiciones a la vez; -n -P: sin resolver nombres ni puertos (rápido);
    // -b -w: sin llamadas que se bloquean (un stat sobre un archivo de iCloud) ni sus avisos.
    cmd.args([
        "-a",
        "-b",
        "-w",
        "-n",
        "-P",
        "-iTCP",
        "-sTCP:LISTEN",
        "-p",
        &list,
        "-F",
        "pn",
    ]);
    match crate::proc::run(cmd, None, Duration::from_secs(3), 256 * 1024) {
        Ok(out) => parse_lsof(&out.stdout_str()),
        Err(err) => {
            log::debug!("ports: lsof: {err}");
            Vec::new()
        }
    }
}

/// Windows: pendiente (haría falta `GetExtendedTcpTable` y el árbol de procesos).
#[cfg(not(unix))]
fn listening(_pids: &[i32]) -> Vec<(i32, u16)> {
    Vec::new()
}

/// Salida `-F pn` de lsof: `p<pid>` y luego un `n<dirección>:<puerto>` por socket.
#[cfg_attr(not(unix), allow(dead_code))]
fn parse_lsof(output: &str) -> Vec<(i32, u16)> {
    let mut pid = None;
    let mut found = Vec::new();
    for line in output.lines() {
        if let Some(rest) = line.strip_prefix('p') {
            pid = rest.parse().ok();
        } else if let (Some(rest), Some(pid)) = (line.strip_prefix('n'), pid)
            && let Some(port) = rest.rsplit(':').next().and_then(|p| p.parse::<u16>().ok())
        {
            found.push((pid, port));
        }
    }
    found
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_lsof_field_output() {
        let out = "p501\nn*:3000\nn[::1]:3000\np777\nn127.0.0.1:5173\nnsin-puerto\n";
        assert_eq!(parse_lsof(out), vec![(501, 3000), (501, 3000), (777, 5173)]);
    }

    #[cfg(unix)]
    #[test]
    fn sees_a_real_listener() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let found = listening(&[std::process::id() as i32]);
        assert!(found.iter().any(|(_, p)| *p == port), "{found:?}");
    }
}
