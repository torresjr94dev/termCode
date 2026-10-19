//! Codex usage, read from the session logs Codex writes locally
//! (`~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`, `token_count` events).
//!
//! * Signed in with ChatGPT: `rate_limits.primary/secondary` carry the 5 h and
//!   weekly windows.
//! * Signed in with an API key: there are no windows (billing is per token),
//!   so only token usage is reported.

use super::time::parse_rfc3339_ms;
use super::{AuthMode, Provider, Source, Status, Window};
use crate::agents::now_ms;
use serde_json::{Value, json};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{LazyLock, Mutex};
use std::time::{Duration, SystemTime};

const WINDOW_MS: i64 = 24 * 60 * 60 * 1000;

fn codex_home() -> Option<PathBuf> {
    if let Some(dir) = std::env::var_os("CODEX_HOME").filter(|d| !d.is_empty()) {
        return Some(PathBuf::from(dir));
    }
    Some(dirs::home_dir()?.join(".codex"))
}

fn auth_mode(home: &Path) -> Option<AuthMode> {
    let raw = std::fs::read_to_string(home.join("auth.json")).ok()?;
    let auth: Value = serde_json::from_str(&raw).ok()?;
    if auth.get("tokens").is_some_and(|t| t.is_object()) {
        Some(AuthMode::Subscription)
    } else if auth
        .get("OPENAI_API_KEY")
        .and_then(Value::as_str)
        .is_some_and(|k| !k.is_empty())
    {
        Some(AuthMode::ApiKey)
    } else {
        None
    }
}

/// Session files modified within `since`, newest first. Directories are not
/// pruned by mtime: a session started yesterday keeps writing into yesterday's
/// directory, whose own mtime does not change when a file inside is modified.
fn recent_sessions(home: &Path, since: SystemTime) -> Vec<(PathBuf, SystemTime)> {
    fn walk(dir: &Path, since: SystemTime, depth: u8, out: &mut Vec<(PathBuf, SystemTime)>) {
        let Ok(entries) = std::fs::read_dir(dir) else {
            return;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            let Ok(meta) = entry.metadata() else { continue };
            if meta.is_dir() {
                if depth < 3 {
                    walk(&path, since, depth + 1, out);
                }
                continue;
            }
            let Ok(modified) = meta.modified() else {
                continue;
            };
            if modified >= since
                && path
                    .file_name()
                    .and_then(|n| n.to_str())
                    .is_some_and(|n| n.starts_with("rollout-") && n.ends_with(".jsonl"))
            {
                out.push((path, modified));
            }
        }
    }
    let mut out = Vec::new();
    walk(&home.join("sessions"), since, 0, &mut out);
    out.sort_by_key(|entry| std::cmp::Reverse(entry.1));
    out
}

#[derive(Clone, Default)]
struct SessionSummary {
    /// (timestamp ms, cumulative non-cached tokens) of every token_count event.
    totals: Vec<(i64, u64)>,
    /// Last non-null rate limits and when they were observed.
    rate_limits: Option<(i64, Value)>,
}

/// Re-parses a file only when its mtime changes.
static CACHE: LazyLock<Mutex<HashMap<PathBuf, (SystemTime, SessionSummary)>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

fn summarize_file(path: &Path, modified: SystemTime) -> SessionSummary {
    if let Ok(cache) = CACHE.lock()
        && let Some((m, summary)) = cache.get(path)
        && *m == modified
    {
        return summary.clone();
    }
    let summary = std::fs::read_to_string(path)
        .map(|content| parse_session(&content))
        .unwrap_or_default();
    if let Ok(mut cache) = CACHE.lock() {
        cache.insert(path.to_owned(), (modified, summary.clone()));
    }
    summary
}

fn parse_session(content: &str) -> SessionSummary {
    let mut summary = SessionSummary::default();
    for line in content.lines().filter(|l| l.contains("\"token_count\"")) {
        let Ok(event) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        let Some(payload) = event
            .get("payload")
            .filter(|p| p.get("type").and_then(Value::as_str) == Some("token_count"))
        else {
            continue;
        };
        let Some(ts) = event
            .get("timestamp")
            .and_then(Value::as_str)
            .and_then(parse_rfc3339_ms)
        else {
            continue;
        };
        if let Some(total) = payload.get("info").and_then(|i| i.get("total_token_usage")) {
            let get = |k: &str| total.get(k).and_then(Value::as_u64).unwrap_or(0);
            let fresh_input = get("input_tokens").saturating_sub(get("cached_input_tokens"));
            summary
                .totals
                .push((ts, fresh_input + get("output_tokens")));
        }
        if let Some(limits) = payload
            .get("rate_limits")
            .filter(|l| l.get("primary").is_some_and(|p| p.is_object()))
        {
            summary.rate_limits = Some((ts, limits.clone()));
        }
    }
    summary
}

/// Tokens a session used after `cutoff` (its counters are cumulative).
fn tokens_since(totals: &[(i64, u64)], cutoff: i64) -> u64 {
    let Some(&(_, last)) = totals.last() else {
        return 0;
    };
    let before = totals
        .iter()
        .take_while(|(ts, _)| *ts < cutoff)
        .last()
        .map_or(0, |(_, t)| *t);
    last.saturating_sub(before)
}

