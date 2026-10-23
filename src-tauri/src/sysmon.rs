//! Monitor del sistema: CPU, memoria, GPU y los procesos que más memoria usan.
//!
//! Solo datos medidos. La vista pregunta cada pocos segundos mientras algo
//! los muestra (con la ventana oculta no pregunta nadie): aquí no hay un hilo
//! de fondo gastando batería. Lo que el sistema no expone queda en `None` y la
//! vista no lo pinta (la GPU fuera de macOS, la presión de memoria fuera de
//! macOS).

use parking_lot::Mutex;
use serde::Serialize;
use std::sync::Arc;
use sysinfo::{Pid, ProcessRefreshKind, ProcessesToUpdate, Signal, System, UpdateKind};

/// Procesos que van con la muestra de la barra lateral, de más a menos memoria.
const TOP_PROCESSES: usize = 4;
/// Tope de la lista del detalle (una tabla larga no se lee).
const MAX_LIST: usize = 30;

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcessUsage {
    pub pid: u32,
    pub name: String,
    /// Por núcleo, como en Monitor de Actividad: un proceso puede pasar de 100.
    pub cpu_percent: f32,
    pub memory: u64,
    /// Es tuyo: se puede terminar sin privilegios.
    pub mine: bool,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemStats {
    /// Uso de todos los núcleos juntos, 0–100.
    pub cpu_percent: f32,
    pub cpu_count: usize,
    /// Uso de cada núcleo, 0–100.
    pub cpu_cores: Vec<f32>,
    /// Carga media de 1, 5 y 15 minutos (no existe en Windows).
    pub load_average: Option<[f64; 3]>,
    pub uptime_secs: u64,
    pub memory_used: u64,
    pub memory_total: u64,
    /// Lo que las apps pueden pedir sin que el sistema tenga que liberar nada.
    pub memory_available: u64,
    pub swap_used: u64,
    pub swap_total: u64,
    /// macOS: `normal`, `warn` o `critical` (lo que el kernel usa para pedir memoria a las apps).
    pub memory_pressure: Option<&'static str>,
    /// Utilización de la GPU, 0–100 (macOS).
    pub gpu_percent: Option<f32>,
    /// Memoria que la GPU tiene en uso, en bytes (macOS; en Apple Silicon es memoria unificada).
    pub gpu_memory: Option<u64>,
    /// Vacío si no se pidieron procesos.
    pub top: Vec<ProcessUsage>,
}

/// `System` guarda la muestra anterior: el uso de CPU es la diferencia entre dos lecturas.
#[derive(Clone)]
pub struct SysMon(Arc<Mutex<System>>);

impl Default for SysMon {
    fn default() -> Self {
        Self(Arc::new(Mutex::new(System::new())))
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum SortBy {
    Memory,
    Cpu,
}

fn sample(system: &mut System, processes: bool) -> SystemStats {
    system.refresh_cpu_usage();
    system.refresh_memory();
    let top = if processes {
        process_list(system, SortBy::Memory, TOP_PROCESSES)
    } else {
        Vec::new()
    };
    let gpu = gpu::sample();
    let load = System::load_average();
    SystemStats {
        cpu_percent: system.global_cpu_usage().clamp(0.0, 100.0),
        cpu_count: system.cpus().len(),
        cpu_cores: system
            .cpus()
            .iter()
            .map(|c| c.cpu_usage().clamp(0.0, 100.0))
            .collect(),
        load_average: cfg!(unix).then_some([load.one, load.five, load.fifteen]),
        uptime_secs: System::uptime(),
        memory_used: system.used_memory(),
        memory_total: system.total_memory(),
        memory_available: system.available_memory(),
        swap_used: system.used_swap(),
        swap_total: system.total_swap(),
        memory_pressure: memory_pressure(),
        gpu_percent: gpu.map(|g| g.utilization),
        gpu_memory: gpu.and_then(|g| g.memory),
        top,
    }
}

fn process_list(system: &mut System, sort: SortBy, limit: usize) -> Vec<ProcessUsage> {
    system.refresh_processes_specifics(
        ProcessesToUpdate::All,
        true,
        ProcessRefreshKind::nothing()
            .with_cpu()
            .with_memory()
            .with_user(UpdateKind::OnlyIfNotSet),
    );
    let me = sysinfo::get_current_pid()
        .ok()
        .and_then(|pid| system.process(pid))
        .and_then(|p| p.user_id().cloned());
    top_processes(
        system.processes().values().map(|p| ProcessUsage {
            pid: p.pid().as_u32(),
            name: p.name().to_string_lossy().into_owned(),
            cpu_percent: p.cpu_usage(),
            memory: p.memory(),
            mine: me.is_some() && p.user_id() == me.as_ref(),
        }),
        sort,
        limit,
    )
}

/// Los `n` que más usan (memoria o CPU). Sin memoria no es un proceso que importe aquí.
fn top_processes(
    all: impl Iterator<Item = ProcessUsage>,
    sort: SortBy,
    n: usize,
) -> Vec<ProcessUsage> {
    let mut all: Vec<ProcessUsage> = all.filter(|p| p.memory > 0).collect();
    match sort {
        SortBy::Memory => all.sort_unstable_by_key(|p| std::cmp::Reverse(p.memory)),
        SortBy::Cpu => all.sort_unstable_by(|a, b| b.cpu_percent.total_cmp(&a.cpu_percent)),
    }
    all.truncate(n);
    all
}

/// Una muestra. `processes`: también los que más memoria usan (cuesta más: recorre todos).
#[tauri::command]
pub async fn system_stats(
    state: tauri::State<'_, SysMon>,
    processes: Option<bool>,
) -> Result<SystemStats, String> {
    let monitor = state.inner().clone();
    // Leer cientos de procesos bloquea unos milisegundos: fuera del runtime async.
    tauri::async_runtime::spawn_blocking(move || {
        sample(&mut monitor.0.lock(), processes.unwrap_or(false))
    })
    .await
    .map_err(|e| e.to_string())
}

/// Los procesos que más usan, por `memory` o `cpu` (para el detalle del sistema).
#[tauri::command]
pub async fn system_processes(
    state: tauri::State<'_, SysMon>,
    sort: String,
    limit: usize,
) -> Result<Vec<ProcessUsage>, String> {
    let sort = if sort == "cpu" {
        SortBy::Cpu
    } else {
        SortBy::Memory
    };
    let monitor = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        process_list(&mut monitor.0.lock(), sort, limit.clamp(1, MAX_LIST))
    })
    .await
    .map_err(|e| e.to_string())
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChildProcess {
    pub pid: u32,
    pub name: String,
    /// Línea de comandos (recortada): `node /…/ng completion script`.
    pub command: String,
}

/// Lo que corre bajo la shell de una sesión (sin la shell): por qué una shell
/// que no da su prompt sigue esperando (algo de tu `.zshrc`, un `nvm`…).
#[tauri::command]
pub async fn pty_children(
    pty: tauri::State<'_, pty_core::PtyManager>,
    state: tauri::State<'_, SysMon>,
    id: pty_core::SessionId,
) -> Result<Vec<ChildProcess>, String> {
    let info = pty.info(id).map_err(|e| e.to_string())?;
    let Some(shell) = info.shell_pid.and_then(|p| i32::try_from(p).ok()) else {
        return Ok(Vec::new());
    };
    let monitor = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let pids: Vec<Pid> = crate::proctree::descendants(shell)
            .into_iter()
            .filter(|&p| p != shell)
            .filter_map(|p| u32::try_from(p).ok().map(Pid::from_u32))
            .collect();
        if pids.is_empty() {
            return Vec::new();
        }
        let mut system = monitor.0.lock();
        system.refresh_processes_specifics(
            ProcessesToUpdate::Some(&pids),
            false,
            ProcessRefreshKind::nothing().with_cmd(UpdateKind::Always),
        );
        pids.iter()
            .filter_map(|pid| system.process(*pid))
            .map(|p| {
                let mut command = p
                    .cmd()
                    .iter()
                    .map(|a| a.to_string_lossy())
                    .collect::<Vec<_>>()
                    .join(" ");
                if command.len() > 200 {
                    let cut = (0..=200)
                        .rev()
                        .find(|&i| command.is_char_boundary(i))
                        .unwrap_or(0);
                    command.truncate(cut);
                    command.push('…');
                }
                ChildProcess {
                    pid: p.pid().as_u32(),
                    name: p.name().to_string_lossy().into_owned(),
                    command,
                }
            })
            .collect()
    })
    .await
    .map_err(|e| e.to_string())
}

