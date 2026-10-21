//! Canal local entre la app y sus procesos auxiliares (`termcode --mcp` y los
//! hooks de Claude Code): una línea de JSON de ida y otra de vuelta.
//!
//! * macOS/Linux: socket Unix en el directorio de estado, con permisos 0600.
//! * Windows: named pipe que solo el usuario (y SYSTEM) pueden abrir, sin
//!   clientes remotos, creado como "primera instancia" (si otro proceso se
//!   adelantó con ese nombre, no se usa). El cliente además comprueba que el
//!   servidor del pipe sea el proceso de termCode: así nadie más puede
//!   contestar (p. ej. aprobar un permiso) haciéndose pasar por la app.

use crate::agents::state_dir;
use serde_json::Value;
use std::io::{BufRead, BufReader, Read, Write};
use std::time::Duration;

/// Una petición de la app no puede ser más grande que esto.
const MAX_RESPONSE: u64 = 4 * 1024 * 1024;

/// Lo que la app necesita de una conexión entrante.
pub trait Peer {
    /// El cliente se fue (nadie va a leer la respuesta).
    fn closed(&self) -> bool;
}

/// Atiende conexiones en un hilo propio; cada conexión, en el suyo.
pub fn serve<F>(handler: F)
where
    F: Fn(Value, &dyn Peer) -> Value + Send + Sync + 'static,
{
    platform::serve(std::sync::Arc::new(handler));
}

/// Del lado del auxiliar: manda `request` y espera la respuesta hasta `timeout`.
pub fn request(request: &Value, timeout: Duration) -> Result<Value, String> {
    let line = platform::request(&format!("{request}\n"), timeout)?;
    serde_json::from_str(line.trim()).map_err(|e| e.to_string())
}

const NOT_RUNNING: &str = "termCode no está abierto (no hay a quién preguntar).";

/// Lee la línea de la petición y contesta con lo que diga el manejador.
fn handle(
    reader: impl Read,
    mut writer: impl Write,
    peer: &dyn Peer,
    handler: &(dyn Fn(Value, &dyn Peer) -> Value + Send + Sync),
) {
    let mut line = String::new();
    if BufReader::new(reader.take(MAX_RESPONSE))
        .read_line(&mut line)
        .is_err()
    {
        return;
    }
    let request: Value = serde_json::from_str(&line).unwrap_or(Value::Null);
    let response = handler(request, peer);
    let _ = writeln!(writer, "{response}");
    let _ = writer.flush();
}

// ---------------------------------------------------------------------------
// Unix
// ---------------------------------------------------------------------------

#[cfg(unix)]
mod platform {
    use super::*;
    use std::os::unix::fs::PermissionsExt;
    use std::os::unix::net::{UnixListener, UnixStream};
    use std::sync::Arc;

    type Handler = Arc<dyn Fn(Value, &dyn Peer) -> Value + Send + Sync>;

    fn socket_path() -> std::path::PathBuf {
        state_dir().join("mcp.sock")
    }

    pub(super) struct Conn<'a>(pub(super) &'a UnixStream);

    impl Peer for Conn<'_> {
        fn closed(&self) -> bool {
            use std::io::ErrorKind;
            // El auxiliar no manda nada después de su petición: leer 0 bytes = cerró.
            if self.0.set_nonblocking(true).is_err() {
                return false;
            }
            let mut probe = [0u8; 1];
            let closed = match (&*self.0).read(&mut probe) {
                Ok(0) => true,
                Ok(_) => false,
                Err(e) => e.kind() != ErrorKind::WouldBlock && e.kind() != ErrorKind::Interrupted,
            };
            let _ = self.0.set_nonblocking(false);
            closed
        }
    }

    pub fn serve(handler: Handler) {
        let path = socket_path();
        let _ = std::fs::remove_file(&path); // de una ejecución anterior
        let listener = match UnixListener::bind(&path) {
            Ok(l) => l,
            Err(e) => {
                log::warn!("ipc: no se pudo abrir {}: {e}", path.display());
                return;
            }
        };
        let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600));
        std::thread::Builder::new()
            .name("local-ipc".into())
            .spawn(move || {
                for stream in listener.incoming().flatten() {
                    let handler = handler.clone();
                    std::thread::spawn(move || handle(&stream, &stream, &Conn(&stream), &*handler));
                }
            })
            .ok();
    }

    pub fn request(line: &str, timeout: Duration) -> Result<String, String> {
        let mut stream = UnixStream::connect(socket_path()).map_err(|_| NOT_RUNNING.to_owned())?;
        let _ = stream.set_read_timeout(Some(timeout));
        stream
            .write_all(line.as_bytes())
            .map_err(|e| e.to_string())?;
        let mut out = String::new();
        stream
            .take(MAX_RESPONSE)
            .read_to_string(&mut out)
            .map_err(|e| e.to_string())?;
        Ok(out)
    }
}

// ---------------------------------------------------------------------------
// Windows
// ---------------------------------------------------------------------------

