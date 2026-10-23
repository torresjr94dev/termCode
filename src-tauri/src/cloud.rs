//! ¿Esta carpeta vive en una nube con File Provider (iCloud Drive, Dropbox,
//! OneDrive, Google Drive)?
//!
//! Con «Optimizar almacenamiento», macOS borra la copia local de los archivos
//! que no usas y los vuelve a bajar al leerlos. git lee el contenido de los
//! archivos rastreados para saber si cambiaron: se queda esperando esa
//! descarga y `git status` no termina. La vista lo usa para explicar por qué
//! un repo no responde en vez de solo reintentar.

#[cfg(target_os = "macos")]
const DOMAIN_XATTR: &std::ffi::CStr = c"com.apple.file-provider-domain-id";

/// Nombre legible del proveedor (`iCloud Drive`, `Dropbox`…) si `path` o una
/// de sus carpetas está sincronizada; `None` si es una carpeta local.
#[tauri::command]
pub async fn fs_cloud_provider(path: String) -> Option<String> {
    tauri::async_runtime::spawn_blocking(move || provider_of(std::path::Path::new(&path)))
        .await
        .ok()
        .flatten()
}

#[cfg(target_os = "macos")]
fn provider_of(path: &std::path::Path) -> Option<String> {
    use std::os::unix::ffi::OsStrExt;
    for dir in path.ancestors() {
        let Ok(c_path) = std::ffi::CString::new(dir.as_os_str().as_bytes()) else {
            continue;
        };
        let mut buf = [0u8; 512];
        // SAFETY: rutas y nombre terminados en 0; el búfer se pasa con su tamaño.
        let len = unsafe {
            libc::getxattr(
                c_path.as_ptr(),
                DOMAIN_XATTR.as_ptr(),
                buf.as_mut_ptr().cast(),
                buf.len(),
                0,
                libc::XATTR_NOFOLLOW,
            )
        };
        if len > 0 {
            return Some(provider_name(&String::from_utf8_lossy(
                &buf[..len as usize],
            )));
        }
    }
    None
}

#[cfg(not(target_os = "macos"))]
fn provider_of(_path: &std::path::Path) -> Option<String> {
    None
}

/// `com.apple.CloudDocs.iCloudDriveFileProvider/…` → `iCloud Drive`.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn provider_name(domain: &str) -> String {
    let lower = domain.to_ascii_lowercase();
    let known = [
        ("clouddocs", "iCloud Drive"),
        ("dropbox", "Dropbox"),
        ("onedrive", "OneDrive"),
        ("google", "Google Drive"),
        ("box.", "Box"),
    ];
    known
        .iter()
        .find(|(needle, _)| lower.contains(needle))
        .map(|(_, name)| (*name).to_owned())
        .unwrap_or_else(|| "una carpeta en la nube".to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_known_providers() {
        assert_eq!(
            provider_name("com.apple.CloudDocs.iCloudDriveFileProvider/E641"),
            "iCloud Drive"
        );
        assert_eq!(
            provider_name("com.getdropbox.dropbox.fileprovider/x"),
            "Dropbox"
        );
        assert_eq!(provider_name("otra.cosa"), "una carpeta en la nube");
    }

    #[test]
    fn a_temp_folder_is_local() {
        assert_eq!(provider_of(&std::env::temp_dir()), None);
    }
}
