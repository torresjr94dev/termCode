//! Pull requests.
//!
//! GitHub with the `gh` CLI signed in: created directly. Anything else
//! (GitLab, Bitbucket, Azure DevOps, or GitHub without `gh`): we publish the
//! branch and return the provider's "new pull request" page, prefilled where
//! the provider allows it.

use super::remote::{self, Host};
use super::{blocking, checked_root, git};
use crate::agents::{tool_command, tools};
use crate::proc;
use serde::Serialize;
use std::path::Path;
use std::time::Duration;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PrInfo {
    pub number: u64,
    pub url: String,
    pub state: String,
    pub title: String,
    pub is_draft: bool,
}

fn origin(root: &Path) -> Option<remote::Remote> {
    git(root, &["config", "--get", "remote.origin.url"])
        .ok()
        .and_then(|u| remote::parse(&u))
}

fn current_branch(root: &Path) -> Result<String, String> {
    let branch = git(root, &["rev-parse", "--abbrev-ref", "HEAD"])?
        .trim()
        .to_owned();
    if branch == "HEAD" {
        Err("Estás en un HEAD desacoplado: crea una rama antes de abrir un PR.".into())
    } else {
        Ok(branch)
    }
}

fn gh() -> Option<String> {
    tools().gh
}

/// Open PR for the current branch, if any (GitHub + `gh` only).
#[tauri::command]
pub async fn pr_status(root: String) -> Result<Option<PrInfo>, String> {
    blocking(move || {
        let root = checked_root(&root)?;
        let (Some(gh), Some(Host::Github)) = (gh(), origin(&root).map(|r| r.host)) else {
            return Ok(None);
        };
        let mut cmd = tool_command(&gh);
        cmd.current_dir(&root)
            .args(["pr", "view", "--json", "number,url,state,title,isDraft"]);
        let out =
            proc::run(cmd, None, Duration::from_secs(20), 64 * 1024).map_err(|e| e.to_string())?;
        if !out.success() {
            return Ok(None); // "no pull requests found for branch", offline…
        }
        let v: serde_json::Value =
            serde_json::from_slice(&out.stdout).map_err(|_| "Respuesta inesperada de gh.")?;
        Ok(Some(PrInfo {
            number: v["number"].as_u64().unwrap_or(0),
            url: v["url"].as_str().unwrap_or_default().to_owned(),
            state: v["state"].as_str().unwrap_or_default().to_owned(),
            title: v["title"].as_str().unwrap_or_default().to_owned(),
            is_draft: v["isDraft"].as_bool().unwrap_or(false),
        }))
    })
    .await
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PrCreated {
    pub url: String,
    /// `false`: the URL is a prefilled form the user still has to submit.
    pub created: bool,
}

fn needs_push(root: &Path) -> bool {
    match git(root, &["rev-list", "--count", "@{u}..HEAD"]) {
        Ok(count) => count.trim() != "0",
        Err(_) => true, // no upstream yet
    }
}

fn prefilled_url(
    remote: &remote::Remote,
    base: &str,
    branch: &str,
    title: &str,
    body: &str,
) -> Option<String> {
    let mut url = remote::new_pull_request_url(remote, base, branch)?;
    let q = |s: &str| {
        s.bytes()
            .map(|b| match b {
                b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                    (b as char).to_string()
                }
                _ => format!("%{b:02X}"),
            })
            .collect::<String>()
    };
    // Browsers and providers choke on huge query strings: the body is optional.
    let body = if body.len() > 4000 { "" } else { body };
    match remote.host {
        Host::Github => url.push_str(&format!("&title={}&body={}", q(title), q(body))),
        Host::Gitlab => url.push_str(&format!(
            "&merge_request%5Btitle%5D={}&merge_request%5Bdescription%5D={}",
            q(title),
            q(body)
        )),
        _ => {}
    }
    Some(url)
}

#[tauri::command]
pub async fn pr_create(
    root: String,
    title: String,
    body: String,
    base: String,
    draft: bool,
) -> Result<PrCreated, String> {
    blocking(move || {
        let root = checked_root(&root)?;
        let title = title.trim().to_owned();
        if title.is_empty() {
            return Err("El PR necesita un título.".into());
        }
        if base.is_empty() || base.starts_with('-') || base.contains(char::is_whitespace) {
            return Err("Rama base inválida.".into());
        }
        let branch = current_branch(&root)?;
        if branch == base {
            return Err(format!("Estás en «{base}»: crea una rama para el PR."));
        }
        let remote = origin(&root).ok_or("El repositorio no tiene un remoto «origin».")?;

        if needs_push(&root) {
            super::push(&root)?;
        }

        if let (Some(gh), Host::Github) = (gh(), remote.host) {
            let mut cmd = tool_command(&gh);
            cmd.current_dir(&root).args([
                "pr",
                "create",
                "--title",
                &title,
                "--body-file",
                "-",
                "--base",
                &base,
                "--head",
                &branch,
            ]);
            if draft {
                cmd.arg("--draft");
            }
            let out = proc::run(
                cmd,
                Some(body.into_bytes()),
                Duration::from_secs(60),
                64 * 1024,
            )
            .map_err(|e| e.to_string())?;
            if !out.success() {
                return Err(out.stderr_str());
            }
            let url = out
                .stdout_str()
                .lines()
                .rev()
                .find(|l| l.starts_with("https://"))
                .map(str::to_owned)
                .ok_or("gh no devolvió la URL del PR.")?;
            return Ok(PrCreated { url, created: true });
        }

        prefilled_url(&remote, &base, &branch, &title, &body)
            .map(|url| PrCreated {
                url,
                created: false,
            })
            .ok_or_else(|| "No sé abrir PRs en este proveedor. La rama ya está publicada.".into())
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prefills_title_and_body() {
        let gh = remote::parse("git@github.com:o/r.git").unwrap();
        let url = prefilled_url(
            &gh,
            "main",
            "feat/x",
            "Título con acento",
            "## Resumen\n- a",
        )
        .unwrap();
        assert!(url.starts_with(
            "https://github.com/o/r/compare/main...feat/x?expand=1&title=T%C3%ADtulo%20con%20acento"
        ));
        assert!(url.contains("&body=%23%23%20Resumen%0A-%20a"));

        let gl = remote::parse("git@gitlab.com:g/p.git").unwrap();
        assert!(
            prefilled_url(&gl, "main", "x", "t", "")
                .unwrap()
                .contains("merge_request%5Btitle%5D=t")
        );
    }
}
