//! A single PTY session: child process + reader/flusher threads.

use crate::flow::{Batch, Flow, FlowConfig};
use crate::procinfo::{self, ProcessInfo};
use crate::shell;
use crate::{Error, Result};
use parking_lot::Mutex;
use portable_pty::{ChildKiller, MasterPty, PtySize, native_pty_system};
use serde::Deserialize;
use std::io::{Read, Write};
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::mpsc::{self, SyncSender, TrySendError};
use std::thread;

/// Pending input chunks per session. Keystrokes are tiny; this only fills up
/// when the child stops reading stdin, and then dropping input is what a real
/// terminal does too (instead of growing memory without bound).
const INPUT_QUEUE: usize = 1024;

pub type SessionId = u32;

/// Receives the output of a session. Implemented by the Tauri layer.
pub trait OutputSink: Send + 'static {
    /// Deliver a batch of raw bytes. Return `false` if the receiver is gone.
    fn data(&mut self, bytes: Vec<u8>) -> bool;
    /// The child process exited.
    fn exit(&mut self, code: Option<u32>);
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpawnOptions {
    /// Program to run. `None` = the user's default shell.
    pub program: Option<String>,
    /// Command line run through the user's login shell (e.g. an AI agent).
    /// Ignored when `program` is set.
    #[serde(default)]
    pub command: Option<String>,
    #[serde(default)]
    pub args: Vec<String>,
    pub cwd: Option<PathBuf>,
    #[serde(default)]
    pub env: Vec<(String, String)>,
    pub cols: u16,
    pub rows: u16,
}

pub struct Session {
    id: SessionId,
    master: Mutex<Box<dyn MasterPty + Send>>,
    /// Input goes through a dedicated writer thread: a child that stops reading
    /// stdin can never block the caller (the async runtime / IPC handler).
    input: SyncSender<Vec<u8>>,
    killer: Mutex<Box<dyn ChildKiller + Send + Sync>>,
    child_pid: Option<u32>,
    flow: Arc<Flow>,
}

impl Session {
    pub(crate) fn spawn(
        id: SessionId,
        opts: SpawnOptions,
        flow_cfg: FlowConfig,
        sink: impl OutputSink,
    ) -> Result<Arc<Self>> {
        let size = PtySize {
            rows: opts.rows.max(1),
            cols: opts.cols.max(1),
            pixel_width: 0,
            pixel_height: 0,
        };
        let pair = native_pty_system().openpty(size).map_err(Error::pty)?;

        let cmd = shell::build_command(&opts);
        let mut child = pair.slave.spawn_command(cmd).map_err(Error::pty)?;
        // The slave end is only needed by the child.
        drop(pair.slave);

        let reader = pair.master.try_clone_reader().map_err(Error::pty)?;
        let writer = pair.master.take_writer().map_err(Error::pty)?;
        let killer = child.clone_killer();
        let child_pid = child.process_id();
        let flow = Arc::new(Flow::new(flow_cfg));

        // Writer thread: queue -> PTY. Ends when the session (sender) is dropped
        // or the PTY stops accepting input.
        let (input, input_rx) = mpsc::sync_channel::<Vec<u8>>(INPUT_QUEUE);
        thread::Builder::new()
            .name(format!("pty-{id}-write"))
            .spawn(move || write_loop(writer, input_rx))
            .map_err(Error::Io)?;

        let session = Arc::new(Self {
            id,
            master: Mutex::new(pair.master),
            input,
            killer: Mutex::new(killer),
            child_pid,
            flow: flow.clone(),
        });

        // Reader thread: PTY -> Flow. Blocking reads, one OS thread per session
        // (cheap: it sleeps in the kernel almost all the time).
        {
            let flow = flow.clone();
            thread::Builder::new()
                .name(format!("pty-{id}-read"))
                .spawn(move || read_loop(reader, &flow))
                .map_err(Error::Io)?;
        }

        // Waiter thread: blocks on the child's exit code.
        let waiter = {
            let flow = flow.clone();
            thread::Builder::new()
                .name(format!("pty-{id}-wait"))
                .spawn(move || {
                    let code = child.wait().ok().map(|s| s.exit_code());
                    // ConPTY never delivers EOF to the reader while the pseudo console
                    // is alive, so end the stream ourselves after a grace period that
                    // lets trailing output drain. On Unix the reader gets EOF/EIO.
                    #[cfg(windows)]
                    {
                        thread::sleep(std::time::Duration::from_millis(150));
                        flow.finish();
                    }
                    #[cfg(not(windows))]
                    let _ = &flow;
                    code
                })
                .map_err(Error::Io)?
        };

        // Flusher thread: Flow -> sink, then report the exit code.
        thread::Builder::new()
            .name(format!("pty-{id}-flush"))
            .spawn(move || {
                let mut sink = sink;
                while let Batch::Data(bytes) = flow.next_batch() {
                    if !sink.data(bytes) {
                        flow.close();
                        break;
                    }
                }
                let code = waiter.join().ok().flatten();
                sink.exit(code);
            })
            .map_err(Error::Io)?;

        Ok(session)
    }

    pub fn id(&self) -> SessionId {
        self.id
    }

    /// Queues input for the child. Never blocks.
    pub fn write(&self, data: &[u8]) -> Result<()> {
        if data.is_empty() {
            return Ok(());
        }
        self.input.try_send(data.to_vec()).map_err(|e| match e {
            TrySendError::Full(_) => {
                Error::Pty("input queue full: the process is not reading".into())
            }
            TrySendError::Disconnected(_) => Error::Pty("session input is closed".into()),
        })
    }

    /// What is running in the terminal right now and where.
    pub fn info(&self) -> ProcessInfo {
        #[cfg(unix)]
        let foreground = self.master.lock().process_group_leader();
        #[cfg(not(unix))]
        let foreground = None;
        procinfo::describe(self.child_pid, foreground)
    }

    pub fn resize(&self, cols: u16, rows: u16) -> Result<()> {
        self.master
            .lock()
            .resize(PtySize {
                rows: rows.max(1),
                cols: cols.max(1),
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(Error::pty)
    }

    pub fn ack(&self, bytes: usize) {
        self.flow.ack(bytes);
    }

    pub fn kill(&self) {
        self.flow.close();
        let _ = self.killer.lock().kill();
    }
}

impl Drop for Session {
    fn drop(&mut self) {
        self.kill();
    }
}

fn write_loop(mut writer: Box<dyn Write + Send>, input: mpsc::Receiver<Vec<u8>>) {
    for chunk in input {
        if let Err(e) = writer.write_all(&chunk).and_then(|()| writer.flush()) {
            log::debug!("pty writer stopped: {e}");
            break;
        }
    }
}

fn read_loop(mut reader: Box<dyn Read + Send>, flow: &Flow) {
    let mut buf = vec![0u8; 64 * 1024];
    loop {
        if !flow.wait_for_space() {
            break;
        }
        match reader.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => flow.push(&buf[..n]),
            Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
            // EIO on Linux/macOS when the child exits: normal end of stream.
            Err(_) => break,
        }
    }
    flow.finish();
}