#[cfg(windows)]
mod platform {
    use super::*;
    use std::fs::File;
    use std::os::windows::io::{AsRawHandle, FromRawHandle, RawHandle};
    use std::sync::Arc;
    use windows_sys::Win32::Foundation::{
        ERROR_BROKEN_PIPE, ERROR_PIPE_CONNECTED, ERROR_PIPE_NOT_CONNECTED, GetLastError, HANDLE,
        INVALID_HANDLE_VALUE,
    };
    use windows_sys::Win32::Security::Authorization::{
        ConvertStringSecurityDescriptorToSecurityDescriptorW, SDDL_REVISION_1,
    };
    use windows_sys::Win32::Security::{PSECURITY_DESCRIPTOR, SECURITY_ATTRIBUTES};
    use windows_sys::Win32::Storage::FileSystem::{
        FILE_FLAG_FIRST_PIPE_INSTANCE, FlushFileBuffers, PIPE_ACCESS_DUPLEX,
    };
    use windows_sys::Win32::System::Pipes::{
        ConnectNamedPipe, CreateNamedPipeW, GetNamedPipeServerProcessId, PIPE_READMODE_BYTE,
        PIPE_REJECT_REMOTE_CLIENTS, PIPE_TYPE_BYTE, PIPE_UNLIMITED_INSTANCES, PIPE_WAIT,
        PeekNamedPipe,
    };

    type Handler = Arc<dyn Fn(Value, &dyn Peer) -> Value + Send + Sync>;

    /// Un nombre por directorio de estado (usuario y build), sin datos personales a la vista.
    fn pipe_name() -> String {
        format!(
            r"\\.\pipe\termcode-{:016x}",
            fnv1a(state_dir().to_string_lossy().as_bytes())
        )
    }

    fn fnv1a(bytes: &[u8]) -> u64 {
        bytes.iter().fold(0xcbf2_9ce4_8422_2325, |h, b| {
            (h ^ u64::from(*b)).wrapping_mul(0x0100_0000_01b3)
        })
    }

    /// PID de la app que atiende el canal: el cliente solo confía en ese servidor.
    fn pid_file() -> std::path::PathBuf {
        state_dir().join("app.pid")
    }

    fn wide(text: &str) -> Vec<u16> {
        text.encode_utf16().chain(std::iter::once(0)).collect()
    }