/// Pide a un proceso tuyo que termine (SIGTERM: puede guardar y cerrar). Nunca
/// a termCode, al sistema (pid 0/1) ni a procesos de otro usuario.
#[tauri::command]
pub async fn process_terminate(state: tauri::State<'_, SysMon>, pid: u32) -> Result<(), String> {
    let monitor = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let own = std::process::id();
        if pid <= 1 || pid == own {
            return Err("Ese proceso no se puede terminar desde aquí.".to_owned());
        }
        let mut system = monitor.0.lock();
        let target = Pid::from_u32(pid);
        system.refresh_processes_specifics(
            ProcessesToUpdate::Some(&[target, Pid::from_u32(own)]),
            false,
            ProcessRefreshKind::nothing().with_user(UpdateKind::OnlyIfNotSet),
        );
        let me = system
            .process(Pid::from_u32(own))
            .and_then(|p| p.user_id().cloned());
        let process = system
            .process(target)
            .ok_or_else(|| "El proceso ya no existe.".to_owned())?;
        if me.is_none() || process.user_id() != me.as_ref() {
            return Err("Es de otro usuario: termCode no lo termina.".to_owned());
        }
        // SIGTERM donde existe; en Windows no hay señales y se termina directamente.
        let sent = process
            .kill_with(Signal::Term)
            .unwrap_or_else(|| process.kill());
        if sent {
            log::info!(
                "sysmon: SIGTERM a {pid} ({})",
                process.name().to_string_lossy()
            );
            Ok(())
        } else {
            Err("El sistema no dejó terminar el proceso.".to_owned())
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(target_os = "macos")]
fn memory_pressure() -> Option<&'static str> {
    let mut level: libc::c_int = 0;
    let mut size = std::mem::size_of::<libc::c_int>();
    // SAFETY: nombre terminado en 0; `level` y `size` son un int y su tamaño.
    let rc = unsafe {
        libc::sysctlbyname(
            c"kern.memorystatus_vm_pressure_level".as_ptr(),
            (&raw mut level).cast(),
            &mut size,
            std::ptr::null_mut(),
            0,
        )
    };
    if rc != 0 {
        return None;
    }
    pressure_name(level)
}

