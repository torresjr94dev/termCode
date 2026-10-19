//! Git for the Project panel: status, diffs, history, commits, push/pull,
//! pull requests and AI-written messages.
//!
//! Everything shells out to the user's `git` (their config, hooks, signing and
//! credential helpers keep working) through [`crate::proc::run`]: arguments are
//! passed as a vector (no shell), paths always go after `--`, and every call
//! has a timeout.

pub mod ai;
pub mod branches;
pub mod ci;
pub mod pr;
mod remote;
pub mod review;
pub mod worktree;

use crate::proc::{self, Output};
use serde::Serialize;
use std::path::{Component, Path, PathBuf};
use std::process::Command;
use std::time::Duration;

/// Diffs bigger than this are cut (the viewer says so).
const MAX_DIFF: usize = 2 * 1024 * 1024;
const LOCAL: Duration = Duration::from_secs(20);
const NETWORK: Duration = Duration::from_secs(120);
/// SHA-1 of the empty tree: the "parent" of a root commit.
const EMPTY_TREE: &str = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

pub(crate) fn command(root: &Path) -> Command {
    let mut cmd = Command::new("git");
    cmd.arg("-C").arg(root);
    // Status refreshes must not take index.lock while the user runs git in a pane.
    cmd.env("GIT_OPTIONAL_LOCKS", "0");
    // Never wait for a password prompt nobody can see.
    cmd.env("GIT_TERMINAL_PROMPT", "0");
    if std::env::var_os("GIT_SSH_COMMAND").is_none() {
        cmd.env("GIT_SSH_COMMAND", "ssh -o BatchMode=yes");
    }
    cmd
}

fn run_raw(
    root: &Path,
    args: &[&str],
    stdin: Option<Vec<u8>>,
    timeout: Duration,
    limit: usize,
) -> Result<Output, String> {
    let mut cmd = command(root);
    cmd.args(args);
    proc::run(cmd, stdin, timeout, limit).map_err(|e| format!("git {e}"))
}

/// stdout on success, git's own message on failure.
pub(crate) fn git(root: &Path, args: &[&str]) -> Result<String, String> {
    let out = run_raw(root, args, None, LOCAL, 8 * 1024 * 1024)?;
    if out.success() {
        Ok(out.stdout_str())
    } else {
        Err(error_message(&out))
    }
}

fn error_message(out: &Output) -> String {
    let err = out.stderr_str();
    if err.is_empty() {
        format!("git terminó con código {:?}", out.code)
    } else {
        err
    }
}

/// The repository root sent by the webview must be a real working tree.
fn checked_root(root: &str) -> Result<PathBuf, String> {
    let path = PathBuf::from(root);
    if path.is_absolute() && path.join(".git").exists() {
        Ok(path)
    } else {
        Err("La carpeta no es la raíz de un repositorio git.".into())
    }
}

/// Repository-relative paths only: no absolute paths, no `..`, no NUL.
fn checked_paths(paths: &[String]) -> Result<Vec<&str>, String> {
    paths
        .iter()
        .map(|p| {
            let path = Path::new(p);
            let ok = !p.is_empty()
                && !p.contains('\0')
                && path
                    .components()
                    .all(|c| matches!(c, Component::Normal(_) | Component::CurDir));
            ok.then_some(p.as_str())
                .ok_or_else(|| format!("Ruta inválida: {p}"))
        })
        .collect()
}

async fn blocking<T: Send + 'static>(
    f: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(f)
        .await
        .map_err(|e| e.to_string())?
}

// ---------------------------------------------------------------------------
// Repository discovery
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoMeta {
    pub root: String,
    pub name: String,
    pub remote_url: Option<String>,
    /// https URL of the repository on its host, when recognizable.
    pub web_url: Option<String>,
    pub host: remote::Host,
    /// `main`, `master`…: what `origin/HEAD` points to.
    pub default_branch: Option<String>,
}

