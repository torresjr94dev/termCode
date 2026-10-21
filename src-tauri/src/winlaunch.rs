//! Agentes y herramientas en Windows sin que `cmd.exe` interprete nada.
//!
//! En macOS y Linux el frontend arma la línea del agente con comillas POSIX y
//! la corre la shell de login. En Windows no hay shell POSIX: `cmd.exe /K` no
//! entiende `'…'` y expande `%VAR%`, `&`, `|`… dentro del prompt, así que un
//! prompt con `" & del /q …` sería un comando. Aquí esa línea se vuelve a partir
//! en argumentos (solo se aceptan palabras simples y `'…'`, que es todo lo que
//! produce el frontend), el programa se resuelve a un ejecutable real (los shims
//! `.cmd` de npm, pnpm y yarn se siguen hasta su `.exe` o su script de Node) y
//! PowerShell lo inicia con `Process.Start`: los argumentos van citados para
//! CreateProcess y ninguna shell los vuelve a leer. Cuando el agente termina, el
//! panel se queda en PowerShell, igual que en macOS se queda en zsh.
//!
//! Todo menos `prepare`/`command` es portable para probarlo también en macOS.
#![cfg_attr(not(windows), allow(dead_code))]

use pty_core::SpawnOptions;
use std::io::Read;
use std::path::{Path, PathBuf};

/// Ejecutable del agente y sus argumentos ya citados (los lee el arranque de PowerShell).
const ENV_RUN_EXE: &str = "TERMCODE_RUN_EXE";
const ENV_RUN_ARGS: &str = "TERMCODE_RUN_ARGS";
/// Script de integración con la shell (`shell_integration`).
const ENV_INTEGRATION: &str = "TERMCODE_PS_INTEGRATION";

/// Arranque de cada PowerShell de termCode. Es constante: rutas y argumentos
/// llegan por variables de entorno, nunca como texto de PowerShell. La
/// integración se lee como texto (`ScriptBlock::Create`) y no como archivo, así
/// que la política de ejecución por defecto de Windows (`Restricted`) no la
/// bloquea; si falla (p. ej. en modo de lenguaje restringido) la shell sigue
/// sin marcas. `WaitForExit()` bloquea a propósito: mientras corre el agente,
/// PowerShell no lee el teclado.
const BOOTSTRAP: &str = "try { if ($env:TERMCODE_PS_INTEGRATION) { . ([scriptblock]::Create([IO.File]::ReadAllText($env:TERMCODE_PS_INTEGRATION))) } } catch {}; \
$__tcExe = $env:TERMCODE_RUN_EXE; $__tcArgs = $env:TERMCODE_RUN_ARGS; \
Remove-Item Env:TERMCODE_RUN_EXE, Env:TERMCODE_RUN_ARGS, Env:TERMCODE_PS_INTEGRATION -ErrorAction Ignore; \
if ($__tcExe) { try { $__tcStart = New-Object System.Diagnostics.ProcessStartInfo; $__tcStart.FileName = $__tcExe; $__tcStart.Arguments = [string]$__tcArgs; $__tcStart.UseShellExecute = $false; $__tcProc = [System.Diagnostics.Process]::Start($__tcStart); $__tcProc.WaitForExit(); $global:LASTEXITCODE = $__tcProc.ExitCode } catch { Write-Host \"[termCode] No se pudo iniciar el agente: $($_.Exception.Message)\" -ForegroundColor Red } }; \
Remove-Variable __tcExe, __tcArgs, __tcStart, __tcProc -ErrorAction Ignore";

/// Un shim más grande que esto no es un shim.
const MAX_SHIM: u64 = 64 * 1024;
/// yarn: shim → shim → script. Más saltos que esto no se siguen.
const MAX_SHIM_DEPTH: usize = 3;
const EXTENSIONS: [&str; 3] = ["exe", "cmd", "bat"];

const UNSUPPORTED_LINE: &str =
    "La línea del agente tiene un formato que termCode no lanza en Windows.";

/// Cómo arrancar un programa.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Launch {
    pub exe: PathBuf,
    /// Argumentos que van antes de los del usuario (el script de Node).
    pub args: Vec<String>,
    /// `.cmd`/`.bat` que no se supo seguir: lo ejecuta `cmd.exe`, que vuelve a
    /// interpretar los argumentos. Solo se usa con argumentos `batch_safe`.
    pub batch: bool,
}

