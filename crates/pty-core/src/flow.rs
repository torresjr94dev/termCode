//! Output flow control: coalescing + backpressure.
//!
//! The PTY reader thread pushes raw bytes into [`Flow`]. A flusher thread pulls
//! batches out and hands them to the frontend. Two goals:
//!
//! * **Low latency when idle**: if nothing was flushed recently, data goes out
//!   immediately (keystroke echo is never delayed).
//! * **Few IPC crossings under load**: while output is streaming, bytes are
//!   batched until `flush_interval` elapses or `max_batch` bytes accumulate.
//!
//! Backpressure: every flushed byte counts as *unacked* until the frontend
//! confirms it was parsed by the terminal emulator. When `unacked + pending`
//! reaches `high_watermark` the reader blocks (and therefore stops reading the
//! PTY, which in turn makes the child process block on write). Reading resumes
//! once the total drops below `low_watermark`. Memory stays bounded no matter
//! how much output a process produces.

use parking_lot::{Condvar, Mutex};
use std::time::{Duration, Instant};

#[derive(Debug, Clone, Copy)]
pub struct FlowConfig {
    pub flush_interval: Duration,
    pub max_batch: usize,
    pub high_watermark: usize,
    pub low_watermark: usize,
}

impl Default for FlowConfig {
    fn default() -> Self {
        Self {
            flush_interval: Duration::from_millis(4),
            max_batch: 128 * 1024,
            high_watermark: 512 * 1024,
            low_watermark: 128 * 1024,
        }
    }
}

#[derive(Default)]
struct State {
    pending: Vec<u8>,
    unacked: usize,
    last_flush: Option<Instant>,
    /// Reader finished (EOF or error). Remaining pending data is still flushed.
    eof: bool,
    /// Session closed: everybody stops as soon as possible.
    closed: bool,
    /// Reader is currently blocked by backpressure.
    throttled: bool,
}

pub struct Flow {
    cfg: FlowConfig,
    state: Mutex<State>,
    /// Signalled when new data arrives or the stream ends.
    data_cv: Condvar,
    /// Signalled when space frees up (acks) or the session closes.
    space_cv: Condvar,
}

/// Result of [`Flow::next_batch`].
#[derive(Debug, PartialEq, Eq)]
pub enum Batch {
    Data(Vec<u8>),
    End,
}

impl Flow {
    pub fn new(cfg: FlowConfig) -> Self {
        assert!(cfg.low_watermark < cfg.high_watermark);
        Self {
            cfg,
            state: Mutex::new(State::default()),
            data_cv: Condvar::new(),
            space_cv: Condvar::new(),
        }
    }

    /// Blocks the reader while the buffer is over the high watermark.
    /// Returns `false` if the session was closed.
    pub fn wait_for_space(&self) -> bool {
        let mut s = self.state.lock();
        if s.unacked + s.pending.len() >= self.cfg.high_watermark {
            s.throttled = true;
        }
        while s.throttled && !s.closed {
            self.space_cv.wait(&mut s);
        }
        !s.closed
    }

    /// Called by the reader with freshly read bytes.
    pub fn push(&self, bytes: &[u8]) {
        if bytes.is_empty() {
            return;
        }
        let mut s = self.state.lock();
        if s.closed {
            return;
        }
        s.pending.extend_from_slice(bytes);
        self.data_cv.notify_one();
    }

    /// Reader reached EOF.
    pub fn finish(&self) {
        let mut s = self.state.lock();
        s.eof = true;
        self.data_cv.notify_all();
    }

    /// Stop everything (kill / window closed).
    pub fn close(&self) {
        let mut s = self.state.lock();
        s.closed = true;
        s.pending = Vec::new();
        self.data_cv.notify_all();
        self.space_cv.notify_all();
    }

    /// Frontend confirmed `n` bytes were processed.
    pub fn ack(&self, n: usize) {
        let mut s = self.state.lock();
        s.unacked = s.unacked.saturating_sub(n);
        if s.throttled && s.unacked + s.pending.len() <= self.cfg.low_watermark {
            s.throttled = false;
            self.space_cv.notify_all();
        }
    }

    pub fn unacked(&self) -> usize {
        self.state.lock().unacked
    }