#[cfg(not(target_os = "macos"))]
fn memory_pressure() -> Option<&'static str> {
    None
}

/// Niveles de `kern.memorystatus_vm_pressure_level` (sys/kern_memorystatus.h).
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn pressure_name(level: i32) -> Option<&'static str> {
    match level {
        1 => Some("normal"),
        2 => Some("warn"),
        4 => Some("critical"),
        _ => None,
    }
}

#[derive(Debug, Clone, Copy)]
struct GpuSample {
    utilization: f32,
    memory: Option<u64>,
}

/// La GPU según IOKit: cada acelerador publica sus `PerformanceStatistics`
/// (las mismas que lee Monitor de Actividad). Sin privilegios.
#[cfg(target_os = "macos")]
mod gpu {
    use super::GpuSample;
    use core_foundation::base::{CFAllocatorRef, CFType, CFTypeRef, TCFType, kCFAllocatorDefault};
    use core_foundation::dictionary::{CFDictionary, CFMutableDictionaryRef};
    use core_foundation::number::CFNumber;
    use core_foundation::string::{CFString, CFStringRef};
    use std::ffi::{c_char, c_void};

    type IoObject = u32;
    type KernReturn = i32;

    #[link(name = "IOKit", kind = "framework")]
    unsafe extern "C" {
        fn IOServiceMatching(name: *const c_char) -> CFMutableDictionaryRef;
        /// Se queda con `matching` (no hay que liberarlo).
        fn IOServiceGetMatchingServices(
            main_port: u32,
            matching: CFMutableDictionaryRef,
            existing: *mut IoObject,
        ) -> KernReturn;
        fn IOIteratorNext(iterator: IoObject) -> IoObject;
        fn IORegistryEntryCreateCFProperty(
            entry: IoObject,
            key: CFStringRef,
            allocator: CFAllocatorRef,
            options: u32,
        ) -> CFTypeRef;
        fn IOObjectRelease(object: IoObject) -> KernReturn;
    }