fn repo_meta(cwd: &Path) -> Option<RepoMeta> {
    let root = PathBuf::from(git(cwd, &["rev-parse", "--show-toplevel"]).ok()?.trim());
    let remote_url = git(&root, &["config", "--get", "remote.origin.url"])
        .ok()
        .map(|u| u.trim().to_owned())
        .filter(|u| !u.is_empty());
    let parsed = remote_url.as_deref().and_then(remote::parse);
    let default_branch = git(
        &root,
        &["symbolic-ref", "--short", "refs/remotes/origin/HEAD"],
    )
    .ok()
    .map(|b| b.trim().trim_start_matches("origin/").to_owned())
    .filter(|b| !b.is_empty());
    Some(RepoMeta {
        name: root.file_name()?.to_string_lossy().into_owned(),
        root: root.to_string_lossy().into_owned(),
        web_url: parsed.as_ref().map(|r| r.web_url.clone()),
        host: parsed.map(|r| r.host).unwrap_or(remote::Host::Other),
        remote_url,
        default_branch,
    })
}

/// `null` when `cwd` is not inside a git working tree.
#[tauri::command]
pub async fn git_repo(cwd: String) -> Result<Option<RepoMeta>, String> {
    blocking(move || {
        let meta = repo_meta(Path::new(&cwd));
        if let Some(m) = &meta {
            log::info!("git: repo {} ({:?})", m.name, m.host);
        }
        Ok(meta)
    })
    .await
}

// ---------------------------------------------------------------------------
// Status (porcelain v2)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Change {
    pub path: String,
    pub orig_path: Option<String>,
    /// Index (staged) status letter; `.` = unchanged.
    pub index: char,
    /// Worktree (unstaged) status letter; `.` = unchanged.
    pub worktree: char,
    pub untracked: bool,
    pub conflicted: bool,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub branch: Option<String>,
    pub head: Option<String>,
    pub upstream: Option<String>,
    pub ahead: u32,
    pub behind: u32,
    pub changes: Vec<Change>,
    /// merge · rebase · cherry-pick · revert waiting to be finished.
    pub operation: Option<String>,
}

fn parse_status(raw: &str) -> Status {
    let mut status = Status::default();
    let mut tokens = raw.split('\0').filter(|t| !t.is_empty());
    while let Some(token) = tokens.next() {
        if let Some(header) = token.strip_prefix("# ") {
            let (key, value) = header.split_once(' ').unwrap_or((header, ""));
            match key {
                "branch.oid" if value != "(initial)" => {
                    status.head = Some(value.chars().take(12).collect())
                }
                "branch.head" if value != "(detached)" => status.branch = Some(value.to_owned()),
                "branch.upstream" => status.upstream = Some(value.to_owned()),
                "branch.ab" => {
                    for part in value.split(' ') {
                        if let Some(n) = part.strip_prefix('+') {
                            status.ahead = n.parse().unwrap_or(0);
                        } else if let Some(n) = part.strip_prefix('-') {
                            status.behind = n.parse().unwrap_or(0);
                        }
                    }
                }
                _ => {}
            }
            continue;
        }

        let kind = token.as_bytes().first().copied();
        let change = match kind {
            // 1 XY sub mH mI mW hH hI path
            Some(b'1') => token
                .splitn(9, ' ')
                .collect::<Vec<_>>()
                .get(8)
                .map(|path| (token, *path, None)),
            // 2 XY sub mH mI mW hH hI Xscore path \0 origPath
            Some(b'2') => token
                .splitn(10, ' ')
                .collect::<Vec<_>>()
                .get(9)
                .map(|path| (token, *path, tokens.next())),
            // u XY sub m1 m2 m3 mW h1 h2 h3 path
            Some(b'u') => token
                .splitn(11, ' ')
                .collect::<Vec<_>>()
                .get(10)
                .map(|path| (token, *path, None)),
            Some(b'?') => {
                status.changes.push(Change {
                    path: token[2..].to_owned(),
                    orig_path: None,
                    index: '.',
                    worktree: '?',
                    untracked: true,
                    conflicted: false,
                });
                None
            }
            _ => None,
        };
        if let Some((line, path, orig)) = change {
            let xy: Vec<char> = line.get(2..4).unwrap_or("..").chars().collect();
            status.changes.push(Change {
                path: path.to_owned(),
                orig_path: orig.map(str::to_owned),
                index: xy[0],
                worktree: xy[1],
                untracked: false,
                conflicted: kind == Some(b'u'),
            });
        }
    }
    status
}

