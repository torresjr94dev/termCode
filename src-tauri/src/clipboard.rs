//! Pegar en la terminal lo que no es texto.
//!
//! - Archivos copiados en Finder o el Explorador (⌘C / Ctrl+C): se pega su
//!   ruta, como hace Terminal.app. El webview no da rutas (solo el contenido),
//!   así que se leen del portapapeles del sistema.
//! - Una captura o una imagen copiada: se guarda en un archivo propio y se
//!   pega su ruta. Claude Code y Codex adjuntan la imagen al ver la ruta.
//!
//! Las imágenes van a la caché de la app (por usuario, nunca a un `/tmp`
//! compartido), con nombre nuevo y sin seguir enlaces; las de más de una
//! semana se borran al guardar la siguiente.

use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Manager};

/// Lo mismo que el visor acepta para previsualizar.
const MAX_IMAGE: usize = 30 * 1024 * 1024;
/// Archivos pegados de una vez como máximo (un ⌘A + ⌘C de una carpeta enorme).
const MAX_FILES: usize = 256;
const KEEP: Duration = Duration::from_secs(7 * 24 * 60 * 60);

/// Rutas de los archivos copiados en el gestor de archivos (vacío si no hay).
#[tauri::command]
pub async fn clipboard_files() -> Result<Vec<String>, String> {
    tauri::async_runtime::spawn_blocking(native_files)
        .await
        .map_err(|e| e.to_string())
}

/// Guarda los bytes de una imagen pegada y devuelve su ruta absoluta.
#[tauri::command]
pub async fn clipboard_save_image(
    app: AppHandle,
    request: tauri::ipc::Request<'_>,
) -> Result<String, String> {
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else {
        return Err("Se esperaban los bytes de la imagen.".into());
    };
    let bytes = bytes.clone();
    let dir = app
        .path()
        .app_cache_dir()
        .map_err(|e| format!("No hay carpeta de caché: {e}"))?
        .join("pegados");
    tauri::async_runtime::spawn_blocking(move || save_image(&dir, &bytes, SystemTime::now()))
        .await
        .map_err(|e| e.to_string())?
        .map(|path| path.to_string_lossy().into_owned())
}

/// Respaldo: la imagen del portapapeles del sistema (macOS), por si el webview
/// no la entregó en el evento de pegar. `None` si no hay imagen.
#[tauri::command]
pub async fn clipboard_image(app: AppHandle) -> Result<Option<String>, String> {
    let dir = app
        .path()
        .app_cache_dir()
        .map_err(|e| format!("No hay carpeta de caché: {e}"))?
        .join("pegados");
    tauri::async_runtime::spawn_blocking(move || match native_image() {
        Some(bytes) => save_image(&dir, &bytes, SystemTime::now())
            .map(|path| Some(path.to_string_lossy().into_owned())),
        None => Ok(None),
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Extensión según los primeros bytes (la que diga el portapapeles podría mentir).
fn image_extension(bytes: &[u8]) -> Option<&'static str> {
    let starts = |magic: &[u8]| bytes.starts_with(magic);
    if starts(b"\x89PNG\r\n\x1a\n") {
        Some("png")
    } else if starts(&[0xff, 0xd8, 0xff]) {
        Some("jpg")
    } else if starts(b"GIF87a") || starts(b"GIF89a") {
        Some("gif")
    } else if starts(b"RIFF") && bytes.get(8..12) == Some(b"WEBP") {
        Some("webp")
    } else if starts(b"II*\0") || starts(b"MM\0*") {
        Some("tiff")
    } else if starts(b"BM") {
        Some("bmp")
    } else {
        None
    }
}

fn save_image(dir: &Path, bytes: &[u8], now: SystemTime) -> Result<PathBuf, String> {
    if bytes.len() > MAX_IMAGE {
        return Err(format!(
            "La imagen pesa {} MB: demasiado para pegarla.",
            bytes.len() >> 20
        ));
    }
    let ext = image_extension(bytes)
        .ok_or("Lo que hay en el portapapeles no es una imagen que se pueda pegar.")?;
    std::fs::create_dir_all(dir).map_err(|e| format!("No se pudo crear {}: {e}", dir.display()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700));
    }
    prune(dir, now);

    let stamp = now.duration_since(UNIX_EPOCH).map_or(0, |d| d.as_millis());
    for attempt in 0..100u32 {
        let name = if attempt == 0 {
            format!("captura-{stamp}.{ext}")
        } else {
            format!("captura-{stamp}-{attempt}.{ext}")
        };
        let path = dir.join(name);
        let mut options = std::fs::OpenOptions::new();
        // create_new: nunca se sigue un enlace ni se pisa nada que ya exista.
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        match options.open(&path) {
            Ok(mut file) => {
                if let Err(e) = file.write_all(bytes).and_then(|()| file.sync_all()) {
                    let _ = std::fs::remove_file(&path);
                    return Err(format!("No se pudo guardar la imagen: {e}"));
                }
                return Ok(path);
            }
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(format!("No se pudo guardar la imagen: {e}")),
        }
    }
    Err("No se pudo elegir un nombre para la imagen.".into())
}

/// Borra las capturas pegadas hace más de una semana (solo las nuestras).
fn prune(dir: &Path, now: SystemTime) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let name = entry.file_name();
        if !name.to_string_lossy().starts_with("captura-") {
            continue;
        }
        let old = entry
            .metadata()
            .ok()
            .filter(|m| m.is_file())
            .and_then(|m| m.modified().ok())
            .and_then(|t| now.duration_since(t).ok())
            .is_some_and(|age| age > KEEP);
        if old {
            let _ = std::fs::remove_file(entry.path());
        }
    }
}

