//! Imagen de fondo del tema «Vidrio líquido».
//!
//! La imagen que eliges se copia a la carpeta de datos de la app: si mueves o
//! borras el original, el tema sigue igual. Solo se guarda una (elegir otra
//! reemplaza a la anterior). El tipo se decide por sus primeros bytes, no por
//! la extensión, y se rechaza todo lo que no sea una imagen rasterizada que
//! las tres webviews sepan pintar (nada de SVG). Al leer, el nombre tiene que
//! ser exactamente uno de los que esto genera: la vista no puede pedir otra
//! ruta.

use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Manager};

/// Un fondo de 8K en PNG anda por los 20 MB; más que eso no aporta nada.
const MAX_BYTES: usize = 25 * 1024 * 1024;
const DIR: &str = "fondos";
const PREFIX: &str = "fondo-";

fn dir(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|d| d.join(DIR))
        .map_err(|e| format!("No hay carpeta de datos: {e}"))
}

/// Extensión según los primeros bytes.
fn image_kind(bytes: &[u8]) -> Option<&'static str> {
    let starts = |magic: &[u8]| bytes.starts_with(magic);
    if starts(b"\x89PNG\r\n\x1a\n") {
        Some("png")
    } else if starts(&[0xff, 0xd8, 0xff]) {
        Some("jpg")
    } else if starts(b"GIF87a") || starts(b"GIF89a") {
        Some("gif")
    } else if starts(b"RIFF") && bytes.get(8..12) == Some(b"WEBP") {
        Some("webp")
    } else if matches!(bytes.get(4..12), Some(b"ftypavif" | b"ftypavis")) {
        Some("avif")
    } else {
        None
    }
}

/// `fondo-<milisegundos>.<ext>`, nada más.
fn is_our_name(name: &str) -> bool {
    let Some(rest) = name.strip_prefix(PREFIX) else {
        return false;
    };
    let Some((stamp, ext)) = rest.split_once('.') else {
        return false;
    };
    !stamp.is_empty()
        && stamp.len() <= 20
        && stamp.bytes().all(|b| b.is_ascii_digit())
        && matches!(ext, "png" | "jpg" | "gif" | "webp" | "avif")
}

fn save(dir: &Path, bytes: &[u8], now: SystemTime) -> Result<String, String> {
    if bytes.len() > MAX_BYTES {
        return Err(format!(
            "La imagen pesa {} MB: el máximo es {} MB.",
            bytes.len() >> 20,
            MAX_BYTES >> 20
        ));
    }
    let ext =
        image_kind(bytes).ok_or("Ese archivo no es una imagen PNG, JPG, WebP, GIF o AVIF.")?;
    std::fs::create_dir_all(dir).map_err(|e| format!("No se pudo crear {}: {e}", dir.display()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700));
    }
    let stamp = now.duration_since(UNIX_EPOCH).map_or(0, |d| d.as_millis());
    let name = format!("{PREFIX}{stamp}.{ext}");
    // Primero el archivo nuevo completo (temporal + renombrar); luego se borran los viejos.
    let tmp = dir.join(format!(".{name}.tmp"));
    std::fs::write(&tmp, bytes).map_err(|e| format!("No se pudo guardar la imagen: {e}"))?;
    std::fs::rename(&tmp, dir.join(&name)).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        format!("No se pudo guardar la imagen: {e}")
    })?;
    remove_all_but(dir, Some(&name));
    Ok(name)
}

/// Borra los fondos guardados salvo `keep`. Solo toca archivos con nuestro nombre.
fn remove_all_but(dir: &Path, keep: Option<&str>) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let name = entry.file_name();
        let Some(name) = name.to_str() else { continue };
        if is_our_name(name) && Some(name) != keep {
            let _ = std::fs::remove_file(entry.path());
        }
    }
}

fn load(dir: &Path, name: &str) -> Result<Vec<u8>, String> {
    if !is_our_name(name) {
        return Err("Nombre de fondo inválido.".into());
    }
    let path = dir.join(name);
    if path.is_symlink() {
        return Err("Nombre de fondo inválido.".into());
    }
    let bytes = std::fs::read(&path).map_err(|e| format!("No se pudo leer el fondo: {e}"))?;
    if bytes.len() > MAX_BYTES || image_kind(&bytes).is_none() {
        return Err("El fondo guardado está dañado: elige la imagen otra vez.".into());
    }
    Ok(bytes)
}

