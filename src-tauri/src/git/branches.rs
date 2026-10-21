//! Branches, stash and conflict resolution.
//!
//! Branch names are validated with `git check-ref-format --branch` and may not
//! start with `-`, so nothing the webview sends can turn into an option. Stash
//! entries are addressed by index only (`stash@{n}`). Resolving a conflict
//! writes only files git itself reports as unmerged.

use super::{LOCAL, blocking, checked_paths, checked_root, command, git};
use crate::proc;
use serde::Serialize;
use std::path::{Path, PathBuf};

const MAX_BRANCHES: usize = 300;

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Branch {
    /// `feature/x`, or `origin/feature/x` for a remote branch.
    pub name: String,
    pub current: bool,
    pub remote: bool,
    pub upstream: Option<String>,
    pub ahead: u32,
    pub behind: u32,
    /// Unix seconds of the last commit.
    pub updated_at: i64,
    pub subject: String,
}

fn parse_track(track: &str) -> (u32, u32) {
    let (mut ahead, mut behind) = (0, 0);
    for part in track.split(", ") {
        if let Some(n) = part.strip_prefix("ahead ") {
            ahead = n.parse().unwrap_or(0);
        } else if let Some(n) = part.strip_prefix("behind ") {
            behind = n.parse().unwrap_or(0);
        }
    }
    (ahead, behind)
}

fn parse_branches(raw: &str) -> Vec<Branch> {
    let mut local = Vec::new();
    let mut remote = Vec::new();
    for line in raw.lines() {
        let f: Vec<&str> = line.split('\0').collect();
        let [refname, head, upstream, track, date, subject] = f[..] else {
            continue;
        };
        let (ahead, behind) = parse_track(track);
        let branch = |name: &str, remote: bool| Branch {
            name: name.to_owned(),
            current: head == "*",
            remote,
            upstream: (!upstream.is_empty()).then(|| upstream.to_owned()),
            ahead,
            behind,
            updated_at: date.parse().unwrap_or(0),
            subject: subject.to_owned(),
        };
        if let Some(name) = refname.strip_prefix("refs/heads/") {
            local.push(branch(name, false));
        } else if let Some(name) = refname.strip_prefix("refs/remotes/")
            && !name.ends_with("/HEAD")
        {
            remote.push(branch(name, true));
        }
    }
    // A remote branch already tracked by a local one is noise in a switcher.
    remote.retain(|r| !local.iter().any(|l| l.upstream.as_deref() == Some(&r.name)));
    local.extend(remote);
    local.truncate(MAX_BRANCHES);
    local
}

fn branches(root: &Path) -> Result<Vec<Branch>, String> {
    git(
        root,
        &[
            "for-each-ref",
            "--sort=-committerdate",
            "--format=%(refname)%00%(HEAD)%00%(upstream:short)%00%(upstream:track,nobracket)%00%(committerdate:unix)%00%(contents:subject)",
            "refs/heads",
            "refs/remotes",
        ],
    )
    .map(|raw| parse_branches(&raw))
}

#[tauri::command]
pub async fn git_branches(root: String) -> Result<Vec<Branch>, String> {
    blocking(move || branches(&checked_root(&root)?)).await
}

fn valid_branch(root: &Path, name: &str) -> Result<(), String> {
    let ok = !name.is_empty()
        && name.len() <= 200
        && !name.starts_with('-')
        && git(root, &["check-ref-format", "--branch", name]).is_ok();
    if ok {
        Ok(())
    } else {
        Err(format!("«{name}» no es un nombre de rama válido."))
    }
}

fn explain_switch_error(raw: &str) -> String {
    if raw.contains("would be overwritten") {
        "Tienes cambios que chocan con esa rama: haz commit o guárdalos en el stash primero.".into()
    } else if raw.contains("already exists") {
        "Ya existe una rama con ese nombre.".into()
    } else if raw.contains("is already checked out at")
        || raw.contains("is already used by worktree")
    {
        "Esa rama ya está abierta en otro worktree.".into()
    } else {
        raw.trim().to_owned()
    }
}