fn window_from(limit: &Value, observed_at: i64, kind: &str) -> Option<Window> {
    let used = limit.get("used_percent").and_then(Value::as_f64)?;
    let minutes = limit.get("window_minutes").and_then(Value::as_u64);
    let resets_at = limit
        .get("resets_at")
        .filter(|v| !v.is_null())
        .cloned()
        .or_else(|| {
            let secs = limit.get("resets_in_seconds").and_then(Value::as_i64)?;
            Some(json!(observed_at + secs * 1000))
        });
    let label = match (kind, minutes) {
        ("session", Some(300) | None) => "Sesión · 5 h".to_owned(),
        ("weekly_all", Some(10080) | None) => "Semana".to_owned(),
        (_, Some(m)) if m % 1440 == 0 => format!("Ventana · {} d", m / 1440),
        (_, Some(m)) => format!("Ventana · {} h", m.div_ceil(60)),
        (_, None) => "Ventana".to_owned(),
    };
    Some(Window {
        kind: kind.to_owned(),
        label,
        used_percent: used,
        resets_at,
        severity: None,
    })
}

pub fn read() -> Provider {
    let mut provider = Provider {
        status: Status::Unavailable,
        plan: None,
        auth_mode: None,
        source: None,
        fetched_at: None,
        windows: Vec::new(),
        tokens_24h: None,
        message: None,
    };

    let Some(home) = codex_home().filter(|h| h.is_dir()) else {
        provider.message = Some("Codex no está configurado en esta máquina.".into());
        return provider;
    };
    provider.auth_mode = auth_mode(&home);

    let since = SystemTime::now() - Duration::from_millis(WINDOW_MS as u64);
    let cutoff = now_ms() as i64 - WINDOW_MS;
    let sessions = recent_sessions(&home, since);
    let summaries: Vec<SessionSummary> = sessions
        .iter()
        .map(|(p, m)| summarize_file(p, *m))
        .collect();
    provider.tokens_24h = Some(
        summaries
            .iter()
            .map(|s| tokens_since(&s.totals, cutoff))
            .sum(),
    );

    match provider.auth_mode {
        Some(AuthMode::ApiKey) => {
            provider.status = Status::Ok;
            provider.plan = Some("API key".into());
            provider.source = Some(Source::SessionLog);
            provider.message =
                Some("Con API key pagas por token: no hay ventanas de 5 h ni semanales.".into());
        }
        Some(AuthMode::Subscription) => {
            // Newest observation across recent sessions.
            let latest = summaries
                .iter()
                .filter_map(|s| s.rate_limits.as_ref())
                .max_by_key(|(ts, _)| *ts);
            if let Some((ts, limits)) = latest {
                provider.windows = [("primary", "session"), ("secondary", "weekly_all")]
                    .into_iter()
                    .filter_map(|(field, kind)| window_from(limits.get(field)?, *ts, kind))
                    .collect();
                provider.plan = limits
                    .get("plan_type")
                    .and_then(Value::as_str)
                    .map(|p| format!("ChatGPT {p}"));
                provider.fetched_at = u64::try_from(*ts).ok();
                provider.source = Some(Source::SessionLog);
                provider.status = Status::Ok;
            } else {
                provider.message =
                    Some("Sin lecturas recientes: los límites aparecen tras usar Codex.".into());
            }
        }
        None => {
            provider.message = Some("Codex no tiene sesión iniciada (`codex login`).".into());
        }
    }
    provider
}

#[cfg(test)]
mod tests {
    use super::*;

    fn event(ts: &str, input: u64, cached: u64, output: u64, limits: Value) -> String {
        json!({
            "timestamp": ts,
            "type": "event_msg",
            "payload": {
                "type": "token_count",
                "info": { "total_token_usage": {
                    "input_tokens": input, "cached_input_tokens": cached, "output_tokens": output,
                    "reasoning_output_tokens": 0, "total_tokens": input + output
                }},
                "rate_limits": limits
            }
        })
        .to_string()
    }

    #[test]
    fn parses_session_totals_and_limits() {
        let limits = json!({
            "primary": { "used_percent": 41.0, "window_minutes": 300, "resets_in_seconds": 600 },
            "secondary": { "used_percent": 68.0, "window_minutes": 10080, "resets_at": 1792435200 },
            "credits": null, "plan_type": "plus"
        });
        let content = [
            event(
                "2026-01-23T10:00:00Z",
                100,
                40,
                10,
                json!({ "primary": null, "secondary": null }),
            ),
            event("2026-01-23T12:00:00Z", 300, 100, 50, limits),
        ]
        .join("\n");
        let s = parse_session(&content);
        assert_eq!(
            s.totals.iter().map(|t| t.1).collect::<Vec<_>>(),
            vec![70, 250]
        );

        let (ts, l) = s.rate_limits.expect("limits");
        let w = window_from(&l["primary"], ts, "session").unwrap();
        assert_eq!((w.label.as_str(), w.used_percent), ("Sesión · 5 h", 41.0));
        assert_eq!(w.resets_at, Some(json!(ts + 600_000)));
        let w2 = window_from(&l["secondary"], ts, "weekly_all").unwrap();
        assert_eq!(w2.resets_at, Some(json!(1792435200)));
    }

    #[test]
    fn counts_only_tokens_after_cutoff() {
        let totals = [(10, 100), (20, 150), (30, 400)];
        assert_eq!(tokens_since(&totals, 25), 250);
        assert_eq!(tokens_since(&totals, 0), 400);
        assert_eq!(tokens_since(&[], 0), 0);
    }
}
