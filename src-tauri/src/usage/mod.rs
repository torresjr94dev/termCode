//! Real AI quota data for the UI.
//!
//! Sources, by preference:
//! * Claude: the `rate_limits` Claude Code hands to our statusLine (supported,
//!   passive) and, when no session is reporting, the OAuth usage endpoint with
//!   the token Claude Code keeps in the Keychain (undocumented, polled gently).
//! * Codex: the `token_count` events Codex writes to its session logs.
//!
//! Tokens never leave this module: the webview only receives percentages.

pub mod claude;
mod claude_tokens;
pub mod codex;
pub mod time;

use crate::agents::now_ms;
use parking_lot::Mutex;
use serde::Serialize;
use serde_json::Value;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::sync::Notify;

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Window {
    /// Stable key used to merge sources (`session`, `weekly_all`, `weekly_scoped:Fable`…).
    pub kind: String,
    pub label: String,
    pub used_percent: f64,
    /// ISO-8601 string or epoch (s/ms) number, exactly as the source gave it.
    pub resets_at: Option<Value>,
    pub severity: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum Status {
    Loading,
    Ok,
    Unavailable,
    Expired,
    Error,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum Source {
    Statusline,
    Oauth,
    SessionLog,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum AuthMode {
    Subscription,
    ApiKey,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Provider {
    pub status: Status,
    pub plan: Option<String>,
    pub auth_mode: Option<AuthMode>,
    pub source: Option<Source>,
    /// Epoch ms of the reading shown.
    pub fetched_at: Option<u64>,
    pub windows: Vec<Window>,
    /// Tokens (input + output, no cache) in the last 24 h.
    pub tokens_24h: Option<u64>,
    pub message: Option<String>,
}

impl Provider {
    fn loading() -> Self {
        Self {
            status: Status::Loading,
            plan: None,
            auth_mode: None,
            source: None,
            fetched_at: None,
            windows: Vec::new(),
            tokens_24h: None,
            message: None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Snapshot {
    pub claude: Provider,
    pub codex: Provider,
}

/// Merge `incoming` into `current` by `kind`, keeping a stable order.
fn merge_windows(current: &mut Vec<Window>, incoming: Vec<Window>) {
    for window in incoming {
        match current.iter_mut().find(|w| w.kind == window.kind) {
            Some(slot) => *slot = window,
            None => current.push(window),
        }
    }
    current.sort_by_key(|w| match w.kind.as_str() {
        "session" => 0,
        "weekly_all" => 1,
        _ => 2,
    });
}

pub struct UsageHub {
    snapshot: Mutex<Snapshot>,
    /// Epoch ms of the last statusline reading for Claude.
    last_statusline: Mutex<Option<u64>>,
    refresh: Notify,
}

impl Default for UsageHub {
    fn default() -> Self {
        Self {
            snapshot: Mutex::new(Snapshot {
                claude: Provider::loading(),
                codex: Provider::loading(),
            }),
            last_statusline: Mutex::new(None),
            refresh: Notify::new(),
        }
    }
}

impl UsageHub {
    fn update(&self, app: &AppHandle, f: impl FnOnce(&mut Snapshot)) {
        let next = {
            let mut snap = self.snapshot.lock();
            let before = snap.clone();
            f(&mut snap);
            if *snap == before {
                return;
            }
            snap.clone()
        };
        let _ = app.emit("usage-updated", next);
    }

    pub fn record_claude_statusline(&self, app: &AppHandle, windows: Vec<Window>, at: u64) {
        *self.last_statusline.lock() = Some(at);
        self.update(app, |s| {
            merge_windows(&mut s.claude.windows, windows);
            s.claude.status = Status::Ok;
            s.claude.source = Some(Source::Statusline);
            s.claude.fetched_at = Some(at);
            s.claude.message = None;
        });
    }

    fn statusline_is_fresh(&self) -> bool {
        self.last_statusline
            .lock()
            .is_some_and(|at| now_ms().saturating_sub(at) < 3 * 60 * 1000)
    }
}

#[tauri::command]
pub fn usage_get(hub: State<'_, UsageHub>) -> Snapshot {
    hub.snapshot.lock().clone()
}

#[tauri::command]
pub fn usage_refresh(hub: State<'_, UsageHub>) {
    hub.refresh.notify_waiters();
}

pub fn spawn(app: AppHandle) {
    spawn_claude_quota(app.clone());
    spawn_claude_tokens(app.clone());
    spawn_codex(app);
}

/// OAuth polling: every 5 min while no Claude session is reporting through the
/// statusline, exponential backoff on errors, immediate on manual refresh.
fn spawn_claude_quota(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        let client = match reqwest::Client::builder()
            .timeout(Duration::from_secs(10))
            .user_agent(concat!("termCode/", env!("CARGO_PKG_VERSION")))
            .build()
        {
            Ok(c) => c,
            Err(e) => {
                log::error!("usage: cannot build HTTP client: {e}");
                return;
            }
        };
        let hub = app.state::<UsageHub>();
        let mut wait = Duration::ZERO;
        let mut failures: u32 = 0;
        loop {
            let forced = tokio::select! {
                _ = tokio::time::sleep(wait) => false,
                _ = hub.refresh.notified() => true,
            };
            if !forced && hub.statusline_is_fresh() {
                wait = Duration::from_secs(60);
                continue;
            }

            match claude::fetch(&client).await {
                Ok(reading) => {
                    log::info!(
                        "usage: claude quota read via oauth ({} windows)",
                        reading.windows.len()
                    );
                    failures = 0;
                    wait = Duration::from_secs(5 * 60);
                    let at = now_ms();
                    hub.update(&app, |s| {
                        // A fresher statusline reading wins for the windows it carries.
                        if !hub.statusline_is_fresh() || s.claude.windows.is_empty() {
                            merge_windows(&mut s.claude.windows, reading.windows);
                            s.claude.source = Some(Source::Oauth);
                            s.claude.fetched_at = Some(at);
                        } else {
                            let extra = reading
                                .windows
                                .into_iter()
                                .filter(|w| w.kind.starts_with("weekly_scoped"))
                                .collect();
                            merge_windows(&mut s.claude.windows, extra);
                        }
                        s.claude.plan = reading.plan.or(s.claude.plan.take());
                        s.claude.auth_mode = Some(AuthMode::Subscription);
                        s.claude.status = Status::Ok;
                        s.claude.message = None;
                    });
                }
                Err(err) => {
                    failures = failures.saturating_add(1);
                    let backoff = 60u64.saturating_mul(1 << failures.min(5)).min(30 * 60);
                    wait = Duration::from_secs(backoff);
                    log::warn!("usage: claude quota unavailable: {err}");
                    hub.update(&app, |s| {
                        if hub.statusline_is_fresh() {
                            return;
                        }
                        let (status, message) = err.describe();
                        // Keep the last good numbers visible, flagged by status/message.
                        s.claude.status = status;
                        s.claude.message = Some(message);
                    });
                }
            }
        }
    });
}

fn spawn_claude_tokens(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        let hub = app.state::<UsageHub>();
        let mut counter = claude_tokens::Counter::default();
        let mut tick = tokio::time::interval(Duration::from_secs(60));
        loop {
            tick.tick().await;
            let (next, total) = tauri::async_runtime::spawn_blocking(move || {
                let total = counter.refresh();
                (counter, total)
            })
            .await
            .unwrap_or_else(|_| (claude_tokens::Counter::default(), None));
            counter = next;
            hub.update(&app, |s| s.claude.tokens_24h = total);
        }
    });
}

fn spawn_codex(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        let hub = app.state::<UsageHub>();
        let mut wait = Duration::ZERO;
        loop {
            tokio::select! {
                _ = tokio::time::sleep(wait) => {},
                _ = hub.refresh.notified() => {},
            }
            wait = Duration::from_secs(15);
            if let Ok(reading) = tauri::async_runtime::spawn_blocking(codex::read).await {
                hub.update(&app, |s| s.codex = reading);
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn w(kind: &str, pct: f64) -> Window {
        Window {
            kind: kind.into(),
            label: kind.into(),
            used_percent: pct,
            resets_at: None,
            severity: None,
        }
    }

    #[test]
    fn merges_by_kind_and_orders_session_first() {
        let mut current = vec![w("weekly_scoped:Fable", 0.0), w("weekly_all", 4.0)];
        merge_windows(&mut current, vec![w("session", 22.0), w("weekly_all", 5.0)]);
        let kinds: Vec<_> = current
            .iter()
            .map(|w| (w.kind.as_str(), w.used_percent))
            .collect();
        assert_eq!(
            kinds,
            vec![
                ("session", 22.0),
                ("weekly_all", 5.0),
                ("weekly_scoped:Fable", 0.0)
            ]
        );
    }
}