    /// Blocks until a batch is ready according to the coalescing policy.
    pub fn next_batch(&self) -> Batch {
        let mut s = self.state.lock();
        loop {
            if s.closed {
                return Batch::End;
            }
            if !s.pending.is_empty() {
                let now = Instant::now();
                let deadline = s.last_flush.map(|t| t + self.cfg.flush_interval);
                let due = match deadline {
                    None => true,
                    Some(d) => now >= d,
                };
                if due || s.eof || s.pending.len() >= self.cfg.max_batch {
                    let batch = if s.pending.len() > self.cfg.max_batch {
                        let rest = s.pending.split_off(self.cfg.max_batch);
                        std::mem::replace(&mut s.pending, rest)
                    } else {
                        std::mem::take(&mut s.pending)
                    };
                    s.unacked += batch.len();
                    s.last_flush = Some(now);
                    return Batch::Data(batch);
                }
                // Not due yet: wait for the deadline or for more data.
                let wait = deadline.map(|d| d - now).unwrap_or_default();
                self.data_cv.wait_for(&mut s, wait);
                continue;
            }
            if s.eof {
                return Batch::End;
            }
            // Idle: reset the coalescing window so the next byte goes out immediately.
            if let Some(t) = s.last_flush
                && t.elapsed() >= self.cfg.flush_interval
            {
                s.last_flush = None;
            }
            self.data_cv.wait(&mut s);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;
    use std::thread;

    fn cfg() -> FlowConfig {
        FlowConfig {
            flush_interval: Duration::from_millis(20),
            max_batch: 8,
            high_watermark: 32,
            low_watermark: 8,
        }
    }

    #[test]
    fn first_push_flushes_immediately() {
        let f = Flow::new(cfg());
        f.push(b"a");
        let start = Instant::now();
        assert_eq!(f.next_batch(), Batch::Data(b"a".to_vec()));
        assert!(start.elapsed() < Duration::from_millis(10));
    }

    #[test]
    fn coalesces_while_streaming() {
        let f = Flow::new(cfg());
        f.push(b"a");
        assert_eq!(f.next_batch(), Batch::Data(b"a".to_vec()));
        // Inside the flush window: these get merged into one batch.
        f.push(b"b");
        f.push(b"c");
        assert_eq!(f.next_batch(), Batch::Data(b"bc".to_vec()));
    }

    #[test]
    fn max_batch_splits_and_flushes_early() {
        let f = Flow::new(cfg());
        f.push(b"0123456789AB");
        assert_eq!(f.next_batch(), Batch::Data(b"01234567".to_vec()));
        // Remaining 4 bytes wait for the window, then flush.
        assert_eq!(f.next_batch(), Batch::Data(b"89AB".to_vec()));
    }

    #[test]
    fn eof_flushes_remaining_then_ends() {
        let f = Flow::new(cfg());
        f.push(b"x");
        let _ = f.next_batch();
        f.push(b"yz");
        f.finish();
        assert_eq!(f.next_batch(), Batch::Data(b"yz".to_vec()));
        assert_eq!(f.next_batch(), Batch::End);
    }

    #[test]
    fn unacked_is_tracked_and_acked() {
        let f = Flow::new(cfg());
        f.push(b"hello");
        let _ = f.next_batch();
        assert_eq!(f.unacked(), 5);
        f.ack(3);
        assert_eq!(f.unacked(), 2);
        f.ack(100);
        assert_eq!(f.unacked(), 0);
    }

    #[test]
    fn backpressure_blocks_reader_until_acked() {
        let f = Arc::new(Flow::new(cfg()));
        // Fill up to the high watermark.
        f.push(&[0u8; 32]);
        let reader = {
            let f = f.clone();
            thread::spawn(move || f.wait_for_space())
        };
        thread::sleep(Duration::from_millis(30));
        assert!(!reader.is_finished(), "reader should be throttled");

        // Drain everything to the "frontend", then ack.
        let mut total = 0;
        while total < 32 {
            if let Batch::Data(b) = f.next_batch() {
                total += b.len();
            }
        }
        f.ack(32);
        assert!(reader.join().unwrap(), "reader resumes after ack");
    }

    #[test]
    fn close_unblocks_everyone() {
        let f = Arc::new(Flow::new(cfg()));
        f.push(&[0u8; 32]);
        let reader = {
            let f = f.clone();
            thread::spawn(move || f.wait_for_space())
        };
        // A flusher waiting on an idle stream.
        let idle = Arc::new(Flow::new(cfg()));
        let flusher = {
            let idle = idle.clone();
            thread::spawn(move || idle.next_batch())
        };
        thread::sleep(Duration::from_millis(20));
        f.close();
        idle.close();
        assert!(!reader.join().unwrap(), "throttled reader is released");
        assert_eq!(flusher.join().unwrap(), Batch::End, "idle flusher is released");
    }
}
