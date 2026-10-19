//! Git worktrees for running several agents in parallel without them stepping
//! on each other's working copy.
//!
//! Layout: `<parent>/<repo>.worktrees/<label>-<n>` on branch `termcode/<label>-<n>`,
//! created from the current HEAD. Git is invoked directly (no shell), and the
//! label is validated, so no user input reaches a command line unescaped.

use std::path::{Path, PathBuf};
use std::process::Command;

fn valid_label(label: &str) -> bool {
    !label.is_empty()
        && label.len() <= 32
        && label
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
        && !label.starts_with('-')
}

fn git(dir: &Path, args: &[&str]) -> Result<String, String> {
    let out = Command::new("git")
        .arg("-C")
        .arg(dir)
        .args(args)
        .output()
        .map_err(|e| format!("No se pudo ejecutar git: {e}"))?;
    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).trim().to_owned())
    } else {
        Err(String::from_utf8_lossy(&out.stderr).trim().to_owned())
    }
}

fn create(cwd: &Path, label: &str) -> Result<PathBuf, String> {
    if !valid_label(label) {
        return Err("Etiqueta inválida para el worktree.".into());
    }
    let top = git(cwd, &["rev-parse", "--show-toplevel"])
        .map_err(|_| "La carpeta del panel no está dentro de un repositorio git.".to_owned())?;
    let top = PathBuf::from(top);
    let name = top
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or("Ruta de repositorio inválida.")?;
    let base = top
        .parent()
        .ok_or("El repositorio no tiene carpeta padre.")?
        .join(format!("{name}.worktrees"));

    for n in 1..=99 {
        let dir = base.join(format!("{label}-{n}"));
        let branch = format!("termcode/{label}-{n}");
        let branch_taken = git(
            &top,
            &[
                "rev-parse",
                "--verify",
                "--quiet",
                &format!("refs/heads/{branch}"),
            ],
        )
        .is_ok();
        if dir.exists() || branch_taken {
            continue;
        }
        let dir_str = dir.to_str().ok_or("Ruta de worktree no UTF-8.")?;
        git(&top, &["worktree", "add", "-b", &branch, dir_str, "HEAD"])
            .map_err(|e| format!("git worktree add falló: {e}"))?;
        return Ok(dir);
    }
    Err("Hay demasiados worktrees con esa etiqueta.".into())
}

/// Creates a worktree next to the repository that contains `cwd` and returns its path.
#[tauri::command]
pub async fn git_worktree_create(cwd: String, label: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || create(Path::new(&cwd), &label))
        .await
        .map_err(|e| e.to_string())?
        .map(|p| p.to_string_lossy().into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validates_labels() {
        assert!(valid_label("claude"));
        assert!(valid_label("codex-2"));
        assert!(!valid_label("-rm"));
        assert!(!valid_label("a b"));
        assert!(!valid_label("../x"));
        assert!(!valid_label(""));
    }

    #[test]
    fn creates_worktree_next_to_repo() {
        let root = std::env::temp_dir().join(format!("termcode-git-{}", std::process::id()));
        let repo = root.join("demo");
        std::fs::create_dir_all(&repo).unwrap();
        let run = |args: &[&str]| {
            assert!(
                Command::new("git")
                    .arg("-C")
                    .arg(&repo)
                    .args(args)
                    .output()
                    .unwrap()
                    .status
                    .success()
            )
        };
        run(&["init", "-q", "-b", "main"]);
        run(&[
            "-c",
            "user.name=t",
            "-c",
            "user.email=t@t",
            "commit",
            "-q",
            "--allow-empty",
            "-m",
            "init",
        ]);

        let first = create(&repo.join("."), "claude").unwrap();
        let second = create(&repo, "claude").unwrap();
        assert!(first.ends_with("demo.worktrees/claude-1"));
        assert!(second.ends_with("demo.worktrees/claude-2"));
        assert!(first.join(".git").exists());
        assert!(create(&root, "claude").is_err(), "outside a repo");

        std::fs::remove_dir_all(root).unwrap();
    }
}
