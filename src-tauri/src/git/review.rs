//! Reviewing what an agent changed, hunk by hunk, and applying partial patches.
//!
//! The baseline is the snapshot the `UserPromptSubmit` hook took
//! (`git stash create`, or HEAD when the tree was clean): comparing it with the
//! working tree shows exactly what happened since, including files the agent
//! created. Reverting a hunk applies it in reverse to the working tree.

use super::{
    CommitFile, DiffText, blocking, checked_paths, checked_root, diff, git, parse_name_status,
    run_raw, valid_rev,
};
use std::collections::HashSet;
use std::path::Path;
use std::time::Duration;

const MAX_PATCH: usize = 8 * 1024 * 1024;

/// Applies a patch (one or more hunks) to the working tree or, with `cached`,
/// to the index. `reverse` undoes it. Used for: staging/unstaging a hunk,
/// discarding a hunk, and rejecting part of an agent's work.
pub(crate) fn apply_patch(
    root: &Path,
    patch: &str,
    reverse: bool,
    cached: bool,
) -> Result<(), String> {
    if patch.len() > MAX_PATCH || !patch.contains("@@") {
        return Err("Parche inválido.".into());
    }
    let mut args = vec!["apply", "--whitespace=nowarn", "--recount"];
    if cached {
        args.push("--cached");
    }
    if reverse {
        args.push("-R");
    }
    args.push("-");
    let out = run_raw(
        root,
        &args,
        Some(patch.as_bytes().to_vec()),
        Duration::from_secs(20),
        64 * 1024,
    )?;
    if out.success() {
        Ok(())
    } else {
        let err = out.stderr_str();
        Err(if err.contains("patch does not apply") {
            "El archivo cambió desde que se calculó el diff: recárgalo e inténtalo de nuevo.".into()
        } else {
            err
        })
    }
}

#[tauri::command]
pub async fn git_apply_patch(
    root: String,
    patch: String,
    reverse: bool,
    cached: bool,
) -> Result<(), String> {
    blocking(move || apply_patch(&checked_root(&root)?, &patch, reverse, cached)).await
}

fn untracked(root: &Path) -> Result<HashSet<String>, String> {
    Ok(
        git(root, &["ls-files", "--others", "--exclude-standard", "-z"])?
            .split('\0')
            .filter(|p| !p.is_empty())
            .map(str::to_owned)
            .collect(),
    )
}

/// Files that differ between the baseline and the working tree, plus files
/// created since (untracked now, not untracked at the baseline).
pub(crate) fn changed_since(
    root: &Path,
    base: &str,
    baseline_untracked: &[String],
) -> Result<Vec<CommitFile>, String> {
    if !valid_rev(base) {
        return Err("Base inválida.".into());
    }
    let mut files = parse_name_status(&git(
        root,
        &["diff", "--name-status", "-z", "-M", "--no-color", base],
    )?);
    let before: HashSet<&str> = baseline_untracked.iter().map(String::as_str).collect();
    let mut created: Vec<String> = untracked(root)?
        .into_iter()
        .filter(|p| !before.contains(p.as_str()))
        .collect();
    created.sort();
    files.extend(created.into_iter().map(|path| CommitFile {
        status: 'A',
        path,
        orig_path: None,
    }));
    Ok(files)
}

#[tauri::command]
pub async fn review_files(
    root: String,
    base: String,
    baseline_untracked: Vec<String>,
) -> Result<Vec<CommitFile>, String> {
    blocking(move || changed_since(&checked_root(&root)?, &base, &baseline_untracked)).await
}