/// `create`: new branch from HEAD. `remote`: `origin/x` → local `x` tracking it.
fn switch(root: &Path, name: &str, create: bool, remote: bool) -> Result<(), String> {
    valid_branch(root, name)?;
    let args: Vec<&str> = if create {
        vec!["switch", "-c", name]
    } else if remote {
        vec!["switch", "--track", name]
    } else {
        vec!["switch", name]
    };
    git(root, &args)
        .map(|_| ())
        .map_err(|e| explain_switch_error(&e))
}

#[tauri::command]
pub async fn git_switch(
    root: String,
    name: String,
    create: bool,
    remote: bool,
) -> Result<(), String> {
    blocking(move || switch(&checked_root(&root)?, &name, create, remote)).await
}

// ---------------------------------------------------------------------------
// Stash
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StashEntry {
    pub index: u32,
    /// "On main: wip" / "WIP on main: abc123 subject"
    pub message: String,
    pub created_at: i64,
}

fn parse_stash(raw: &str) -> Vec<StashEntry> {
    raw.lines()
        .filter_map(|line| {
            let mut f = line.splitn(3, '\0');
            let selector = f.next()?;
            let index = selector
                .strip_prefix("stash@{")?
                .strip_suffix('}')?
                .parse()
                .ok()?;
            Some(StashEntry {
                index,
                created_at: f.next()?.parse().unwrap_or(0),
                message: f.next()?.to_owned(),
            })
        })
        .collect()
}

#[tauri::command]
pub async fn git_stash_list(root: String) -> Result<Vec<StashEntry>, String> {
    blocking(move || {
        let root = checked_root(&root)?;
        git(&root, &["stash", "list", "--format=%gd%x00%ct%x00%gs"]).map(|raw| parse_stash(&raw))
    })
    .await
}

fn stash_push(root: &Path, message: &str, include_untracked: bool) -> Result<(), String> {
    let message: String = message
        .chars()
        .filter(|c| !c.is_control())
        .take(200)
        .collect();
    let mut args = vec!["stash", "push"];
    if include_untracked {
        args.push("--include-untracked");
    }
    if !message.trim().is_empty() {
        args.extend(["-m", message.trim()]);
    }
    let out = git(root, &args)?;
    if out.contains("No local changes to save") {
        return Err("No hay cambios que guardar.".into());
    }
    Ok(())
}

#[tauri::command]
pub async fn git_stash_push(
    root: String,
    message: String,
    include_untracked: bool,
) -> Result<(), String> {
    blocking(move || stash_push(&checked_root(&root)?, &message, include_untracked)).await
}

/// `action`: apply · pop · drop.
fn stash_action(root: &Path, action: &str, index: u32) -> Result<(), String> {
    if !matches!(action, "apply" | "pop" | "drop") {
        return Err("Acción de stash inválida.".into());
    }
    let selector = format!("stash@{{{index}}}");
    git(root, &["stash", action, &selector])
        .map(|_| ())
        .map_err(|e| {
            if e.contains("CONFLICT") || e.contains("conflict") {
                "Se aplicó con conflictos: resuélvelos en Cambios. El stash se conservó.".into()
            } else if e.contains("would be overwritten") {
                "Tus cambios actuales chocan con el stash: haz commit o guárdalos antes.".into()
            } else {
                e
            }
        })
}

#[tauri::command]
pub async fn git_stash_action(root: String, action: String, index: u32) -> Result<(), String> {
    blocking(move || stash_action(&checked_root(&root)?, &action, index)).await
}

// ---------------------------------------------------------------------------
// Merge / rebase in progress, conflicts
// ---------------------------------------------------------------------------

/// The repository's git dir, also for linked worktrees (`.git` is a file).
fn git_dir(root: &Path) -> Option<PathBuf> {
    let dot = root.join(".git");
    if dot.is_dir() {
        return Some(dot);
    }
    let text = std::fs::read_to_string(&dot).ok()?;
    let dir = PathBuf::from(text.strip_prefix("gitdir:")?.trim());
    Some(if dir.is_absolute() {
        dir
    } else {
        root.join(dir)
    })
}

