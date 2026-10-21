import React, { useEffect, useRef, useState } from "react";
import { ArrowRight, Asterisk, Hexagon, RefreshCw, X, type LucideIcon } from "lucide-react";
import { useTerminalStore } from "../store/terminalStore";
import { actions, AGENTS, type AgentKind } from "../lib/actions";
import { formatAgo, formatTokens, formatUntil } from "../lib/format";
import { pace, type Pace } from "../lib/quota";
import { useNow } from "../lib/useNow";
import { cn } from "../lib/layout";
import type { ProviderUsage, UsageWindow } from "../types/layout";
import { IconButton, Ring, toneFor } from "./ui";

interface UsagePopoverProps {
  onClose: () => void;
}

export const UsagePopover: React.FC<UsagePopoverProps> = ({ onClose }) => {
  const isOpen = useTerminalStore((s) => s.isUsageDrawerOpen);
  if (!isOpen) return null;
  return <UsagePanel onClose={onClose} />;
};

const SOURCE_LABEL: Record<NonNullable<ProviderUsage["source"]>, string> = {
  statusline: "sesión de Claude Code",
  oauth: "cuenta de Anthropic",
  "session-log": "registros de Codex",
};

/** `16:05` (sin "p. m." ni puntos finales: va dentro de frases). */
const clock = (ms: number) => new Date(ms).toLocaleTimeString("es-MX", { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });

const UsagePanel: React.FC<UsagePopoverProps> = ({ onClose }) => {
  const usage = useTerminalStore((s) => s.usage);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const now = useNow(30_000);
  const [refreshing, setRefreshing] = useState(false);

  useEffect(() => {
    panelRef.current?.focus();
  }, []);

  // El giro dura lo que tarda en llegar la siguiente lectura (o 4 s como máximo).
  useEffect(() => {
    if (!refreshing) return;
    const id = setTimeout(() => setRefreshing(false), 4000);
    return () => clearTimeout(id);
  }, [refreshing, usage]);

  const refresh = () => {
    setRefreshing(true);
    actions.refreshUsage();
  };

  const launch = (agent: AgentKind) => {
    onClose();
    void actions.openAgentInSplit(agent);
  };

  return (
    <div
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          onClose();
        }
      }}
      className="fixed inset-0 z-40"
    >
      <div
        ref={panelRef}
        tabIndex={-1}
        role="dialog"
        aria-label="Consumo de IA"
        className="absolute right-2 top-12 max-h-[calc(100vh-4.5rem)] w-[400px] origin-top-right animate-pop-in overflow-y-auto rounded-2xl border border-[var(--glass-border)] glass outline-none"
      >
        <div className="flex h-11 items-center justify-between pl-5 pr-2">
          <h2 className="text-[13px] font-semibold text-ink">Consumo</h2>
          <div className="flex items-center">
            <IconButton icon={RefreshCw} label="Actualizar ahora" size="sm" onClick={refresh} className={cn(refreshing && "[&>svg]:animate-spin")} />
            <IconButton icon={X} label="Cerrar" size="sm" onClick={onClose} />
          </div>
        </div>

        <div className="flex flex-col gap-2 px-2 pb-2">
          <ProviderCard icon={Asterisk} agent="claude" data={usage.claude} now={now} onLaunch={() => launch("claude")} />
          <ProviderCard icon={Hexagon} agent="codex" data={usage.codex} now={now} onLaunch={() => launch("codex")} />
        </div>
      </div>
    </div>
  );
};

interface ProviderCardProps {
  icon: LucideIcon;
  agent: AgentKind;
  data: ProviderUsage;
  now: number;
  onLaunch: () => void;
}