/// Parte una línea con comillas POSIX en argumentos. Solo acepta lo que produce
/// `agentCommand` en el frontend: palabras sin metacaracteres y cadenas `'…'`
/// (con `'\''` para la comilla). Cualquier otra cosa es un error: nunca se adivina.
pub fn split_posix_words(line: &str) -> Result<Vec<String>, String> {
    let mut words = Vec::new();
    let mut word = String::new();
    let mut started = false;
    let mut chars = line.chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            ' ' | '\t' => {
                if started {
                    words.push(std::mem::take(&mut word));
                    started = false;
                }
            }
            '\'' => {
                started = true;
                loop {
                    match chars.next() {
                        Some('\'') => break,
                        Some('\0') | None => return Err(UNSUPPORTED_LINE.into()),
                        Some(ch) => word.push(ch),
                    }
                }
            }
            '\\' if chars.next_if_eq(&'\'').is_some() => {
                started = true;
                word.push('\'');
            }
            c if c.is_ascii_alphanumeric() || "-_./:=@,+".contains(c) => {
                started = true;
                word.push(c);
            }
            _ => return Err(UNSUPPORTED_LINE.into()),
        }
    }
    if started {
        words.push(word);
    }
    Ok(words)
}

/// Cita un argumento como lo lee `CommandLineToArgvW` (y el CRT de MSVC, Node,
/// Bun y Rust): las barras solo se duplican antes de una comilla o del final.
pub fn quote_windows_arg(arg: &str, out: &mut String) {
    if !arg.is_empty() && !arg.contains([' ', '\t', '\n', '\x0b', '"']) {
        out.push_str(arg);
        return;
    }
    out.push('"');
    let mut backslashes = 0;
    for c in arg.chars() {
        match c {
            '\\' => backslashes += 1,
            '"' => {
                out.extend(std::iter::repeat_n('\\', backslashes * 2 + 1));
                out.push('"');
                backslashes = 0;
            }
            _ => {
                out.extend(std::iter::repeat_n('\\', backslashes));
                out.push(c);
                backslashes = 0;
            }
        }
    }
    out.extend(std::iter::repeat_n('\\', backslashes * 2));
    out.push('"');
}

pub fn windows_command_line(args: &[String]) -> String {
    let mut line = String::new();
    for (i, arg) in args.iter().enumerate() {
        if i > 0 {
            line.push(' ');
        }
        quote_windows_arg(arg, &mut line);
    }
    line
}

/// Un argumento que `cmd.exe` no puede reinterpretar: sin `%` ni `!`
/// (variables), comillas, `^`, `&`, `|`, `<`, `>`, paréntesis ni controles.
pub fn batch_safe(arg: &str) -> bool {
    !arg.chars()
        .any(|c| c.is_control() || "%!\"^&|<>()".contains(c))
}

/// Lo que ejecuta un shim `.cmd` de npm, pnpm o yarn: la ruta literal entre
/// comillas, relativa a la carpeta del shim, justo antes de `%*`.
pub fn shim_target(content: &str) -> Option<PathBuf> {
    content.lines().rev().find_map(|line| {
        let before = &line[..line.find("%*")?];
        let close = before.rfind('"')?;
        let open = before[..close].rfind('"')?;
        let token = &before[open + 1..close];
        let rest = ["%dp0%\\", "%~dp0\\", "%dp0%/", "%~dp0/"]
            .iter()
            .find_map(|prefix| token.strip_prefix(prefix))?;
        // Ni variables ni rutas absolutas: solo una ruta relativa literal.
        if rest.is_empty() || rest.contains(['%', '!', '"', ':']) || rest.starts_with(['\\', '/']) {
            return None;
        }
        Some(rest.split(['\\', '/']).filter(|s| !s.is_empty()).collect())
    })
}

fn extension(path: &Path) -> Option<String> {
    path.extension()
        .and_then(|e| e.to_str())
        .map(str::to_ascii_lowercase)
}

fn is_batch(path: &Path) -> bool {
    matches!(extension(path).as_deref(), Some("cmd" | "bat"))
}

fn read_capped(path: &Path, limit: u64) -> Option<String> {
    let mut text = String::new();
    std::fs::File::open(path)
        .ok()?
        .take(limit)
        .read_to_string(&mut text)
        .ok()?;
    Some(text)
}

