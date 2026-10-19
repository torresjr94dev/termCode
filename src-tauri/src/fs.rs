//! File access for the Project panel: tree, preview, images and editing.
//!
//! Every path is resolved inside the project root sent by the webview: no
//! absolute paths, no `..`, and the canonical result must stay under the
//! canonical root (symlinks pointing outside are refused). Writes only replace
//! existing regular files, never touch `.git/`, and refuse to overwrite a file
//! that changed on disk since it was read (an agent may be editing it too).

use crate::git;
use serde::Serialize;
use std::io::{Read, Write};
use std::path::{Component, Path, PathBuf};
use std::time::UNIX_EPOCH;

const MAX_ENTRIES: usize = 5_000;
/// Text files up to this size open (and can be edited) in the viewer.
const MAX_PREVIEW: u64 = 2 * 1024 * 1024;
const MAX_IMAGE: u64 = 30 * 1024 * 1024;
const MAX_WRITE: usize = 4 * 1024 * 1024;

/// Identity of a file's content on disk: changes whenever someone writes it.
fn version_of(meta: &std::fs::Metadata) -> String {
    let modified = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map_or(0, |d| d.as_nanos());
    format!("{modified}:{}", meta.len())
}

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
    /// Valid UTF-8: only then can it be edited without corrupting it.
    pub utf8: bool,
    /// Pass back to [`fs_write`] to detect concurrent changes.
    pub version: String,
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
    let truncated = meta.len() > MAX_PREVIEW;
    // Recortado, el final puede caer a mitad de un carácter: eso no cuenta como inválido.
    let utf8 = match std::str::from_utf8(&buf) {
        Ok(_) => true,
        Err(e) => truncated && e.error_len().is_none(),
    };
    Ok(Preview {
        text: if binary {
            String::new()
        } else {
            String::from_utf8_lossy(&buf).into_owned()
        },
        size: meta.len(),
        truncated,
        binary,
        utf8: utf8 && !binary,
        version: version_of(&meta),
        absolute: file.to_string_lossy().into_owned(),
    })
}

#[tauri::command]
pub async fn fs_read(root: String, path: String) -> Result<Preview, String> {
    tauri::async_runtime::spawn_blocking(move || read(&root, &path))
        .await
        .map_err(|e| e.to_string())?
}

/// Image formats the webview can show, recognised by their first bytes (the
/// extension alone could lie). SVG goes into an `<img>`, where scripts never run.
fn is_image(head: &[u8], rel: &str) -> bool {
    let starts = |magic: &[u8]| head.starts_with(magic);
    let brand = head.get(4..12);
    starts(b"\x89PNG\r\n\x1a\n")
        || starts(&[0xff, 0xd8, 0xff])
        || starts(b"GIF87a")
        || starts(b"GIF89a")
        || (starts(b"RIFF") && head.get(8..12) == Some(b"WEBP"))
        || starts(b"BM")
        || starts(&[0, 0, 1, 0])
        || starts(b"II*\0")
        || starts(b"MM\0*")
        || matches!(brand, Some(b) if b == b"ftypavif" || b == b"ftypavis")
        || (rel.to_ascii_lowercase().ends_with(".svg") && {
            let text = String::from_utf8_lossy(&head[..head.len().min(1024)]).to_ascii_lowercase();
            text.contains("<svg")
        })
}

fn read_image(root: &str, rel: &str) -> Result<Vec<u8>, String> {
    let (_, file) = resolve(root, rel)?;
    let meta = std::fs::metadata(&file).map_err(|e| e.to_string())?;
    if !meta.is_file() {
        return Err("No es un archivo.".into());
    }
    if meta.len() > MAX_IMAGE {
        return Err(format!(
            "La imagen pesa {} MB: demasiado para previsualizarla aquí.",
            meta.len() >> 20
        ));
    }
    let bytes = std::fs::read(&file).map_err(|e| format!("No se puede leer la imagen: {e}"))?;
    if !is_image(&bytes[..bytes.len().min(1024)], rel) {
        return Err("El archivo no es una imagen que se pueda mostrar.".into());
    }
    Ok(bytes)
}

/// Raw bytes (binary IPC, no base64): the webview turns them into a blob URL.
#[tauri::command]
pub async fn fs_read_image(root: String, path: String) -> Result<tauri::ipc::Response, String> {
    tauri::async_runtime::spawn_blocking(move || read_image(&root, &path))
        .await
        .map_err(|e| e.to_string())?
        .map(tauri::ipc::Response::new)
}