const ProviderCard: React.FC<ProviderCardProps> = ({ icon: Icon, agent, data, now, onLaunch }) => {
  const name = AGENTS[agent].title;
  const stale = data.status === "expired" || data.status === "error";
  const session = data.windows.find((w) => w.kind === "session");
  const others = data.windows.filter((w) => w !== session);

  return (
    <section aria-label={name} className="rounded-xl border border-line bg-raised px-4 pb-3.5 pt-3">
      <header className="flex items-center gap-2">
        <Icon size={14} strokeWidth={1.9} aria-hidden="true" className="text-accent" />
        <h3 className="flex-1 text-[13px] font-medium text-ink">{name}</h3>
        {data.plan && <span className="rounded-full bg-hover px-2 font-mono text-[10.5px] leading-5 text-ink-2">{data.plan}</span>}
        {data.authMode === "api-key" && !data.plan && <span className="rounded-full bg-hover px-2 font-mono text-[10.5px] leading-5 text-ink-2">API key</span>}
      </header>

      {data.status === "loading" && <p className="mt-3 text-[12px] text-ink-3">Leyendo cuota…</p>}

      <div className={cn(stale && "opacity-60")}>
        {session && <SessionHero window={session} now={now} name={name} />}
        {others.length > 0 && (
          <div className="mt-3 flex flex-col gap-2.5">
            {others.map((w) => (
              <BulletWindow key={w.kind} window={w} now={now} name={name} />
            ))}
          </div>
        )}
      </div>

      {data.message && <p className={cn("mt-3 text-[12px] leading-relaxed", stale ? "text-signal/90" : "text-ink-3")}>{data.message}</p>}

      {data.tokensByHour && <Activity values={data.tokensByHour} total={data.tokens24h} now={now} />}

      <div className="mt-3 flex items-center justify-between gap-3">
        <span className="min-w-0 truncate text-[11px] text-ink-3">
          {data.fetchedAt && data.source ? `Leído ${formatAgo(data.fetchedAt, now)} · ${SOURCE_LABEL[data.source]}` : ""}
        </span>
        <button
          type="button"
          onClick={onLaunch}
          className="group flex h-7 shrink-0 items-center gap-1.5 rounded-full border border-line px-3 text-[12px] text-ink-2 transition-colors duration-150 hover:border-accent/50 hover:text-ink"
        >
          Abrir aquí
          <ArrowRight size={12} strokeWidth={1.9} aria-hidden="true" className="text-ink-3 transition-transform duration-150 group-hover:translate-x-0.5 group-hover:text-accent" />
        </button>
      </div>
    </section>
  );
};

/** El veredicto del ritmo, en palabras (el color nunca va solo). */
function verdict(p: Pace | null, used: number, now: number): { title: string; detail: string; tone: "ok" | "warn" | "alert" } {
  if (!p) return { title: `${Math.round(used)} % usado`, detail: "Aún no hay ritmo que proyectar.", tone: used >= 90 ? "alert" : "ok" };
  if (p.exhaustsAt !== null) {
    const early = p.resetsAt - p.exhaustsAt;
    return {
      title: used >= 100 ? "Sin cuota" : `Se agota a las ${clock(p.exhaustsAt)}`,
      detail: used >= 100 ? `Vuelve a las ${clock(p.resetsAt)}.` : `A este ritmo, ${formatUntil(now + early, now).replace("en ", "")} antes del reinicio.`,
      tone: "alert",
    };
  }
  // El título dice lo mismo que el color: los dos salen de la proyección.
  const projected = Math.min(100, Math.round(p.projectedPercent));
  const tight = projected >= 85;
  return {
    title: tight ? `Llegarías al ${projected} %` : "Vas holgado",
    detail: `${tight ? "Justo, pero alcanza" : `A este ritmo cierras la ventana en ~${projected} %`}. Se reinicia a las ${clock(p.resetsAt)}.`,
    tone: tight ? "warn" : "ok",
  };
}

const TONE_TEXT = { ok: "text-ink", warn: "text-warn", alert: "text-signal" } as const;

/** Ventana de 5 h: anillo de uso, anillo interior de tiempo transcurrido y el veredicto. */
const SessionHero: React.FC<{ window: UsageWindow; now: number; name: string }> = ({ window: w, now, name }) => {
  const p = pace(w, now);
  const v = verdict(p, w.usedPercent, now);
  const pct = Math.round(w.usedPercent);
  return (
    <div className="mt-3 flex items-center gap-4">
      <Ring value={w.usedPercent} inner={p?.elapsedPercent ?? null} size={92} stroke={8} tone={toneFor(w.usedPercent)} label={`${name}, sesión de 5 h: ${pct} %`}>
        <span className="flex flex-col items-center leading-none">
          <span className="font-mono text-[22px] font-semibold tabular-nums text-ink">{pct}%</span>
          <span className="mt-1 text-[10px] text-ink-3">de 5 h</span>
        </span>
      </Ring>
      <div className="min-w-0 flex-1">
        <p className={cn("text-[14px] font-medium", TONE_TEXT[v.tone])}>{v.title}</p>
        <p className="mt-0.5 text-[12px] leading-snug text-ink-3">{v.detail}</p>
        {p && (
          <p className="mt-2 flex items-center gap-3 text-[10.5px] text-ink-3">
            <span className="flex items-center gap-1">
              <span className="h-[3px] w-3 rounded-full bg-accent" aria-hidden="true" /> uso
            </span>
            <span className="flex items-center gap-1">
              <span className="h-[2px] w-3 rounded-full bg-ink-3/60" aria-hidden="true" /> tiempo transcurrido ({Math.round(p.elapsedPercent)} %)
            </span>
          </p>
        )}
      </div>
    </div>
  );
};

