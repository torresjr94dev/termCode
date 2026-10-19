//! CI status of the checked-out commit (GitHub Actions through `gh`).

use super::remote::{self, Host};
use super::{blocking, checked_root, git};
use crate::agents::{tool_command, tools};
use crate::proc;
use serde::Serialize;
use std::time::Duration;

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CiRun {
    pub name: String,
    /// queued · in_progress · completed …
    pub status: String,
    /// success · failure · cancelled … (empty while running)
    pub conclusion: String,
    pub url: String,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CiStatus {
    /// pending · success · failure
    pub state: String,
    pub sha: String,
    pub runs: Vec<CiRun>,
}

fn summarize(runs: &[CiRun]) -> &'static str {
    if runs.iter().any(|r| r.status != "completed") {
        "pending"
    } else if runs
        .iter()
        .all(|r| matches!(r.conclusion.as_str(), "success" | "skipped" | "neutral"))
    {
        "success"
    } else {
        "failure"
    }
}

fn parse_runs(json: &[u8]) -> Result<Vec<CiRun>, String> {
    let value: serde_json::Value =
        serde_json::from_slice(json).map_err(|_| "Respuesta inesperada de gh.")?;
    let text = |v: &serde_json::Value, k: &str| v[k].as_str().unwrap_or_default().to_owned();
    Ok(value
        .as_array()
        .map(|runs| {
            runs.iter()
                .map(|r| CiRun {
                    name: Some(text(r, "workflowName"))
                        .filter(|n| !n.is_empty())
                        .unwrap_or_else(|| text(r, "name")),
                    status: text(r, "status"),
                    conclusion: text(r, "conclusion"),
                    url: text(r, "url"),
                })
                // Only links to GitHub are opened from the UI.
                .filter(|r| r.url.starts_with("https://"))
                .collect()
        })
        .unwrap_or_default())
}

/// Runs for HEAD. `None`: not GitHub, no `gh`, or no runs for this commit
/// (e.g. not pushed yet).
#[tauri::command]
pub async fn ci_status(root: String) -> Result<Option<CiStatus>, String> {
    blocking(move || {
        let root = checked_root(&root)?;
        let github = git(&root, &["config", "--get", "remote.origin.url"])
            .ok()
            .and_then(|u| remote::parse(&u))
            .is_some_and(|r| r.host == Host::Github);
        let Some(gh) = tools().gh.filter(|_| github) else {
            return Ok(None);
        };
        let sha = git(&root, &["rev-parse", "HEAD"])?.trim().to_owned();
        let mut cmd = tool_command(&gh);
        cmd.current_dir(&root).args([
            "run",
            "list",
            "--commit",
            &sha,
            "--limit",
            "20",
            "--json",
            "name,workflowName,status,conclusion,url",
        ]);
        let out =
            proc::run(cmd, None, Duration::from_secs(20), 256 * 1024).map_err(|e| e.to_string())?;
        if !out.success() {
            return Ok(None); // offline, not authenticated, Actions disabled…
        }
        let runs = parse_runs(&out.stdout)?;
        if runs.is_empty() {
            return Ok(None);
        }
        Ok(Some(CiStatus {
            state: summarize(&runs).to_owned(),
            sha,
            runs,
        }))
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn summarizes_runs() {
        let runs = parse_runs(
            br#"[{"name":"push","workflowName":"CI","status":"completed","conclusion":"success","url":"https://github.com/a/b/actions/runs/1"},
                 {"name":"Release","workflowName":"","status":"in_progress","conclusion":"","url":"https://github.com/a/b/actions/runs/2"},
                 {"name":"evil","workflowName":"x","status":"completed","conclusion":"failure","url":"javascript:alert(1)"}]"#,
        )
        .unwrap();
        assert_eq!(runs.len(), 2, "non-https links are dropped");
        assert_eq!(runs[0].name, "CI");
        assert_eq!(runs[1].name, "Release");
        assert_eq!(summarize(&runs), "pending");
        assert_eq!(summarize(&runs[..1]), "success");
        let failed = CiRun {
            conclusion: "failure".into(),
            ..runs[0].clone()
        };
        assert_eq!(summarize(&[runs[0].clone(), failed]), "failure");
    }
}