/// Current version of a file, to notice when someone else changed it.
#[tauri::command]
pub async fn fs_version(root: String, path: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let (_, file) = resolve(&root, &path)?;
        std::fs::metadata(&file)
            .map(|m| version_of(&m))
            .map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

pub(crate) const CHANGED_ON_DISK: &str = "El archivo cambió en disco desde que lo abriste.";

/// Replaces an existing file atomically (temp file + rename, same permissions).
/// `expected`: the version that was read; `None` overwrites whatever is there.
fn write(root: &str, rel: &str, content: &str, expected: Option<&str>) -> Result<String, String> {
    if content.len() > MAX_WRITE {
        return Err("El contenido es demasiado grande para guardarlo desde aquí.".into());
    }
    if Path::new(rel).components().any(|c| c.as_os_str() == ".git") {
        return Err("Los archivos de .git no se editan desde aquí.".into());
    }
    let (_, file) = resolve(root, rel)?;
    let meta = std::fs::metadata(&file).map_err(|e| e.to_string())?;
    if !meta.is_file() {
        return Err("No es un archivo.".into());
    }
    if expected.is_some_and(|v| v != version_of(&meta)) {
        return Err(CHANGED_ON_DISK.into());
    }
    let dir = file.parent().ok_or("Ruta inválida.")?;
    let name = file
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or("Nombre de archivo inválido.")?;
    let nonce = std::time::SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_nanos());
    let tmp = dir.join(format!(
        ".{name}.termcode-{}-{nonce}.tmp",
        std::process::id()
    ));
    let written = (|| -> std::io::Result<()> {
        // create_new: nunca se sigue un enlace ni se pisa nada que ya exista con ese nombre.
        let mut out = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&tmp)?;
        out.write_all(content.as_bytes())?;
        out.sync_all()?;
        std::fs::set_permissions(&tmp, meta.permissions())?;
        std::fs::rename(&tmp, &file)
    })();
    if let Err(e) = written {
        let _ = std::fs::remove_file(&tmp);
        return Err(format!("No se pudo guardar: {e}"));
    }
    std::fs::metadata(&file)
        .map(|m| version_of(&m))
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn fs_write(
    root: String,
    path: String,
    content: String,
    expected_version: Option<String>,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        write(&root, &path, &content, expected_version.as_deref())
    })
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

    #[test]
    fn recognises_images_by_content() {
        let dir = fixture("recognises_images");
        let root = dir.to_string_lossy().into_owned();
        let png = b"\x89PNG\r\n\x1a\n\0\0\0\rIHDR";
        std::fs::write(dir.join("logo.png"), png).unwrap();
        std::fs::write(
            dir.join("icono.svg"),
            "<?xml version=\"1.0\"?><svg xmlns=\"http://www.w3.org/2000/svg\"/>",
        )
        .unwrap();
        std::fs::write(dir.join("falsa.png"), "no soy una imagen").unwrap();
        assert_eq!(read_image(&root, "logo.png").unwrap(), png);
        assert!(read_image(&root, "icono.svg").is_ok());
        assert!(
            read_image(&root, "falsa.png").is_err(),
            "la extensión no basta"
        );
        assert!(read_image(&root, "../afuera.png").is_err());
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn writes_atomically_and_detects_concurrent_changes() {
        use std::os::unix::fs::PermissionsExt;
        let dir = fixture("writes");
        let root = dir.to_string_lossy().into_owned();
        let path = dir.join("A.md");
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o640)).unwrap();

        let opened = read(&root, "A.md").unwrap();
        assert!(opened.utf8);
        let v2 = write(&root, "A.md", "# editado\n", Some(&opened.version)).unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "# editado\n");
        assert_eq!(
            std::fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o640
        );

        // Otro proceso (un agente) cambia el archivo: la versión vieja ya no sirve.
        std::thread::sleep(std::time::Duration::from_millis(5));
        std::fs::write(&path, "# del agente\n").unwrap();
        assert_eq!(
            write(&root, "A.md", "# mío\n", Some(&v2)).unwrap_err(),
            CHANGED_ON_DISK
        );
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "# del agente\n");
        // Sobrescribir a sabiendas.
        write(&root, "A.md", "# mío\n", None).unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "# mío\n");

        // Ningún temporal queda tirado.
        let leftovers: Vec<_> = std::fs::read_dir(&dir)
            .unwrap()
            .flatten()
            .filter(|e| e.file_name().to_string_lossy().contains(".termcode-"))
            .collect();
        assert!(leftovers.is_empty());

        assert!(write(&root, "../fuera.md", "x", None).is_err());
        assert!(write(&root, "src", "x", None).is_err(), "carpeta");
        assert!(
            write(&root, "nuevo.md", "x", None).is_err(),
            "solo archivos existentes"
        );
        std::fs::create_dir_all(dir.join(".git/hooks")).unwrap();
        std::fs::write(dir.join(".git/hooks/pre-commit"), "").unwrap();
        assert!(write(&root, ".git/hooks/pre-commit", "rm -rf /", None).is_err());
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn flags_non_utf8_files_as_not_editable() {
        let dir = fixture("latin1");
        let root = dir.to_string_lossy().into_owned();
        std::fs::write(dir.join("viejo.txt"), b"caf\xe9 con leche").unwrap();
        let p = read(&root, "viejo.txt").unwrap();
        assert!(!p.binary);
        assert!(!p.utf8, "editarlo lo convertiría a UTF-8 y lo dañaría");
        std::fs::remove_dir_all(dir).unwrap();
    }
}
