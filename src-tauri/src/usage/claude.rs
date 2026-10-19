//! Claude subscription quota.
//!
//! The OAuth usage endpoint is undocumented: it already changed shape once
//! (a structured `limits` array next to the flat `five_hour`/`seven_day`
//! objects), so parsing accepts both and ignores anything unknown.
//!
//! The access token is read from where Claude Code keeps it and used for a
//! single request. It is never logged, cached on disk or sent to the webview,
//! and it is NEVER refreshed here: rotating the refresh token would silently
//! log Claude Code out.

use super::{Status, Window};
use crate::agents::now_ms;
use serde_json::Value;
use std::fmt;

const USAGE_URL: &str = "https://api.anthropic.com/api/oauth/usage";
const OAUTH_BETA: &str = "oauth-2025-04-20";
#[cfg(target_os = "macos")]
const KEYCHAIN_SERVICE: &str = "Claude Code-credentials";

#[derive(Debug)]
pub enum FetchError {
    NotLoggedIn,
    Expired,
    Http(u16),
    Network(String),
    Parse,
}

impl fmt::Display for FetchError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::NotLoggedIn => write!(f, "no Claude Code credentials"),
            Self::Expired => write!(f, "access token expired"),
            Self::Http(code) => write!(f, "HTTP {code}"),
            Self::Network(e) => write!(f, "network: {e}"),
            Self::Parse => write!(f, "unexpected response"),
        }
    }
}

impl FetchError {
    /// Status + user-facing message (Spanish, shown in the popover).
    pub fn describe(&self) -> (Status, String) {
        match self {
            Self::NotLoggedIn => (
                Status::Unavailable,
                "Claude Code no tiene sesión iniciada.".into(),
            ),
            Self::Expired => (
                Status::Expired,
                "La sesión de Claude Code expiró: ábrelo para renovarla.".into(),
            ),
            Self::Http(429) => (
                Status::Error,
                "Anthropic limitó las consultas; reintento más tarde.".into(),
            ),
            Self::Http(code) => (Status::Error, format!("Anthropic respondió HTTP {code}.")),
            Self::Network(_) => (Status::Error, "Sin conexión con Anthropic.".into()),
            Self::Parse => (Status::Error, "Respuesta inesperada de Anthropic.".into()),
        }
    }
}

pub struct Reading {
    pub windows: Vec<Window>,
    pub plan: Option<String>,
}

struct Credentials {
    access_token: String,
    expires_at_ms: Option<u64>,
    plan: Option<String>,
}

fn parse_credentials(raw: &str) -> Option<Credentials> {
    let value: Value = serde_json::from_str(raw).ok()?;
    let oauth = value.get("claudeAiOauth")?;
    let access_token = oauth.get("accessToken")?.as_str()?.to_owned();
    let plan = plan_label(
        oauth.get("subscriptionType").and_then(Value::as_str),
        oauth.get("rateLimitTier").and_then(Value::as_str),
    );
    Some(Credentials {
        access_token,
        expires_at_ms: oauth.get("expiresAt").and_then(Value::as_u64),
        plan,
    })
}

/// `team` + `default_claude_max_5x` → `Team · Max 5×`.
fn plan_label(subscription: Option<&str>, tier: Option<&str>) -> Option<String> {
    let mut label = subscription.filter(|s| !s.is_empty()).map(|s| {
        let mut chars = s.chars();
        chars
            .next()
            .map(|c| c.to_uppercase().chain(chars).collect::<String>())
            .unwrap_or_default()
    })?;
    if let Some(mult) = tier
        .and_then(|t| t.rsplit_once("max_"))
        .map(|(_, m)| m.trim_end_matches('x'))
        .filter(|m| !m.is_empty() && m.bytes().all(|b| b.is_ascii_digit()))
    {
        label.push_str(&format!(" · Max {mult}×"));
    }
    Some(label)
}

