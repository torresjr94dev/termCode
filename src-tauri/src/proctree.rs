//! Los procesos de un panel: la shell y todo lo que cuelga de ella (un
//! agente, `npm run dev` y el `node` que lanza, el binario nativo de Codex…).

/// Profundidad del árbol bajo la shell (`zsh → npm → node → esbuild`).
const MAX_DEPTH: usize = 5;

/// La shell y todo lo que cuelga de ella (Codex de npm es `node` lanzando el binario nativo).
pub fn descendants(root: i32) -> Vec<i32> {
    let mut all = vec![root];
    let mut level = vec![root];
    for _ in 0..MAX_DEPTH {
        level = level.into_iter().flat_map(children).collect();
        if level.is_empty() {
            break;
        }
        all.extend(&level);
    }
    all
}

#[cfg(target_os = "macos")]
fn children(pid: i32) -> Vec<i32> {
    /// `PROC_PPID_ONLY` de sys/proc_info.h (libc no lo exporta).
    const PROC_PPID_ONLY: u32 = 6;
    let mut pids = vec![0 as libc::pid_t; 256];
    let size = (pids.len() * std::mem::size_of::<libc::pid_t>()) as libc::c_int;
    // SAFETY: el búfer tiene exactamente `size` bytes; devuelve cuántos escribió.
    let bytes =
        unsafe { libc::proc_listpids(PROC_PPID_ONLY, pid as u32, pids.as_mut_ptr().cast(), size) };
    if bytes <= 0 {
        return Vec::new();
    }
    pids.truncate(bytes as usize / std::mem::size_of::<libc::pid_t>());
    pids.retain(|&p| p > 0);
    pids
}

#[cfg(target_os = "linux")]
fn children(pid: i32) -> Vec<i32> {
    std::fs::read_to_string(format!("/proc/{pid}/task/{pid}/children"))
        .map(|s| {
            s.split_whitespace()
                .filter_map(|p| p.parse().ok())
                .collect()
        })
        .unwrap_or_default()
}

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
fn children(_pid: i32) -> Vec<i32> {
    Vec::new()
}

#[cfg(all(test, any(target_os = "macos", target_os = "linux")))]
mod tests {
    use super::*;

    #[test]
    fn finds_a_child_process() {
        let mut child = std::process::Command::new("sleep")
            .arg("5")
            .spawn()
            .unwrap();
        let me = std::process::id() as i32;
        let found = descendants(me);
        child.kill().ok();
        child.wait().ok();
        assert!(found.contains(&me));
        assert!(found.contains(&(child.id() as i32)), "{found:?}");
    }
}