/// Un bin de npm sin extensión con `#!… node` en la primera línea.
fn is_node_script(path: &Path) -> bool {
    read_capped(path, 256)
        .and_then(|text| text.lines().next().map(str::to_owned))
        .is_some_and(|first| first.starts_with("#!") && first.contains("node"))
}

/// El primer `name` (o `name.exe`, `.cmd`, `.bat`) en `dirs`, en ese orden.
pub fn find_program(name: &str, dirs: &[PathBuf]) -> Option<PathBuf> {
    if name.is_empty()
        || !name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || "-_.".contains(c))
    {
        return None;
    }
    let has_extension =
        extension(Path::new(name)).is_some_and(|e| EXTENSIONS.contains(&e.as_str()));
    dirs.iter().find_map(|dir| {
        if has_extension {
            let path = dir.join(name);
            return path.is_file().then_some(path);
        }
        EXTENSIONS
            .iter()
            .map(|ext| dir.join(format!("{name}.{ext}")))
            .find(|path| path.is_file())
    })
}

/// Cómo ejecutar `path`: un `.exe` tal cual; un shim, lo que este ejecuta.
pub fn launch_for(path: &Path, dirs: &[PathBuf]) -> Launch {
    follow(path, dirs, 0).unwrap_or_else(|| Launch {
        exe: path.to_owned(),
        args: Vec::new(),
        batch: is_batch(path),
    })
}

fn follow(path: &Path, dirs: &[PathBuf], depth: usize) -> Option<Launch> {
    if !is_batch(path) {
        return Some(Launch {
            exe: path.to_owned(),
            args: Vec::new(),
            batch: false,
        });
    }
    if depth >= MAX_SHIM_DEPTH {
        return None;
    }
    let dir = path.parent()?;
    let target = dir.join(shim_target(&read_capped(path, MAX_SHIM)?)?);
    if !target.is_file() {
        return None;
    }
    match extension(&target).as_deref() {
        Some("exe") => Some(Launch {
            exe: target,
            args: Vec::new(),
            batch: false,
        }),
        Some("cmd" | "bat") => follow(&target, dirs, depth + 1),
        Some("js" | "mjs" | "cjs") => node_launch(dir, target, dirs),
        None if is_node_script(&target) => node_launch(dir, target, dirs),
        _ => None,
    }
}

fn node_launch(shim_dir: &Path, script: PathBuf, dirs: &[PathBuf]) -> Option<Launch> {
    // Como el propio shim: primero el node.exe que vive a su lado.
    let local = shim_dir.join("node.exe");
    let node = if local.is_file() {
        local
    } else {
        find_program("node.exe", dirs)?
    };
    Some(Launch {
        exe: node,
        args: vec![script.to_string_lossy().into_owned()],
        batch: false,
    })
}

/// Carpetas donde buscar programas: el PATH de la app y, aunque ese PATH sea
/// de antes de instalarlos, donde dejan sus binarios Claude Code (instalador
/// nativo), npm, pnpm y bun. Las entradas relativas se ignoran: con ellas, un
/// `claude.exe` en la carpeta del proyecto ganaría al instalado.
pub fn search_dirs() -> Vec<PathBuf> {
    let var = |key: &str| {
        std::env::var_os(key)
            .filter(|v| !v.is_empty())
            .map(PathBuf::from)
    };
    let mut dirs: Vec<PathBuf> = std::env::var_os("PATH")
        .map(|path| std::env::split_paths(&path).collect())
        .unwrap_or_default();
    let known = [
        var("USERPROFILE").map(|home| home.join(".local").join("bin")),
        var("APPDATA").map(|roaming| roaming.join("npm")),
        var("LOCALAPPDATA").map(|local| local.join("pnpm")),
        var("USERPROFILE").map(|home| home.join(".bun").join("bin")),
    ];
    for dir in known.into_iter().flatten() {
        if !dirs.contains(&dir) {
            dirs.push(dir);
        }
    }
    dirs.retain(|dir| dir.is_absolute());
    dirs
}

