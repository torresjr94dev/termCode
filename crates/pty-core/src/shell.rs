//! Default shell detection and command construction.

use crate::session::SpawnOptions;
use portable_pty::CommandBuilder;

/// Builds the command for a session, applying terminal environment variables.
pub fn build_command(opts: &SpawnOptions) -> CommandBuilder {
    let mut cmd = match &opts.program {
        Some(program) => {
            let mut c = CommandBuilder::new(program);
            c.args(&opts.args);
            c
        }
        None => default_shell(),
    };

    let cwd = opts
        .cwd
        .clone()
        .filter(|p| p.is_dir())
        .or_else(home_dir);
    if let Some(cwd) = cwd {
        cmd.cwd(cwd);
    }

    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");
    cmd.env("TERM_PROGRAM", "termCode");
    cmd.env("TERM_PROGRAM_VERSION", env!("CARGO_PKG_VERSION"));
    // Apps launched from Finder/Explorer may lack a UTF-8 locale.
    if std::env::var_os("LANG").is_none() {
        cmd.env("LANG", "en_US.UTF-8");
    }
    for (k, v) in &opts.env {
        cmd.env(k, v);
    }
    cmd
}

#[cfg(unix)]
fn default_shell() -> CommandBuilder {
    // Login shell from $SHELL / passwd, launched as a login shell
    // so PATH is correct even when the app is started from the GUI.
    CommandBuilder::new_default_prog()
}

#[cfg(windows)]
fn default_shell() -> CommandBuilder {
    // Prefer PowerShell 7, then Windows PowerShell, then cmd.
    for candidate in ["pwsh.exe", "powershell.exe"] {
        if which(candidate) {
            let mut c = CommandBuilder::new(candidate);
            c.arg("-NoLogo");
            return c;
        }
    }
    CommandBuilder::new_default_prog()
}

#[cfg(windows)]
fn which(program: &str) -> bool {
    std::env::var_os("PATH")
        .map(|paths| std::env::split_paths(&paths).any(|dir| dir.join(program).is_file()))
        .unwrap_or(false)
}

fn home_dir() -> Option<std::path::PathBuf> {
    #[cfg(unix)]
    let var = "HOME";
    #[cfg(windows)]
    let var = "USERPROFILE";
    std::env::var_os(var).map(Into::into)
}