    /// La GPU más ocupada (en un Mac con dos GPUs, la que trabaja).
    pub(super) fn sample() -> Option<GpuSample> {
        // SAFETY: nombre de clase terminado en 0. El diccionario lo consume la llamada de abajo.
        let matching = unsafe { IOServiceMatching(c"IOAccelerator".as_ptr()) };
        if matching.is_null() {
            return None;
        }
        let mut iterator: IoObject = 0;
        // SAFETY: puerto 0 = el puerto principal por omisión; `iterator` es una salida válida.
        if unsafe { IOServiceGetMatchingServices(0, matching, &mut iterator) } != 0 {
            return None;
        }
        let key = CFString::from_static_string("PerformanceStatistics");
        let mut best: Option<GpuSample> = None;
        loop {
            // SAFETY: iterador vivo hasta el IOObjectRelease del final.
            let entry = unsafe { IOIteratorNext(iterator) };
            if entry == 0 {
                break;
            }
            // SAFETY: entrada válida y clave CFString viva; la regla "Create" nos da la propiedad.
            let raw = unsafe {
                IORegistryEntryCreateCFProperty(
                    entry,
                    key.as_concrete_TypeRef(),
                    kCFAllocatorDefault,
                    0,
                )
            };
            // SAFETY: cada entrada que da el iterador se libera una vez.
            unsafe { IOObjectRelease(entry) };
            if raw.is_null() {
                continue;
            }
            // SAFETY: referencia +1 de "Create": CFType la libera al salir.
            let value = unsafe { CFType::wrap_under_create_rule(raw) };
            let Some(stats) = value.downcast::<CFDictionary>() else {
                continue;
            };
            let number = |name: &'static str| -> Option<i64> {
                let key = CFString::from_static_string(name);
                let item = stats.find(key.as_concrete_TypeRef().cast::<c_void>())?;
                // SAFETY: el valor pertenece al diccionario, que sigue vivo; "Get" no transfiere la propiedad.
                let item = unsafe { CFType::wrap_under_get_rule(*item) };
                item.downcast::<CFNumber>()?.to_i64()
            };
            let Some(utilization) = number("Device Utilization %") else {
                continue;
            };
            let found = GpuSample {
                utilization: (utilization as f32).clamp(0.0, 100.0),
                memory: number("In use system memory").and_then(|m| u64::try_from(m).ok()),
            };
            if best.is_none_or(|b| found.utilization > b.utilization) {
                best = Some(found);
            }
        }
        // SAFETY: iterador obtenido arriba, liberado una sola vez.
        unsafe { IOObjectRelease(iterator) };
        best
    }
}

#[cfg(not(target_os = "macos"))]
mod gpu {
    pub(super) fn sample() -> Option<super::GpuSample> {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn usage(pid: u32, memory: u64, cpu: f32) -> ProcessUsage {
        ProcessUsage {
            pid,
            name: format!("p{pid}"),
            cpu_percent: cpu,
            memory,
            mine: true,
        }
    }

    #[test]
    fn top_keeps_the_biggest_without_empty_ones() {
        let all = vec![
            usage(1, 10, 5.0),
            usage(2, 0, 90.0),
            usage(3, 30, 1.0),
            usage(4, 20, 50.0),
        ];
        let by_memory = top_processes(all.clone().into_iter(), SortBy::Memory, 2);
        assert_eq!(
            by_memory.iter().map(|p| p.pid).collect::<Vec<_>>(),
            vec![3, 4]
        );
        let by_cpu = top_processes(all.into_iter(), SortBy::Cpu, 2);
        assert_eq!(by_cpu.iter().map(|p| p.pid).collect::<Vec<_>>(), vec![4, 1]);
    }

    #[test]
    fn pressure_levels_follow_the_kernel() {
        assert_eq!(pressure_name(1), Some("normal"));
        assert_eq!(pressure_name(2), Some("warn"));
        assert_eq!(pressure_name(4), Some("critical"));
        assert_eq!(pressure_name(0), None);
    }

    #[cfg(any(target_os = "macos", target_os = "linux"))]
    #[test]
    fn reads_a_childs_command_line() {
        let mut child = std::process::Command::new("sleep")
            .arg("7")
            .spawn()
            .unwrap();
        let pid = Pid::from_u32(child.id());
        let mut system = System::new();
        system.refresh_processes_specifics(
            ProcessesToUpdate::Some(&[pid]),
            false,
            ProcessRefreshKind::nothing().with_cmd(UpdateKind::Always),
        );
        let cmd: Vec<String> = system
            .process(pid)
            .map(|p| {
                p.cmd()
                    .iter()
                    .map(|a| a.to_string_lossy().into_owned())
                    .collect()
            })
            .unwrap_or_default();
        child.kill().ok();
        child.wait().ok();
        assert_eq!(cmd, vec!["sleep", "7"]);
    }

    #[test]
    fn samples_real_numbers() {
        let mut system = System::new();
        let stats = sample(&mut system, true);
        assert!(stats.memory_total > 0);
        assert!(stats.memory_used <= stats.memory_total);
        assert!(stats.cpu_count > 0);
        assert_eq!(stats.cpu_cores.len(), stats.cpu_count);
        assert!(stats.memory_available <= stats.memory_total);
        assert!(!stats.top.is_empty());
        assert!(stats.top.windows(2).all(|w| w[0].memory >= w[1].memory));
    }
}