/// merge · rebase · cherry-pick · revert, if one is waiting to be finished.
pub(crate) fn operation(root: &Path) -> Option<&'static str> {
    let dir = git_dir(root)?;
    if dir.join("rebase-merge").is_dir() || dir.join("rebase-apply").is_dir() {
        Some("rebase")
    } else if dir.join("MERGE_HEAD").is_file() {
        Some("merge")
    } else if dir.join("CHERRY_PICK_HEAD").is_file() {
        Some("cherry-pick")
    } else if dir.join("REVERT_HEAD").is_file() {
        Some("revert")
    } else {
        None
    }
}

/// Continue or abort the operation in progress. Continuing keeps git's
/// default messages (no editor can open here).
fn finish_operation(root: &Path, abort: bool) -> Result<(), String> {
    let op = operation(root).ok_or("No hay ninguna operación en curso.")?;
    let flag = if abort { "--abort" } else { "--continue" };
    let mut cmd = command(root);
    // `:` es "sin editor" para git en todas las plataformas; `true` necesitaría
    // un `true.exe` en el PATH de Windows.
    cmd.args([op, flag]).env("GIT_EDITOR", ":");
    let out = proc::run(cmd, None, LOCAL, 256 * 1024).map_err(|e| format!("git {e}"))?;
    if out.success() {
        Ok(())
    } else {
        let err = format!("{}\n{}", out.stdout_str(), out.stderr_str());
        Err(
            if err.contains("CONFLICT") || err.contains("unmerged") || err.contains("Unmerged") {
                "Aún quedan conflictos por resolver.".into()
            } else {
                err.trim().to_owned()
            },
        )
    }
}

#[tauri::command]
pub async fn git_operation_finish(root: String, abort: bool) -> Result<(), String> {
    blocking(move || finish_operation(&checked_root(&root)?, abort)).await
}

fn has_markers(text: &str) -> bool {
    text.lines().any(|l| {
        l.starts_with("<<<<<<< ")
            || l.starts_with(">>>>>>> ")
            || l == "======="
            || l == "<<<<<<<"
            || l == ">>>>>>>"
    })
}

/// Writes the resolved content of a conflicted file and marks it resolved.
/// Only files git lists as unmerged can be written this way.
fn resolve_conflict(root: &Path, path: &str, content: &str) -> Result<(), String> {
    let paths = [path.to_owned()];
    let path = checked_paths(&paths)?[0];
    let unmerged = git(root, &["diff", "--name-only", "--diff-filter=U", "-z"])?;
    if !unmerged.split('\0').any(|p| p == path) {
        return Err("Ese archivo no tiene conflictos.".into());
    }
    if has_markers(content) {
        return Err("Todavía quedan marcas de conflicto en el archivo.".into());
    }
    let canonical_root = root.canonicalize().map_err(|e| e.to_string())?;
    let target = canonical_root.join(path);
    // The parent must resolve inside the repo (no symlinked directories out of it).
    let parent = target
        .parent()
        .and_then(|p| p.canonicalize().ok())
        .ok_or("Ruta inválida.")?;
    if !parent.starts_with(&canonical_root) || target.is_symlink() {
        return Err("La ruta apunta fuera del proyecto.".into());
    }
    std::fs::write(&target, content).map_err(|e| format!("No se pudo guardar: {e}"))?;
    git(root, &["add", "--", path]).map(|_| ())
}

