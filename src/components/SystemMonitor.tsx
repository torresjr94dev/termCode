import React from "react";
import { X } from "lucide-react";
import { cn } from "../lib/layout";
import { ipc } from "../lib/ipc";
import { HISTORY, SAMPLE_MS, formatBytes, useSystemStore, useSystemWatch } from "../lib/system";
import { useUiStore } from "../store/uiStore";
import type { ProcessUsage, SystemStats } from "../types/layout";
import { IconButton } from "./ui";

const PRESSURE: Record<NonNullable<SystemStats["memoryPressure"]>, { label: string; tone: string; fill: string }> = {
  normal: { label: "normal", tone: "text-ink-3", fill: "bg-accent" },
  warn: { label: "alta", tone: "text-warn", fill: "bg-warn" },
  critical: { label: "crítica", tone: "text-signal", fill: "bg-signal" },
};

/** Severidad por uso cuando el sistema no dice la presión (Windows, Linux). */
const fillFor = (percent: number) => (percent >= 90 ? "bg-signal" : percent >= 75 ? "bg-warn" : "bg-accent");

const pct = (value: number) => `${Math.round(value)}%`;

/** `11.2 / 16 GB`: la unidad una vez, para que quepa junto al porcentaje. */
function formatMemory(used: number, total: number): string {
  const GB = 1024 ** 3;
  if (total < GB) return `${formatBytes(used)} / ${formatBytes(total)}`;
  return `${(used / GB).toFixed(1)} / ${Math.round(total / GB)} GB`;
}

/**
 * Tendencia de los últimos 2 minutos: línea atenuada y solo el valor actual
 * en acento. Escala fija 0–100: dos gráficas iguales significan lo mismo.
 */
const Sparkline: React.FC<{ values: number[] }> = ({ values }) => {
  if (values.length < 2) return <span className="h-4 flex-1" />;
  const step = 100 / (HISTORY - 1);
  const start = (HISTORY - values.length) * step;
  const y = (v: number) => 15 - (Math.min(Math.max(v, 0), 100) / 100) * 13;
  const points = values.map((v, i) => `${(start + i * step).toFixed(2)},${y(v).toFixed(2)}`).join(" ");
  const last = values[values.length - 1];
  return (
    <span aria-hidden="true" className="relative h-4 min-w-0 flex-1">
      <svg viewBox="0 0 100 16" preserveAspectRatio="none" className="absolute inset-0 size-full overflow-visible">
        <line x1="0" x2="100" y1="15" y2="15" stroke="var(--color-line)" strokeWidth="1" vectorEffect="non-scaling-stroke" />
        <polyline
          points={points}
          fill="none"
          stroke="var(--color-ink-3)"
          strokeWidth="1.5"
          strokeLinejoin="round"
          strokeLinecap="round"
          vectorEffect="non-scaling-stroke"
        />
      </svg>
      {/* El punto va en HTML: estirado dentro del SVG sería un óvalo. */}
      <span
        className="absolute right-0 size-[5px] -translate-y-1/2 translate-x-1/2 rounded-full bg-accent"
        style={{ top: `${(y(last) / 16) * 100}%` }}
      />
    </span>
  );
};

/** Una métrica: nombre, tendencia y valor actual (el valor en tinta, nunca en el color de la línea). */
const MetricRow: React.FC<{ label: string; values: number[]; value: string; title: string }> = ({ label, values, value, title }) => (
  <div title={title} className="flex h-6 items-center gap-2 px-2">
    <span className="w-8 shrink-0 font-mono text-[10.5px] text-ink-3">{label}</span>
    <Sparkline values={values} />
    <span className="w-10 shrink-0 text-right font-mono text-[11px] tabular-nums text-ink-2">{value}</span>
  </div>
);

function trendTitle(name: string, values: number[]): string {
  if (!values.length) return name;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const minutes = Math.round((values.length * SAMPLE_MS) / 60_000) || 1;
  return `${name}: ahora ${pct(values[values.length - 1])} · últimos ${minutes} min entre ${pct(min)} y ${pct(max)}`;
}

