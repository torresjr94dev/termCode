//! Benchmarks de pty-core (los corre el CI en cada push).
//!
//! - **throughput**: un hijo escribe N bytes lo más rápido que puede; el sink
//!   confirma (ack) cada lote al instante, como una vista que nunca se atrasa.
//!   Mide MB/s y el tamaño medio de lote (cuánto agrupa el coalescing).
//! - **echo**: latencia tecla → pantalla. Se escribe un byte a `cat` en una
//!   PTY y se espera su eco: entrada, hilo escritor, disciplina de línea,
//!   hilo lector y coalescing, completos.
//!
//! Uso: `cargo run --release -p pty-core --example bench -- [--mib 128]
//!       [--min-mbps 40] [--max-p99-ms 20] [--json]`
//! Sale con código 1 si un umbral no se cumple.

#[cfg(unix)]
fn main() {
    if let Err(e) = unix::run() {
        eprintln!("bench: {e}");
        std::process::exit(1);
    }
}

#[cfg(not(unix))]
fn main() {
    eprintln!("bench: solo en sistemas unix");
}

#[cfg(unix)]
mod unix {
    use pty_core::{OutputSink, PtyManager, SpawnOptions};
    use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender};
    use std::time::{Duration, Instant};

    enum Event {
        Data(Vec<u8>),
        Exit,
    }

    struct Sink(Sender<Event>);

    impl OutputSink for Sink {
        fn data(&mut self, bytes: Vec<u8>) -> bool {
            self.0.send(Event::Data(bytes)).is_ok()
        }
        fn exit(&mut self, _code: Option<u32>) {
            let _ = self.0.send(Event::Exit);
        }
    }

    struct Args {
        mib: usize,
        min_mbps: Option<f64>,
        max_p99_ms: Option<f64>,
        json: bool,
    }

    fn parse_args() -> Result<Args, String> {
        let mut args = Args {
            mib: 128,
            min_mbps: None,
            max_p99_ms: None,
            json: false,
        };
        let mut it = std::env::args().skip(1);
        while let Some(flag) = it.next() {
            let mut value =
                |name: &str| it.next().ok_or_else(|| format!("falta el valor de {name}"));
            match flag.as_str() {
                "--mib" => {
                    args.mib = value("--mib")?
                        .parse()
                        .map_err(|_| "--mib debe ser un entero")?;
                    if !(1..=4096).contains(&args.mib) {
                        return Err("--mib fuera de rango (1–4096)".into());
                    }
                }
                "--min-mbps" => {
                    args.min_mbps = Some(
                        value("--min-mbps")?
                            .parse()
                            .map_err(|_| "--min-mbps debe ser un número")?,
                    )
                }
                "--max-p99-ms" => {
                    args.max_p99_ms = Some(
                        value("--max-p99-ms")?
                            .parse()
                            .map_err(|_| "--max-p99-ms debe ser un número")?,
                    )
                }
                "--json" => args.json = true,
                other => return Err(format!("opción desconocida: {other}")),
            }
        }
        Ok(args)
    }

    fn spawn(mgr: &PtyManager, script: &str) -> Result<(u32, Receiver<Event>), String> {
        let (tx, rx) = mpsc::channel();
        let id = mgr
            .spawn(
                SpawnOptions {
                    program: Some("/bin/sh".into()),
                    args: vec!["-c".into(), script.into()],
                    cols: 200,
                    rows: 50,
                    ..Default::default()
                },
                |_| Sink(tx),
            )
            .map_err(|e| e.to_string())?;
        Ok((id, rx))
    }

    struct Throughput {
        bytes: usize,
        seconds: f64,
        batches: usize,
    }

    fn throughput(mgr: &PtyManager, mib: usize) -> Result<Throughput, String> {
        // `yes` + `head -c`: N bytes exactos de texto, sin costo de CPU apreciable.
        let script = format!(
            "yes 'termcode throughput 0123456789abcdef' | head -c {}",
            mib << 20
        );
        let start = Instant::now();
        let (id, rx) = spawn(mgr, &script)?;
        let (mut bytes, mut batches) = (0usize, 0usize);
        loop {
            match rx.recv_timeout(Duration::from_secs(60)) {
                Ok(Event::Data(chunk)) => {
                    bytes += chunk.len();
                    batches += 1;
                    mgr.ack(id, chunk.len());
                }
                Ok(Event::Exit) => break,
                Err(RecvTimeoutError::Timeout) => {
                    return Err("throughput: el hijo dejó de responder".into());
                }
                Err(RecvTimeoutError::Disconnected) => break,
            }
        }
        let seconds = start.elapsed().as_secs_f64();
        mgr.remove(id);
        // La PTY convierte \n en \r\n: llegan más bytes de los pedidos, nunca menos.
        if bytes < mib << 20 {
            return Err(format!(
                "throughput: llegaron {bytes} de {} bytes",
                mib << 20
            ));
        }
        Ok(Throughput {
            bytes,
            seconds,
            batches,
        })
    }

    fn percentile(sorted: &[f64], p: f64) -> f64 {
        let rank = ((sorted.len() as f64 - 1.0) * p).round() as usize;
        sorted[rank.min(sorted.len() - 1)]
    }

    struct Echo {
        p50_ms: f64,
        p99_ms: f64,
        max_ms: f64,
    }

    fn echo(mgr: &PtyManager, samples: usize) -> Result<Echo, String> {
        let (id, rx) = spawn(mgr, "stty -icanon; exec cat")?;
        // Que la shell termine de arrancar antes de medir.
        std::thread::sleep(Duration::from_millis(200));
        while let Ok(Event::Data(chunk)) = rx.recv_timeout(Duration::from_millis(50)) {
            mgr.ack(id, chunk.len());
        }
        let mut times = Vec::with_capacity(samples);
        for i in 0..samples {
            // Pausa de tecleo humano (≥ 30 ms entre teclas), drenando lo que quede:
            // sin ella cada tecla caería en la ventana de coalescing de la anterior.
            while let Ok(event) = rx.recv_timeout(Duration::from_millis(30)) {
                if let Event::Data(chunk) = event {
                    mgr.ack(id, chunk.len());
                }
            }
            let byte = b'a' + (i % 26) as u8;
            let sent = Instant::now();
            mgr.write(id, &[byte]).map_err(|e| e.to_string())?;
            loop {
                match rx.recv_timeout(Duration::from_secs(2)) {
                    Ok(Event::Data(chunk)) => {
                        mgr.ack(id, chunk.len());
                        if chunk.contains(&byte) {
                            times.push(sent.elapsed().as_secs_f64() * 1000.0);
                            break;
                        }
                    }
                    Ok(Event::Exit) | Err(_) => return Err("echo: sin eco del hijo".into()),
                }
            }
        }
        mgr.remove(id);
        times.sort_by(f64::total_cmp);
        Ok(Echo {
            p50_ms: percentile(&times, 0.5),
            p99_ms: percentile(&times, 0.99),
            max_ms: *times.last().unwrap_or(&0.0),
        })
    }

    pub fn run() -> Result<(), String> {
        let args = parse_args()?;
        let mgr = PtyManager::default();

        let t = throughput(&mgr, args.mib)?;
        let mbps = t.bytes as f64 / (1 << 20) as f64 / t.seconds;
        let avg_batch = t.bytes / t.batches.max(1);
        let e = echo(&mgr, 150)?;

        if args.json {
            println!(
                "{{\"throughput_mbps\":{mbps:.1},\"avg_batch_bytes\":{avg_batch},\"batches\":{},\"echo_p50_ms\":{:.3},\"echo_p99_ms\":{:.3},\"echo_max_ms\":{:.3}}}",
                t.batches, e.p50_ms, e.p99_ms, e.max_ms
            );
        } else {
            println!(
                "throughput   {mbps:>8.1} MB/s   ({} MiB en {:.2} s, {} lotes de ~{} KiB)",
                args.mib,
                t.seconds,
                t.batches,
                avg_batch / 1024
            );
            println!(
                "eco          p50 {:.2} ms · p99 {:.2} ms · máx {:.2} ms (150 teclas)",
                e.p50_ms, e.p99_ms, e.max_ms
            );
        }

        let mut failed = Vec::new();
        if let Some(min) = args.min_mbps.filter(|&min| mbps < min) {
            failed.push(format!("throughput {mbps:.1} MB/s < {min} MB/s"));
        }
        if let Some(max) = args.max_p99_ms.filter(|&max| e.p99_ms > max) {
            failed.push(format!("eco p99 {:.2} ms > {max} ms", e.p99_ms));
        }
        if failed.is_empty() {
            Ok(())
        } else {
            Err(failed.join("; "))
        }
    }
}