/** Ventanas largas: barra de uso con una marca de dónde "deberías" ir según el tiempo. */
const BulletWindow: React.FC<{ window: UsageWindow; now: number; name: string }> = ({ window: w, now, name }) => {
  const p = pace(w, now);
  const pct = Math.round(w.usedPercent);
  const tone = toneFor(w.usedPercent);
  return (
    <div>
      <div className="mb-1 flex items-baseline justify-between gap-2">
        <span className="text-[12px] text-ink-2">{w.label}</span>
        <span className={cn("font-mono text-[12px] tabular-nums", tone === "alert" ? "text-signal" : tone === "warn" ? "text-warn" : "text-ink")}>{pct}%</span>
      </div>
      <div role="meter" aria-label={`${name}, ${w.label}`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct} className="relative h-1.5 rounded-full bg-line-strong">
        <div
          className={cn("h-full rounded-full transition-[width] duration-500", tone === "alert" ? "bg-signal" : tone === "warn" ? "bg-warn" : "bg-accent")}
          style={{ width: `${Math.min(100, Math.max(0, w.usedPercent))}%` }}
        />
        {p && (
          <span
            aria-hidden="true"
            title={`Tiempo transcurrido: ${Math.round(p.elapsedPercent)} %`}
            className="absolute -top-1 h-3.5 w-[2px] rounded-full bg-ink-2"
            style={{ left: `calc(${p.elapsedPercent}% - 1px)` }}
          />
        )}
      </div>
      <p className="mt-1 text-[11px] text-ink-3">
        {p ? (p.ahead ? "Por delante del tiempo · " : "Por debajo del ritmo · ") : ""}
        {p ? `se reinicia ${formatUntil(p.resetsAt, now)}` : ""}
      </p>
    </div>
  );
};

/** Tokens por hora de las últimas 24 h; la hora en curso, resaltada. */
const Activity: React.FC<{ values: number[]; total: number | null; now: number }> = ({ values, total, now }) => {
  const max = Math.max(...values, 1);
  const peak = values.indexOf(max);
  const W = 336;
  const H = 40;
  const gap = 2;
  const bar = (W - gap * (values.length - 1)) / values.length;
  const hourLabel = (i: number) => clock(now - (values.length - 1 - i) * 3600_000).replace(/:\d\d/, ":00");
  const hasData = values.some((v) => v > 0);
  return (
    <div className="mt-3.5">
      <div className="mb-1.5 flex items-baseline justify-between text-[11px]">
        <span className="text-ink-2">Actividad · 24 h</span>
        <span className="font-mono tabular-nums text-ink-3">
          {total !== null ? `${formatTokens(total)} tokens` : ""}
          {hasData && ` · pico ${hourLabel(peak)}`}
        </span>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} className="h-10 w-full" role="img" aria-label={`Tokens por hora en las últimas 24 horas${total !== null ? `: ${formatTokens(total)} en total` : ""}`}>
        {values.map((v, i) => {
          const h = v > 0 ? Math.max(2, (v / max) * (H - 2)) : 1;
          const current = i === values.length - 1;
          return (
            <rect
              key={i}
              x={i * (bar + gap)}
              y={H - h}
              width={bar}
              height={h}
              rx={Math.min(2, bar / 2)}
              fill={v > 0 ? "var(--color-accent)" : "var(--color-line-strong)"}
              fillOpacity={v > 0 ? (current || i === peak ? 1 : 0.42) : 1}
            >
              <title>{`${hourLabel(i)}: ${formatTokens(v)} tokens`}</title>
            </rect>
          );
        })}
      </svg>
      <div className="mt-1 flex justify-between font-mono text-[10px] text-ink-3">
        <span>hace 24 h</span>
        <span>ahora</span>
      </div>
    </div>
  );
};