#[tauri::command]
pub async fn git_status(root: String) -> Result<Status, String> {
    blocking(move || {
        let root = checked_root(&root)?;
        git(
            &root,
            &[
                "status",
                "--porcelain=v2",
                "--branch",
                "-z",
                "--untracked-files=all",
            ],
        )
        .map(|raw| Status {
            operation: branches::operation(&root).map(str::to_owned),
            ..parse_status(&raw)
        })
    })
    .await
}

// ---------------------------------------------------------------------------
// Diffs
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiffText {
    pub text: String,
    pub truncated: bool,
}

fn diff(root: &Path, args: &[&str], ok_codes: &[i32]) -> Result<DiffText, String> {
    let out = run_raw(root, args, None, LOCAL, MAX_DIFF)?;
    if out.code.is_some_and(|c| ok_codes.contains(&c)) {
        Ok(DiffText {
            text: out.stdout_str(),
            truncated: out.truncated,
        })
    } else {
        Err(error_message(&out))
    }
}

/// `mode`: `staged` (index vs HEAD), `worktree` (files vs index) or `untracked`.
#[tauri::command]
pub async fn git_diff(
    root: String,
    path: String,
    orig_path: Option<String>,
    mode: String,
) -> Result<DiffText, String> {
    blocking(move || {
        let root = checked_root(&root)?;
        let mut paths = vec![path];
        paths.extend(orig_path);
        let paths = checked_paths(&paths)?;
        let base = ["diff", "--no-color", "--no-ext-diff", "-M"];
        match mode.as_str() {
            "staged" => diff(
                &root,
                &[&base[..], &["--cached", "--"], &paths].concat(),
                &[0],
            ),
            "worktree" => diff(&root, &[&base[..], &["--"], &paths].concat(), &[0]),
            // `--no-index` exits with 1 when the files differ (always, here).
            "untracked" => diff(
                &root,
                &[
                    "diff",
                    "--no-color",
                    "--no-index",
                    "--",
                    "/dev/null",
                    paths[0],
                ],
                &[0, 1],
            ),
            other => Err(format!("Modo de diff desconocido: {other}")),
        }
    })
    .await
}

// ---------------------------------------------------------------------------
// Index operations and commits
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn git_stage(root: String, paths: Vec<String>) -> Result<(), String> {
    blocking(move || {
        let root = checked_root(&root)?;
        let paths = checked_paths(&paths)?;
        git(&root, &[&["add", "-A", "--"][..], &paths].concat()).map(drop)
    })
    .await
}

#[tauri::command]
pub async fn git_unstage(root: String, paths: Vec<String>) -> Result<(), String> {
    blocking(move || {
        let root = checked_root(&root)?;
        let paths = checked_paths(&paths)?;
        let has_head = git(&root, &["rev-parse", "--verify", "--quiet", "HEAD"]).is_ok();
        let args: &[&str] = if has_head {
            &["restore", "--staged", "--"]
        } else {
            &["rm", "--cached", "-r", "-q", "--"]
        };
        git(&root, &[args, &paths].concat()).map(drop)
    })
    .await
}

