//! Tokens Claude Code used in the last 24 h, read from its local transcripts
//! (`~/.claude/projects/**/*.jsonl`). No network, no tokens.
//!
//! Transcripts get big (tens of MB per day), so each file is read
//! incrementally from the last offset, and only lines that mention `"usage"`
//! are parsed. Claude Code repeats the same usage on every content block of a
//! message, so entries are deduplicated by message id.

use super::time::parse_rfc3339_ms;
use crate::agents::now_ms;
use serde_json::Value;
use std::collections::HashMap;
use std::fs::File;
use std::io::{BufRead, BufReader, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

const WINDOW_MS: u64 = 24 * 60 * 60 * 1000;

#[derive(Default)]
struct FileState {
    offset: u64,
}

#[derive(Default)]
pub struct Counter {
    files: HashMap<PathBuf, FileState>,
    /// message id → (timestamp ms, tokens)
    entries: HashMap<String, (u64, u64)>,
}

impl Counter {
    /// Returns `None` when Claude Code has no transcripts on this machine.
    pub fn refresh(&mut self) -> Option<u64> {
        let root = dirs::home_dir()?.join(".claude").join("projects");
        if !root.is_dir() {
            return None;
        }
        let since = SystemTime::now() - Duration::from_millis(WINDOW_MS);
        let mut live = Vec::new();
        collect_recent(&root, since, 0, &mut live);

        self.files.retain(|path, _| live.contains(path));
        for path in live {
            let state = self.files.entry(path.clone()).or_default();
            ingest(&path, state, &mut self.entries);
        }

        let cutoff = now_ms().saturating_sub(WINDOW_MS);
        self.entries.retain(|_, (ts, _)| *ts >= cutoff);
        Some(self.entries.values().map(|(_, tokens)| tokens).sum())
    }
}

fn collect_recent(dir: &Path, since: SystemTime, depth: u8, out: &mut Vec<PathBuf>) {
    if depth > 4 {
        return;
    }
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let Ok(meta) = entry.metadata() else { continue };
        if meta.is_dir() {
            collect_recent(&path, since, depth + 1, out);
        } else if path.extension().is_some_and(|e| e == "jsonl")
            && meta.modified().is_ok_and(|m| m >= since)
        {
            out.push(path);
        }
    }
}

fn ingest(path: &Path, state: &mut FileState, entries: &mut HashMap<String, (u64, u64)>) {
    let Ok(mut file) = File::open(path) else {
        return;
    };
    let len = file.metadata().map(|m| m.len()).unwrap_or(0);
    if len < state.offset {
        state.offset = 0; // truncated / rewritten
    }
    if len == state.offset || file.seek(SeekFrom::Start(state.offset)).is_err() {
        return;
    }

    let mut reader = BufReader::new(file);
    let mut line = String::new();
    loop {
        line.clear();
        match reader.read_line(&mut line) {
            Ok(0) | Err(_) => break,
            Ok(n) => {
                // A partial last line is re-read on the next pass.
                if !line.ends_with('\n') {
                    break;
                }
                state.offset += n as u64;
                if line.contains("\"usage\"")
                    && let Some((id, entry)) = parse_line(&line)
                {
                    entries.insert(id, entry);
                }
            }
        }
    }
}

fn parse_line(line: &str) -> Option<(String, (u64, u64))> {
    let v: Value = serde_json::from_str(line).ok()?;
    if v.get("type")?.as_str()? != "assistant" {
        return None;
    }
    let message = v.get("message")?;
    let usage = message.get("usage")?;
    let id = message.get("id")?.as_str()?.to_owned();
    let ts = parse_rfc3339_ms(v.get("timestamp")?.as_str()?)?;
    let tokens = ["input_tokens", "output_tokens"]
        .iter()
        .filter_map(|k| usage.get(*k).and_then(Value::as_u64))
        .sum();
    Some((id, (u64::try_from(ts).ok()?, tokens)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn line(id: &str, ts: &str, input: u64, output: u64) -> String {
        format!(
            r#"{{"type":"assistant","timestamp":"{ts}","message":{{"id":"{id}","usage":{{"input_tokens":{input},"output_tokens":{output},"cache_read_input_tokens":999999}}}}}}"#
        ) + "\n"
    }

    #[test]
    fn reads_incrementally_and_deduplicates() {
        let dir = std::env::temp_dir().join(format!("termcode-tokens-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("s.jsonl");
        let recent = "2099-01-01T00:00:00Z"; // never older than the 24 h window
        let mut f = File::create(&path).unwrap();
        f.write_all(line("msg_1", recent, 10, 5).as_bytes())
            .unwrap();
        f.write_all(line("msg_1", recent, 10, 5).as_bytes())
            .unwrap(); // repeated block
        f.write_all(b"{\"type\":\"user\",\"message\":{}}\n")
            .unwrap();

        let mut state = FileState::default();
        let mut entries = HashMap::new();
        ingest(&path, &mut state, &mut entries);
        assert_eq!(entries.values().map(|e| e.1).sum::<u64>(), 15);

        // Partial line: not consumed until it is complete.
        f.write_all(line("msg_2", recent, 1, 1).trim_end().as_bytes())
            .unwrap();
        ingest(&path, &mut state, &mut entries);
        assert_eq!(entries.len(), 1);
        f.write_all(b"\n").unwrap();
        ingest(&path, &mut state, &mut entries);
        assert_eq!(entries.values().map(|e| e.1).sum::<u64>(), 17);

        std::fs::remove_dir_all(dir).unwrap();
    }
}
