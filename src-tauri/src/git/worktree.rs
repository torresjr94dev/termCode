//! Git worktrees for running several agents in parallel without them stepping
//! on each other's working copy.
//!
//! Layout: `<parent>/<repo>.worktrees/<label>-<n>` on branch `termcode/<label>-<n>`,
//! created from the current HEAD. Git is invoked directly (no shell), and the
//! label is validated, so no user input reaches a command line unescaped.

use super::git;
use std::path::{Path, PathBuf};
#[cfg(test)]
use std::process::Command;

fn valid_label(label: &str) -> bool {
    !label.is_empty()
        && label.len() <= 32
        && label
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
        && !label.starts_with('-')
}

fn create(cwd: &Path, label: &str) -> Result<PathBuf, String> {
    if !valid_label(label) {
        return Err("Etiqueta inválida para el worktree.".into());
    }
    let top = git(cwd, &["rev-parse", "--show-toplevel"])
        .map_err(|_| "La carpeta del panel no está dentro de un repositorio git.".to_owned())?;
    let top = super::native_path(&top);
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

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentWorktree {
    pub path: String,
    pub branch: String,
    /// Commit del que partió el agente: base de la comparación y del parche.
    pub base: String,
    /// Commits que el agente hizo en su rama.
    pub commits: usize,
    /// Archivos que difieren de `base` (commiteados o no, incluidos los nuevos).
    pub changed: usize,
    pub insertions: usize,
    pub deletions: usize,
}

/// Punto de bifurcación entre el worktree del agente y tu HEAD. Con él, lo que
/// el agente commiteó en su rama también cuenta como "su trabajo".
fn fork_base(worktree: &Path, target_head: &str) -> Result<String, String> {
    git(worktree, &["merge-base", "HEAD", target_head])
        .map(|s| s.trim().to_owned())
        .map_err(|_| "El worktree no comparte historia con tu rama.".to_owned())
}

/// Líneas de un archivo nuevo, para que "+N" no ignore lo que el agente creó.
/// Binarios y archivos enormes cuentan 0.
fn count_lines(path: &Path) -> usize {
    const MAX: u64 = 2 * 1024 * 1024;
    match std::fs::metadata(path) {
        Ok(meta) if meta.is_file() && meta.len() <= MAX => std::fs::read(path)
            .ok()
            .filter(|bytes| !bytes.contains(&0))
            .map(|bytes| {
                let newlines = bytes.iter().filter(|&&b| b == b'\n').count();
                newlines + usize::from(bytes.last().is_some_and(|&b| b != b'\n'))
            })
            .unwrap_or(0),
        _ => 0,
    }
}

fn stats(wt: &Path, base: &str) -> (usize, usize, usize) {
    let tracked = git(wt, &["diff", "--name-only", "-z", base]).unwrap_or_default();
    let untracked =
        git(wt, &["ls-files", "--others", "--exclude-standard", "-z"]).unwrap_or_default();
    let untracked: Vec<&str> = untracked.split('\0').filter(|p| !p.is_empty()).collect();
    let changed = tracked.split('\0').filter(|p| !p.is_empty()).count() + untracked.len();

    let (mut insertions, mut deletions) = (0, 0);
    for line in git(wt, &["diff", "--numstat", base])
        .unwrap_or_default()
        .lines()
    {
        let mut cols = line.split('\t');
        insertions += cols
            .next()
            .and_then(|n| n.parse::<usize>().ok())
            .unwrap_or(0);
        deletions += cols
            .next()
            .and_then(|n| n.parse::<usize>().ok())
            .unwrap_or(0);
    }
    insertions += untracked
        .iter()
        .map(|p| count_lines(&wt.join(p)))
        .sum::<usize>();
    (changed, insertions, deletions)
}

/// Worktrees creados por termCode (ramas `termcode/…`) del repo de `root`,
/// comparados con el HEAD de `root`.
fn list(root: &Path) -> Result<Vec<AgentWorktree>, String> {
    let raw = git(root, &["worktree", "list", "--porcelain"])?;
    let head = git(root, &["rev-parse", "HEAD"])?.trim().to_owned();
    let mut out = Vec::new();
    for block in raw.split("\n\n") {
        let path = block.lines().find_map(|l| l.strip_prefix("worktree "));
        let branch = block
            .lines()
            .find_map(|l| l.strip_prefix("branch refs/heads/"));
        let (Some(path), Some(branch)) = (path, branch) else {
            continue;
        };
        if !branch.starts_with("termcode/") {
            continue;
        }
        let wt = super::native_path(path);
        let wt = wt.as_path();
        let Ok(base) = fork_base(wt, &head) else {
            continue;
        };
        let commits = git(wt, &["rev-list", "--count", &format!("{base}..HEAD")])
            .ok()
            .and_then(|n| n.trim().parse().ok())
            .unwrap_or(0);
        let (changed, insertions, deletions) = stats(wt, &base);
        out.push(AgentWorktree {
            path: wt.to_string_lossy().into_owned(),
            branch: branch.to_owned(),
            base,
            commits,
            changed,
            insertions,
            deletions,
        });
    }
    Ok(out)
}

#[tauri::command]
pub async fn git_worktree_list(root: String) -> Result<Vec<AgentWorktree>, String> {
    tauri::async_runtime::spawn_blocking(move || list(Path::new(&root)))
        .await
        .map_err(|e| e.to_string())?
}

/// Trae a tu árbol de trabajo todo lo que el agente hizo en su worktree desde
/// que se bifurcó (commits, cambios y archivos nuevos), sin commitear, con
/// `--3way` para conflictos razonables.
fn apply(source: &Path, target: &Path) -> Result<usize, String> {
    let branch = git(source, &["rev-parse", "--abbrev-ref", "HEAD"])?;
    if !branch.trim().starts_with("termcode/") {
        return Err("Solo se aplican worktrees creados por termCode.".into());
    }
    let head = git(target, &["rev-parse", "HEAD"])?.trim().to_owned();
    let base = fork_base(source, &head)?;
    // El worktree es del agente: preparar todo ahí no toca tu repo.
    git(source, &["add", "-A"])?;
    let patch = git(source, &["diff", "--cached", "--binary", &base])?;
    if patch.trim().is_empty() {
        return Err("Ese agente no dejó cambios.".into());
    }
    let files = patch
        .lines()
        .filter(|l| l.starts_with("diff --git "))
        .count();
    let mut cmd = super::command(target);
    cmd.args(["apply", "--3way", "--whitespace=nowarn", "-"]);
    let out = crate::proc::run(
        cmd,
        Some(patch.into_bytes()),
        std::time::Duration::from_secs(30),
        64 * 1024,
    )
    .map_err(|e| e.to_string())?;
    if out.success() {
        Ok(files)
    } else {
        Err(format!("No se pudo aplicar limpio: {}", out.stderr_str()))
    }
}

#[tauri::command]
pub async fn git_worktree_apply(source: String, target: String) -> Result<usize, String> {
    tauri::async_runtime::spawn_blocking(move || apply(Path::new(&source), Path::new(&target)))
        .await
        .map_err(|e| e.to_string())?
}

/// Borra el worktree y su rama `termcode/…` (el trabajo no aplicado se pierde).
fn remove(root: &Path, path: &Path) -> Result<(), String> {
    let branch = git(path, &["rev-parse", "--abbrev-ref", "HEAD"])?
        .trim()
        .to_owned();
    if !branch.starts_with("termcode/") {
        return Err("Solo se eliminan worktrees creados por termCode.".into());
    }
    let path_str = path.to_str().ok_or("Ruta no UTF-8.")?;
    git(root, &["worktree", "remove", "--force", path_str])?;
    git(root, &["branch", "-D", &branch])?;
    Ok(())
}

#[tauri::command]
pub async fn git_worktree_remove(root: String, path: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || remove(Path::new(&root), Path::new(&path)))
        .await
        .map_err(|e| e.to_string())?
}

