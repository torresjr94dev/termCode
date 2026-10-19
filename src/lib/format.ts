const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** Acepta ISO-8601, epoch en segundos o en milisegundos. */
export function toEpochMs(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return null;
    return value < 1e12 ? value * 1000 : value;
  }
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

function span(ms: number): string {
  if (ms < MINUTE) return "menos de 1 min";
  if (ms < HOUR) return `${Math.round(ms / MINUTE)} min`;
  if (ms < DAY) {
    const h = Math.floor(ms / HOUR);
    const m = Math.round((ms % HOUR) / MINUTE);
    return m && h < 10 ? `${h} h ${m} min` : `${h} h`;
  }
  const d = Math.round(ms / DAY);
  return d === 1 ? "1 día" : `${d} días`;
}

/** "en 2 h 45 min", "en 3 días", "ahora". */
export function formatUntil(target: number, now: number): string {
  const diff = target - now;
  return diff <= 0 ? "ahora" : `en ${span(diff)}`;
}

/** "hace 3 min", "justo ahora". */
export function formatAgo(past: number, now: number): string {
  const diff = now - past;
  return diff < MINUTE ? "justo ahora" : `hace ${span(diff)}`;
}

const compact = new Intl.NumberFormat("es-MX", { notation: "compact", maximumFractionDigits: 1 });

export function formatTokens(value: number): string {
  return compact.format(value);
}

const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 2 });

export function formatUsd(value: number): string {
  return usd.format(value);
}

/** 2.3 s · 14 s · 2 min 14 s · 1 h 3 min */
export function formatDuration(ms: number): string {
  if (ms < 10_000) return `${(ms / 1000).toFixed(1)} s`;
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min ${seconds % 60} s`;
  return `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
}