#[cfg(target_os = "macos")]
fn native_files() -> Vec<String> {
    objc2::rc::autoreleasepool(|_| file_paths(&objc2_app_kit::NSPasteboard::generalPasteboard()))
}

#[cfg(target_os = "macos")]
fn file_paths(board: &objc2_app_kit::NSPasteboard) -> Vec<String> {
    use objc2_app_kit::NSPasteboardTypeFileURL;
    use objc2_foundation::NSURL;

    let Some(items) = board.pasteboardItems() else {
        return Vec::new();
    };
    // SAFETY: constante de AppKit, inmutable y siempre presente.
    let file_url = unsafe { NSPasteboardTypeFileURL };
    let mut out = Vec::new();
    for i in 0..items.count().min(MAX_FILES) {
        let item = items.objectAtIndex(i);
        let Some(url) = item.stringForType(file_url) else {
            continue;
        };
        // Finder copia URLs de referencia (file:///.file/id=…): filePathURL las vuelve ruta.
        let path = NSURL::URLWithString(&url)
            .and_then(|u| u.filePathURL())
            .and_then(|u| u.path());
        if let Some(path) = path {
            out.push(path.to_string());
        }
    }
    out
}

#[cfg(target_os = "macos")]
fn native_image() -> Option<Vec<u8>> {
    objc2::rc::autoreleasepool(|_| image_png(&objc2_app_kit::NSPasteboard::generalPasteboard()))
}

/// PNG tal cual; si solo hay TIFF (lo que ponen muchas apps de macOS), se convierte a PNG.
#[cfg(target_os = "macos")]
fn image_png(board: &objc2_app_kit::NSPasteboard) -> Option<Vec<u8>> {
    use objc2::runtime::AnyObject;
    use objc2_app_kit::{
        NSBitmapImageFileType, NSBitmapImageRep, NSPasteboardTypePNG, NSPasteboardTypeTIFF,
    };
    use objc2_foundation::{NSDictionary, NSString};

    // SAFETY: constantes de AppKit, inmutables y siempre presentes.
    let (png, tiff) = unsafe { (NSPasteboardTypePNG, NSPasteboardTypeTIFF) };
    if let Some(data) = board.dataForType(png) {
        return Some(data.to_vec());
    }
    let data = board.dataForType(tiff)?;
    let rep = NSBitmapImageRep::imageRepWithData(&data)?;
    let none = NSDictionary::<NSString, AnyObject>::new();
    // SAFETY: diccionario vacío del tipo que pide el método.
    let png = unsafe { rep.representationUsingType_properties(NSBitmapImageFileType::PNG, &none) }?;
    Some(png.to_vec())
}

