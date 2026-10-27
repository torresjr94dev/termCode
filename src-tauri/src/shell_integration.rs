//! Shell integration: the shell tells termCode where each prompt and command
//! starts, what was run, how it ended and in which directory it happens.
//!
//! Sequences (same family VS Code, iTerm2 and Ghostty use):
//! * `OSC 133;A` prompt start · `OSC 133;C` output start · `OSC 133;D;<code>` end
//! * `OSC 633;E;<command line>` (escaped: `\\` and `\x3b` for `;`)
//! * `OSC 7;file://<host><cwd>`
//!
//! zsh is hooked through `ZDOTDIR`, the way VS Code does it: our startup files
//! source the user's own (untouched) files and then add two hooks. On Windows,
//! PowerShell loads its profile as usual and then our script wraps `prompt` and
//! PSReadLine's `PSConsoleHostReadLine` (see `winlaunch`). Nothing in the user's
//! dotfiles or profile is modified. Other shells start without integration.

use crate::agents::state_dir;
use std::path::PathBuf;

const ZSHENV: &str = r#"# termCode: carga tu .zshenv y sigue con la integración.
__tc_dir="$ZDOTDIR"
ZDOTDIR="${TERMCODE_USER_ZDOTDIR:-$HOME}"
[[ -f "$ZDOTDIR/.zshenv" ]] && source "$ZDOTDIR/.zshenv"
TERMCODE_USER_ZDOTDIR="$ZDOTDIR"
if [[ -o interactive ]]; then
  ZDOTDIR="$__tc_dir"
else
  # Shells no interactivas (scripts, herramientas): todo lo demás es tuyo.
  [[ "$TERMCODE_ORIG_ZDOTDIR_UNSET" == 1 ]] && unset ZDOTDIR
  unset __tc_dir TERMCODE_USER_ZDOTDIR TERMCODE_ORIG_ZDOTDIR_UNSET
fi
"#;

const ZPROFILE: &str = r#"# termCode: carga tu .zprofile.
ZDOTDIR="$TERMCODE_USER_ZDOTDIR"
[[ -f "$ZDOTDIR/.zprofile" ]] && source "$ZDOTDIR/.zprofile"
TERMCODE_USER_ZDOTDIR="$ZDOTDIR"
ZDOTDIR="$__tc_dir"
"#;