/// Guarda la imagen (bytes crudos por IPC) y devuelve su nombre.
#[tauri::command]
pub async fn backdrop_save(
    app: AppHandle,
    request: tauri::ipc::Request<'_>,
) -> Result<String, String> {
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else {
        return Err("Se esperaban los bytes de la imagen.".into());
    };
    let bytes = bytes.clone();
    let dir = dir(&app)?;
    tauri::async_runtime::spawn_blocking(move || save(&dir, &bytes, SystemTime::now()))
        .await
        .map_err(|e| e.to_string())?
}

/// Los bytes del fondo guardado (la vista los convierte en una URL `blob:`).
#[tauri::command]
pub async fn backdrop_load(app: AppHandle, name: String) -> Result<tauri::ipc::Response, String> {
    let dir = dir(&app)?;
    tauri::async_runtime::spawn_blocking(move || load(&dir, &name))
        .await
        .map_err(|e| e.to_string())?
        .map(tauri::ipc::Response::new)
}

/// Quita el fondo propio (el tema vuelve al degradado de fábrica).
#[tauri::command]
pub async fn backdrop_clear(app: AppHandle) -> Result<(), String> {
    let dir = dir(&app)?;
    tauri::async_runtime::spawn_blocking(move || remove_all_but(&dir, None))
        .await
        .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    const PNG: &[u8] = b"\x89PNG\r\n\x1a\n\0\0\0\rIHDR";

    fn temp(name: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("termcode-fondo-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        dir
    }

    #[test]
    fn knows_images_by_their_bytes() {
        assert_eq!(image_kind(PNG), Some("png"));
        assert_eq!(image_kind(&[0xff, 0xd8, 0xff, 0xe0]), Some("jpg"));
        assert_eq!(image_kind(b"RIFF\0\0\0\0WEBPVP8 "), Some("webp"));
        assert_eq!(image_kind(b"\0\0\0\x1cftypavif"), Some("avif"));
        assert_eq!(image_kind(b"GIF89a"), Some("gif"));
        assert_eq!(image_kind(b"<svg xmlns="), None);
        assert_eq!(image_kind(b""), None);
    }

    #[test]
    fn only_loads_names_it_made() {
        assert!(is_our_name("fondo-1795753095452.png"));
        assert!(!is_our_name("fondo-.png"));
        assert!(!is_our_name("fondo-12.svg"));
        assert!(!is_our_name("../fondo-12.png"));
        assert!(!is_our_name("fondo-12.png/../../x"));
        assert!(!is_our_name("fondo-1a.png"));
        assert!(!is_our_name("otra.png"));
        assert!(load(&temp("x"), "../../etc/passwd").is_err());
    }

    #[test]
    fn keeps_a_single_copy_and_rejects_non_images() {
        let dir = temp("save");
        let t0 = UNIX_EPOCH + std::time::Duration::from_millis(1000);
        let t1 = UNIX_EPOCH + std::time::Duration::from_millis(2000);
        let first = save(&dir, PNG, t0).unwrap();
        assert_eq!(first, "fondo-1000.png");
        let second = save(&dir, &[0xff, 0xd8, 0xff, 0xdb], t1).unwrap();
        assert_eq!(second, "fondo-2000.jpg");
        assert!(!dir.join(&first).exists(), "el anterior se borra");
        assert_eq!(load(&dir, &second).unwrap(), vec![0xff, 0xd8, 0xff, 0xdb]);
        assert!(save(&dir, b"<svg/>", t1).is_err());
        assert!(
            save(&dir, &vec![0u8; MAX_BYTES + 1], t1)
                .unwrap_err()
                .contains("MB")
        );
        // Otros archivos de la carpeta no se tocan.
        std::fs::write(dir.join("nota.txt"), "x").unwrap();
        remove_all_but(&dir, None);
        assert!(!dir.join(&second).exists());
        assert!(dir.join("nota.txt").exists());
        std::fs::remove_dir_all(dir).unwrap();
    }
}