/** La sección «Sistema» de la barra lateral. Mide solo mientras está desplegada. */
export const SystemPanel: React.FC<{ active: boolean }> = ({ active }) => {
  useSystemWatch(active, true);
  const stats = useSystemStore((s) => s.stats);
  const cpu = useSystemStore((s) => s.cpu);
  const gpu = useSystemStore((s) => s.gpu);

  if (!stats) {
    return <p className="px-2 py-1 text-[11.5px] text-ink-3">Midiendo…</p>;
  }
  const memPercent = stats.memoryTotal ? (stats.memoryUsed / stats.memoryTotal) * 100 : 0;
  const pressure = stats.memoryPressure ? PRESSURE[stats.memoryPressure] : null;

  return (
    <div className="flex flex-col">
      <MetricRow label="CPU" values={cpu} value={pct(stats.cpuPercent)} title={`${trendTitle("CPU", cpu)} · ${stats.cpuCount} núcleos`} />
      {stats.gpuPercent !== null && (
        <MetricRow
          label="GPU"
          values={gpu}
          value={pct(stats.gpuPercent)}
          title={`${trendTitle("GPU", gpu)}${stats.gpuMemory ? ` · ${formatBytes(stats.gpuMemory)} en uso` : ""}`}
        />
      )}

      <div
        className="px-2 pb-1 pt-1.5"
        title={`Memoria: ${formatBytes(stats.memoryUsed)} de ${formatBytes(stats.memoryTotal)}${pressure ? ` · presión ${pressure.label}` : ""}${stats.swapUsed ? ` · swap ${formatBytes(stats.swapUsed)}` : ""}`}
      >
        <div className="flex items-baseline gap-2">
          <span className="w-8 shrink-0 font-mono text-[10.5px] text-ink-3">RAM</span>
          <span className="min-w-0 flex-1 truncate font-mono text-[11px] tabular-nums text-ink-2">{formatMemory(stats.memoryUsed, stats.memoryTotal)}</span>
          <span className="w-10 shrink-0 text-right font-mono text-[11px] tabular-nums text-ink-2">{pct(memPercent)}</span>
        </div>
        <div
          role="meter"
          aria-label="Memoria en uso"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(memPercent)}
          className="mt-1 h-[5px] overflow-hidden rounded-full bg-line"
        >
          <span
            className={cn("block h-full rounded-full transition-[width] duration-500 ease-out", pressure?.fill ?? fillFor(memPercent))}
            style={{ width: `${Math.min(memPercent, 100)}%` }}
          />
        </div>
        {(pressure || stats.swapUsed > 0) && (
          <p className="mt-1 flex gap-2 font-mono text-[10px]">
            {pressure && <span className={pressure.tone}>presión {pressure.label}</span>}
            {stats.swapUsed > 0 && <span className="text-ink-3">swap {formatBytes(stats.swapUsed)}</span>}
          </p>
        )}
      </div>

      {stats.top.length > 0 && (
        <ul aria-label="Procesos que más memoria usan" className="mt-1 flex flex-col">
          {stats.top.slice(0, 3).map((p) => (
            <li
              key={p.pid}
              title={`${p.name} (pid ${p.pid}) · ${formatBytes(p.memory)} · CPU ${pct(p.cpuPercent)}`}
              className="flex h-5 items-center gap-2 px-2 font-mono text-[10.5px] tabular-nums"
            >
              <span className="min-w-0 flex-1 truncate text-ink-2">{p.name}</span>
              <span className="shrink-0 text-ink-3">{formatBytes(p.memory)}</span>
              <span className="w-9 shrink-0 text-right text-ink-3">{pct(p.cpuPercent)}</span>
            </li>
          ))}
        </ul>
      )}
      <button
        type="button"
        data-system-trigger
        onClick={() => useUiStore.getState().setSystemOpen(!useUiStore.getState().isSystemOpen)}
        className="mx-1 mt-1 flex h-6 items-center justify-center rounded-md text-[11px] text-ink-3 transition-colors duration-150 hover:bg-hover hover:text-ink-2 focus-visible:outline-2 focus-visible:outline-accent"
      >
        Ver detalle y procesos
      </button>
    </div>
  );
};