/// `created`: the file did not exist at the baseline (diffed against nothing).
#[tauri::command]
pub async fn review_diff(
    root: String,
    base: String,
    path: String,
    orig_path: Option<String>,
    created: bool,
) -> Result<DiffText, String> {
    blocking(move || {
        let root = checked_root(&root)?;
        if !valid_rev(&base) {
            return Err("Base inválida.".into());
        }
        let mut paths = vec![path];
        paths.extend(orig_path);
        let paths = checked_paths(&paths)?;
        if created {
            diff(
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
            )
        } else {
            diff(
                &root,
                &[
                    &["diff", "--no-color", "--no-ext-diff", "-M", &base, "--"][..],
                    &paths,
                ]
                .concat(),
                &[0],
            )
        }
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn repo(name: &str) -> std::path::PathBuf {
        let dir =
            std::env::temp_dir().join(format!("termcode-review-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        git(&dir, &["init", "-q", "-b", "main"]).unwrap();
        git(&dir, &["config", "user.name", "t"]).unwrap();
        git(&dir, &["config", "user.email", "t@t"]).unwrap();
        fs::write(
            dir.join("a.txt"),
            "uno\ndos\ntres\ncuatro\ncinco\nseis\nsiete\nocho\nnueve\ndiez\n",
        )
        .unwrap();
        git(&dir, &["add", "."]).unwrap();
        git(&dir, &["commit", "-q", "-m", "base"]).unwrap();
        dir
    }

    #[test]
    fn lists_changes_since_baseline_including_new_files() {
        let dir = repo("since");
        fs::write(dir.join("previo.txt"), "ya estaba").unwrap(); // sin seguimiento antes del agente
        let base = git(&dir, &["rev-parse", "HEAD"]).unwrap().trim().to_owned();
        // "El agente" edita y crea.
        fs::write(
            dir.join("a.txt"),
            "UNO\ndos\ntres\ncuatro\ncinco\nseis\nsiete\nocho\nnueve\nDIEZ\n",
        )
        .unwrap();
        fs::write(dir.join("nuevo.rs"), "fn main() {}\n").unwrap();

        let files = changed_since(&dir, &base, &["previo.txt".into()]).unwrap();
        let summary: Vec<_> = files.iter().map(|f| (f.status, f.path.as_str())).collect();
        assert_eq!(summary, vec![('M', "a.txt"), ('A', "nuevo.rs")]);
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn reverts_a_single_hunk() {
        let dir = repo("hunk");
        let base = git(&dir, &["rev-parse", "HEAD"]).unwrap().trim().to_owned();
        fs::write(
            dir.join("a.txt"),
            "UNO\ndos\ntres\ncuatro\ncinco\nseis\nsiete\nocho\nnueve\nDIEZ\n",
        )
        .unwrap();

        // Dos fragmentos separados (-U1): se revierte solo el primero.
        let full = git(&dir, &["diff", "-U1", &base, "--", "a.txt"]).unwrap();
        let header: String = full
            .lines()
            .take_while(|l| !l.starts_with("@@"))
            .map(|l| format!("{l}\n"))
            .collect();
        let first_hunk: String = full
            .lines()
            .skip_while(|l| !l.starts_with("@@"))
            .enumerate()
            .take_while(|(i, l)| *i == 0 || !l.starts_with("@@"))
            .map(|(_, l)| format!("{l}\n"))
            .collect();
        apply_patch(&dir, &format!("{header}{first_hunk}"), true, false).unwrap();
        assert_eq!(
            fs::read_to_string(dir.join("a.txt")).unwrap(),
            "uno\ndos\ntres\ncuatro\ncinco\nseis\nsiete\nocho\nnueve\nDIEZ\n"
        );

        // Aplicar el mismo parche otra vez ya no encaja: error legible.
        let err = apply_patch(&dir, &format!("{header}{first_hunk}"), true, false).unwrap_err();
        assert!(err.contains("cambió"), "{err}");
        assert!(apply_patch(&dir, "no es un parche", false, false).is_err());
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn stages_a_single_hunk() {
        let dir = repo("stage");
        fs::write(
            dir.join("a.txt"),
            "UNO\ndos\ntres\ncuatro\ncinco\nseis\nsiete\nocho\nnueve\nDIEZ\n",
        )
        .unwrap();
        let full = git(&dir, &["diff", "-U1", "--", "a.txt"]).unwrap();
        let header: String = full
            .lines()
            .take_while(|l| !l.starts_with("@@"))
            .map(|l| format!("{l}\n"))
            .collect();
        let last_hunk: String = {
            let start = full.rfind("\n@@").unwrap() + 1;
            full[start..].to_owned()
        };
        apply_patch(&dir, &format!("{header}{last_hunk}"), false, true).unwrap();
        let staged = git(&dir, &["diff", "--cached"]).unwrap();
        assert!(
            staged.contains("+DIEZ") && !staged.contains("+UNO"),
            "{staged}"
        );
        fs::remove_dir_all(dir).unwrap();
    }
}
