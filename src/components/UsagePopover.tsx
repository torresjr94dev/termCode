import React, { useEffect, useRef, useState } from "react";
import { ArrowRight, Asterisk, Hexagon, RefreshCw, X, type LucideIcon } from "lucide-react";
import { useTerminalStore } from "../store/terminalStore";
import { actions, AGENTS, type AgentKind } from "../lib/actions";
import { formatAgo, formatTokens, formatUntil, toEpochMs } from "../lib/format";
import { cn } from "../lib/layout";
import type { ProviderUsage } from "../types/layout";
import { IconButton, Meter } from "./ui";

interface UsagePopoverProps {
  onClose: () => void;
}

export const UsagePopover: React.FC<UsagePopoverProps> = ({ onClose }) => {
  const isOpen = useTerminalStore((s) => s.isUsageDrawerOpen);
  if (!isOpen) return null;
  return <UsagePanel onClose={onClose} />;
};

/** Re-render periódico para que "en 2 h 45 min" y "hace 3 min" no se congelen. */
function useNow(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}

const SOURCE_LABEL: Record<NonNullable<ProviderUsage["source"]>, string> = {
  statusline: "sesión de Claude Code",
  oauth: "cuenta de Anthropic",
  "session-log": "registros de Codex",
};

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
        aria-label="Cuotas de IA"
        className="absolute right-2 top-11 max-h-[calc(100vh-4rem)] w-[340px] origin-top-right animate-pop-in overflow-y-auto rounded-lg border border-line-strong bg-raised shadow-[0_24px_64px_-12px_rgb(0_0_0/0.7)] outline-none"
      >
        <div className="sticky top-0 z-10 flex h-10 items-center justify-between border-b border-line bg-raised pl-4 pr-1.5">
          <h2 className="font-mono text-[11px] uppercase tracking-[0.08em] text-ink-3">Cuotas de IA</h2>
          <div className="flex items-center">
            <IconButton
              icon={RefreshCw}
              label="Actualizar ahora"
              size="sm"
              onClick={refresh}
              className={cn(refreshing && "[&>svg]:animate-spin")}
            />
            <IconButton icon={X} label="Cerrar" size="sm" onClick={onClose} />
          </div>
        </div>

        <ProviderBlock icon={Asterisk} agent="claude" data={usage.claude} now={now} onLaunch={() => launch("claude")} />
        <ProviderBlock icon={Hexagon} agent="codex" data={usage.codex} now={now} onLaunch={() => launch("codex")} />
      </div>
    </div>
  );
};

interface ProviderBlockProps {
  icon: LucideIcon;
  agent: AgentKind;
  data: ProviderUsage;
  now: number;
  onLaunch: () => void;
}

const ProviderBlock: React.FC<ProviderBlockProps> = ({ icon: Icon, agent, data, now, onLaunch }) => {
  const name = AGENTS[agent].title;
  const stale = data.status === "expired" || data.status === "error";

  return (
    <section aria-label={name} className="border-b border-line px-4 pb-3 pt-3.5 last-of-type:border-b-0">
      <header className="mb-3 flex items-center gap-2">
        <Icon size={14} strokeWidth={1.75} aria-hidden="true" className="text-ink-3" />
        <h3 className="flex-1 text-[13px] font-medium text-ink">{name}</h3>
        {data.plan && (
          <span className="rounded-sm border border-line px-1.5 py-px font-mono text-[11px] text-ink-3">{data.plan}</span>
        )}
      </header>

      {data.status === "loading" && <p className="text-[12px] text-ink-3">Leyendo cuota…</p>}

      {data.windows.length > 0 && (
        <div className={cn("flex flex-col gap-3", stale && "opacity-60")}>
          {data.windows.map((w) => {
            const resets = toEpochMs(w.resetsAt);
            const pct = Math.round(w.usedPercent);
            return (
              <div key={w.kind}>
                <div className="mb-1.5 flex items-baseline justify-between">
                  <span className="text-[12px] text-ink-2">{w.label}</span>
                  <span
                    className={cn(
                      "font-mono text-[13px] font-medium tabular-nums",
                      pct >= 85 || w.severity === "critical" ? "text-signal" : "text-ink",
                    )}
                  >
                    {pct}%
                  </span>
                </div>
                <Meter value={w.usedPercent} label={`${name}, ${w.label}`} />
                {resets && <div className="mt-1 text-[11px] text-ink-3">Se reinicia {formatUntil(resets, now)}</div>}
              </div>
            );
          })}
        </div>
      )}

      {data.message && (
        <p className={cn("mt-3 text-[12px] leading-relaxed", stale ? "text-signal/90" : "text-ink-3")}>{data.message}</p>
      )}

      <dl className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-ink-3">
        {data.tokens24h !== null && (
          <div className="flex gap-1.5">
            <dt>Tokens 24 h</dt>
            <dd className="font-mono tabular-nums text-ink-2" title="Entrada + salida, sin caché">
              {formatTokens(data.tokens24h)}
            </dd>
          </div>
        )}
        {data.fetchedAt && data.source && (
          <div className="flex gap-1.5">
            <dt>Leído</dt>
            <dd className="text-ink-2">
              {formatAgo(data.fetchedAt, now)} · {SOURCE_LABEL[data.source]}
            </dd>
          </div>
        )}
      </dl>

      <button
        type="button"
        onClick={onLaunch}
        className="group mt-3 flex h-8 w-full items-center justify-between rounded-md border border-line px-2.5 text-[12px] text-ink-2 transition-colors duration-150 hover:border-amber/50 hover:bg-amber/10 hover:text-ink"
      >
        Abrir junto al panel actual
        <ArrowRight
          size={13}
          strokeWidth={1.75}
          aria-hidden="true"
          className="text-ink-3 transition-transform duration-150 group-hover:translate-x-0.5 group-hover:text-amber"
        />
      </button>
    </section>
  );
};