#[cfg(not(target_os = "macos"))]
fn native_image() -> Option<Vec<u8>> {
    None
}

#[cfg(windows)]
fn native_files() -> Vec<String> {
    use std::ffi::OsString;
    use std::os::windows::ffi::OsStringExt;
    use windows_sys::Win32::System::DataExchange::{
        CloseClipboard, GetClipboardData, IsClipboardFormatAvailable, OpenClipboard,
    };
    use windows_sys::Win32::System::Ole::CF_HDROP;
    use windows_sys::Win32::UI::Shell::DragQueryFileW;

    // SAFETY: llamadas Win32 documentadas; el portapapeles se cierra en todos los caminos
    // y los búferes miden lo que DragQueryFileW pidió.
    unsafe {
        if IsClipboardFormatAvailable(u32::from(CF_HDROP)) == 0 {
            return Vec::new();
        }
        // Otro programa puede tenerlo abierto un instante.
        let mut opened = false;
        for _ in 0..5 {
            if OpenClipboard(std::ptr::null_mut()) != 0 {
                opened = true;
                break;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        if !opened {
            return Vec::new();
        }
        let mut out = Vec::new();
        let drop = GetClipboardData(u32::from(CF_HDROP));
        if !drop.is_null() {
            let count = DragQueryFileW(drop, u32::MAX, std::ptr::null_mut(), 0);
            for i in 0..count.min(MAX_FILES as u32) {
                let len = DragQueryFileW(drop, i, std::ptr::null_mut(), 0);
                if len == 0 {
                    continue;
                }
                let mut buf = vec![0u16; len as usize + 1];
                let got = DragQueryFileW(drop, i, buf.as_mut_ptr(), buf.len() as u32) as usize;
                if got > 0 && got < buf.len() {
                    out.push(
                        OsString::from_wide(&buf[..got])
                            .to_string_lossy()
                            .into_owned(),
                    );
                }
            }
        }
        CloseClipboard();
        out
    }
}

/// Linux: WebKitGTK ya entrega `text/uri-list` en el evento de pegar.
#[cfg(not(any(target_os = "macos", windows)))]
fn native_files() -> Vec<String> {
    Vec::new()
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;

    fn dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("termcode-clip-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        dir
    }

    const PNG: &[u8] = b"\x89PNG\r\n\x1a\n\0\0\0\rIHDR";

    #[test]
    fn saves_images_with_their_real_extension_and_private_permissions() {
        use std::os::unix::fs::PermissionsExt;
        let dir = dir("saves");
        let now = SystemTime::now();
        let a = save_image(&dir, PNG, now).unwrap();
        let b = save_image(&dir, PNG, now).unwrap();
        assert_ne!(a, b, "misma hora: otro nombre, nunca se pisa");
        assert_eq!(a.extension().unwrap(), "png");
        assert_eq!(std::fs::read(&a).unwrap(), PNG);
        let mode = |p: &Path| std::fs::metadata(p).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode(&a), 0o600);
        assert_eq!(mode(&dir), 0o700);
        let jpg = save_image(&dir, &[0xff, 0xd8, 0xff, 0xe0], now).unwrap();
        assert_eq!(jpg.extension().unwrap(), "jpg");
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn refuses_what_is_not_an_image() {
        let dir = dir("refuses");
        assert!(save_image(&dir, b"<script>alert(1)</script>", SystemTime::now()).is_err());
        assert!(save_image(&dir, &[], SystemTime::now()).is_err());
        let big = [PNG, &vec![0u8; MAX_IMAGE]].concat();
        assert!(save_image(&dir, &big, SystemTime::now()).is_err());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn prunes_only_old_captures() {
        let dir = dir("prunes");
        let now = SystemTime::now();
        let old = save_image(&dir, PNG, now - KEEP - Duration::from_secs(60)).unwrap();
        std::fs::File::options()
            .write(true)
            .open(&old)
            .unwrap()
            .set_modified(now - KEEP - Duration::from_secs(60))
            .unwrap();
        let other = dir.join("notas.txt");
        std::fs::write(&other, "mío").unwrap();
        std::fs::File::options()
            .write(true)
            .open(&other)
            .unwrap()
            .set_modified(now - KEEP - Duration::from_secs(60))
            .unwrap();
        let fresh = save_image(&dir, PNG, now).unwrap();
        assert!(!old.exists(), "la captura vieja se borra");
        assert!(fresh.exists());
        assert!(other.exists(), "lo que no es nuestro no se toca");
        std::fs::remove_dir_all(dir).unwrap();
    }

    /// Lo que deja Finder al copiar: una URL de referencia (`file:///.file/id=…`),
    /// no la ruta. En un portapapeles propio: el del sistema es del usuario.
    #[cfg(target_os = "macos")]
    #[test]
    fn reads_finder_file_references_as_paths() {
        use objc2_app_kit::{NSPasteboard, NSPasteboardTypeFileURL};
        use objc2_foundation::{NSString, NSURL};
        let dir = dir("finder");
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("captura con espacios.png");
        std::fs::write(&file, PNG).unwrap();
        let file = file.canonicalize().unwrap();
        objc2::rc::autoreleasepool(|_| {
            let url = NSURL::fileURLWithPath(&NSString::from_str(&file.to_string_lossy()));
            let reference = url
                .fileReferenceURL()
                .and_then(|u| u.absoluteString())
                .unwrap();
            assert!(reference.to_string().starts_with("file:///.file/id="));
            let board = NSPasteboard::pasteboardWithUniqueName();
            board.clearContents();
            // SAFETY: constante de AppKit.
            let wrote = board.setString_forType(&reference, unsafe { NSPasteboardTypeFileURL });
            if wrote {
                assert_eq!(
                    file_paths(&board),
                    vec![file.to_string_lossy().into_owned()]
                );
            }
            board.clearContents();
        });
        std::fs::remove_dir_all(dir).unwrap();
    }

    /// Un PNG válido de 1×1 (el de arriba es solo la cabecera).
    #[cfg(target_os = "macos")]
    const PIXEL: &[u8] = &[
        0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44,
        0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x04, 0x00, 0x00, 0x00, 0xb5,
        0x1c, 0x0c, 0x02, 0x00, 0x00, 0x00, 0x0b, 0x49, 0x44, 0x41, 0x54, 0x78, 0xda, 0x63, 0x64,
        0x60, 0x00, 0x00, 0x00, 0x06, 0x00, 0x02, 0x30, 0x81, 0xd0, 0x2f, 0x00, 0x00, 0x00, 0x00,
        0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
    ];

    /// Captura con ⌘⌃⇧4 (PNG) o una app que solo copia TIFF: siempre sale un PNG.
    #[cfg(target_os = "macos")]
    #[test]
    fn reads_png_or_converts_tiff_from_the_system_clipboard() {
        use objc2_app_kit::{
            NSBitmapImageRep, NSPasteboard, NSPasteboardTypePNG, NSPasteboardTypeTIFF,
        };
        use objc2_foundation::NSData;
        objc2::rc::autoreleasepool(|_| {
            let board = NSPasteboard::pasteboardWithUniqueName();
            // SAFETY: constantes de AppKit.
            let (png, tiff) = unsafe { (NSPasteboardTypePNG, NSPasteboardTypeTIFF) };
            assert_eq!(image_png(&board), None, "vacío: nada que pegar");

            board.clearContents();
            if board.setData_forType(Some(&NSData::with_bytes(PIXEL)), png) {
                assert_eq!(image_png(&board).as_deref(), Some(PIXEL));
            }

            let tiff_bytes = NSBitmapImageRep::imageRepWithData(&NSData::with_bytes(PIXEL))
                .and_then(|rep| rep.TIFFRepresentation())
                .unwrap();
            board.clearContents();
            if board.setData_forType(Some(&tiff_bytes), tiff) {
                let out = image_png(&board).unwrap();
                assert_eq!(image_extension(&out), Some("png"), "TIFF → PNG");
            }
            board.clearContents();
        });
    }
}
