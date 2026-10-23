import { useEffect } from "react";
import { create } from "zustand";
import type { SystemStats } from "../types/layout";
import { ipc } from "./ipc";

/** Cada cuánto se mide mientras algo lo muestra. */
export const SAMPLE_MS = 2000;
/** Muestras de las gráficas: 2 minutos. */
export const HISTORY = 60;

interface SystemState {
  stats: SystemStats | null;
  /** De la más vieja a la más nueva, 0–100. */
  cpu: number[];
  gpu: number[];
  memory: number[];
  push: (stats: SystemStats) => void;
}

const append = (series: number[], value: number) => [...series.slice(-(HISTORY - 1)), value];

export const useSystemStore = create<SystemState>((set) => ({
  stats: null,
  cpu: [],
  gpu: [],
  memory: [],
  push: (stats) =>
    set((s) => ({
      // Sin procesos en esta muestra: se conservan los de la anterior (se piden menos seguido).
      stats: stats.top.length || !s.stats ? stats : { ...stats, top: s.stats.top },
      cpu: append(s.cpu, stats.cpuPercent),
      gpu: stats.gpuPercent === null ? s.gpu : append(s.gpu, stats.gpuPercent),
      memory: append(s.memory, stats.memoryTotal ? (stats.memoryUsed / stats.memoryTotal) * 100 : 0),
    })),
}));

/*
 * Quién lo está mirando. Sin nadie (barra lateral cerrada y sección plegada),
 * o con la ventana oculta, no se pregunta nada al sistema.
 */
let watchers = 0;
let processWatchers = 0;
let timer: ReturnType<typeof setInterval> | undefined;
let inFlight = false;
let ticks = 0;

async function sample() {
  if (inFlight || document.visibilityState !== "visible") return;
  inFlight = true;
  try {
    // Recorrer todos los procesos cuesta más: uno de cada dos ciclos.
    const processes = processWatchers > 0 && ticks++ % 2 === 0;
    const stats = await ipc.systemStats(processes);
    if (stats) useSystemStore.getState().push(stats);
  } finally {
    inFlight = false;
  }
}

/** Empieza a medir (o se suma a quien ya mide). Devuelve cómo dejar de mirar. */
export function watchSystem({ processes = false } = {}): () => void {
  watchers++;
  if (processes) {
    processWatchers++;
    ticks = 0;
  }
  if (!timer) {
    timer = setInterval(() => void sample(), SAMPLE_MS);
    document.addEventListener("visibilitychange", onVisible);
  }
  void sample();
  return () => {
    watchers--;
    if (processes) processWatchers--;
    if (watchers === 0 && timer) {
      clearInterval(timer);
      timer = undefined;
      document.removeEventListener("visibilitychange", onVisible);
    }
  };
}

/** Al volver a la ventana, una muestra ya: no hay que esperar al siguiente ciclo. */
function onVisible() {
  if (document.visibilityState === "visible") void sample();
}

/** Mide mientras el componente está montado. */
export function useSystemWatch(enabled: boolean, processes = false) {
  useEffect(() => (enabled ? watchSystem({ processes }) : undefined), [enabled, processes]);
}

const GB = 1024 ** 3;

/** `11.2 GB`, `640 MB`: lo justo para leer de un vistazo. */
export function formatBytes(bytes: number): string {
  if (bytes >= 100 * GB) return `${Math.round(bytes / GB)} GB`;
  if (bytes >= GB) return `${(bytes / GB).toFixed(1)} GB`;
  return `${Math.max(1, Math.round(bytes / 1024 ** 2))} MB`;
}