/// Ejecutable y argumentos del agente de `line` (comillas POSIX del frontend).
fn agent_launch(line: &str, dirs: &[PathBuf]) -> Result<(String, Vec<String>), String> {
    let words = split_posix_words(line)?;
    let (name, rest) = words
        .split_first()
        .ok_or_else(|| UNSUPPORTED_LINE.to_owned())?;
    let path = find_program(name, dirs)
        .ok_or_else(|| format!("No se encontró «{name}». ¿Está instalado y en el PATH?"))?;
    let launch = launch_for(&path, dirs);
    let args: Vec<String> = launch
        .args
        .into_iter()
        .chain(rest.iter().cloned())
        .collect();
    if launch.batch && !args.iter().all(|arg| batch_safe(arg)) {
        return Err(format!(
            "«{name}» está instalado como un script .cmd que termCode no sabe seguir, y cmd.exe \
             interpretaría parte del texto (%, !, comillas, paréntesis…). Instala su versión nativa \
             o lanza el agente sin ese texto."
        ));
    }
    Ok((launch.exe.to_string_lossy().into_owned(), args))
}

fn set_env(options: &mut SpawnOptions, key: &str, value: String) {
    options.env.retain(|(k, _)| k != key);
    options.env.push((key.to_owned(), value));
}

/// Convierte la petición del frontend en lo que corre de verdad en Windows:
/// la shell es PowerShell con la integración cargada y, si hay un agente, este
/// arranca dentro de esa PowerShell. `powershell` e `integration` son lo que
/// hay instalado; `dirs`, dónde buscar el agente.
pub fn prepare_with(
    options: &mut SpawnOptions,
    powershell: Option<&str>,
    integration: Option<&Path>,
    dirs: &[PathBuf],
) -> Result<(), String> {
    if options.program.is_some() {
        // Igual que pty-core: con `program`, `command` no cuenta.
        options.command = None;
        return Ok(());
    }
    let agent = options
        .command
        .take()
        .map(|line| agent_launch(&line, dirs))
        .transpose()?;
    let Some(powershell) = powershell else {
        // Sin PowerShell (rarísimo): el agente directo; al terminar se cierra el panel.
        if let Some((exe, args)) = agent {
            options.program = Some(exe);
            options.args = args;
        }
        return Ok(());
    };
    if agent.is_none() && integration.is_none() {
        // La PowerShell de siempre (la de pty-core).
        return Ok(());
    }
    if let Some(script) = integration {
        set_env(
            options,
            ENV_INTEGRATION,
            script.to_string_lossy().into_owned(),
        );
    }
    if let Some((exe, args)) = agent {
        set_env(options, ENV_RUN_EXE, exe);
        set_env(options, ENV_RUN_ARGS, windows_command_line(&args));
    }
    options.program = Some(powershell.to_owned());
    options.args = ["-NoLogo", "-NoExit", "-Command", BOOTSTRAP]
        .map(String::from)
        .to_vec();
    Ok(())
}

#[cfg(windows)]
pub fn prepare(options: &mut SpawnOptions, shell_integration: bool) -> Result<(), String> {
    let script = shell_integration
        .then(crate::shell_integration::powershell_script)
        .flatten();
    prepare_with(
        options,
        pty_core::powershell(),
        script.as_deref(),
        &search_dirs(),
    )
}