    struct Conn<'a>(&'a File);

    impl Peer for Conn<'_> {
        fn closed(&self) -> bool {
            let mut available = 0u32;
            // SAFETY: handle válido mientras viva `File`; los punteros nulos están permitidos.
            let ok = unsafe {
                PeekNamedPipe(
                    self.0.as_raw_handle() as HANDLE,
                    std::ptr::null_mut(),
                    0,
                    std::ptr::null_mut(),
                    &mut available,
                    std::ptr::null_mut(),
                )
            };
            if ok != 0 {
                return false;
            }
            // SAFETY: lectura del último error del hilo.
            let error = unsafe { GetLastError() };
            error == ERROR_BROKEN_PIPE || error == ERROR_PIPE_NOT_CONNECTED
        }
    }

    /// Solo el usuario actual (OW, owner rights) y SYSTEM pueden abrir el pipe.
    fn owner_only() -> Option<SECURITY_ATTRIBUTES> {
        let sddl = wide("D:P(A;;GA;;;SY)(A;;GA;;;OW)");
        let mut descriptor: PSECURITY_DESCRIPTOR = std::ptr::null_mut();
        // SAFETY: cadena terminada en 0; el descriptor vive lo que el servidor (se libera nunca a propósito).
        let ok = unsafe {
            ConvertStringSecurityDescriptorToSecurityDescriptorW(
                sddl.as_ptr(),
                SDDL_REVISION_1,
                &mut descriptor,
                std::ptr::null_mut(),
            )
        };
        (ok != 0).then_some(SECURITY_ATTRIBUTES {
            nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
            lpSecurityDescriptor: descriptor,
            bInheritHandle: 0,
        })
    }

    fn create_instance(name: &[u16], first: bool, security: &SECURITY_ATTRIBUTES) -> Option<File> {
        let mode = PIPE_ACCESS_DUPLEX
            | if first {
                FILE_FLAG_FIRST_PIPE_INSTANCE
            } else {
                0
            };
        // SAFETY: nombre terminado en 0 y atributos de seguridad válidos.
        let handle = unsafe {
            CreateNamedPipeW(
                name.as_ptr(),
                mode,
                PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS,
                PIPE_UNLIMITED_INSTANCES,
                64 * 1024,
                64 * 1024,
                0,
                security,
            )
        };
        if handle == INVALID_HANDLE_VALUE {
            return None;
        }
        // SAFETY: handle recién creado y de nuestra propiedad.
        Some(unsafe { File::from_raw_handle(handle as RawHandle) })
    }

    pub fn serve(handler: Handler) {
        let Some(security) = owner_only() else {
            log::warn!("ipc: no se pudo crear la ACL del pipe; MCP y aprobaciones desactivados");
            return;
        };
        let name = wide(&pipe_name());
        // Primera instancia: si el nombre ya existe (otro proceso), no se atiende nada.
        let Some(mut next) = create_instance(&name, true, &security) else {
            log::warn!(
                "ipc: el pipe {} ya existe; MCP y aprobaciones desactivados",
                pipe_name()
            );
            return;
        };
        if let Err(e) = std::fs::write(pid_file(), std::process::id().to_string()) {
            log::warn!("ipc: no se pudo escribir app.pid: {e}");
        }
        // `SECURITY_ATTRIBUTES` lleva un puntero crudo: se mueve al hilo como dirección.
        let security_addr = security.lpSecurityDescriptor as usize;
        std::thread::Builder::new()
            .name("local-ipc".into())
            .spawn(move || {
                let security = SECURITY_ATTRIBUTES {
                    nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
                    lpSecurityDescriptor: security_addr as PSECURITY_DESCRIPTOR,
                    bInheritHandle: 0,
                };
                loop {
                    let pipe = next;
                    // SAFETY: pipe en modo bloqueante, sin OVERLAPPED.
                    let connected = unsafe {
                        ConnectNamedPipe(pipe.as_raw_handle() as HANDLE, std::ptr::null_mut())
                    } != 0
                        || unsafe { GetLastError() } == ERROR_PIPE_CONNECTED;
                    // La siguiente instancia antes de atender: nunca hay un hueco sin escucha.
                    next = loop {
                        if let Some(p) = create_instance(&name, false, &security) {
                            break p;
                        }
                        std::thread::sleep(Duration::from_millis(250));
                    };
                    if !connected {
                        continue;
                    }
                    let handler = handler.clone();
                    std::thread::spawn(move || {
                        handle(&pipe, &pipe, &Conn(&pipe), &*handler);
                        // SAFETY: espera a que el cliente lea la respuesta antes de cerrar.
                        unsafe { FlushFileBuffers(pipe.as_raw_handle() as HANDLE) };
                    });
                }
            })
            .ok();
    }

    /// El servidor del pipe tiene que ser la app que escribió `app.pid`.
    fn server_is_termcode(pipe: &File) -> bool {
        let Some(expected) = std::fs::read_to_string(pid_file())
            .ok()
            .and_then(|s| s.trim().parse::<u32>().ok())
        else {
            return false;
        };
        let mut pid = 0u32;
        // SAFETY: handle válido de un pipe abierto.
        let ok = unsafe { GetNamedPipeServerProcessId(pipe.as_raw_handle() as HANDLE, &mut pid) };
        ok != 0 && pid == expected
    }

    pub fn request(line: &str, timeout: Duration) -> Result<String, String> {
        let pipe = std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .open(pipe_name())
            .map_err(|_| NOT_RUNNING.to_owned())?;
        if !server_is_termcode(&pipe) {
            return Err("El canal local no pertenece a termCode: no se usa.".into());
        }
        (&pipe)
            .write_all(line.as_bytes())
            .map_err(|e| e.to_string())?;
        // Un pipe síncrono no tiene timeout de lectura: se lee en otro hilo y se espera con plazo.
        let (tx, rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let mut out = String::new();
            let result = (&pipe)
                .take(MAX_RESPONSE)
                .read_to_string(&mut out)
                .map(|_| out);
            let _ = tx.send(result);
        });
        match rx.recv_timeout(timeout) {
            Ok(Ok(out)) => Ok(out),
            Ok(Err(e)) => Err(e.to_string()),
            Err(_) => Err("termCode no contestó a tiempo.".into()),
        }
    }
}

// ---------------------------------------------------------------------------
// Ni Unix ni Windows: sin canal (MCP y aprobaciones desactivados).
// ---------------------------------------------------------------------------

#[cfg(not(any(unix, windows)))]
mod platform {
    use super::*;
    pub fn serve(_handler: std::sync::Arc<dyn Fn(Value, &dyn Peer) -> Value + Send + Sync>) {}
    pub fn request(_line: &str, _timeout: Duration) -> Result<String, String> {
        Err(NOT_RUNNING.into())
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;

    #[test]
    fn detects_when_the_client_goes_away() {
        let (a, b) = std::os::unix::net::UnixStream::pair().unwrap();
        let conn = platform::Conn(&a);
        assert!(!conn.closed());
        drop(b);
        assert!(conn.closed());
    }

    #[test]
    fn answers_one_line_with_the_handler_result() {
        let (server, mut client) = std::os::unix::net::UnixStream::pair().unwrap();
        client.write_all(b"{\"op\":\"ping\"}\n").unwrap();
        let echo = |request: Value, _: &dyn Peer| serde_json::json!({ "got": request["op"] });
        handle(&server, &server, &platform::Conn(&server), &echo);
        drop(server);
        let mut out = String::new();
        client.read_to_string(&mut out).unwrap();
        assert_eq!(out.trim(), r#"{"got":"ping"}"#);
    }
}