// ---------------------------------------------------------------------------
// Juez de la carrera: tu comando de verificación en el worktree de cada agente
// ---------------------------------------------------------------------------

const VERIFY_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(15 * 60);
/// Se lee mucho y se guarda la cola: el resumen de un test runner va al final.
const VERIFY_READ: usize = 8 * 1024 * 1024;
const VERIFY_TAIL: usize = 24 * 1024;
const MAX_VERIFY_COMMAND: usize = 2000;

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VerifyResult {
    /// `None`: no terminó (tiempo agotado o lo mató una señal).
    pub code: Option<i32>,
    pub timed_out: bool,
    /// Últimos KB de stdout+stderr, en orden y sin colores.
    pub output: String,
    pub duration_ms: u64,
}

fn tail(text: &str, max: usize) -> String {
    if text.len() <= max {
        return text.to_owned();
    }
    let mut start = text.len() - max;
    while !text.is_char_boundary(start) {
        start += 1;
    }
    format!("…\n{}", &text[start..])
}

/// Tu comando, tal cual lo escribiste, en tu shell de login (tu PATH: nvm,
/// brew…). `exec 2>&1` junta stderr con stdout respetando el orden.
#[cfg(unix)]
fn verify_command(command: &str) -> std::process::Command {
    let mut cmd = crate::agents::tool_command(&pty_core::user_shell());
    cmd.args(["-l", "-c", &format!("exec 2>&1\n{command}")]);
    cmd
}