#[cfg(target_os = "macos")]
fn read_credentials_raw() -> Option<String> {
    // `/usr/bin/security` is the trusted reader on the Keychain item Claude Code
    // creates, so this does not trigger a permission prompt for termCode.
    let out = std::process::Command::new("/usr/bin/security")
        .args(["find-generic-password", "-s", KEYCHAIN_SERVICE, "-w"])
        .stdin(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .output()
        .ok()?;
    out.status
        .success()
        .then(|| String::from_utf8_lossy(&out.stdout).into_owned())
}

#[cfg(not(target_os = "macos"))]
fn read_credentials_raw() -> Option<String> {
    let path = dirs::home_dir()?.join(".claude").join(".credentials.json");
    std::fs::read_to_string(path).ok()
}

pub async fn fetch(client: &reqwest::Client) -> Result<Reading, FetchError> {
    let raw = tauri::async_runtime::spawn_blocking(read_credentials_raw)
        .await
        .ok()
        .flatten()
        .ok_or(FetchError::NotLoggedIn)?;
    let creds = parse_credentials(&raw).ok_or(FetchError::NotLoggedIn)?;
    if creds
        .expires_at_ms
        .is_some_and(|exp| exp <= now_ms() + 30_000)
    {
        return Err(FetchError::Expired);
    }

    let response = client
        .get(USAGE_URL)
        .bearer_auth(&creds.access_token)
        .header("anthropic-beta", OAUTH_BETA)
        .header("Accept", "application/json")
        .send()
        .await
        .map_err(|e| FetchError::Network(e.without_url().to_string()))?;

    match response.status().as_u16() {
        200 => {}
        401 | 403 => return Err(FetchError::Expired),
        code => return Err(FetchError::Http(code)),
    }
    let body: Value = response.json().await.map_err(|_| FetchError::Parse)?;
    let windows = parse_usage(&body);
    if windows.is_empty() {
        return Err(FetchError::Parse);
    }
    Ok(Reading {
        windows,
        plan: creds.plan,
    })
}

fn label_for(kind: &str, model: Option<&str>) -> String {
    match (kind, model) {
        ("session", _) => "Sesión · 5 h".into(),
        ("weekly_all", _) => "Semana".into(),
        (_, Some(model)) => format!("Semana · {model}"),
        (other, None) => other.replace('_', " "),
    }
}

/// Prefers the structured `limits` array; falls back to the flat objects.
pub fn parse_usage(body: &Value) -> Vec<Window> {
    if let Some(limits) = body.get("limits").and_then(Value::as_array) {
        let windows: Vec<Window> = limits
            .iter()
            .filter_map(|l| {
                let kind = l.get("kind")?.as_str()?;
                let percent = l.get("percent").and_then(Value::as_f64)?;
                let model = l
                    .get("scope")
                    .and_then(|s| s.get("model"))
                    .and_then(|m| m.get("display_name"))
                    .and_then(Value::as_str);
                let key = match model {
                    Some(m) if kind != "session" && kind != "weekly_all" => format!("{kind}:{m}"),
                    _ => kind.to_owned(),
                };
                Some(Window {
                    kind: key,
                    label: label_for(kind, model),
                    used_percent: percent,
                    resets_at: l.get("resets_at").filter(|v| !v.is_null()).cloned(),
                    severity: l.get("severity").and_then(Value::as_str).map(str::to_owned),
                })
            })
            .collect();
        if !windows.is_empty() {
            return windows;
        }
    }

    [
        ("five_hour", "session", None),
        ("seven_day", "weekly_all", None),
        ("seven_day_opus", "weekly_scoped:Opus", Some("Opus")),
        ("seven_day_sonnet", "weekly_scoped:Sonnet", Some("Sonnet")),
    ]
    .into_iter()
    .filter_map(|(field, kind, model)| {
        let w = body.get(field).filter(|v| v.is_object())?;
        Some(Window {
            kind: kind.to_owned(),
            label: label_for(kind.split(':').next().unwrap_or(kind), model),
            used_percent: w.get("utilization").and_then(Value::as_f64)?,
            resets_at: w.get("resets_at").filter(|v| !v.is_null()).cloned(),
            severity: None,
        })
    })
    .collect()
}

/// `rate_limits` from the statusLine JSON. Accepts `used_percentage` or
/// `utilization`, and `resets_at` or `reset_at` (both have been reported).
pub fn windows_from_statusline(status: &Value) -> Option<Vec<Window>> {
    let limits = status.get("rate_limits")?;
    let windows: Vec<Window> = [("five_hour", "session"), ("seven_day", "weekly_all")]
        .into_iter()
        .filter_map(|(field, kind)| {
            let w = limits.get(field).filter(|v| v.is_object())?;
            let pct = w
                .get("used_percentage")
                .or_else(|| w.get("utilization"))
                .and_then(Value::as_f64)?;
            Some(Window {
                kind: kind.to_owned(),
                label: label_for(kind, None),
                used_percent: pct,
                resets_at: w
                    .get("resets_at")
                    .or_else(|| w.get("reset_at"))
                    .filter(|v| !v.is_null())
                    .cloned(),
                severity: None,
            })
        })
        .collect();
    (!windows.is_empty()).then_some(windows)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// Trimmed copy of a real response (2026-10-19).
    fn live_sample() -> Value {
        json!({
            "five_hour": { "utilization": 22.0, "resets_at": "2026-10-19T18:40:00.108298+00:00" },
            "seven_day": { "utilization": 4.0, "resets_at": "2026-10-26T13:00:00.108318+00:00" },
            "seven_day_opus": null,
            "limits": [
                { "kind": "session", "group": "session", "percent": 22, "severity": "normal",
                  "resets_at": "2026-10-19T18:40:00.108298+00:00", "scope": null, "is_active": true },
                { "kind": "weekly_all", "group": "weekly", "percent": 4, "severity": "normal",
                  "resets_at": "2026-10-26T13:00:00.108318+00:00", "scope": null, "is_active": false },
                { "kind": "weekly_scoped", "group": "weekly", "percent": 0, "severity": "normal",
                  "resets_at": "2026-10-26T13:00:00+00:00",
                  "scope": { "model": { "id": null, "display_name": "Fable" }, "surface": null } }
            ]
        })
    }

    #[test]
    fn parses_limits_array() {
        let w = parse_usage(&live_sample());
        let summary: Vec<_> = w
            .iter()
            .map(|w| (w.kind.as_str(), w.label.as_str(), w.used_percent))
            .collect();
        assert_eq!(
            summary,
            vec![
                ("session", "Sesión · 5 h", 22.0),
                ("weekly_all", "Semana", 4.0),
                ("weekly_scoped:Fable", "Semana · Fable", 0.0),
            ]
        );
        assert_eq!(w[0].severity.as_deref(), Some("normal"));
    }

    #[test]
    fn falls_back_to_flat_objects() {
        let mut body = live_sample();
        body.as_object_mut().unwrap().remove("limits");
        let w = parse_usage(&body);
        assert_eq!(w.len(), 2);
        assert_eq!(w[0].kind, "session");
        assert_eq!(w[1].used_percent, 4.0);
    }

    #[test]
    fn reads_statusline_variants() {
        let a = json!({ "rate_limits": { "five_hour": { "used_percentage": 30, "resets_at": 1760900000 } } });
        let b = json!({ "rate_limits": { "seven_day": { "utilization": 12.5, "reset_at": "2026-10-26T13:00:00Z" } } });
        assert_eq!(windows_from_statusline(&a).unwrap()[0].used_percent, 30.0);
        let wb = windows_from_statusline(&b).unwrap();
        assert_eq!(
            (wb[0].kind.as_str(), wb[0].used_percent),
            ("weekly_all", 12.5)
        );
        assert!(windows_from_statusline(&json!({})).is_none());
    }

    /// `cargo test -p termcode live_fetch -- --ignored --nocapture`
    #[test]
    #[ignore = "live: reads the Keychain and calls Anthropic"]
    fn live_fetch() {
        let client = reqwest::Client::builder().build().unwrap();
        let reading = tauri::async_runtime::block_on(fetch(&client)).expect("live fetch");
        assert!(!reading.windows.is_empty());
        println!("plan: {:?}", reading.plan);
        for w in &reading.windows {
            println!(
                "{} → {}% (resets {:?})",
                w.label, w.used_percent, w.resets_at
            );
        }
    }

    #[test]
    fn credentials_and_plan() {
        let raw = r#"{"claudeAiOauth":{"accessToken":"x","expiresAt":1,"subscriptionType":"team","rateLimitTier":"default_claude_max_5x"}}"#;
        let c = parse_credentials(raw).unwrap();
        assert_eq!(c.plan.as_deref(), Some("Team · Max 5×"));
        assert_eq!(c.expires_at_ms, Some(1));
        assert_eq!(plan_label(Some("pro"), None).as_deref(), Some("Pro"));
        assert!(parse_credentials("{}").is_none());
    }
}