/// `Command` para una herramienta (`claude -p`, `gh`, un editor): un shim de
/// npm se sigue hasta su `.exe` o Node; lo que no se sabe seguir queda en
/// manos de Rust, que cita para `cmd.exe` o se niega si no puede hacerlo seguro.
#[cfg(windows)]
pub fn command(binary: &str) -> std::process::Command {
    let launch = launch_for(Path::new(binary), &search_dirs());
    let mut cmd = std::process::Command::new(&launch.exe);
    cmd.args(&launch.args);
    cmd
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `CommandLineToArgvW` (reglas de 2008 en adelante), para probar la ida y vuelta.
    fn parse_windows(line: &str) -> Vec<String> {
        let mut args = Vec::new();
        let mut arg = String::new();
        let mut quoted = false;
        let mut started = false;
        let mut backslashes = 0usize;
        for c in line.chars() {
            match c {
                '\\' => {
                    backslashes += 1;
                    started = true;
                }
                '"' => {
                    arg.extend(std::iter::repeat_n('\\', backslashes / 2));
                    if backslashes % 2 == 1 {
                        arg.push('"');
                    } else {
                        quoted = !quoted;
                    }
                    backslashes = 0;
                    started = true;
                }
                ' ' | '\t' if !quoted => {
                    arg.extend(std::iter::repeat_n('\\', backslashes));
                    backslashes = 0;
                    if started {
                        args.push(std::mem::take(&mut arg));
                        started = false;
                    }
                }
                _ => {
                    arg.extend(std::iter::repeat_n('\\', backslashes));
                    backslashes = 0;
                    arg.push(c);
                    started = true;
                }
            }
        }
        arg.extend(std::iter::repeat_n('\\', backslashes));
        if started {
            args.push(arg);
        }
        args
    }

    fn posix_quote(value: &str) -> String {
        pty_core::shell_quote(value)
    }

    #[test]
    fn splits_what_the_frontend_builds() {
        let line = format!(
            "claude --settings {} --resume {} -- {}",
            posix_quote(r"C:\Users\Jorge’s PC\AppData\claude-settings.json"),
            posix_quote("0b6f2a43-1c1e"),
            posix_quote("it's \"done\" & del /q %USERPROFILE% $(rm) `x`\nline 2"),
        );
        assert_eq!(
            split_posix_words(&line).unwrap(),
            [
                "claude",
                "--settings",
                r"C:\Users\Jorge’s PC\AppData\claude-settings.json",
                "--resume",
                "0b6f2a43-1c1e",
                "--",
                "it's \"done\" & del /q %USERPROFILE% $(rm) `x`\nline 2",
            ]
        );
        assert_eq!(
            split_posix_words("codex resume --last").unwrap(),
            ["codex", "resume", "--last"]
        );
        assert_eq!(split_posix_words("x ''").unwrap(), ["x", ""]);
    }

    #[test]
    fn refuses_anything_a_shell_would_interpret() {
        for line in [
            "claude; calc",
            "claude && calc",
            "claude | calc",
            "claude $(calc)",
            "claude `calc`",
            "claude \"x\"",
            "claude 'unterminated",
            "claude %PATH%",
            "claude > out",
            "claude ~/x",
            "claude\ncalc",
            "claude 'a\0b'",
        ] {
            assert!(split_posix_words(line).is_err(), "{line:?}");
        }
    }

    #[test]
    fn quoting_survives_the_trip_through_commandlinetoargvw() {
        let cases: Vec<Vec<String>> = vec![
            vec![
                "--settings".into(),
                r"C:\Program Files\termCode\s.json".into(),
            ],
            vec![r"ends with \".into(), r"C:\dir\".into(), r"a\\b".into()],
            vec![
                r#"say "hi" \"there\""#.into(),
                "".into(),
                "tab\there".into(),
            ],
            vec![
                "multi\nline".into(),
                r#"\\"#.into(),
                r#"\""#.into(),
                "ñandú ✓".into(),
            ],
            vec!["%PATH% & calc | (x) ^ !y!".into()],
        ];
        for args in cases {
            assert_eq!(parse_windows(&windows_command_line(&args)), args);
        }
        assert_eq!(windows_command_line(&["plain".into()]), "plain");
        assert_eq!(windows_command_line(&["".into()]), r#""""#);
    }

    #[test]
    fn batch_safety_rejects_what_cmd_expands() {
        assert!(batch_safe(
            r"C:\Users\Jorge’s PC\AppData\Roaming\termCode\s.json"
        ));
        assert!(batch_safe("--settings"));
        for evil in [
            "%PATH%", "!x!", "a\"b", "a & calc", "a|b", "(x)", "a^b", "a\nb", "<x>",
        ] {
            assert!(!batch_safe(evil), "{evil:?}");
        }
    }

    #[test]
    fn reads_npm_pnpm_and_yarn_shims() {
        let npm7 = "@ECHO off\r\nGOTO start\r\n:find_dp0\r\nSET dp0=%~dp0\r\nEXIT /b\r\n:start\r\nSETLOCAL\r\nCALL :find_dp0\r\n\r\nIF EXIST \"%dp0%\\node.exe\" (\r\n  SET \"_prog=%dp0%\\node.exe\"\r\n) ELSE (\r\n  SET \"_prog=node\"\r\n  SET PATHEXT=%PATHEXT:;.JS;=;%\r\n)\r\n\r\nendLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & \"%_prog%\"  \"%dp0%\\node_modules\\@anthropic-ai\\claude-code\\cli.js\" %*\r\n";
        assert_eq!(
            shim_target(npm7),
            Some(
                ["node_modules", "@anthropic-ai", "claude-code", "cli.js"]
                    .iter()
                    .collect()
            )
        );
        let native =
            "@ECHO off\r\n\"%dp0%\\node_modules\\@openai\\codex\\bin\\codex.exe\"   %*\r\n";
        assert_eq!(
            shim_target(native),
            Some(
                ["node_modules", "@openai", "codex", "bin", "codex.exe"]
                    .iter()
                    .collect()
            )
        );
        let pnpm = "@SETLOCAL\r\n@IF EXIST \"%~dp0\\node.exe\" (\r\n  \"%~dp0\\node.exe\"  \"%~dp0\\global\\5\\node_modules\\x\\cli.js\" %*\r\n) ELSE (\r\n  @SET PATHEXT=%PATHEXT:;.JS;=;%\r\n  node  \"%~dp0\\global\\5\\node_modules\\x\\cli.js\" %*\r\n)\r\n";
        assert_eq!(
            shim_target(pnpm),
            Some(
                ["global", "5", "node_modules", "x", "cli.js"]
                    .iter()
                    .collect()
            )
        );
        let yarn = "@\"%~dp0\\..\\Data\\global\\node_modules\\.bin\\claude.cmd\" %*\r\n";
        assert_eq!(
            shim_target(yarn),
            Some(
                ["..", "Data", "global", "node_modules", ".bin", "claude.cmd"]
                    .iter()
                    .collect()
            )
        );
        // Ni variables, ni rutas absolutas, ni scripts arbitrarios.
        assert_eq!(shim_target("\"%dp0%\\%EVIL%\\x.exe\" %*"), None);
        assert_eq!(shim_target("\"C:\\tools\\x.exe\" %*"), None);
        assert_eq!(shim_target("\"%dp0%\\C:\\x.exe\" %*"), None);
        assert_eq!(shim_target("echo hola"), None);
    }

    struct Sandbox(PathBuf);

    impl Sandbox {
        fn new(name: &str) -> Self {
            let dir = std::env::temp_dir()
                .join(format!("termcode-winlaunch-{name}-{}", std::process::id()));
            let _ = std::fs::remove_dir_all(&dir);
            std::fs::create_dir_all(&dir).unwrap();
            Self(dir)
        }

        fn file(&self, rel: &str, content: &str) -> PathBuf {
            let path = self.0.join(rel.split('/').collect::<PathBuf>());
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(&path, content).unwrap();
            path
        }
    }

    impl Drop for Sandbox {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    const NPM_SHIM: &str = "@ECHO off\r\nendLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & \"%_prog%\"  \"%dp0%\\node_modules\\@anthropic-ai\\claude-code\\cli.js\" %*\r\n";

    #[test]
    fn follows_shims_to_the_real_program() {
        let sb = Sandbox::new("follow");
        let (npm, nodejs, native) = (sb.0.join("npm"), sb.0.join("nodejs"), sb.0.join("native"));
        let shim = sb.file("npm/claude.cmd", NPM_SHIM);
        let script = sb.file(
            "npm/node_modules/@anthropic-ai/claude-code/cli.js",
            "// cli",
        );
        let node = sb.file("nodejs/node.exe", "");
        let dirs = vec![native, npm, nodejs];

        // Node script: node.exe del PATH + el script.
        assert_eq!(
            launch_for(&shim, &dirs),
            Launch {
                exe: node,
                args: vec![script.to_string_lossy().into_owned()],
                batch: false,
            }
        );

        // El node.exe junto al shim gana, como en el propio shim.
        let local_node = sb.file("npm/node.exe", "");
        assert_eq!(launch_for(&shim, &dirs).exe, local_node);

        // El instalador nativo va antes en el PATH: gana el .exe.
        let exe = sb.file("native/claude.exe", "");
        assert_eq!(find_program("claude", &dirs), Some(exe.clone()));
        assert_eq!(
            launch_for(&exe, &dirs),
            Launch {
                exe,
                args: vec![],
                batch: false
            }
        );
    }

    #[test]
    fn an_unknown_shim_only_runs_with_batch_safe_arguments() {
        let sb = Sandbox::new("batch");
        let dirs = vec![sb.0.clone()];
        let odd = sb.file("codex.cmd", "@echo off\r\ncall something-else %*\r\n");
        assert!(launch_for(&odd, &dirs).batch);

        let ok = agent_launch(
            &format!("codex -- {}", posix_quote("arregla el login")),
            &dirs,
        )
        .unwrap();
        assert_eq!(
            ok,
            (
                odd.to_string_lossy().into_owned(),
                vec!["--".into(), "arregla el login".into()]
            )
        );
        let err =
            agent_launch(&format!("codex -- {}", posix_quote("50% & calc")), &dirs).unwrap_err();
        assert!(err.contains(".cmd"), "{err}");
    }

    #[test]
    fn prepares_powershell_with_the_agent_inside() {
        let sb = Sandbox::new("prepare");
        let exe = sb.file("claude.exe", "");
        let dirs = vec![sb.0.clone()];
        let integration = sb.file("termcode-integration.ps1", "");
        let prompt = "di \"hola\" & sal";
        let mut options = SpawnOptions {
            command: Some(format!(
                "claude --settings {} -- {}",
                posix_quote(r"C:\a b\s.json"),
                posix_quote(prompt)
            )),
            env: vec![("TERMCODE_PANE_ID".into(), "pane-1".into())],
            ..Default::default()
        };
        prepare_with(&mut options, Some("pwsh.exe"), Some(&integration), &dirs).unwrap();

        assert_eq!(options.program.as_deref(), Some("pwsh.exe"));
        assert_eq!(options.command, None);
        assert_eq!(options.args[..3], ["-NoLogo", "-NoExit", "-Command"]);
        // La línea de PowerShell es siempre la misma: nada del usuario se vuelve código.
        assert_eq!(options.args[3], BOOTSTRAP);
        assert!(!BOOTSTRAP.contains(prompt));
        let env = |key: &str| {
            options
                .env
                .iter()
                .find(|(k, _)| k == key)
                .map(|(_, v)| v.clone())
        };
        assert_eq!(env(ENV_RUN_EXE), Some(exe.to_string_lossy().into_owned()));
        assert_eq!(
            parse_windows(&env(ENV_RUN_ARGS).unwrap()),
            ["--settings", r"C:\a b\s.json", "--", prompt]
        );
        assert_eq!(
            env(ENV_INTEGRATION),
            Some(integration.to_string_lossy().into_owned())
        );
        assert_eq!(env("TERMCODE_PANE_ID").as_deref(), Some("pane-1"));
    }

    #[test]
    fn plain_shells_and_missing_powershell() {
        let sb = Sandbox::new("plain");
        let integration = sb.file("termcode-integration.ps1", "");

        // Shell sin integración: la de siempre.
        let mut plain = SpawnOptions::default();
        prepare_with(&mut plain, Some("pwsh.exe"), None, &[]).unwrap();
        assert_eq!(plain.program, None);

        // Shell con integración.
        let mut shell = SpawnOptions::default();
        prepare_with(&mut shell, Some("powershell.exe"), Some(&integration), &[]).unwrap();
        assert_eq!(shell.program.as_deref(), Some("powershell.exe"));
        assert!(shell.env.iter().all(|(k, _)| k != ENV_RUN_EXE));

        // Sin PowerShell: el agente se lanza directo, con sus argumentos exactos.
        let exe = sb.file("codex.exe", "");
        let mut agent = SpawnOptions {
            command: Some("codex resume --last".into()),
            ..Default::default()
        };
        prepare_with(
            &mut agent,
            None,
            Some(&integration),
            std::slice::from_ref(&sb.0),
        )
        .unwrap();
        assert_eq!(agent.program, Some(exe.to_string_lossy().into_owned()));
        assert_eq!(agent.args, ["resume", "--last"]);

        // Un agente que no existe es un error legible, no un panel muerto.
        let mut missing = SpawnOptions {
            command: Some("claude".into()),
            ..Default::default()
        };
        let err = prepare_with(
            &mut missing,
            Some("pwsh.exe"),
            None,
            std::slice::from_ref(&sb.0),
        )
        .unwrap_err();
        assert!(err.contains("claude"), "{err}");
    }

    #[test]
    fn search_ignores_relative_and_odd_names() {
        let sb = Sandbox::new("names");
        sb.file("tool.exe", "");
        let dirs = vec![sb.0.clone()];
        assert!(find_program("tool", &dirs).is_some());
        assert!(find_program("tool.exe", &dirs).is_some());
        for odd in ["", "..\\tool", "to ol", "tool&calc", "C:\\x\\tool"] {
            assert_eq!(find_program(odd, &dirs), None, "{odd:?}");
        }
    }
}