/// En Windows, PowerShell (la misma que usan los paneles): `2>&1` junta los
/// flujos. El código es el del último programa si corrió alguno (en 5.1, `$?`
/// sale falso con cualquier línea en stderr aunque el programa salga con 0); si
/// solo hubo cmdlets, 1 cuando fallaron.
#[cfg(windows)]
fn verify_command(command: &str) -> std::process::Command {
    let mut cmd = crate::agents::tool_command(pty_core::powershell().unwrap_or("powershell.exe"));
    cmd.args([
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        &format!(
            "$global:LASTEXITCODE = $null; & {{ {command} }} 2>&1; $ok = $?; \
             if ($null -ne $global:LASTEXITCODE) {{ exit $global:LASTEXITCODE }}; if ($ok) {{ exit 0 }}; exit 1"
        ),
    ]);
    cmd
}

fn verify(worktree: &Path, command: &str) -> Result<VerifyResult, String> {
    let command = command.trim();
    if command.is_empty() || command.len() > MAX_VERIFY_COMMAND || command.contains('\0') {
        return Err("Comando de verificación inválido.".into());
    }
    let branch = git(worktree, &["rev-parse", "--abbrev-ref", "HEAD"])?;
    if !branch.trim().starts_with("termcode/") {
        return Err("Solo se verifican worktrees creados por termCode.".into());
    }
    let mut cmd = verify_command(command);
    cmd.current_dir(worktree)
        .env("CI", "1")
        .env("NO_COLOR", "1")
        .env("FORCE_COLOR", "0");
    let started = std::time::Instant::now();
    let result = crate::proc::run(cmd, None, VERIFY_TIMEOUT, VERIFY_READ);
    let duration_ms = started.elapsed().as_millis() as u64;
    match result {
        Ok(out) => Ok(VerifyResult {
            code: out.code,
            timed_out: false,
            output: tail(&crate::mcp::strip_ansi(&out.stdout), VERIFY_TAIL),
            duration_ms,
        }),
        Err(crate::proc::RunError::Timeout) => Ok(VerifyResult {
            code: None,
            timed_out: true,
            output: format!("Se canceló tras {} min.", VERIFY_TIMEOUT.as_secs() / 60),
            duration_ms,
        }),
        Err(e) => Err(e.to_string()),
    }
}