/// Throws away unstaged changes (tracked files) and deletes untracked files.
/// The webview asks for confirmation first.
#[tauri::command]
pub async fn git_discard(
    root: String,
    tracked: Vec<String>,
    untracked: Vec<String>,
) -> Result<(), String> {
    blocking(move || {
        let root = checked_root(&root)?;
        let tracked = checked_paths(&tracked)?;
        let untracked = checked_paths(&untracked)?;
        if !tracked.is_empty() {
            git(
                &root,
                &[&["restore", "--worktree", "--"][..], &tracked].concat(),
            )?;
        }
        if !untracked.is_empty() {
            git(
                &root,
                &[&["clean", "-f", "-q", "--"][..], &untracked].concat(),
            )?;
        }
        Ok(())
    })
    .await
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitResult {
    pub sha: String,
    pub summary: String,
}

/// Runs the user's hooks; their output comes back as the error when they fail.
#[tauri::command]
pub async fn git_commit(
    root: String,
    message: String,
    amend: bool,
) -> Result<CommitResult, String> {
    blocking(move || {
        let root = checked_root(&root)?;
        if message.trim().is_empty() {
            return Err("El mensaje de commit está vacío.".into());
        }
        let mut args = vec!["commit", "--cleanup=strip", "-F", "-"];
        if amend {
            args.push("--amend");
        }
        let out = run_raw(
            &root,
            &args,
            Some(message.into_bytes()),
            Duration::from_secs(300),
            256 * 1024,
        )?;
        if !out.success() {
            let msg = error_message(&out);
            let stdout = out.stdout_str();
            return Err(
                if msg.starts_with("git terminó") && !stdout.trim().is_empty() {
                    stdout
                } else {
                    msg
                },
            );
        }
        let line = git(&root, &["log", "-1", "--format=%h%x1f%s"])?;
        let (sha, summary) = line
            .trim()
            .split_once('\u{1f}')
            .unwrap_or((line.trim(), ""));
        Ok(CommitResult {
            sha: sha.to_owned(),
            summary: summary.to_owned(),
        })
    })
    .await
}

fn has_upstream(root: &Path) -> bool {
    git(
        root,
        &["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"],
    )
    .is_ok()
}

/// Publishes the current branch (setting `origin` as upstream the first time).
pub(crate) fn push(root: &Path) -> Result<String, String> {
    let args: &[&str] = if has_upstream(root) {
        &["push"]
    } else {
        &["push", "-u", "origin", "HEAD"]
    };
    let out = run_raw(root, args, None, NETWORK, 256 * 1024)?;
    if out.success() {
        Ok(out.stderr_str()) // git reports progress on stderr
    } else {
        Err(explain_push_error(&error_message(&out)))
    }
}

/// git's rejection text says *what* happened; this adds *what to do*.
fn explain_push_error(raw: &str) -> String {
    let hint = if raw.contains("fetch first") {
        Some("El remoto tiene commits que no tienes: haz Pull primero.")
    } else if raw.contains("non-fast-forward") || raw.contains("[rejected]") {
        Some(
            "Tu rama y la del remoto divergieron (p. ej. enmendaste o rebaseaste un commit ya publicado). \
             Si es intencional, fuerza desde la terminal: git push --force-with-lease",
        )
    } else {
        None
    };
    match hint {
        Some(hint) => format!("{hint}\n\n{raw}"),
        None => raw.to_owned(),
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LastCommit {
    pub sha: String,
    pub short: String,
    pub message: String,
    /// Remote branches that already contain it: non-empty = published.
    pub published_in: Vec<String>,
}

fn last_commit(root: &Path) -> Result<LastCommit, String> {
    let raw = git(root, &["log", "-1", "--format=%H%x1f%h%x1f%B"])
        .map_err(|_| "Todavía no hay commits que enmendar.".to_owned())?;
    let mut fields = raw.splitn(3, '\u{1f}');
    let sha = fields.next().unwrap_or_default().trim().to_owned();
    let short = fields.next().unwrap_or_default().trim().to_owned();
    let message = fields.next().unwrap_or_default().trim().to_owned();
    if sha.is_empty() {
        return Err("Todavía no hay commits que enmendar.".into());
    }
    let published_in = git(
        root,
        &["branch", "-r", "--contains", "HEAD", "--format=%(refname)"],
    )
    .unwrap_or_default()
    .lines()
    .map(str::trim)
    .filter(|r| !r.is_empty() && !r.ends_with("/HEAD"))
    .map(|r| r.trim_start_matches("refs/remotes/").to_owned())
    .collect();
    Ok(LastCommit {
        sha,
        short,
        message,
        published_in,
    })
}

/// The commit an amend would replace, and whether others may already have it.
#[tauri::command]
pub async fn git_last_commit(root: String) -> Result<LastCommit, String> {
    blocking(move || last_commit(&checked_root(&root)?)).await
}

#[tauri::command]
pub async fn git_push(root: String) -> Result<String, String> {
    blocking(move || push(&checked_root(&root)?)).await
}

#[tauri::command]
pub async fn git_pull(root: String) -> Result<String, String> {
    blocking(move || {
        let root = checked_root(&root)?;
        let out = run_raw(&root, &["pull", "--ff-only"], None, NETWORK, 256 * 1024)?;
        if out.success() {
            Ok(out.stdout_str().trim().to_owned())
        } else {
            Err(error_message(&out))
        }
    })
    .await
}

// ---------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitInfo {
    pub sha: String,
    pub short: String,
    pub author: String,
    /// Epoch seconds.
    pub time: i64,
    pub parents: Vec<String>,
    /// Decorations: `HEAD -> main`, `origin/main`, `tag: v1`…
    pub refs: Vec<String>,
    pub subject: String,
}

const LOG_FORMAT: &str = "--format=%H%x1f%h%x1f%an%x1f%at%x1f%P%x1f%D%x1f%s%x1e";

fn parse_log(raw: &str) -> Vec<CommitInfo> {
    raw.split('\u{1e}')
        .map(|r| r.trim_matches('\n'))
        .filter(|r| !r.is_empty())
        .filter_map(|record| {
            let f: Vec<&str> = record.split('\u{1f}').collect();
            if f.len() < 7 {
                return None;
            }
            Some(CommitInfo {
                sha: f[0].to_owned(),
                short: f[1].to_owned(),
                author: f[2].to_owned(),
                time: f[3].parse().unwrap_or(0),
                parents: f[4].split_whitespace().map(str::to_owned).collect(),
                refs: f[5]
                    .split(", ")
                    .filter(|r| !r.is_empty())
                    .map(str::to_owned)
                    .collect(),
                subject: f[6..].join("\u{1f}"),
            })
        })
        .collect()
}

#[tauri::command]
pub async fn git_log(root: String, skip: u32, limit: u32) -> Result<Vec<CommitInfo>, String> {
    blocking(move || {
        let root = checked_root(&root)?;
        if git(&root, &["rev-parse", "--verify", "--quiet", "HEAD"]).is_err() {
            return Ok(Vec::new()); // no commits yet
        }
        let (skip, limit) = (
            format!("--skip={skip}"),
            format!("-n{}", limit.clamp(1, 500)),
        );
        git(&root, &["log", LOG_FORMAT, &skip, &limit]).map(|raw| parse_log(&raw))
    })
    .await
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitFile {
    pub status: char,
    pub path: String,
    pub orig_path: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitDetail {
    pub body: String,
    pub author_email: String,
    /// What the files are compared against (first parent, or the empty tree).
    pub base: String,
    pub files: Vec<CommitFile>,
}

fn parse_name_status(raw: &str) -> Vec<CommitFile> {
    let mut files = Vec::new();
    let mut tokens = raw.split('\0').filter(|t| !t.is_empty());
    while let Some(code) = tokens.next() {
        let status = code.chars().next().unwrap_or('M');
        let (orig_path, path) = if matches!(status, 'R' | 'C') {
            (tokens.next().map(str::to_owned), tokens.next())
        } else {
            (None, tokens.next())
        };
        if let Some(path) = path {
            files.push(CommitFile {
                status,
                path: path.to_owned(),
                orig_path,
            });
        }
    }
    files
}

fn valid_rev(rev: &str) -> bool {
    (4..=64).contains(&rev.len()) && rev.bytes().all(|b| b.is_ascii_hexdigit())
}

#[tauri::command]
pub async fn git_commit_detail(root: String, sha: String) -> Result<CommitDetail, String> {
    blocking(move || {
        let root = checked_root(&root)?;
        if !valid_rev(&sha) {
            return Err("Commit inválido.".into());
        }
        let meta = git(&root, &["log", "-1", "--format=%ae%x1f%P%x1f%B", &sha])?;
        let mut f = meta.splitn(3, '\u{1f}');
        let author_email = f.next().unwrap_or_default().to_owned();
        let base = f
            .next()
            .and_then(|p| p.split_whitespace().next())
            .unwrap_or(EMPTY_TREE)
            .to_owned();
        let body = f.next().unwrap_or_default().trim().to_owned();
        let files = git(
            &root,
            &[
                "diff",
                "--name-status",
                "-z",
                "-M",
                "--no-color",
                &base,
                &sha,
            ],
        )
        .map(|raw| parse_name_status(&raw))?;
        Ok(CommitDetail {
            body,
            author_email,
            base,
            files,
        })
    })
    .await
}

#[tauri::command]
pub async fn git_commit_diff(
    root: String,
    base: String,
    sha: String,
    path: String,
    orig_path: Option<String>,
) -> Result<DiffText, String> {
    blocking(move || {
        let root = checked_root(&root)?;
        if !valid_rev(&sha) || !valid_rev(&base) {
            return Err("Commit inválido.".into());
        }
        let mut paths = vec![path];
        paths.extend(orig_path);
        let paths = checked_paths(&paths)?;
        diff(
            &root,
            &[
                &[
                    "diff",
                    "--no-color",
                    "--no-ext-diff",
                    "-M",
                    &base,
                    &sha,
                    "--",
                ][..],
                &paths,
            ]
            .concat(),
            &[0],
        )
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_porcelain_v2() {
        let raw = [
            "# branch.oid 2fcfd1c9a8b7c6d5e4f3",
            "# branch.head mejoras/p0-p4",
            "# branch.upstream origin/mejoras/p0-p4",
            "# branch.ab +2 -1",
            "1 .M N... 100644 100644 100644 aaa bbb src/App.tsx",
            "1 A. N... 000000 100644 100644 000 ccc src/lib/con espacio.ts",
            "2 R. N... 100644 100644 100644 ddd eee R100 src/nuevo.ts",
            "src/viejo.ts",
            "u UU N... 100644 100644 100644 100644 f1 f2 f3 conflicto.rs",
            "? notas.txt",
            "",
        ]
        .join("\0");
        let s = parse_status(&raw);
        assert_eq!(s.branch.as_deref(), Some("mejoras/p0-p4"));
        assert_eq!(s.upstream.as_deref(), Some("origin/mejoras/p0-p4"));
        assert_eq!((s.ahead, s.behind), (2, 1));
        assert_eq!(s.head.as_deref(), Some("2fcfd1c9a8b7"));
        let summary: Vec<_> = s
            .changes
            .iter()
            .map(|c| (c.path.as_str(), c.index, c.worktree))
            .collect();
        assert_eq!(
            summary,
            vec![
                ("src/App.tsx", '.', 'M'),
                ("src/lib/con espacio.ts", 'A', '.'),
                ("src/nuevo.ts", 'R', '.'),
                ("conflicto.rs", 'U', 'U'),
                ("notas.txt", '.', '?'),
            ]
        );
        assert_eq!(s.changes[2].orig_path.as_deref(), Some("src/viejo.ts"));
        assert!(s.changes[3].conflicted);
        assert!(s.changes[4].untracked);
    }

    #[test]
    fn parses_initial_and_detached() {
        let s = parse_status("# branch.oid (initial)\0# branch.head (detached)\0");
        assert_eq!((s.head, s.branch), (None, None));
    }

    #[test]
    fn parses_log_records() {
        let raw = "abc123\u{1f}abc\u{1f}Jorge\u{1f}1792430000\u{1f}p1 p2\u{1f}HEAD -> main, origin/main\u{1f}Merge: algo\u{1e}\n\
                   def456\u{1f}def\u{1f}Jorge\u{1f}1792420000\u{1f}\u{1f}\u{1f}Inicio\u{1e}\n";
        let log = parse_log(raw);
        assert_eq!(log.len(), 2);
        assert_eq!(log[0].parents, vec!["p1", "p2"]);
        assert_eq!(log[0].refs, vec!["HEAD -> main", "origin/main"]);
        assert!(log[1].parents.is_empty() && log[1].refs.is_empty());
        assert_eq!(log[1].subject, "Inicio");
    }

    #[test]
    fn parses_name_status_with_renames() {
        let raw = "M\0src/a.ts\0R087\0viejo.ts\0nuevo.ts\0D\0borrado.md\0";
        let files = parse_name_status(raw);
        assert_eq!(files.len(), 3);
        assert_eq!(files[1].status, 'R');
        assert_eq!(files[1].orig_path.as_deref(), Some("viejo.ts"));
        assert_eq!(files[1].path, "nuevo.ts");
        assert_eq!(files[2].status, 'D');
    }

    #[test]
    fn rejects_paths_outside_the_repo() {
        assert!(checked_paths(&["src/ok.ts".into()]).is_ok());
        assert!(checked_paths(&["../fuera".into()]).is_err());
        assert!(checked_paths(&["/etc/passwd".into()]).is_err());
        assert!(checked_paths(&["".into()]).is_err());
        assert!(!valid_rev("HEAD; rm -rf"));
        assert!(valid_rev("2fcfd1c"));
    }

    #[test]
    fn last_commit_knows_whether_it_is_published() {
        let base = std::env::temp_dir().join(format!("termcode-amend-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        let (origin, work) = (base.join("origin.git"), base.join("work"));
        std::fs::create_dir_all(&origin).unwrap();
        std::fs::create_dir_all(&work).unwrap();
        git(&origin, &["init", "-q", "--bare", "-b", "main"]).unwrap();
        git(&work, &["init", "-q", "-b", "main"]).unwrap();
        git(&work, &["config", "user.name", "t"]).unwrap();
        git(&work, &["config", "user.email", "t@t"]).unwrap();
        git(
            &work,
            &["remote", "add", "origin", &origin.to_string_lossy()],
        )
        .unwrap();

        assert!(last_commit(&work).is_err(), "no commits yet");

        git(
            &work,
            &[
                "commit",
                "-q",
                "--allow-empty",
                "-m",
                "Primero\n\nCon cuerpo",
            ],
        )
        .unwrap();
        let local = last_commit(&work).unwrap();
        assert_eq!(local.message, "Primero\n\nCon cuerpo");
        assert!(local.published_in.is_empty());

        push(&work).unwrap();
        assert_eq!(
            last_commit(&work).unwrap().published_in,
            vec!["origin/main"]
        );

        git(&work, &["commit", "-q", "--allow-empty", "-m", "Segundo"]).unwrap();
        assert!(
            last_commit(&work).unwrap().published_in.is_empty(),
            "new commit is local"
        );

        // Rewriting a published commit makes the next push diverge.
        git(&work, &["reset", "-q", "--hard", "HEAD~1"]).unwrap();
        git(
            &work,
            &[
                "commit",
                "-q",
                "--amend",
                "--allow-empty",
                "-m",
                "Primero (enmendado)",
            ],
        )
        .unwrap();
        let err = push(&work).unwrap_err();
        assert!(
            err.starts_with("Tu rama y la del remoto divergieron"),
            "{err}"
        );

        std::fs::remove_dir_all(base).unwrap();
    }

    /// End-to-end against a throwaway repository.
    #[test]
    fn stages_commits_and_reads_history() {
        let dir = std::env::temp_dir().join(format!("termcode-gitops-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        git(&dir, &["init", "-q", "-b", "main"]).unwrap();
        git(&dir, &["config", "user.name", "t"]).unwrap();
        git(&dir, &["config", "user.email", "t@t"]).unwrap();
        std::fs::write(dir.join("a.txt"), "uno\n").unwrap();

        let s = parse_status(
            &git(
                &dir,
                &[
                    "status",
                    "--porcelain=v2",
                    "--branch",
                    "-z",
                    "--untracked-files=all",
                ],
            )
            .unwrap(),
        );
        assert!(s.changes[0].untracked);

        let root = dir.to_string_lossy().into_owned();
        tauri::async_runtime::block_on(async {
            git_stage(root.clone(), vec!["a.txt".into()]).await.unwrap();
            let staged = git_diff(root.clone(), "a.txt".into(), None, "staged".into())
                .await
                .unwrap();
            assert!(staged.text.contains("+uno"));
            let c = git_commit(root.clone(), "Primer commit\n\nCuerpo".into(), false)
                .await
                .unwrap();
            assert_eq!(c.summary, "Primer commit");

            std::fs::write(dir.join("a.txt"), "uno\ndos\n").unwrap();
            let wt = git_diff(root.clone(), "a.txt".into(), None, "worktree".into())
                .await
                .unwrap();
            assert!(wt.text.contains("+dos"));

            let log = git_log(root.clone(), 0, 10).await.unwrap();
            assert_eq!(log.len(), 1);
            let detail = git_commit_detail(root.clone(), log[0].sha.clone())
                .await
                .unwrap();
            assert_eq!(detail.base, EMPTY_TREE);
            assert_eq!(detail.body, "Primer commit\n\nCuerpo");
            assert_eq!(
                detail.files,
                vec![CommitFile {
                    status: 'A',
                    path: "a.txt".into(),
                    orig_path: None
                }]
            );
            let d = git_commit_diff(
                root.clone(),
                detail.base,
                log[0].sha.clone(),
                "a.txt".into(),
                None,
            )
            .await
            .unwrap();
            assert!(d.text.contains("+uno"));

            git_discard(root.clone(), vec!["a.txt".into()], vec![])
                .await
                .unwrap();
            assert_eq!(std::fs::read_to_string(dir.join("a.txt")).unwrap(), "uno\n");
        });
        std::fs::remove_dir_all(dir).unwrap();
    }
}
