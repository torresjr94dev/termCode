//! Opening files in the user's editor at an exact position, and the cheap
//! existence checks behind clickable paths in terminal output.

use crate::agents::{tool_command, tools};
use crate::proc;
use std::path::Path;
#[cfg(unix)]
use std::process::Command;
use std::time::Duration;

/// Which editor binary to use for a preference (`auto` = first one installed).
fn pick(preference: &str) -> Option<(String, &'static str)> {
    let t = tools();
    let candidates: [(&str, Option<String>, &'static str); 4] = [
        ("cursor", t.cursor, "goto"),
        ("code", t.code, "goto"),
        ("zed", t.zed, "suffix"),
        ("subl", t.subl, "suffix"),
    ];
    candidates
        .into_iter()
        .filter(|(name, _, _)| preference == "auto" || preference == *name)
        .find_map(|(_, path, style)| path.map(|p| (p, style)))
}

/// Windows: `ShellExecuteW` (vía el plugin opener), nunca `cmd /C start`, que
/// leería `&`, `^` o `%` de un nombre de archivo como parte del comando.
#[cfg(windows)]
fn system_open(path: &Path) -> Result<(), String> {
    tauri_plugin_opener::open_path(path, None::<&str>).map_err(|e| e.to_string())
}

#[cfg(unix)]
fn system_open(path: &Path) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    let mut cmd = Command::new("/usr/bin/open");
    #[cfg(not(target_os = "macos"))]
    let mut cmd = Command::new("xdg-open");
    cmd.arg(path);
    let out = proc::run(cmd, None, Duration::from_secs(10), 4096).map_err(|e| e.to_string())?;
    if out.success() {
        Ok(())
    } else {
        Err(out.stderr_str())
    }
}

/// `editor`: `auto`, `cursor`, `code`, `zed`, `subl` or `system`.
#[tauri::command]
pub async fn open_in_editor(
    path: String,
    line: Option<u32>,
    column: Option<u32>,
    editor: String,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let file = Path::new(&path);
        if !file.is_absolute() || !file.exists() {
            return Err(format!("No existe: {path}"));
        }
        let location = match (line, column) {
            (Some(l), Some(c)) => format!("{path}:{l}:{c}"),
            (Some(l), None) => format!("{path}:{l}"),
            _ => path.clone(),
        };
        if editor != "system"
            && let Some((binary, style)) = pick(&editor)
        {
            let mut cmd = tool_command(&binary);
            if style == "goto" {
                cmd.args(["-g", &location]);
            } else {
                cmd.arg(&location);
            }
            let out =
                proc::run(cmd, None, Duration::from_secs(15), 4096).map_err(|e| e.to_string())?;
            if out.success() {
                let name = Path::new(&binary)
                    .file_name()
                    .map(|n| n.to_string_lossy().into_owned());
                return Ok(name.unwrap_or(binary));
            }
            return Err(out.stderr_str());
        }
        system_open(file).map(|()| "system".to_owned())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Which of these absolute paths are existing files (links in the terminal
/// are only drawn for real files). At most 256 per call.
#[tauri::command]
pub async fn fs_existing_files(paths: Vec<String>) -> Vec<String> {
    tauri::async_runtime::spawn_blocking(move || {
        paths
            .into_iter()
            .take(256)
            .filter(|p| {
                let path = Path::new(p);
                path.is_absolute() && !p.contains('\0') && path.is_file()
            })
            .collect()
    })
    .await
    .unwrap_or_default()
}
