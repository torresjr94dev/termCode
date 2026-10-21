//! Running external tools (git, gh, claude, the login shell) safely:
//! no shell interpolation, a hard timeout, bounded output, and stdin/stdout
//! drained on their own threads so a chatty child can never deadlock us.

use std::io::{Read, Write};
use std::process::{Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};

#[derive(Debug)]
pub struct Output {
    pub code: Option<i32>,
    pub stdout: Vec<u8>,
    pub stderr: Vec<u8>,
    /// `stdout` was cut at the size limit.
    pub truncated: bool,
}

impl Output {
    pub fn success(&self) -> bool {
        self.code == Some(0)
    }

    pub fn stdout_str(&self) -> String {
        String::from_utf8_lossy(&self.stdout).into_owned()
    }

    pub fn stderr_str(&self) -> String {
        String::from_utf8_lossy(&self.stderr).trim().to_owned()
    }
}

#[derive(Debug)]
pub enum RunError {
    Spawn(std::io::Error),
    Timeout,
}

impl std::fmt::Display for RunError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Spawn(e) => write!(f, "no se pudo ejecutar: {e}"),
            Self::Timeout => write!(f, "tardó demasiado y se canceló"),
        }
    }
}

/// Reads up to `limit` bytes, then keeps draining (and discarding) so the
/// child never blocks on a full pipe.
fn drain(mut source: impl Read, limit: usize) -> (Vec<u8>, bool) {
    let mut kept = Vec::new();
    let mut buf = [0u8; 16 * 1024];
    let mut truncated = false;
    loop {
        match source.read(&mut buf) {
            Ok(0) | Err(_) => break,
            Ok(n) => {
                let room = limit.saturating_sub(kept.len());
                kept.extend_from_slice(&buf[..n.min(room)]);
                truncated |= n > room;
            }
        }
    }
    (kept, truncated)
}

pub fn run(
    mut cmd: Command,
    stdin: Option<Vec<u8>>,
    timeout: Duration,
    max_stdout: usize,
) -> Result<Output, RunError> {
    cmd.stdin(if stdin.is_some() {
        Stdio::piped()
    } else {
        Stdio::null()
    })
    .stdout(Stdio::piped())
    .stderr(Stdio::piped());
    // Windows: una app de ventana que lanza git, gh o claude abriría una
    // consola por cada uno. Sus salidas van por tuberías; la consola sobra.
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    let mut child = cmd.spawn().map_err(RunError::Spawn)?;

    if let (Some(data), Some(mut pipe)) = (stdin, child.stdin.take()) {
        // Dropping the pipe after writing sends EOF.
        thread::spawn(move || {
            let _ = pipe.write_all(&data);
        });
    }
    let stdout = child
        .stdout
        .take()
        .map(|s| thread::spawn(move || drain(s, max_stdout)));
    let stderr = child
        .stderr
        .take()
        .map(|s| thread::spawn(move || drain(s, 64 * 1024)));

    let deadline = Instant::now() + timeout;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break Some(status),
            Ok(None) if Instant::now() < deadline => thread::sleep(Duration::from_millis(15)),
            Ok(None) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(RunError::Timeout);
            }
            Err(_) => break None,
        }
    };

    let (stdout, truncated) = stdout.and_then(|h| h.join().ok()).unwrap_or_default();
    let (stderr, _) = stderr.and_then(|h| h.join().ok()).unwrap_or_default();
    Ok(Output {
        code: status.and_then(|s| s.code()),
        stdout,
        stderr,
        truncated,
    })
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;

    #[test]
    fn captures_output_and_exit_code() {
        let mut cmd = Command::new("/bin/sh");
        cmd.args(["-c", "cat; echo err >&2; exit 3"]);
        let out = run(cmd, Some(b"hola".to_vec()), Duration::from_secs(5), 1024).unwrap();
        assert_eq!(out.stdout_str(), "hola");
        assert_eq!(out.stderr_str(), "err");
        assert_eq!(out.code, Some(3));
    }

    #[test]
    fn truncates_without_blocking_the_child() {
        let mut cmd = Command::new("/bin/sh");
        cmd.args(["-c", "head -c 300000 /dev/zero"]);
        let out = run(cmd, None, Duration::from_secs(5), 1000).unwrap();
        assert_eq!(out.stdout.len(), 1000);
        assert!(out.truncated);
        assert!(out.success());
    }

    #[test]
    fn kills_on_timeout() {
        let mut cmd = Command::new("/bin/sh");
        cmd.args(["-c", "sleep 5"]);
        assert!(matches!(
            run(cmd, None, Duration::from_millis(200), 10),
            Err(RunError::Timeout)
        ));
    }
}
