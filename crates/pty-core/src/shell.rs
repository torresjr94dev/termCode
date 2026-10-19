//! Default shell detection and command construction.

use crate::session::SpawnOptions;
use portable_pty::CommandBuilder;

/// Builds the command for a session, applying terminal environment variables.
pub fn build_command(opts: &SpawnOptions) -> CommandBuilder {
    let mut cmd = match (&opts.program, &opts.command) {
        (Some(program), _) => {
            let mut c = CommandBuilder::new(program);
            c.args(&opts.args);
            c
        }
        (None, Some(command)) => command_in_shell(command),
        (None, None) => default_shell(),
    };

    let cwd = opts.cwd.clone().filter(|p| p.is_dir()).or_else(home_dir);
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

/// Runs `command` through the user's login + interactive shell (so PATH, nvm,
/// aliases… are loaded) and then replaces itself with a regular login shell:
/// when the agent exits, the pane stays usable and its output stays visible.
/// Unlike typing the command after a delay, there is no race with shell startup
/// and nothing lands in the shell history.
#[cfg(unix)]
fn command_in_shell(command: &str) -> CommandBuilder {
    let shell = user_shell();
    let mut c = CommandBuilder::new(&shell);
    c.args([
        "-l",
        "-i",
        "-c",
        &format!("{command}; exec {} -l", shell_quote(&shell)),
    ]);
    c
}

#[cfg(windows)]
fn command_in_shell(command: &str) -> CommandBuilder {
    let mut c = CommandBuilder::new("cmd.exe");
    c.args(["/K", command]);
    c
}

/// Quotes a string for POSIX shells (`'…'`, with embedded quotes escaped).
pub fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', r"'\''"))
}

/// The user's login shell: `$SHELL`, then the passwd database, then `/bin/sh`.
#[cfg(unix)]
pub fn user_shell() -> String {
    if let Some(shell) = std::env::var_os("SHELL").filter(|s| !s.is_empty()) {
        return shell.to_string_lossy().into_owned();
    }
    // SAFETY: getpwuid returns a pointer into static storage or null.
    unsafe {
        let pw = libc::getpwuid(libc::getuid());
        if !pw.is_null() && !(*pw).pw_shell.is_null() {
            let shell = std::ffi::CStr::from_ptr((*pw).pw_shell)
                .to_string_lossy()
                .into_owned();
            if !shell.is_empty() {
                return shell;
            }
        }
    }
    "/bin/sh".to_owned()
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn quotes_for_posix_shells() {
        assert_eq!(shell_quote("/bin/zsh"), "'/bin/zsh'");
        assert_eq!(shell_quote("it's"), r"'it'\''s'");
        assert_eq!(
            shell_quote("/Library/Application Support/x"),
            "'/Library/Application Support/x'"
        );
    }

    #[cfg(unix)]
    #[test]
    fn resolves_a_shell() {
        assert!(user_shell().starts_with('/'));
    }
}