/** Lo mismo en una línea para la barra de estado; clic abre el detalle. */
export const SystemReadout: React.FC = () => {
  useSystemWatch(true);
  const stats = useSystemStore((s) => s.stats);
  const open = useUiStore((s) => s.isSystemOpen);
  const setOpen = useUiStore((s) => s.setSystemOpen);
  if (!stats) return null;
  const pressure = stats.memoryPressure ? PRESSURE[stats.memoryPressure] : null;
  return (
    <button
      type="button"
      data-system-trigger
      aria-expanded={open}
      onClick={() => setOpen(!open)}
      title={`CPU ${pct(stats.cpuPercent)}${stats.gpuPercent !== null ? ` · GPU ${pct(stats.gpuPercent)}` : ""} · RAM ${formatBytes(stats.memoryUsed)} de ${formatBytes(stats.memoryTotal)}${pressure ? ` · presión ${pressure.label}` : ""}\nClic: detalle y procesos`}
      className={cn(
        "-mx-1 flex h-[18px] items-center gap-2 rounded-sm px-1 transition-colors duration-150 hover:bg-hover focus-visible:outline-2 focus-visible:outline-accent",
        open && "bg-hover",
      )}
    >
      <span>
        CPU <span className="text-ink-2">{pct(stats.cpuPercent)}</span>
      </span>
      {stats.gpuPercent !== null && (
        <span>
          GPU <span className="text-ink-2">{pct(stats.gpuPercent)}</span>
        </span>
      )}
      <span>
        RAM <span className={pressure && stats.memoryPressure !== "normal" ? pressure.tone : "text-ink-2"}>{formatBytes(stats.memoryUsed)}</span>
      </span>
    </button>
  );
};

/* ------------------------------------------------------------------ */
/* Detalle (clic en la barra de estado o en la sección Sistema)        */
/* ------------------------------------------------------------------ */

const PROCESS_ROWS = 10;

function formatUptime(secs: number): string {
  const days = Math.floor(secs / 86_400);
  const hours = Math.floor((secs % 86_400) / 3_600);
  const minutes = Math.floor((secs % 3_600) / 60);
  if (days) return `${days} d ${hours} h`;
  if (hours) return `${hours} h ${minutes} min`;
  return `${minutes} min`;
}

/** Tarjeta de una métrica: nombre, valor grande (en tinta) y su tendencia. */
const StatTile: React.FC<{ label: string; value: string; detail?: React.ReactNode; values?: number[]; title: string }> = ({
  label,
  value,
  detail,
  values,
  title,
}) => (
  <div title={title} className="flex min-w-0 flex-col gap-1 rounded-lg border border-line bg-raised/60 px-2.5 py-2">
    <span className="text-[10.5px] font-semibold uppercase tracking-[0.08em] text-ink-3">{label}</span>
    <span className="font-sans text-[18px] font-semibold tabular-nums leading-6 text-ink">{value}</span>
    {/* Caja de alto fijo: en una columna flex, `flex-1` anularía el alto y la línea quedaría en 0 px. */}
    {values && (
      <div className="flex h-4">
        <Sparkline values={values} />
      </div>
    )}
    {detail && <span className="truncate font-mono text-[10.5px] text-ink-3">{detail}</span>}
  </div>
);

/** Un núcleo por barra: de un vistazo se ve si un proceso satura uno solo o todos. */
const CoreBars: React.FC<{ cores: number[] }> = ({ cores }) => (
  <div role="img" aria-label={`Uso por núcleo: ${cores.map((c) => pct(c)).join(", ")}`} className="flex h-8 items-end gap-[3px]">
    {cores.map((core, i) => (
      <span key={i} title={`Núcleo ${i + 1}: ${pct(core)}`} className="relative h-full min-w-[4px] flex-1 overflow-hidden rounded-[2px] bg-line">
        <span className={cn("absolute inset-x-0 bottom-0 rounded-[2px]", fillFor(core))} style={{ height: `${Math.max(core, 2)}%` }} />
      </span>
    ))}
  </div>
);

