//! Information about the processes running inside a PTY.
//!
//! The foreground process group leader tells us what the user is actually
//! running (shell idle vs. `vim`/`claude`/`cargo`), and its working directory
//! lets new splits open where the user is — no shell integration required.

use serde::Serialize;
use std::path::PathBuf;

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcessInfo {
    /// PID of the process the session was spawned with (usually the shell).
    pub shell_pid: Option<u32>,
    /// Leader of the foreground process group of the terminal.
    pub foreground_pid: Option<i32>,
    /// Short name of the foreground process (`zsh`, `vim`, `node`…).
    pub foreground_name: Option<String>,
    /// Working directory of the foreground process (falls back to the shell's).
    pub cwd: Option<PathBuf>,
    /// `true` when something other than the shell owns the terminal.
    pub busy: bool,
}

pub(crate) fn describe(shell_pid: Option<u32>, foreground_pid: Option<i32>) -> ProcessInfo {
    let target = foreground_pid.or(shell_pid.and_then(|p| i32::try_from(p).ok()));
    let busy = match (foreground_pid, shell_pid) {
        (Some(fg), Some(shell)) => i64::from(fg) != i64::from(shell),
        _ => false,
    };
    let cwd = target.and_then(cwd_of).or_else(|| {
        shell_pid
            .and_then(|p| i32::try_from(p).ok())
            .and_then(cwd_of)
    });

    ProcessInfo {
        shell_pid,
        foreground_pid,
        foreground_name: target.and_then(name_of),
        cwd,
        busy,
    }
}

#[cfg(target_os = "macos")]
fn cwd_of(pid: i32) -> Option<PathBuf> {
    use std::ffi::CStr;
    use std::mem::{MaybeUninit, size_of};
    use std::os::unix::ffi::OsStrExt;

    let size = size_of::<libc::proc_vnodepathinfo>() as libc::c_int;
    let mut info = MaybeUninit::<libc::proc_vnodepathinfo>::zeroed();
    // SAFETY: the buffer is exactly `size` bytes and the kernel fills at most that.
    let written = unsafe {
        libc::proc_pidinfo(
            pid,
            libc::PROC_PIDVNODEPATHINFO,
            0,
            info.as_mut_ptr().cast(),
            size,
        )
    };
    if written != size {
        return None;
    }
    // SAFETY: proc_pidinfo reported a complete write.
    let info = unsafe { info.assume_init() };
    // `vip_path` is a MAXPATHLEN buffer declared as 32×32 chunks; it is contiguous.
    // SAFETY: 1024 contiguous bytes owned by `info`, alive for this scope.
    let bytes: &[u8] = unsafe {
        std::slice::from_raw_parts(info.pvi_cdir.vip_path.as_ptr().cast::<u8>(), 32 * 32)
    };
    let cstr = CStr::from_bytes_until_nul(bytes).ok()?;
    let path = PathBuf::from(std::ffi::OsStr::from_bytes(cstr.to_bytes()));
    path.is_absolute().then_some(path)
}

#[cfg(target_os = "macos")]
fn name_of(pid: i32) -> Option<String> {
    let mut buf = [0u8; 256];
    // SAFETY: buffer length is passed alongside the pointer.
    let len = unsafe { libc::proc_name(pid, buf.as_mut_ptr().cast(), buf.len() as u32) };
    (len > 0).then(|| String::from_utf8_lossy(&buf[..len as usize]).into_owned())
}

#[cfg(target_os = "linux")]
fn cwd_of(pid: i32) -> Option<PathBuf> {
    std::fs::read_link(format!("/proc/{pid}/cwd")).ok()
}

#[cfg(target_os = "linux")]
fn name_of(pid: i32) -> Option<String> {
    std::fs::read_to_string(format!("/proc/{pid}/comm"))
        .ok()
        .map(|s| s.trim().to_owned())
        .filter(|s| !s.is_empty())
}

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
fn cwd_of(_pid: i32) -> Option<PathBuf> {
    None
}

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
fn name_of(_pid: i32) -> Option<String> {
    None
}

#[cfg(all(test, any(target_os = "macos", target_os = "linux")))]
mod tests {
    use super::*;

    #[test]
    fn describes_current_process() {
        let me = std::process::id();
        let info = describe(Some(me), Some(me as i32));
        assert!(!info.busy, "same pid is not busy");
        assert_eq!(info.cwd.as_deref(), std::env::current_dir().ok().as_deref());
        assert!(info.foreground_name.is_some());
    }

    #[test]
    fn different_foreground_is_busy() {
        let info = describe(Some(1), Some(std::process::id() as i32));
        assert!(info.busy);
    }
}
