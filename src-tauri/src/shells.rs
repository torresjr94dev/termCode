//! Shells instaladas, para abrir una pestaña con la que quieras (zsh, bash,
//! fish, nu, PowerShell…). Solo se listan ejecutables que existen; la
//! predeterminada es la tuya (`$SHELL` en macOS/Linux, PowerShell en Windows).

use serde::Serialize;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShellInfo {
    /// `zsh`, `bash`, `pwsh`…
    pub name: String,
    pub path: String,
    /// Con qué se lanza (p. ej. `-l`: shell de login, con tu PATH completo).
    pub args: Vec<String>,
    /// La de siempre: se lanza sin `program` (conserva la integración de cada sistema).
    pub default: bool,
}

/// Shells interactivas conocidas y sus argumentos de login.
fn login_args(name: &str) -> Option<Vec<String>> {
    let args: &[&str] = match name {
        "zsh" | "bash" | "fish" | "sh" | "dash" | "ksh" | "tcsh" | "csh" | "nu" => &["-l"],
        "pwsh" | "pwsh-preview" => &["-NoLogo", "-Login"],
        "elvish" | "xonsh" => &[],
        _ => return None,
    };
    Some(args.iter().map(|a| (*a).to_owned()).collect())
}

#[tauri::command]
pub async fn shells_available() -> Vec<ShellInfo> {
    tauri::async_runtime::spawn_blocking(list)
        .await
        .unwrap_or_default()
}

#[cfg(unix)]
fn list() -> Vec<ShellInfo> {
    let mut candidates: Vec<PathBuf> = std::fs::read_to_string("/etc/shells")
        .unwrap_or_default()
        .lines()
        .map(str::trim)
        .filter(|l| l.starts_with('/'))
        .map(PathBuf::from)
        .collect();
    // Las de Homebrew y similares no siempre están en /etc/shells.
    for dir in ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"] {
        for name in ["zsh", "bash", "fish", "nu", "pwsh", "elvish", "xonsh"] {
            candidates.push(Path::new(dir).join(name));
        }
    }
    build(candidates, &pty_core::user_shell())
}

#[cfg(windows)]
fn list() -> Vec<ShellInfo> {
    let mut found = Vec::new();
    let default = pty_core::powershell();
    for exe in ["pwsh.exe", "powershell.exe"] {
        if let Some(path) = which(exe) {
            found.push(ShellInfo {
                name: exe.trim_end_matches(".exe").to_owned(),
                path: path.to_string_lossy().into_owned(),
                args: vec!["-NoLogo".into()],
                default: default == Some(exe),
            });
        }
    }
    let system = std::env::var_os("SystemRoot").map(|r| PathBuf::from(r).join("System32"));
    if let Some(cmd) = system
        .as_ref()
        .map(|s| s.join("cmd.exe"))
        .filter(|p| p.is_file())
    {
        found.push(ShellInfo {
            name: "cmd".into(),
            path: cmd.to_string_lossy().into_owned(),
            args: Vec::new(),
            default: default.is_none(),
        });
    }
    let git_bash = ["ProgramFiles", "ProgramW6432", "LOCALAPPDATA"]
        .iter()
        .filter_map(std::env::var_os)
        .flat_map(|root| {
            let root = PathBuf::from(root);
            [
                root.join(r"Git\bin\bash.exe"),
                root.join(r"Programs\Git\bin\bash.exe"),
            ]
        })
        .find(|p| p.is_file());
    if let Some(bash) = git_bash {
        found.push(ShellInfo {
            name: "Git Bash".into(),
            path: bash.to_string_lossy().into_owned(),
            args: vec!["--login".into(), "-i".into()],
            default: false,
        });
    }
    if let Some(wsl) = system.map(|s| s.join("wsl.exe")).filter(|p| p.is_file()) {
        found.push(ShellInfo {
            name: "WSL".into(),
            path: wsl.to_string_lossy().into_owned(),
            args: Vec::new(),
            default: false,
        });
    }
    found
}

#[cfg(windows)]
fn which(program: &str) -> Option<PathBuf> {
    std::env::var_os("PATH").and_then(|paths| {
        std::env::split_paths(&paths)
            .map(|dir| dir.join(program))
            .find(|p| p.is_file())
    })
}

/// Ejecutables que existen, sin repetir (`/bin/sh` y su enlace cuentan una vez),
/// la predeterminada primero y el resto por nombre.
#[cfg_attr(not(unix), allow(dead_code))]
fn build(candidates: Vec<PathBuf>, default_shell: &str) -> Vec<ShellInfo> {
    let real = |p: &Path| p.canonicalize().unwrap_or_else(|_| p.to_owned());
    let default_real = real(Path::new(default_shell));
    let mut seen = std::collections::HashSet::new();
    let mut shells: Vec<ShellInfo> = candidates
        .into_iter()
        .filter(|p| is_executable(p))
        .filter_map(|path| {
            let name = path.file_name()?.to_str()?.to_owned();
            let args = login_args(&name)?;
            let canonical = real(&path);
            if !seen.insert(canonical.clone()) {
                return None;
            }
            Some(ShellInfo {
                default: canonical == default_real,
                path: path.to_string_lossy().into_owned(),
                name,
                args,
            })
        })
        .collect();
    shells.sort_by(|a, b| {
        b.default
            .cmp(&a.default)
            .then_with(|| a.name.cmp(&b.name))
            .then_with(|| a.path.cmp(&b.path))
    });
    shells
}

#[cfg(unix)]
fn is_executable(path: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    path.metadata()
        .is_ok_and(|m| m.is_file() && m.permissions().mode() & 0o111 != 0)
}

#[cfg(not(unix))]
#[allow(dead_code)]
fn is_executable(path: &Path) -> bool {
    path.is_file()
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;

    #[test]
    fn lists_real_shells_once_with_the_default_first() {
        let shells = build(
            vec![
                PathBuf::from("/bin/sh"),
                PathBuf::from("/bin/sh"),
                PathBuf::from("/bin/no-existe"),
                PathBuf::from("/bin/ls"),
            ],
            "/bin/sh",
        );
        assert_eq!(shells.len(), 1, "{shells:?}");
        assert!(shells[0].default);
        assert_eq!(shells[0].args, vec!["-l"]);
    }

    #[test]
    fn knows_how_to_log_in() {
        assert_eq!(login_args("pwsh").unwrap(), vec!["-NoLogo", "-Login"]);
        assert_eq!(login_args("fish").unwrap(), vec!["-l"]);
        assert!(login_args("python3").is_none());
    }

    #[test]
    fn finds_the_users_shell() {
        let shells = list();
        assert!(shells.iter().any(|s| s.default), "{shells:?}");
    }
}
