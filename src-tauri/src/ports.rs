//! Puertos TCP en escucha de cada panel: el `:3000` de tu servidor de
//! desarrollo, para abrirlo con un clic. Una sola llamada a `lsof` para todos
//! los paneles (los procesos de cada uno, juntos), con tope de tiempo.
//!
//! Solo cuentan los puertos que alguien eligió. Los del rango efímero del
//! sistema (49152–65535 en macOS) los asigna el kernel a quien pide «cualquier
//! puerto libre»: el servidor interno de Claude Code, un `node --inspect`, un
//! language server. Escuchan, pero no son una página que abrir.

use crate::proctree::descendants;
use pty_core::{PtyManager, SessionId};
use std::collections::{BTreeSet, HashMap};
use std::ops::RangeInclusive;
use std::sync::LazyLock;
use tauri::State;

/// El rango que IANA reserva para puertos dinámicos: el de macOS y Windows.
const IANA_EPHEMERAL: RangeInclusive<u16> = 49152..=65535;

/// Rango efímero del sistema, leído una vez (no cambia sin reiniciar la red).
static EPHEMERAL: LazyLock<RangeInclusive<u16>> =
    LazyLock::new(|| system_ephemeral_range().unwrap_or(IANA_EPHEMERAL));

#[cfg(target_os = "macos")]
fn system_ephemeral_range() -> Option<RangeInclusive<u16>> {
    fn read(name: &std::ffi::CStr) -> Option<u16> {
        let mut value: libc::c_int = 0;
        let mut size = std::mem::size_of::<libc::c_int>();
        // SAFETY: nombre terminado en 0; `value` y `size` son un int y su tamaño.
        let rc = unsafe {
            libc::sysctlbyname(
                name.as_ptr(),
                (&raw mut value).cast(),
                &mut size,
                std::ptr::null_mut(),
                0,
            )
        };
        if rc == 0 {
            u16::try_from(value).ok()
        } else {
            None
        }
    }
    valid_range(
        read(c"net.inet.ip.portrange.first")?,
        read(c"net.inet.ip.portrange.last")?,
    )
}

#[cfg(target_os = "linux")]
fn system_ephemeral_range() -> Option<RangeInclusive<u16>> {
    let text = std::fs::read_to_string("/proc/sys/net/ipv4/ip_local_port_range").ok()?;
    parse_linux_range(&text)
}

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
fn system_ephemeral_range() -> Option<RangeInclusive<u16>> {
    None
}

/// `32768\t60999` → 32768..=60999.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
fn parse_linux_range(text: &str) -> Option<RangeInclusive<u16>> {
    let mut parts = text.split_whitespace().map(str::parse::<u16>);
    valid_range(parts.next()?.ok()?, parts.next()?.ok()?)
}

/// Un rango absurdo (al revés, o que se come los puertos de desarrollo de
/// siempre) no sirve para filtrar: mejor el de IANA.
#[cfg_attr(not(any(target_os = "macos", target_os = "linux")), allow(dead_code))]
fn valid_range(first: u16, last: u16) -> Option<RangeInclusive<u16>> {
    (first <= last && first >= 10_000).then_some(first..=last)
}

/// Un puerto que se eligió (3000, 5173, 8080…), no uno que repartió el kernel.
fn is_chosen(port: u16, ephemeral: &RangeInclusive<u16>) -> bool {
    !ephemeral.contains(&port)
}

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
        let ephemeral = &*EPHEMERAL;
        for (pid, port) in listening(&pids) {
            if !is_chosen(port, ephemeral) {
                continue;
            }
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
    match crate::proc::run(cmd, None, std::time::Duration::from_secs(3), 256 * 1024) {
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

    #[test]
    fn ignores_ports_the_kernel_handed_out() {
        // El :52263 que abría Claude Code por dentro no es un servidor tuyo.
        let range = IANA_EPHEMERAL;
        assert!(!is_chosen(52263, &range));
        assert!(!is_chosen(49152, &range));
        assert!(!is_chosen(65535, &range));
        for port in [80, 3000, 4200, 5173, 8000, 8080, 8787, 19000] {
            assert!(is_chosen(port, &range), "{port}");
        }
    }

    #[test]
    fn reads_the_linux_range_and_rejects_nonsense() {
        assert_eq!(parse_linux_range("32768\t60999\n"), Some(32768..=60999));
        assert_eq!(parse_linux_range("60999 32768"), None);
        // Un rango que se tragaría el :3000 o el :8080 no se usa para filtrar.
        assert_eq!(parse_linux_range("1024 65535"), None);
        assert_eq!(parse_linux_range("basura"), None);
        assert_eq!(parse_linux_range(""), None);
    }

    #[test]
    fn the_system_range_never_hides_dev_ports() {
        for port in [3000, 5173, 8080] {
            assert!(is_chosen(port, &EPHEMERAL), "{port} en {:?}", *EPHEMERAL);
        }
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
