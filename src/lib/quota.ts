import type { UsageWindow } from "../types/layout";
import { toEpochMs } from "./format";

const HOUR = 60 * 60 * 1000;

/** Duración de cada ventana conocida (las demás no se proyectan). */
export function windowDuration(kind: string): number | null {
  if (kind === "session") return 5 * HOUR;
  if (kind === "weekly_all" || kind.startsWith("weekly")) return 7 * 24 * HOUR;
  return null;
}

export interface Pace {
  /** 0–100: cuánto del tiempo de la ventana ya pasó. */
  elapsedPercent: number;
  /** Uso al que llegarías al reiniciarse, a este ritmo (puede pasar de 100). */
  projectedPercent: number;
  /** Si a este ritmo se agota antes del reinicio: cuándo (ms). */
  exhaustsAt: number | null;
  /** Cuándo se reinicia (ms). */
  resetsAt: number;
  /** Vas por delante del tiempo (gastas más rápido de lo que pasa la ventana). */
  ahead: boolean;
}

/**
 * Ritmo de una ventana a partir de dos datos reales: cuánto llevas usado y
 * cuándo se reinicia. Supone que sigues al mismo ritmo medio desde que
 * empezó la ventana; con muy poco tiempo transcurrido no se proyecta (el
 * ritmo de los primeros minutos no dice nada).
 */
export function pace(window: UsageWindow, now: number): Pace | null {
  const duration = windowDuration(window.kind);
  const resetsAt = toEpochMs(window.resetsAt);
  if (!duration || !resetsAt || resetsAt <= now) return null;
  const remaining = Math.min(duration, resetsAt - now);
  const elapsed = duration - remaining;
  const elapsedPercent = (elapsed / duration) * 100;
  const used = Math.max(0, window.usedPercent);
  if (elapsed < duration * 0.04 || used <= 0) {
    return { elapsedPercent, projectedPercent: used, exhaustsAt: null, resetsAt, ahead: false };
  }
  const perMs = used / elapsed;
  const projectedPercent = used + perMs * remaining;
  const toFull = (100 - used) / perMs;
  const exhaustsAt = used >= 100 ? now : toFull < remaining ? now + toFull : null;
  return { elapsedPercent, projectedPercent, exhaustsAt, resetsAt, ahead: used > elapsedPercent + 2 };
}
