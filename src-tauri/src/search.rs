//! «Buscar en archivos»: el texto dentro de los archivos del proyecto (o de
//! una carpeta suya), línea por línea.
//!
//! Los archivos son los mismos que lista el buscador (⌘P): en un repo, lo que
//! git no ignora. Las expresiones son las del crate `regex`, de tiempo lineal:
//! ningún patrón puede colgar la búsqueda. Todo tiene tope: tamaño de archivo,
//! coincidencias por archivo y en total, y tiempo. Los binarios y los archivos
//! que solo están en la nube (iCloud con «Optimizar almacenamiento», OneDrive)
//! se saltan sin leerlos: leerlos los descargaría y la búsqueda se quedaría
//! esperando. Una búsqueda nueva cancela la que siga corriendo.

use crate::fs::{files, resolve};
use regex::{Regex, RegexBuilder};
use serde::{Deserialize, Serialize};
use std::io::Read;
use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::time::{Duration, Instant};

const MAX_FILE: u64 = 2 * 1024 * 1024;
const MAX_MATCHES: usize = 2_000;
const MAX_PER_FILE: usize = 100;
const MAX_QUERY: usize = 1_000;
const BUDGET: Duration = Duration::from_secs(10);
/// Caracteres de la línea que se muestran (las minificadas tienen miles).
const PREVIEW_CHARS: usize = 200;
/// Contexto antes de la coincidencia cuando hay que recortar la línea.
const PREVIEW_LEAD: usize = 40;