#[tauri::command]
pub async fn git_resolve_conflict(
    root: String,
    path: String,
    content: String,
) -> Result<(), String> {
    blocking(move || resolve_conflict(&checked_root(&root)?, &path, &content)).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn repo(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("termcode-br-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        git(&dir, &["init", "-q", "-b", "main"]).unwrap();
        git(&dir, &["config", "user.name", "t"]).unwrap();
        git(&dir, &["config", "user.email", "t@t"]).unwrap();
        fs::write(dir.join("a.txt"), "uno\ndos\ntres\n").unwrap();
        git(&dir, &["add", "."]).unwrap();
        git(&dir, &["commit", "-q", "-m", "base"]).unwrap();
        dir
    }

    #[test]
    fn parses_tracking_info() {
        assert_eq!(parse_track("ahead 2, behind 1"), (2, 1));
        assert_eq!(parse_track("behind 4"), (0, 4));
        assert_eq!(parse_track("gone"), (0, 0));
        let raw = "refs/heads/main|*|origin/main|ahead 1|100|init\n\
                   refs/remotes/origin/main| |||100|init\n\
                   refs/remotes/origin/HEAD| |||100|init\n\
                   refs/remotes/origin/feature| |||90|feat\n"
            .replace('|', "\0");
        let b = parse_branches(&raw);
        let names: Vec<_> = b
            .iter()
            .map(|b| (b.name.as_str(), b.remote, b.current))
            .collect();
        assert_eq!(
            names,
            vec![("main", false, true), ("origin/feature", true, false)]
        );
        assert_eq!(b[0].ahead, 1);
    }

    #[test]
    fn switches_and_validates_branch_names() {
        let dir = repo("switch");
        switch(&dir, "feature/x", true, false).unwrap();
        assert!(
            branches(&dir)
                .unwrap()
                .iter()
                .any(|b| b.name == "feature/x" && b.current)
        );
        switch(&dir, "main", false, false).unwrap();
        assert!(switch(&dir, "--orphan", true, false).is_err());
        assert!(switch(&dir, "a..b", true, false).is_err());
        assert!(
            switch(&dir, "feature/x", true, false)
                .unwrap_err()
                .contains("Ya existe")
        );
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn stashes_and_restores() {
        let dir = repo("stash");
        fs::write(dir.join("a.txt"), "UNO\ndos\ntres\n").unwrap();
        fs::write(dir.join("nuevo.txt"), "x\n").unwrap();
        stash_push(&dir, "a medias\u{7}", true).unwrap();
        assert_eq!(
            fs::read_to_string(dir.join("a.txt")).unwrap(),
            "uno\ndos\ntres\n"
        );
        assert!(!dir.join("nuevo.txt").exists());
        let list =
            parse_stash(&git(&dir, &["stash", "list", "--format=%gd%x00%ct%x00%gs"]).unwrap());
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].index, 0);
        assert!(list[0].message.ends_with("a medias"), "{}", list[0].message);
        assert!(
            stash_push(&dir, "", false)
                .unwrap_err()
                .contains("No hay cambios")
        );
        stash_action(&dir, "pop", 0).unwrap();
        assert!(dir.join("nuevo.txt").exists());
        assert!(stash_action(&dir, "clear", 0).is_err());
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn resolves_a_merge_conflict() {
        let dir = repo("conflict");
        git(&dir, &["switch", "-q", "-c", "otra"]).unwrap();
        fs::write(dir.join("a.txt"), "uno\nDOS (otra)\ntres\n").unwrap();
        git(&dir, &["commit", "-qam", "otra"]).unwrap();
        git(&dir, &["switch", "-q", "main"]).unwrap();
        fs::write(dir.join("a.txt"), "uno\nDOS (main)\ntres\n").unwrap();
        git(&dir, &["commit", "-qam", "main"]).unwrap();
        assert!(git(&dir, &["merge", "otra"]).is_err());
        assert_eq!(operation(&dir), Some("merge"));

        assert!(
            resolve_conflict(&dir, "a.txt", "<<<<<<< HEAD\nx\n=======\ny\n>>>>>>> otra\n").is_err()
        );
        assert!(resolve_conflict(&dir, "../fuera.txt", "x").is_err());
        assert!(
            resolve_conflict(&dir, "otro.txt", "x").is_err(),
            "not unmerged"
        );
        resolve_conflict(&dir, "a.txt", "uno\nDOS (ambas)\ntres\n").unwrap();
        finish_operation(&dir, false).unwrap();
        assert_eq!(operation(&dir), None);
        assert!(
            git(&dir, &["log", "-1", "--format=%s"])
                .unwrap()
                .contains("Merge")
        );
        fs::remove_dir_all(dir).unwrap();
    }
}
