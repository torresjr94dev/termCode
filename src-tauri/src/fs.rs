//! Read-only file access for the Project panel (tree + preview).
//!
//! Every path is resolved inside the project root sent by the webview: no
//! absolute paths, no `..`, and the canonical result must stay under the
//! canonical root (symlinks pointing outside are refused).

use crate::git;
use serde::Serialize;
use std::io::Read;
use std::path::{Component, Path, PathBuf};

const MAX_ENTRIES: usize = 5_000;
const MAX_PREVIEW: u64 = 512 * 1024;

fn resolve(root: &str, rel: &str) -> Result<(PathBuf, PathBuf), String> {
    let root = Path::new(root);
    if !root.is_absolute() {
        return Err("Ruta de proyecto inválida.".into());
    }
    let rel_path = Path::new(rel);
    if rel.contains('\0')
        || !rel_path
            .components()
            .all(|c| matches!(c, Component::Normal(_) | Component::CurDir))
    {
        return Err(format!("Ruta inválida: {rel}"));
    }
    let canonical_root = root
        .canonicalize()
        .map_err(|e| format!("No se puede abrir el proyecto: {e}"))?;
    let target = canonical_root
        .join(rel_path)
        .canonicalize()
        .map_err(|e| format!("No se puede abrir {rel}: {e}"))?;
    if !target.starts_with(&canonical_root) {
        return Err("La ruta apunta fuera del proyecto.".into());
    }
    Ok((canonical_root, target))
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    pub name: String,
    /// Relative to the project root, `/`-separated.
    pub path: String,
    pub is_dir: bool,
    pub size: u64,
    /// Matched by .gitignore (shown dimmed).
    pub ignored: bool,
}

fn ignored_set(root: &Path, rels: &[String]) -> std::collections::HashSet<String> {
    if rels.is_empty() || !root.join(".git").exists() {
        return Default::default();
    }
    let mut cmd = git::command(root);
    cmd.args(["check-ignore", "-z", "--stdin"]);
    let input = rels.join("\0").into_bytes();
    crate::proc::run(
        cmd,
        Some(input),
        std::time::Duration::from_secs(10),
        1024 * 1024,
    )
    .map(|out| {
        out.stdout_str()
            .split('\0')
            .filter(|p| !p.is_empty())
            .map(str::to_owned)
            .collect()
    })
    .unwrap_or_default()
}

fn list(root: &str, rel: &str) -> Result<Vec<Entry>, String> {
    let (canonical_root, dir) = resolve(root, rel)?;
    let mut entries: Vec<Entry> = std::fs::read_dir(&dir)
        .map_err(|e| format!("No se puede leer la carpeta: {e}"))?
        .flatten()
        .filter(|e| e.file_name() != ".git")
        .take(MAX_ENTRIES)
        .filter_map(|e| {
            let name = e.file_name().to_string_lossy().into_owned();
            let meta = e.metadata().ok()?; // follows symlinks
            let path = dir.join(&name);
            let path = path
                .strip_prefix(&canonical_root)
                .ok()?
                .to_string_lossy()
                .replace('\\', "/");
            Some(Entry {
                name,
                path,
                is_dir: meta.is_dir(),
                size: meta.len(),
                ignored: false,
            })
        })
        .collect();

    let rels: Vec<String> = entries.iter().map(|e| e.path.clone()).collect();
    let ignored = ignored_set(&canonical_root, &rels);
    for entry in &mut entries {
        entry.ignored = ignored.contains(&entry.path);
    }
    entries.sort_by(|a, b| {
        b.is_dir
            .cmp(&a.is_dir)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    Ok(entries)
}

#[tauri::command]
pub async fn fs_list(root: String, path: String) -> Result<Vec<Entry>, String> {
    tauri::async_runtime::spawn_blocking(move || list(&root, &path))
        .await
        .map_err(|e| e.to_string())?
}

const MAX_FILES: usize = 50_000;
/// Carpetas que nunca interesan en el buscador cuando no hay git que las ignore.
const SKIP_DIRS: &[&str] = &[
    "node_modules",
    "target",
    "dist",
    "build",
    ".next",
    ".venv",
    "__pycache__",
];

/// Every file of the project for the ⌘P finder, relative and `/`-separated.
/// In a repo: tracked + untracked not ignored (git already knows); elsewhere a
/// bounded walk that skips hidden and heavy folders.
fn files(root: &str) -> Result<Vec<String>, String> {
    let (canonical_root, _) = resolve(root, "")?;
    if canonical_root.join(".git").exists() {
        let out = git::git(
            &canonical_root,
            &[
                "ls-files",
                "-z",
                "--cached",
                "--others",
                "--exclude-standard",
                "--deduplicate",
            ],
        )?;
        return Ok(out
            .split('\0')
            .filter(|p| !p.is_empty())
            .take(MAX_FILES)
            .map(str::to_owned)
            .collect());
    }
    let mut out = Vec::new();
    let mut stack = vec![canonical_root.clone()];
    while let Some(dir) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let name = entry.file_name();
            let name = name.to_string_lossy();
            let Ok(kind) = entry.file_type() else {
                continue;
            };
            if kind.is_dir() {
                // Symlinked folders are not followed: they may point anywhere.
                if !name.starts_with('.') && !SKIP_DIRS.contains(&name.as_ref()) {
                    stack.push(entry.path());
                }
            } else if kind.is_file()
                && let Ok(rel) = entry.path().strip_prefix(&canonical_root)
            {
                out.push(rel.to_string_lossy().replace('\\', "/"));
                if out.len() >= MAX_FILES {
                    return Ok(out);
                }
            }
        }
    }
    Ok(out)
}