#[tauri::command]
pub async fn git_worktree_verify(
    worktree: String,
    command: String,
) -> Result<VerifyResult, String> {
    tauri::async_runtime::spawn_blocking(move || verify(Path::new(&worktree), &command))
        .await
        .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keeps_the_tail_of_long_output_on_char_boundaries() {
        assert_eq!(tail("corto", 10), "corto");
        let long = format!("{}ñfin", "x".repeat(100));
        let cut = tail(&long, 4);
        assert!(cut.ends_with("fin"));
        assert!(cut.starts_with("…\n"));
    }

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

        // Un agente commitea una parte y deja otra sin commitear: ambas son su trabajo.
        std::fs::write(first.join("plan.md"), "uno\ndos\n").unwrap();
        git(&first, &["add", "plan.md"]).unwrap();
        git(
            &first,
            &[
                "-c",
                "user.name=t",
                "-c",
                "user.email=t@t",
                "commit",
                "-q",
                "-m",
                "plan",
            ],
        )
        .unwrap();
        std::fs::write(first.join("idea.txt"), "del agente\n").unwrap();
        let listed = list(&repo).unwrap();
        assert_eq!(listed.len(), 2);
        let wt = listed
            .iter()
            .find(|w| w.branch == "termcode/claude-1")
            .unwrap();
        assert_eq!((wt.commits, wt.changed, wt.insertions), (1, 2, 3));
        assert_eq!(apply(&first, &repo).unwrap(), 2);
        assert_eq!(
            std::fs::read_to_string(repo.join("idea.txt")).unwrap(),
            "del agente\n"
        );
        assert_eq!(
            std::fs::read_to_string(repo.join("plan.md")).unwrap(),
            "uno\ndos\n"
        );
        assert!(apply(&second, &repo).is_err(), "sin cambios");
        assert!(
            apply(&repo, &repo).is_err(),
            "el repo principal no es un worktree de termCode"
        );
        // El juez solo corre en worktrees de termCode y con un comando razonable.
        assert!(
            verify(&repo, "true").is_err(),
            "el repo principal no se verifica"
        );
        assert!(verify(&first, "   ").is_err());
        assert!(verify(&first, &"x".repeat(MAX_VERIFY_COMMAND + 1)).is_err());

        remove(&repo, &first).unwrap();
        remove(&repo, &second).unwrap();
        assert!(list(&repo).unwrap().is_empty());

        std::fs::remove_dir_all(root).unwrap();
    }

    /// Lanza tu shell de login de verdad (lento y depende de la máquina): `cargo test -- --ignored`.
    #[test]
    #[ignore]
    fn verify_runs_the_command_in_the_worktree() {
        let root = std::env::temp_dir().join(format!("termcode-verify-{}", std::process::id()));
        let repo = root.join("demo");
        std::fs::create_dir_all(&repo).unwrap();
        git(&repo, &["init", "-q", "-b", "main"]).unwrap();
        git(
            &repo,
            &[
                "-c",
                "user.name=t",
                "-c",
                "user.email=t@t",
                "commit",
                "-q",
                "--allow-empty",
                "-m",
                "init",
            ],
        )
        .unwrap();
        let wt = create(&repo, "claude").unwrap();

        let out = verify(&wt, "printf 'ok\\n'; echo fallo >&2; pwd; exit 3").unwrap();
        assert_eq!(out.code, Some(3));
        assert!(!out.timed_out);
        assert!(
            out.output.contains("ok\nfallo"),
            "stderr en orden: {:?}",
            out.output
        );
        assert!(
            out.output.contains("claude-1"),
            "corre dentro del worktree: {:?}",
            out.output
        );
        assert_eq!(verify(&wt, "test \"$CI\" = 1").unwrap().code, Some(0));

        remove(&repo, &wt).unwrap();
        std::fs::remove_dir_all(root).unwrap();
    }
}
