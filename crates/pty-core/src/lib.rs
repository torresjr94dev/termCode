//! PTY core for termCode.
//!
//! Framework-agnostic: the app layer provides an [`OutputSink`] per session and
//! forwards input/resize/ack calls to the [`PtyManager`].

pub mod flow;
mod procinfo;
mod session;
mod shell;

pub use flow::FlowConfig;
pub use procinfo::ProcessInfo;
pub use session::{OutputSink, Session, SessionId, SpawnOptions};
#[cfg(windows)]
pub use shell::powershell;
pub use shell::shell_quote;
#[cfg(unix)]
pub use shell::user_shell;

use parking_lot::RwLock;
use std::collections::HashMap;
use std::sync::Arc;
use std::sync::atomic::{AtomicU32, Ordering};

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("pty error: {0}")]
    Pty(String),
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
    #[error("session {0} not found")]
    NotFound(SessionId),
}

impl Error {
    fn pty(e: impl std::fmt::Display) -> Self {
        Self::Pty(e.to_string())
    }
}

pub type Result<T> = std::result::Result<T, Error>;

/// Owns every live session.
pub struct PtyManager {
    sessions: RwLock<HashMap<SessionId, Arc<Session>>>,
    next_id: AtomicU32,
    flow_cfg: FlowConfig,
}

impl Default for PtyManager {
    fn default() -> Self {
        Self::new(FlowConfig::default())
    }
}

impl PtyManager {
    pub fn new(flow_cfg: FlowConfig) -> Self {
        Self {
            sessions: RwLock::new(HashMap::new()),
            next_id: AtomicU32::new(1),
            flow_cfg,
        }
    }

    /// Spawns a session. `make_sink` receives the new session id so the sink can
    /// tag its output/exit notifications.
    pub fn spawn<S: OutputSink>(
        &self,
        opts: SpawnOptions,
        make_sink: impl FnOnce(SessionId) -> S,
    ) -> Result<SessionId> {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let session = Session::spawn(id, opts, self.flow_cfg, make_sink(id))?;
        self.sessions.write().insert(id, session);
        Ok(id)
    }

    fn get(&self, id: SessionId) -> Result<Arc<Session>> {
        self.sessions
            .read()
            .get(&id)
            .cloned()
            .ok_or(Error::NotFound(id))
    }

    pub fn write(&self, id: SessionId, data: &[u8]) -> Result<()> {
        self.get(id)?.write(data)
    }

    pub fn resize(&self, id: SessionId, cols: u16, rows: u16) -> Result<()> {
        self.get(id)?.resize(cols, rows)
    }

    pub fn info(&self, id: SessionId) -> Result<ProcessInfo> {
        Ok(self.get(id)?.info())
    }

    pub fn ack(&self, id: SessionId, bytes: usize) {
        if let Ok(s) = self.get(id) {
            s.ack(bytes);
        }
    }

    /// Kills the process (if alive) and forgets the session.
    pub fn remove(&self, id: SessionId) {
        if let Some(s) = self.sessions.write().remove(&id) {
            s.kill();
        }
    }

    pub fn len(&self) -> usize {
        self.sessions.read().len()
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    pub fn kill_all(&self) {
        for (_, s) in self.sessions.write().drain() {
            s.kill();
        }
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::sync::mpsc;
    use std::time::Duration;

    struct ChanSink(mpsc::Sender<Option<Vec<u8>>>);
    impl OutputSink for ChanSink {
        fn data(&mut self, bytes: Vec<u8>) -> bool {
            self.0.send(Some(bytes)).is_ok()
        }
        fn exit(&mut self, _code: Option<u32>) {
            let _ = self.0.send(None);
        }
    }

    #[test]
    fn spawns_process_and_streams_output() {
        let mgr = PtyManager::default();
        let (tx, rx) = mpsc::channel();
        let id = mgr
            .spawn(
                SpawnOptions {
                    program: Some("/bin/sh".into()),
                    args: vec!["-c".into(), "printf hello-termcode".into()],
                    cols: 80,
                    rows: 24,
                    ..Default::default()
                },
                |_| ChanSink(tx),
            )
            .unwrap();

        let mut out = Vec::new();
        while let Ok(Some(chunk)) = rx.recv_timeout(Duration::from_secs(5)) {
            mgr.ack(id, chunk.len());
            out.extend(chunk);
        }
        assert!(String::from_utf8_lossy(&out).contains("hello-termcode"));
        mgr.remove(id);
        assert!(mgr.is_empty());
    }

    #[test]
    fn input_reaches_the_child_and_info_reports_it() {
        let mgr = PtyManager::default();
        let (tx, rx) = mpsc::channel();
        let id = mgr
            .spawn(
                SpawnOptions {
                    program: Some("/bin/sh".into()),
                    args: vec!["-c".into(), "read line; printf 'got:%s' \"$line\"".into()],
                    cols: 80,
                    rows: 24,
                    ..Default::default()
                },
                |_| ChanSink(tx),
            )
            .unwrap();

        let info = mgr.info(id).unwrap();
        assert!(info.shell_pid.is_some());
        assert!(info.cwd.is_some(), "cwd of the child is known");

        mgr.write(id, b"termcode\n").unwrap();
        let mut out = Vec::new();
        while let Ok(Some(chunk)) = rx.recv_timeout(Duration::from_secs(5)) {
            mgr.ack(id, chunk.len());
            out.extend(chunk);
        }
        assert!(String::from_utf8_lossy(&out).contains("got:termcode"));
        mgr.remove(id);
    }

    #[test]
    fn command_runs_through_the_login_shell() {
        let mgr = PtyManager::default();
        let (tx, rx) = mpsc::channel();
        let id = mgr
            .spawn(
                SpawnOptions {
                    command: Some("printf agent-ok; exit".into()),
                    cols: 80,
                    rows: 24,
                    ..Default::default()
                },
                |_| ChanSink(tx),
            )
            .unwrap();
        let mut out = Vec::new();
        while let Ok(Some(chunk)) = rx.recv_timeout(Duration::from_secs(10)) {
            mgr.ack(id, chunk.len());
            out.extend(chunk);
            if String::from_utf8_lossy(&out).contains("agent-ok") {
                break;
            }
        }
        assert!(String::from_utf8_lossy(&out).contains("agent-ok"));
        mgr.remove(id);
    }

    #[test]
    fn large_output_is_bounded_by_backpressure() {
        let mgr = PtyManager::default();
        let (tx, rx) = mpsc::channel();
        let id = mgr
            .spawn(
                SpawnOptions {
                    program: Some("/bin/sh".into()),
                    // ~8 MB of output.
                    args: vec![
                        "-c".into(),
                        "head -c 8000000 /dev/zero | tr '\\0' 'x'".into(),
                    ],
                    cols: 120,
                    rows: 40,
                    ..Default::default()
                },
                |_| ChanSink(tx),
            )
            .unwrap();

        let mut total = 0usize;
        let mut max_chunk = 0usize;
        while let Ok(Some(chunk)) = rx.recv_timeout(Duration::from_secs(10)) {
            total += chunk.len();
            max_chunk = max_chunk.max(chunk.len());
            mgr.ack(id, chunk.len());
        }
        assert!(total >= 8_000_000, "got {total} bytes");
        // Batches never exceed max_batch, so the IPC payloads stay bounded.
        assert!(max_chunk <= FlowConfig::default().max_batch);
        mgr.remove(id);
    }
}