/// La búsqueda más reciente: las anteriores que sigan corriendo se detienen.
static LATEST: AtomicU64 = AtomicU64::new(0);

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchQuery {
    pub query: String,
    #[serde(default)]
    pub case_sensitive: bool,
    #[serde(default)]
    pub whole_word: bool,
    #[serde(default)]
    pub regex: bool,
    /// Carpeta dentro de la raíz (`""` = todo el proyecto), separada con `/`.
    #[serde(default)]
    pub dir: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LineMatch {
    /// Empieza en 1.
    pub line: u32,
    /// Inicio de la primera coincidencia en la línea, en unidades UTF-16 (como cuentan JS y CodeMirror).
    pub column: u32,
    /// Largo de esa coincidencia, en UTF-16.
    pub length: u32,
    /// La línea (o un tramo alrededor de la coincidencia), sin la sangría.
    pub preview: String,
    /// Coincidencias dentro de `preview`, `[inicio, fin)` en UTF-16.
    pub ranges: Vec<[u32; 2]>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileMatches {
    pub path: String,
    pub matches: Vec<LineMatch>,
    /// Hay más coincidencias en el archivo que las devueltas.
    pub more: bool,
}

#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchResult {
    pub files: Vec<FileMatches>,
    /// Coincidencias devueltas (una por línea).
    pub total: usize,
    /// Archivos de texto leídos.
    pub searched: usize,
    /// Se paró antes: demasiadas coincidencias o se acabó el tiempo.
    pub truncated: bool,
    /// Otra búsqueda la reemplazó (la vista ignora el resultado).
    pub cancelled: bool,
    /// Saltados sin leer: muy grandes o solo en la nube.
    pub skipped: usize,
}

#[tauri::command]
pub async fn fs_search(root: String, query: SearchQuery, id: u64) -> Result<SearchResult, String> {
    LATEST.fetch_max(id, Ordering::SeqCst);
    tauri::async_runtime::spawn_blocking(move || {
        search(&root, &query, &|| LATEST.load(Ordering::Relaxed) != id)
    })
    .await
    .map_err(|e| e.to_string())?
}

fn build_regex(q: &SearchQuery) -> Result<Regex, String> {
    if q.query.is_empty() {
        return Err("Escribe qué buscar.".into());
    }
    if q.query.len() > MAX_QUERY {
        return Err("La búsqueda es demasiado larga.".into());
    }
    let pattern = if q.regex {
        q.query.clone()
    } else {
        regex::escape(&q.query)
    };
    let pattern = if q.whole_word {
        format!(r"\b(?:{pattern})\b")
    } else {
        pattern
    };
    RegexBuilder::new(&pattern)
        .case_insensitive(!q.case_sensitive)
        // ^ y $ por línea también en el filtro previo, que mira el archivo entero.
        .multi_line(true)
        .crlf(true)
        .size_limit(4 * 1024 * 1024)
        .dfa_size_limit(8 * 1024 * 1024)
        .build()
        .map_err(|e| {
            // El error de sintaxis trae un dibujo de varias líneas: basta la explicación.
            let text = e.to_string();
            let reason = text
                .lines()
                .rev()
                .find(|l| !l.trim().is_empty())
                .unwrap_or("");
            format!(
                "Expresión regular inválida: {}",
                reason.trim().trim_start_matches("error: ")
            )
        })
}

/// Solo un marcador de lo que vive en la nube: leerlo lo descargaría.
fn is_cloud_placeholder(meta: &std::fs::Metadata) -> bool {
    #[cfg(target_os = "macos")]
    {
        use std::os::macos::fs::MetadataExt;
        const SF_DATALESS: u32 = 0x4000_0000;
        meta.st_flags() & SF_DATALESS != 0
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        const FILE_ATTRIBUTE_OFFLINE: u32 = 0x1000;
        const FILE_ATTRIBUTE_RECALL_ON_DATA_ACCESS: u32 = 0x0040_0000;
        meta.file_attributes() & (FILE_ATTRIBUTE_OFFLINE | FILE_ATTRIBUTE_RECALL_ON_DATA_ACCESS)
            != 0
    }
    #[cfg(not(any(target_os = "macos", windows)))]
    {
        let _ = meta;
        false
    }
}

enum Outcome {
    /// Leído; con o sin coincidencias.
    Searched(Option<FileMatches>),
    /// Muy grande o solo en la nube.
    Skipped,
    /// Binario, enlace, carpeta o ilegible.
    Ignored,
}

fn search_file(root: &Path, rel: &str, regex: &Regex) -> Outcome {
    let path = root.join(rel);
    // Sin seguir enlaces: uno dentro del repo puede apuntar a cualquier parte.
    let Ok(meta) = std::fs::symlink_metadata(&path) else {
        return Outcome::Ignored;
    };
    if !meta.is_file() {
        return Outcome::Ignored;
    }
    if meta.len() > MAX_FILE || is_cloud_placeholder(&meta) {
        return Outcome::Skipped;
    }
    let mut bytes = Vec::with_capacity(meta.len() as usize);
    if std::fs::File::open(&path)
        .and_then(|f| f.take(MAX_FILE).read_to_end(&mut bytes))
        .is_err()
    {
        return Outcome::Ignored;
    }
    if bytes[..bytes.len().min(8192)].contains(&0) {
        return Outcome::Ignored;
    }
    let text = String::from_utf8_lossy(&bytes);
    // La mayoría de los archivos no tiene nada: un solo recorrido rápido los descarta.
    if !regex.is_match(&text) {
        return Outcome::Searched(None);
    }
    let mut matches = Vec::new();
    let mut more = false;
    for (index, line) in text.split('\n').enumerate() {
        let line = line.strip_suffix('\r').unwrap_or(line);
        let spans: Vec<(usize, usize)> = regex
            .find_iter(line)
            .filter(|m| !m.is_empty())
            .map(|m| (m.start(), m.end()))
            .take(32)
            .collect();
        if spans.is_empty() {
            continue;
        }
        if matches.len() == MAX_PER_FILE {
            more = true;
            break;
        }
        matches.push(line_match(line, index as u32 + 1, &spans));
    }
    if matches.is_empty() {
        return Outcome::Searched(None);
    }
    Outcome::Searched(Some(FileMatches {
        path: rel.to_owned(),
        matches,
        more,
    }))
}

fn utf16_len(s: &str) -> u32 {
    s.encode_utf16().count() as u32
}

/// La línea lista para mostrar: sin sangría y, si es muy larga, un tramo
/// alrededor de la primera coincidencia. `spans` son bytes de `line`.
fn line_match(line: &str, number: u32, spans: &[(usize, usize)]) -> LineMatch {
    let (first_start, first_end) = spans[0];
    let indent = line.len() - line.trim_start().len();
    let mut start = indent.min(first_start);
    let mut end = line.len();
    if line[start..].chars().count() > PREVIEW_CHARS {
        // Hasta PREVIEW_LEAD caracteres antes de la coincidencia, y desde ahí PREVIEW_CHARS.
        start = line[start..first_start]
            .char_indices()
            .rev()
            .nth(PREVIEW_LEAD - 1)
            .map_or(start, |(i, _)| start + i);
        end = line[start..]
            .char_indices()
            .nth(PREVIEW_CHARS)
            .map_or(line.len(), |(i, _)| start + i);
    }
    let prefix = if start > indent { "…" } else { "" };
    let suffix = if end < line.len() { "…" } else { "" };
    let base = utf16_len(prefix);
    let ranges = spans
        .iter()
        .filter(|(s, e)| *e > start && *s < end)
        .map(|&(s, e)| {
            let (s, e) = (s.max(start), e.min(end));
            let from = base + utf16_len(&line[start..s]);
            [from, from + utf16_len(&line[s..e])]
        })
        .collect();
    LineMatch {
        line: number,
        column: utf16_len(&line[..first_start]),
        length: utf16_len(&line[first_start..first_end]),
        preview: format!("{prefix}{}{suffix}", &line[start..end]),
        ranges,
    }
}

fn search(
    root: &str,
    q: &SearchQuery,
    cancelled: &(dyn Fn() -> bool + Sync),
) -> Result<SearchResult, String> {
    let regex = build_regex(q)?;
    let dir = q.dir.trim_matches('/');
    let (canonical_root, base) = resolve(root, dir)?;
    if !base.is_dir() {
        return Err("No es una carpeta.".into());
    }
    let prefix = if dir.is_empty() {
        String::new()
    } else {
        format!("{dir}/")
    };
    let all = files(root)?;
    let candidates: Vec<&str> = all
        .iter()
        .map(String::as_str)
        .filter(|p| p.starts_with(&prefix))
        .collect();

    let started = Instant::now();
    let next = AtomicUsize::new(0);
    let total = AtomicUsize::new(0);
    let stop = AtomicBool::new(false);
    let truncated = AtomicBool::new(false);
    let was_cancelled = AtomicBool::new(false);
    let threads = std::thread::available_parallelism()
        .map_or(4, |n| n.get())
        .clamp(1, 8);

    let parts: Vec<(Vec<FileMatches>, usize, usize)> = std::thread::scope(|scope| {
        let workers: Vec<_> = (0..threads)
            .map(|_| {
                scope.spawn(|| {
                    let (mut found, mut searched, mut skipped) = (Vec::new(), 0, 0);
                    while !stop.load(Ordering::Relaxed) {
                        if cancelled() {
                            was_cancelled.store(true, Ordering::Relaxed);
                            stop.store(true, Ordering::Relaxed);
                            break;
                        }
                        if started.elapsed() > BUDGET {
                            truncated.store(true, Ordering::Relaxed);
                            stop.store(true, Ordering::Relaxed);
                            break;
                        }
                        let Some(rel) = candidates.get(next.fetch_add(1, Ordering::Relaxed)) else {
                            break;
                        };
                        match search_file(&canonical_root, rel, &regex) {
                            Outcome::Searched(hit) => {
                                searched += 1;
                                if let Some(hit) = hit {
                                    let count = hit.matches.len();
                                    found.push(hit);
                                    if total.fetch_add(count, Ordering::Relaxed) + count
                                        >= MAX_MATCHES
                                    {
                                        truncated.store(true, Ordering::Relaxed);
                                        stop.store(true, Ordering::Relaxed);
                                    }
                                }
                            }
                            Outcome::Skipped => skipped += 1,
                            Outcome::Ignored => {}
                        }
                    }
                    (found, searched, skipped)
                })
            })
            .collect();
        workers
            .into_iter()
            .map(|w| w.join().unwrap_or_default())
            .collect()
    });

    let mut result = SearchResult {
        truncated: truncated.load(Ordering::Relaxed),
        cancelled: was_cancelled.load(Ordering::Relaxed),
        ..Default::default()
    };
    for (found, searched, skipped) in parts {
        result.files.extend(found);
        result.searched += searched;
        result.skipped += skipped;
    }
    // Orden estable (los hilos terminan en cualquier orden) y el tope exacto.
    result.files.sort_by(|a, b| a.path.cmp(&b.path));
    let mut budget = MAX_MATCHES;
    result.files.retain_mut(|f| {
        if budget == 0 {
            return false;
        }
        if f.matches.len() > budget {
            f.matches.truncate(budget);
            f.more = true;
        }
        budget -= f.matches.len();
        true
    });
    result.total = result.files.iter().map(|f| f.matches.len()).sum();
    Ok(result)
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;

    fn fixture(name: &str) -> std::path::PathBuf {
        let dir =
            std::env::temp_dir().join(format!("termcode-search-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("src/ui")).unwrap();
        std::fs::create_dir_all(dir.join("node_modules/x")).unwrap();
        std::fs::write(
            dir.join("src/main.rs"),
            "fn main() {\n    let total = 1;\n    println!(\"{total}\");\n}\n",
        )
        .unwrap();
        std::fs::write(
            dir.join("src/ui/App.tsx"),
            "export const App = () => <Total value={1} />;\r\n",
        )
        .unwrap();
        std::fs::write(dir.join("README.md"), "# Proyecto\nEl total del mes.\n").unwrap();
        std::fs::write(dir.join("src/logo.bin"), [0u8, 116, 111, 116, 97, 108]).unwrap();
        std::fs::write(dir.join("node_modules/x/i.js"), "total").unwrap();
        std::fs::write(dir.join(".gitignore"), "node_modules\n").unwrap();
        crate::git::git(&dir, &["init", "-q"]).unwrap();
        dir
    }

    fn run(dir: &Path, q: SearchQuery) -> SearchResult {
        search(&dir.to_string_lossy(), &q, &|| false).unwrap()
    }

    fn q(text: &str) -> SearchQuery {
        SearchQuery {
            query: text.into(),
            ..Default::default()
        }
    }

    fn paths(r: &SearchResult) -> Vec<&str> {
        r.files.iter().map(|f| f.path.as_str()).collect()
    }

    #[test]
    fn finds_text_respecting_gitignore_and_skipping_binaries() {
        let dir = fixture("finds");
        let r = run(&dir, q("total"));
        assert_eq!(
            paths(&r),
            vec!["README.md", "src/main.rs", "src/ui/App.tsx"]
        );
        let main = &r.files[1];
        assert_eq!(main.matches.len(), 2);
        assert_eq!(main.matches[0].line, 2);
        assert_eq!(main.matches[0].preview, "let total = 1;", "sin sangría");
        assert_eq!(main.matches[0].ranges, vec![[4, 9]]);
        assert_eq!(main.matches[0].column, 8, "la columna cuenta la sangría");
        assert!(!r.files[2].matches[0].preview.ends_with('\r'), "CRLF fuera");
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn honours_case_whole_word_regex_and_folder() {
        let dir = fixture("options");
        let case = SearchQuery {
            case_sensitive: true,
            ..q("Total")
        };
        assert_eq!(paths(&run(&dir, case)), vec!["src/ui/App.tsx"]);

        let word = SearchQuery {
            whole_word: true,
            ..q("tot")
        };
        assert!(run(&dir, word).files.is_empty());

        let regex = SearchQuery {
            regex: true,
            ..q(r"let \w+ = \d")
        };
        assert_eq!(paths(&run(&dir, regex)), vec!["src/main.rs"]);

        // ^ y $ son de cada línea, no del archivo (el filtro previo lo mira entero).
        let anchored = SearchQuery {
            regex: true,
            ..q(r"^\s+let total")
        };
        assert_eq!(paths(&run(&dir, anchored)), vec!["src/main.rs"]);
        let at_end = SearchQuery {
            regex: true,
            ..q(r"1;$")
        };
        assert_eq!(paths(&run(&dir, at_end)), vec!["src/main.rs"]);

        let literal = q("{total}");
        assert_eq!(
            paths(&run(&dir, literal)),
            vec!["src/main.rs"],
            "sin regex, las llaves son texto"
        );

        let folder = SearchQuery {
            dir: "src/ui".into(),
            ..q("total")
        };
        assert_eq!(paths(&run(&dir, folder)), vec!["src/ui/App.tsx"]);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn refuses_bad_input() {
        let dir = fixture("bad");
        let root = dir.to_string_lossy().into_owned();
        assert!(search(&root, &q(""), &|| false).is_err());
        let bad = SearchQuery {
            regex: true,
            ..q("(sin cerrar")
        };
        let err = search(&root, &bad, &|| false).unwrap_err();
        assert!(err.starts_with("Expresión regular inválida"), "{err}");
        assert!(!err.contains('\n'));
        let outside = SearchQuery {
            dir: "../..".into(),
            ..q("total")
        };
        assert!(search(&root, &outside, &|| false).is_err());
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn a_newer_search_cancels_this_one() {
        let dir = fixture("cancel");
        let r = search(&dir.to_string_lossy(), &q("total"), &|| true).unwrap();
        assert!(r.cancelled);
        assert!(r.files.is_empty());
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn does_not_follow_symlinks_out_of_the_project() {
        let dir = fixture("symlink");
        let outside =
            std::env::temp_dir().join(format!("termcode-search-fuera-{}", std::process::id()));
        std::fs::write(&outside, "total secreto").unwrap();
        std::os::unix::fs::symlink(&outside, dir.join("fuga.txt")).unwrap();
        let r = run(&dir, q("secreto"));
        assert!(r.files.is_empty());
        std::fs::remove_file(outside).unwrap();
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn long_lines_show_a_window_around_the_match_in_utf16() {
        let line = format!("{}ñandú {}", "x".repeat(500), "y".repeat(500));
        let m = line_match(&line, 7, &[(500, 500 + "ñandú".len())]);
        assert!(m.preview.starts_with('…') && m.preview.ends_with('…'));
        assert_eq!(m.column, 500);
        assert_eq!(m.length, 5, "ñ y ú cuentan una unidad UTF-16");
        let [s, e] = m.ranges[0];
        let units: Vec<u16> = m.preview.encode_utf16().collect();
        assert_eq!(
            String::from_utf16(&units[s as usize..e as usize]).unwrap(),
            "ñandú"
        );
        assert!(m.preview.chars().count() <= PREVIEW_CHARS + 2);
    }

    #[test]
    fn caps_matches_per_file() {
        let dir = fixture("cap");
        std::fs::write(dir.join("muchos.txt"), "total\n".repeat(MAX_PER_FILE + 5)).unwrap();
        let r = run(&dir, q("total"));
        let many = r.files.iter().find(|f| f.path == "muchos.txt").unwrap();
        assert_eq!(many.matches.len(), MAX_PER_FILE);
        assert!(many.more);
        std::fs::remove_dir_all(dir).unwrap();
    }
}