#[tauri::command]
pub async fn fs_files(root: String) -> Result<Vec<String>, String> {
    tauri::async_runtime::spawn_blocking(move || files(&root))
        .await
        .map_err(|e| e.to_string())?
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Preview {
    pub text: String,
    pub size: u64,
    pub truncated: bool,
    pub binary: bool,
    /// Absolute path (for "copy path", "reveal in Finder", pasting into a pane).
    pub absolute: String,
}

fn read(root: &str, rel: &str) -> Result<Preview, String> {
    let (_, file) = resolve(root, rel)?;
    let meta = std::fs::metadata(&file).map_err(|e| e.to_string())?;
    if meta.is_dir() {
        return Err("Es una carpeta.".into());
    }
    let mut buf = Vec::new();
    std::fs::File::open(&file)
        .and_then(|f| f.take(MAX_PREVIEW).read_to_end(&mut buf))
        .map_err(|e| format!("No se puede leer el archivo: {e}"))?;
    let binary = buf.iter().take(8192).any(|&b| b == 0);
    Ok(Preview {
        text: if binary {
            String::new()
        } else {
            String::from_utf8_lossy(&buf).into_owned()
        },
        size: meta.len(),
        truncated: meta.len() > MAX_PREVIEW,
        binary,
        absolute: file.to_string_lossy().into_owned(),
    })
}

#[tauri::command]
pub async fn fs_read(root: String, path: String) -> Result<Preview, String> {
    tauri::async_runtime::spawn_blocking(move || read(&root, &path))
        .await
        .map_err(|e| e.to_string())?
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;

    fn fixture(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("termcode-fs-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("src")).unwrap();
        std::fs::write(dir.join("src/b.ts"), "export {}\n").unwrap();
        std::fs::write(dir.join("A.md"), "# hola\n").unwrap();
        std::fs::write(dir.join("bin.dat"), [0u8, 1, 2]).unwrap();
        std::fs::write(dir.join(".gitignore"), "bin.dat\n").unwrap();
        crate::git::git(&dir, &["init", "-q"]).unwrap();
        dir
    }

    #[test]
    fn lists_dirs_first_and_marks_ignored() {
        let dir = fixture("lists_dirs_first_and_marks_ignored");
        let root = dir.to_string_lossy().into_owned();
        let names: Vec<_> = list(&root, "")
            .unwrap()
            .into_iter()
            .map(|e| (e.name, e.is_dir, e.ignored))
            .collect();
        assert_eq!(names[0], ("src".into(), true, false));
        assert!(names.contains(&("bin.dat".into(), false, true)));
        assert!(!names.iter().any(|(n, _, _)| n == ".git"));
        assert_eq!(list(&root, "src").unwrap()[0].path, "src/b.ts");
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn previews_text_and_detects_binary() {
        let dir = fixture("previews_text_and_detects_binary");
        let root = dir.to_string_lossy().into_owned();
        assert_eq!(read(&root, "A.md").unwrap().text, "# hola\n");
        assert!(read(&root, "bin.dat").unwrap().binary);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn lists_project_files_respecting_gitignore() {
        let dir = fixture("lists_project_files");
        let root = dir.to_string_lossy().into_owned();
        let mut all = files(&root).unwrap();
        all.sort();
        assert_eq!(all, vec![".gitignore", "A.md", "src/b.ts"]);
        // Sin git: recorrido acotado que salta carpetas pesadas.
        std::fs::remove_dir_all(dir.join(".git")).unwrap();
        std::fs::create_dir_all(dir.join("node_modules/x")).unwrap();
        std::fs::write(dir.join("node_modules/x/i.js"), "").unwrap();
        let mut all = files(&root).unwrap();
        all.sort();
        assert_eq!(all, vec![".gitignore", "A.md", "bin.dat", "src/b.ts"]);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn refuses_escaping_the_root() {
        let dir = fixture("refuses_escaping_the_root");
        let root = dir.to_string_lossy().into_owned();
        assert!(read(&root, "../etc/passwd").is_err());
        assert!(read(&root, "/etc/passwd").is_err());
        std::os::unix::fs::symlink("/etc", dir.join("fuga")).unwrap();
        assert!(list(&root, "fuga").is_err(), "symlink outside the root");
        std::fs::remove_dir_all(dir).unwrap();
    }
}