const SystemDetail: React.FC<{ onClose: () => void }> = ({ onClose }) => {
  useSystemWatch(true);
  const stats = useSystemStore((s) => s.stats);
  const cpu = useSystemStore((s) => s.cpu);
  const gpu = useSystemStore((s) => s.gpu);
  const memory = useSystemStore((s) => s.memory);
  const [sort, setSort] = React.useState<"memory" | "cpu">("memory");
  const [processes, setProcesses] = React.useState<ProcessUsage[] | null>(null);
  const panel = React.useRef<HTMLDivElement | null>(null);
  const askConfirm = useUiStore((s) => s.askConfirm);
  const toast = useUiStore((s) => s.showToast);

  // Procesos con su propio orden, mientras el detalle está abierto.
  React.useEffect(() => {
    let cancelled = false;
    const load = async () => {
      if (document.visibilityState !== "visible") return;
      const list = await ipc.systemProcesses(sort, PROCESS_ROWS);
      if (!cancelled && list) setProcesses(list);
    };
    void load();
    const timer = setInterval(() => void load(), SAMPLE_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [sort]);

  // Esc o un clic fuera cierran (el de la barra de estado lo abre y lo cierra él mismo).
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    const onDown = (e: MouseEvent) => {
      const target = e.target as Element | null;
      if (!panel.current?.contains(target) && !target?.closest("[data-system-trigger]")) onClose();
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("mousedown", onDown);
    panel.current?.focus();
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("mousedown", onDown);
    };
  }, [onClose]);

  const terminate = (p: ProcessUsage) =>
    askConfirm({
      title: `¿Terminar ${p.name}?`,
      body: `Se le pide que cierre (SIGTERM, pid ${p.pid}): puede guardar antes de salir. Lo que no haya guardado, se pierde.`,
      confirmLabel: "Terminar",
      onConfirm: () =>
        void ipc
          .processTerminate(p.pid)
          .then(() => toast(`${p.name} recibió la orden de terminar.`))
          .catch((err: unknown) => toast(String(err), "error")),
    });

  const memPercent = stats?.memoryTotal ? (stats.memoryUsed / stats.memoryTotal) * 100 : 0;
  const pressure = stats?.memoryPressure ? PRESSURE[stats.memoryPressure] : null;

  return (
    <div
      ref={panel}
      role="dialog"
      aria-label="Detalle del sistema"
      tabIndex={-1}
      className="fixed bottom-8 right-3 z-40 flex max-h-[min(640px,calc(100vh-80px))] w-[400px] animate-pop-in flex-col overflow-hidden rounded-xl border border-[var(--glass-border)] glass outline-none"
    >
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-line pl-3.5 pr-1.5">
        <span className="text-[13px] font-medium text-ink">Sistema</span>
        {stats && (
          <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-ink-3">
            {stats.cpuCount} núcleos · encendido hace {formatUptime(stats.uptimeSecs)}
          </span>
        )}
        <IconButton icon={X} label="Cerrar" shortcut="esc" size="sm" onClick={onClose} />
      </div>

      {!stats ? (
        <p className="px-4 py-6 text-[12.5px] text-ink-3">Midiendo…</p>
      ) : (
        <div className="flex min-h-0 flex-col gap-3 overflow-y-auto p-3">
          <div className={cn("grid gap-2", stats.gpuPercent !== null ? "grid-cols-3" : "grid-cols-2")}>
            <StatTile label="CPU" value={pct(stats.cpuPercent)} values={cpu} title={trendTitle("CPU", cpu)} />
            {stats.gpuPercent !== null && (
              <StatTile
                label="GPU"
                value={pct(stats.gpuPercent)}
                values={gpu}
                title={trendTitle("GPU", gpu)}
                detail={stats.gpuMemory ? `${formatBytes(stats.gpuMemory)} en uso` : undefined}
              />
            )}
            <StatTile
              label="Memoria"
              value={pct(memPercent)}
              values={memory}
              title={trendTitle("Memoria", memory)}
              detail={formatMemory(stats.memoryUsed, stats.memoryTotal)}
            />
          </div>

          <section aria-label="Núcleos" className="flex flex-col gap-1.5">
            <div className="flex items-baseline justify-between text-[11px]">
              <span className="font-semibold uppercase tracking-[0.08em] text-ink-3">Núcleos</span>
              {stats.loadAverage && (
                <span
                  title="Carga media de 1, 5 y 15 minutos: procesos esperando CPU. Por encima del número de núcleos, hay cola."
                  className="font-mono tabular-nums text-ink-3"
                >
                  carga {stats.loadAverage.map((l) => l.toFixed(2)).join(" · ")}
                </span>
              )}
            </div>
            <CoreBars cores={stats.cpuCores} />
          </section>

          <section aria-label="Memoria" className="flex flex-col gap-1.5">
            <div
              role="meter"
              aria-label="Memoria en uso"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.round(memPercent)}
              className="h-[6px] overflow-hidden rounded-full bg-line"
            >
              <span className={cn("block h-full rounded-full", pressure?.fill ?? fillFor(memPercent))} style={{ width: `${Math.min(memPercent, 100)}%` }} />
            </div>
            <p className="flex flex-wrap gap-x-3 gap-y-0.5 font-mono text-[10.5px] text-ink-3">
              <span>disponible {formatBytes(stats.memoryAvailable)}</span>
              {stats.swapTotal > 0 && (
                <span>
                  swap {formatBytes(stats.swapUsed)} / {formatBytes(stats.swapTotal)}
                </span>
              )}
              {pressure && <span className={pressure.tone}>presión {pressure.label}</span>}
            </p>
          </section>

          <section aria-label="Procesos" className="flex min-h-0 flex-col gap-1">
            <div className="flex items-center justify-between">
              <span className="text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-3">Procesos</span>
              <div role="radiogroup" aria-label="Ordenar por" className="flex rounded-md border border-line p-0.5">
                {(["memory", "cpu"] as const).map((key) => (
                  <button
                    key={key}
                    type="button"
                    role="radio"
                    aria-checked={sort === key}
                    onClick={() => setSort(key)}
                    className={cn(
                      "rounded px-2 text-[11px] leading-5 transition-colors duration-150 focus-visible:outline-2 focus-visible:outline-accent",
                      sort === key ? "bg-press text-ink" : "text-ink-3 hover:text-ink-2",
                    )}
                  >
                    {key === "memory" ? "Memoria" : "CPU"}
                  </button>
                ))}
              </div>
            </div>
            <ul className="flex flex-col">
              {(processes ?? []).map((p) => (
                <li key={p.pid} className="group/proc flex h-7 items-center gap-2 rounded-md px-1.5 font-mono text-[11px] tabular-nums hover:bg-hover">
                  <span className="min-w-0 flex-1 truncate text-ink-2" title={`${p.name} (pid ${p.pid})`}>
                    {p.name}
                  </span>
                  <span className="w-14 shrink-0 text-right text-ink-3">{pct(p.cpuPercent)}</span>
                  <span className="w-16 shrink-0 text-right text-ink-2">{formatBytes(p.memory)}</span>
                  <span className="w-6 shrink-0">
                    {p.mine && (
                      <button
                        type="button"
                        aria-label={`Terminar ${p.name}`}
                        title="Terminar proceso"
                        onClick={() => terminate(p)}
                        className="grid size-6 place-items-center rounded text-ink-3 opacity-0 transition-opacity duration-150 hover:bg-signal/15 hover:text-signal focus-visible:opacity-100 group-hover/proc:opacity-100"
                      >
                        <X size={12} strokeWidth={2} aria-hidden="true" />
                      </button>
                    )}
                  </span>
                </li>
              ))}
              {processes === null && <li className="px-1.5 py-2 text-[11.5px] text-ink-3">Leyendo procesos…</li>}
            </ul>
          </section>
        </div>
      )}
    </div>
  );
};

/** El detalle, montado solo mientras está abierto (no mide nada cerrado). */
export const SystemPopover: React.FC = () => {
  const open = useUiStore((s) => s.isSystemOpen);
  const setOpen = useUiStore((s) => s.setSystemOpen);
  const close = React.useCallback(() => setOpen(false), [setOpen]);
  return open ? <SystemDetail onClose={close} /> : null;
};
