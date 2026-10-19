//! Remote URL → hosting provider and web links.

use serde::Serialize;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum Host {
    Github,
    Gitlab,
    Bitbucket,
    Azure,
    Other,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Remote {
    pub host: Host,
    /// `https://github.com/owner/repo`
    pub web_url: String,
}

/// Accepts `git@host:owner/repo.git`, `ssh://git@host:22/owner/repo.git`,
/// `https://user@host/owner/repo.git` and Azure DevOps variants.
pub fn parse(url: &str) -> Option<Remote> {
    let url = url.trim();
    let (domain, path) = if let Some(rest) = url.split_once("://").map(|(_, r)| r) {
        let rest = rest.split_once('@').map_or(rest, |(_, r)| r);
        let (authority, path) = rest.split_once('/')?;
        (authority.split(':').next()?.to_owned(), path.to_owned())
    } else {
        // scp-like: git@host:owner/repo.git
        let rest = url.split_once('@').map_or(url, |(_, r)| r);
        let (domain, path) = rest.split_once(':')?;
        (domain.to_owned(), path.to_owned())
    };
    let path = path.trim_matches('/').trim_end_matches(".git");
    if domain.is_empty() || path.is_empty() {
        return None;
    }

    let lower = domain.to_ascii_lowercase();
    // Azure DevOps SSH: ssh.dev.azure.com:v3/org/project/repo
    if lower == "ssh.dev.azure.com" {
        let parts: Vec<&str> = path.split('/').collect();
        if let [_v3, org, project, repo] = parts[..] {
            return Some(Remote {
                host: Host::Azure,
                web_url: format!("https://dev.azure.com/{org}/{project}/_git/{repo}"),
            });
        }
        return None;
    }

    let host = match lower.as_str() {
        d if d == "github.com" || d.ends_with(".github.com") => Host::Github,
        d if d.contains("gitlab") => Host::Gitlab,
        "bitbucket.org" => Host::Bitbucket,
        d if d == "dev.azure.com" || d.ends_with(".visualstudio.com") => Host::Azure,
        _ => Host::Other,
    };
    Some(Remote {
        host,
        web_url: format!("https://{domain}/{path}"),
    })
}

fn encode(value: &str) -> String {
    value
        .bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' | b'/' => {
                (b as char).to_string()
            }
            _ => format!("%{b:02X}"),
        })
        .collect()
}

/// Page to open a PR/MR in the browser (used when `gh` is not available).
pub fn new_pull_request_url(remote: &Remote, base: &str, branch: &str) -> Option<String> {
    let (web, base, branch) = (&remote.web_url, encode(base), encode(branch));
    Some(match remote.host {
        Host::Github => format!("{web}/compare/{base}...{branch}?expand=1"),
        Host::Gitlab => format!(
            "{web}/-/merge_requests/new?merge_request%5Bsource_branch%5D={branch}&merge_request%5Btarget_branch%5D={base}"
        ),
        Host::Bitbucket => format!("{web}/pull-requests/new?source={branch}&dest={base}"),
        Host::Azure => format!("{web}/pullrequestcreate?sourceRef={branch}&targetRef={base}"),
        Host::Other => return None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_common_remotes() {
        let cases = [
            (
                "git@github.com:torresjr94dev/termCode.git",
                Host::Github,
                "https://github.com/torresjr94dev/termCode",
            ),
            (
                "https://github.com/owner/repo.git",
                Host::Github,
                "https://github.com/owner/repo",
            ),
            (
                "ssh://git@gitlab.empresa.mx:2222/equipo/app.git",
                Host::Gitlab,
                "https://gitlab.empresa.mx/equipo/app",
            ),
            (
                "https://user@bitbucket.org/team/repo.git",
                Host::Bitbucket,
                "https://bitbucket.org/team/repo",
            ),
            (
                "git@ssh.dev.azure.com:v3/org/proj/repo",
                Host::Azure,
                "https://dev.azure.com/org/proj/_git/repo",
            ),
            (
                "https://dev.azure.com/org/proj/_git/repo",
                Host::Azure,
                "https://dev.azure.com/org/proj/_git/repo",
            ),
            (
                "git@git.interno.local:a/b.git",
                Host::Other,
                "https://git.interno.local/a/b",
            ),
        ];
        for (url, host, web) in cases {
            let r = parse(url).unwrap_or_else(|| panic!("{url}"));
            assert_eq!((r.host, r.web_url.as_str()), (host, web), "{url}");
        }
        assert!(parse("no-es-una-url").is_none());
    }

    #[test]
    fn builds_pull_request_links() {
        let gh = parse("git@github.com:o/r.git").unwrap();
        assert_eq!(
            new_pull_request_url(&gh, "main", "feat/ñu").unwrap(),
            "https://github.com/o/r/compare/main...feat/%C3%B1u?expand=1"
        );
        let other = parse("git@git.interno.local:a/b.git").unwrap();
        assert!(new_pull_request_url(&other, "main", "x").is_none());
    }
}
