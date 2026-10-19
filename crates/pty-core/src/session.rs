//! A single PTY session: child process + reader/flusher threads.

use crate::flow::{Batch, Flow, FlowConfig};
use crate::shell;
use crate::{Error, Result};
use parking_lot::Mutex;
use portable_pty::{ChildKiller, MasterPty, PtySize, native_pty_system};
use serde::Deserialize;
use std::io::{Read, Write};
use std::path::PathBuf;
use std::sync::Arc;
use std::thread;

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
    writer: Mutex<Box<dyn Write + Send>>,
    killer: Mutex<Box<dyn ChildKiller + Send + Sync>>,
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
        let flow = Arc::new(Flow::new(flow_cfg));

        let session = Arc::new(Self {
            id,
            master: Mutex::new(pair.master),
            writer: Mutex::new(writer),
            killer: Mutex::new(killer),
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
                loop {
                    match flow.next_batch() {
                        Batch::Data(bytes) => {
                            if !sink.data(bytes) {
                                flow.close();
                                break;
                            }
                        }
                        Batch::End => break,
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

    pub fn write(&self, data: &[u8]) -> Result<()> {
        let mut w = self.writer.lock();
        w.write_all(data)?;
        w.flush()?;
        Ok(())
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