const ZSHRC: &str = r#"# termCode: carga tu .zshrc y después engancha la integración.
ZDOTDIR="$TERMCODE_USER_ZDOTDIR"
# /etc/zshrc (macOS) fija HISTFILE con el ZDOTDIR de termCode: tu historial
# debe seguir en tu archivo de siempre.
[[ "$HISTFILE" == "$__tc_dir"/* ]] && HISTFILE="$ZDOTDIR/.zsh_history"
[[ -f "$ZDOTDIR/.zshrc" ]] && source "$ZDOTDIR/.zshrc"
# Desde aquí (.zlogin, shells anidadas) se usan tus archivos tal cual.
[[ "$TERMCODE_ORIG_ZDOTDIR_UNSET" == 1 ]] && unset ZDOTDIR
source "$__tc_dir/termcode-integration.zsh"
unset __tc_dir TERMCODE_USER_ZDOTDIR TERMCODE_ORIG_ZDOTDIR_UNSET
"#;

const INTEGRATION: &str = r#"# termCode: marcas de prompt, comando, salida y código de salida.
[[ -o interactive ]] || return 0
(( ${+__tc_integrated} )) && return 0
typeset -g __tc_integrated=1
typeset -g __tc_running=0

__tc_escape() {
  local s=$1
  s=${s//\\/\\\\}
  s=${s//;/\\x3b}
  s=${s//$'\n'/\\x0a}
  s=${s//$'\a'/}
  s=${s//$'\e'/}
  print -rn -- "$s"
}

__tc_precmd() {
  local code=$?
  if (( __tc_running )); then
    printf '\e]133;D;%d\a' "$code"
    __tc_running=0
  fi
  local dir=${PWD//\%/%25}
  printf '\e]7;file://%s%s\a' "$HOST" "${dir// /%20}"
  printf '\e]133;A\a'
}

__tc_preexec() {
  printf '\e]633;E;%s\a' "$(__tc_escape "$1")"
  printf '\e]133;C\a'
  __tc_running=1
}

# Primero que nadie: el código de salida ($?) se lee antes de que otros hooks
# del prompt (p10k, starship…) lo pisen.
precmd_functions=(__tc_precmd ${precmd_functions[@]})
preexec_functions+=(__tc_preexec)

# Un `claude` escrito a mano recibe lo mismo que uno lanzado desde termCode
# (statusLine y hooks): así su panel muestra el modelo y el contexto. Solo en
# una sesión interactiva: `-p`, los subcomandos y lo que ya trae su propio
# `--settings` pasan tal cual. Si ya tienes una función `claude`, manda la
# tuya. `function claude` y no `claude()`: así un alias `claude` no se expande.
if [[ -n "$TERMCODE_CLAUDE_SETTINGS" ]] && (( ! ${+functions[claude]} )); then
  function claude {
    emulate -L zsh
    local arg first=""
    for arg in "$@"; do
      [[ -z "$first" && "$arg" != -* ]] && first=$arg
      [[ "$arg" == (-p|--print|-v|--version|-h|--help|--settings|--settings=*) ]] && { command claude "$@"; return; }
    done
    if [[ ! -t 0 || ! -t 1 || ! -r "$TERMCODE_CLAUDE_SETTINGS" || "$first" == (mcp|config|doctor|update|install|setup-token|migrate-installer|plugin|plugins) ]]; then
      command claude "$@"
      return
    fi
    local -a extra=(--settings "$TERMCODE_CLAUDE_SETTINGS")
    [[ -r "$TERMCODE_CLAUDE_MCP" ]] && extra+=(--mcp-config "$TERMCODE_CLAUDE_MCP")
    command claude "${extra[@]}" "$@"
  }
fi
"#;

/// PowerShell 5.1 y 7: `[char]27`/`[char]7` porque `` `e `` no existe en 5.1.
/// El código de salida es 0 si el comando salió bien; si no, el del último
/// programa nativo o 1 (un cmdlet que falla no tiene código). El prompt del
/// usuario (oh-my-posh, starship…) ve el mismo `$?` y `$LASTEXITCODE` que sin
/// termCode. Sin PSReadLine no hay línea de comando ni marca de salida, solo
/// prompts y carpeta.
const POWERSHELL: &str = r#"# termCode: marcas de prompt, comando, salida y código de salida.
if ($Global:__TcIntegrated) { return }
$Global:__TcIntegrated = $true
$Global:__TcRunning = $false
$Global:__TcPrompt = $function:prompt

function Global:__TcEscape([string]$Value) {
  $Value = $Value.Replace('\', '\\').Replace(';', '\x3b').Replace("`r", '').Replace("`n", '\x0a')
  $Value.Replace([string][char]7, '').Replace([string][char]27, '')
}

function Global:prompt {
  $ok = $global:?
  $code = $Global:LASTEXITCODE
  $e = [char]27
  $bel = [char]7
  $out = ''
  if ($Global:__TcRunning) {
    $Global:__TcRunning = $false
    $status = if ($ok) { 0 } elseif ($code -is [int] -and $code -ne 0) { $code } else { 1 }
    $out += "$e]133;D;$status$bel"
  }
  $location = $ExecutionContext.SessionState.Path.CurrentLocation
  if ($location.Provider.Name -eq 'FileSystem' -and $location.ProviderPath -match '^[A-Za-z]:\\') {
    $path = $location.ProviderPath.Replace('\', '/').Replace('%', '%25').Replace(' ', '%20')
    $out += "$e]7;file://$env:COMPUTERNAME/$path$bel"
  }
  $out += "$e]133;A$bel"
  $Global:LASTEXITCODE = $code
  if (-not $ok) { Write-Error 'termCode' -ErrorAction Ignore }
  $out + (& $Global:__TcPrompt)
}

if (Get-Command PSConsoleHostReadLine -ErrorAction Ignore) {
  $Global:__TcReadLine = $function:PSConsoleHostReadLine
  function Global:PSConsoleHostReadLine {
    $line = & $Global:__TcReadLine
    if (-not [string]::IsNullOrWhiteSpace($line)) {
      $e = [char]27
      $bel = [char]7
      [Console]::Write("$e]633;E;$(__TcEscape $line)$bel$e]133;C$bel")
      $Global:__TcRunning = $true
    }
    $line
  }
}
"#;

const POWERSHELL_FILE: &str = "termcode-integration.ps1";

fn powershell_dir() -> PathBuf {
    state_dir().join("shell").join("pwsh")
}

/// The PowerShell integration script, if it was installed.
#[cfg(windows)]
pub fn powershell_script() -> Option<PathBuf> {
    Some(powershell_dir().join(POWERSHELL_FILE)).filter(|p| p.is_file())
}

fn zsh_dir() -> PathBuf {
    state_dir().join("shell").join("zsh")
}

/// Writes (or refreshes) the integration files. Called at startup.
pub fn install() -> std::io::Result<PathBuf> {
    let dir = zsh_dir();
    std::fs::create_dir_all(&dir)?;
    // Restos de una versión que dejaba ahí el historial: solo si está vacío.
    let stray = dir.join(".zsh_history");
    if std::fs::metadata(&stray).is_ok_and(|m| m.len() == 0) {
        let _ = std::fs::remove_file(stray);
    }
    for (name, content) in [
        (".zshenv", ZSHENV),
        (".zprofile", ZPROFILE),
        (".zshrc", ZSHRC),
        ("termcode-integration.zsh", INTEGRATION),
    ] {
        std::fs::write(dir.join(name), content)?;
    }
    if cfg!(windows) {
        let pwsh = powershell_dir();
        std::fs::create_dir_all(&pwsh)?;
        std::fs::write(pwsh.join(POWERSHELL_FILE), POWERSHELL)?;
    }
    Ok(dir)
}

/// Environment that turns integration on for a zsh session (empty for other shells).
#[cfg(unix)]
pub fn env_for(shell: &str) -> Vec<(String, String)> {
    if !shell.ends_with("/zsh") && shell != "zsh" {
        return Vec::new();
    }
    let dir = zsh_dir();
    if !dir.join("termcode-integration.zsh").is_file() {
        return Vec::new();
    }
    let user = std::env::var("ZDOTDIR").ok().filter(|d| !d.is_empty());
    let home = std::env::var("HOME").unwrap_or_default();
    vec![
        ("ZDOTDIR".into(), dir.to_string_lossy().into_owned()),
        ("TERMCODE_USER_ZDOTDIR".into(), user.clone().unwrap_or(home)),
        (
            "TERMCODE_ORIG_ZDOTDIR_UNSET".into(),
            if user.is_none() { "1" } else { "0" }.into(),
        ),
    ]
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use pty_core::{OutputSink, PtyManager, SpawnOptions};
    use std::sync::mpsc;
    use std::time::{Duration, Instant};

    struct Sink(mpsc::Sender<Vec<u8>>);
    impl OutputSink for Sink {
        fn data(&mut self, bytes: Vec<u8>) -> bool {
            self.0.send(bytes).is_ok()
        }
        fn exit(&mut self, _code: Option<u32>) {}
    }

    /// Real zsh, hermetic dotfiles: the hooks emit every sequence we parse.
    #[test]
    fn zsh_emits_prompt_command_and_exit_marks() {
        if !std::path::Path::new("/bin/zsh").exists() {
            return;
        }
        let base = std::env::temp_dir().join(format!("termcode-shellint-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        let (ours, user) = (base.join("ours"), base.join("user"));
        std::fs::create_dir_all(&ours).unwrap();
        std::fs::create_dir_all(&user).unwrap();
        for (name, content) in [
            (".zshenv", ZSHENV),
            (".zprofile", ZPROFILE),
            (".zshrc", ZSHRC),
            ("termcode-integration.zsh", INTEGRATION),
        ] {
            std::fs::write(ours.join(name), content).unwrap();
        }
        // The user's own config still runs (and a hostile PS1 does not matter).
        std::fs::write(user.join(".zshrc"), "PS1='user> '\nexport FROM_USER_RC=1\n").unwrap();
        // /etc/zsh/zshrc de Debian y Ubuntu corre compinit, que pregunta y espera
        // si una carpeta de $fpath tiene permisos laxos (las del runner de GitHub).
        std::fs::write(user.join(".zshenv"), "skip_global_compinit=1\n").unwrap();

        let mgr = PtyManager::default();
        let (tx, rx) = mpsc::channel();
        let id = mgr
            .spawn(
                SpawnOptions {
                    program: Some("/bin/zsh".into()),
                    args: vec!["-i".into()],
                    env: vec![
                        ("ZDOTDIR".into(), ours.to_string_lossy().into_owned()),
                        (
                            "TERMCODE_USER_ZDOTDIR".into(),
                            user.to_string_lossy().into_owned(),
                        ),
                        ("TERMCODE_ORIG_ZDOTDIR_UNSET".into(), "1".into()),
                    ],
                    cols: 120,
                    rows: 30,
                    ..Default::default()
                },
                |_| Sink(tx),
            )
            .unwrap();

        let mut out = String::new();
        let wait_for = |needle: &str, out: &mut String| {
            let deadline = Instant::now() + Duration::from_secs(10);
            while !out.contains(needle) && Instant::now() < deadline {
                if let Ok(chunk) = rx.recv_timeout(Duration::from_millis(200)) {
                    mgr.ack(id, chunk.len());
                    out.push_str(&String::from_utf8_lossy(&chunk));
                }
            }
            assert!(out.contains(needle), "no apareció {needle:?} en:\n{out}");
        };

        wait_for("\x1b]133;A\x07", &mut out);
        // El historial sigue en la carpeta del usuario, nunca en la de termCode.
        mgr.write(id, b"print -r -- \"HF=${HISTFILE:-unset}\"\n")
            .unwrap();
        wait_for("HF=", &mut out);
        wait_for("\x1b]133;D;0\x07", &mut out);
        let ours_str = ours.to_string_lossy();
        let hf_line = out
            .lines()
            .rev()
            .find(|l| l.contains("HF=") && !l.contains("print"))
            .unwrap_or("");
        assert!(
            !hf_line.contains(ours_str.as_ref()),
            "HISTFILE quedó en la carpeta de termCode: {hf_line}"
        );
        mgr.write(id, b"echo \"$FROM_USER_RC\"; false\n").unwrap();
        wait_for("\x1b]133;D;1\x07", &mut out);
        assert!(
            out.contains("\x1b]633;E;echo \"$FROM_USER_RC\"\\x3b false\x07"),
            "{out}"
        );
        assert!(out.contains("\x1b]133;C\x07"));
        assert!(out.contains("\x1b]7;file://"));

        mgr.remove(id);
        // zsh escribe su historial al cerrarse: limpieza tolerante a esa carrera.
        for _ in 0..20 {
            if std::fs::remove_dir_all(&base).is_ok() {
                break;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
    }

    /// A hand-typed `claude` gets termCode's `--settings` only when it opens
    /// its interface; the user's alias still applies and their own flags win.
    #[test]
    fn zsh_wraps_a_hand_typed_claude() {
        if !std::path::Path::new("/bin/zsh").exists() {
            return;
        }
        let base = std::env::temp_dir().join(format!("termcode-claudewrap-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        let (ours, user, bin) = (base.join("ours"), base.join("user"), base.join("bin"));
        for dir in [&ours, &user, &bin] {
            std::fs::create_dir_all(dir).unwrap();
        }
        for (name, content) in [
            (".zshenv", ZSHENV),
            (".zprofile", ZPROFILE),
            (".zshrc", ZSHRC),
            ("termcode-integration.zsh", INTEGRATION),
        ] {
            std::fs::write(ours.join(name), content).unwrap();
        }
        // Un `claude` falso que imprime cada argumento entre corchetes.
        let fake = bin.join("claude");
        std::fs::write(
            &fake,
            "#!/bin/sh\nprintf 'ARGS:'; for a in \"$@\"; do printf '[%s]' \"$a\"; done; printf '\\n'\n",
        )
        .unwrap();
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&fake, std::fs::Permissions::from_mode(0o755)).unwrap();
        let settings = base.join("claude settings.json");
        let mcp = base.join("mcp.json");
        std::fs::write(&settings, "{}").unwrap();
        std::fs::write(&mcp, "{}").unwrap();
        std::fs::write(user.join(".zshenv"), "skip_global_compinit=1\n").unwrap();
        std::fs::write(
            user.join(".zshrc"),
            format!(
                "PATH={}:$PATH\nalias claude='claude --alias'\n",
                bin.to_string_lossy()
            ),
        )
        .unwrap();

        let mgr = PtyManager::default();
        let (tx, rx) = mpsc::channel();
        let id = mgr
            .spawn(
                SpawnOptions {
                    program: Some("/bin/zsh".into()),
                    args: vec!["-i".into()],
                    env: vec![
                        ("ZDOTDIR".into(), ours.to_string_lossy().into_owned()),
                        (
                            "TERMCODE_USER_ZDOTDIR".into(),
                            user.to_string_lossy().into_owned(),
                        ),
                        ("TERMCODE_ORIG_ZDOTDIR_UNSET".into(), "1".into()),
                        (
                            crate::agents::ENV_CLAUDE_SETTINGS.into(),
                            settings.to_string_lossy().into_owned(),
                        ),
                        (
                            crate::agents::ENV_CLAUDE_MCP.into(),
                            mcp.to_string_lossy().into_owned(),
                        ),
                    ],
                    cols: 400,
                    rows: 30,
                    ..Default::default()
                },
                |_| Sink(tx),
            )
            .unwrap();

        let mut out = String::new();
        let mut wait_for = |needle: &str| {
            let deadline = Instant::now() + Duration::from_secs(10);
            while !out.contains(needle) && Instant::now() < deadline {
                if let Ok(chunk) = rx.recv_timeout(Duration::from_millis(200)) {
                    mgr.ack(id, chunk.len());
                    out.push_str(&String::from_utf8_lossy(&chunk));
                }
            }
            assert!(out.contains(needle), "no apareció {needle:?} en:\n{out}");
        };

        wait_for("\x1b]133;A\x07");
        let (s, m) = (settings.to_string_lossy(), mcp.to_string_lossy());
        for (typed, expected) in [
            // Sesión interactiva: los settings de termCode, luego el alias y lo tuyo.
            (
                "claude uno",
                format!("ARGS:[--settings][{s}][--mcp-config][{m}][--alias][uno]"),
            ),
            ("claude -p dos", "ARGS:[--alias][-p][dos]".to_owned()),
            (
                "claude --settings mio tres",
                "ARGS:[--alias][--settings][mio][tres]".to_owned(),
            ),
            (
                "claude mcp cuatro",
                "ARGS:[--alias][mcp][cuatro]".to_owned(),
            ),
            ("echo | claude cinco", "ARGS:[--alias][cinco]".to_owned()),
        ] {
            mgr.write(id, format!("{typed}\n").as_bytes()).unwrap();
            wait_for(&expected);
        }

        mgr.remove(id);
        for _ in 0..20 {
            if std::fs::remove_dir_all(&base).is_ok() {
                break;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
    }
}

#[cfg(all(test, windows))]
mod windows_tests {
    use super::*;
    use pty_core::{OutputSink, PtyManager, SpawnOptions};
    use std::sync::mpsc;
    use std::time::{Duration, Instant};

    struct Sink(mpsc::Sender<Vec<u8>>);
    impl OutputSink for Sink {
        fn data(&mut self, bytes: Vec<u8>) -> bool {
            self.0.send(bytes).is_ok()
        }
        fn exit(&mut self, _code: Option<u32>) {}
    }

    /// PowerShell real detrás de ConPTY: las marcas tienen que atravesar conhost.
    #[test]
    fn powershell_emits_prompt_command_and_exit_marks() {
        let Some(shell) = pty_core::powershell() else {
            return;
        };
        let base = std::env::temp_dir().join(format!("termcode-psint-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(&base).unwrap();
        let script = base.join(POWERSHELL_FILE);
        std::fs::write(&script, POWERSHELL).unwrap();

        let mut options = SpawnOptions {
            cwd: Some(base.clone()),
            cols: 120,
            rows: 30,
            ..Default::default()
        };
        crate::winlaunch::prepare_with(&mut options, Some(shell), Some(&script), &[]).unwrap();
        // Hermético: sin el perfil de quien corre los tests.
        options.args.insert(0, "-NoProfile".into());

        let mgr = PtyManager::default();
        let (tx, rx) = mpsc::channel();
        let id = mgr.spawn(options, |_| Sink(tx)).unwrap();

        let mut out = String::new();
        let wait_for = |needle: &str, out: &mut String| {
            let deadline = Instant::now() + Duration::from_secs(20);
            while !out.contains(needle) && Instant::now() < deadline {
                if let Ok(chunk) = rx.recv_timeout(Duration::from_millis(200)) {
                    mgr.ack(id, chunk.len());
                    let text = String::from_utf8_lossy(&chunk);
                    // ConPTY pregunta dónde está el cursor y no sigue hasta que
                    // la terminal contesta (en la app lo hace xterm.js).
                    if text.contains("\x1b[6n") {
                        mgr.write(id, b"\x1b[1;1R").unwrap();
                    }
                    out.push_str(&text);
                }
            }
            assert!(out.contains(needle), "no apareció {needle:?} en:\n{out:?}");
        };

        wait_for("\x1b]133;A\x07", &mut out);
        mgr.write(id, b"Write-Output tc-ok; cmd /c exit 3\r")
            .unwrap();
        wait_for("\x1b]133;D;3\x07", &mut out);
        assert!(
            out.contains("\x1b]633;E;Write-Output tc-ok\\x3b cmd /c exit 3\x07"),
            "{out:?}"
        );
        assert!(out.contains("\x1b]133;C\x07"), "{out:?}");
        assert!(out.contains("\x1b]7;file://"), "{out:?}");
        mgr.write(id, b"Write-Output listo\r").unwrap();
        wait_for("\x1b]133;D;0\x07", &mut out);

        mgr.remove(id);
        for _ in 0..20 {
            if std::fs::remove_dir_all(&base).is_ok() {
                break;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
    }
}
