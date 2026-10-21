import React, { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Radio } from "lucide-react";
import { useTerminalStore } from "../store/terminalStore";
import { useApprovalStore } from "../store/approvalStore";
import { useUiStore } from "../store/uiStore";
import { terminalManager } from "../terminal/TerminalManager";
import { actions } from "../lib/actions";
import { agentSummary } from "../lib/attention";
import { cn, collectPanes } from "../lib/layout";
import { formatDuration, formatUsd } from "../lib/format";
import { paneDisplayName } from "../lib/identity";
import { useNow } from "../lib/useNow";
import { shortcutLabel } from "../lib/shortcuts";
import { Lamp } from "./ui";

/** Solo datos reales. Nada de latencias ni RAM inventadas. */
export const StatusBar: React.FC = () => {
  const tabs = useTerminalStore((s) => s.tabs);
  const activeTabId = useTerminalStore((s) => s.activeTabId);
  const isBroadcastEnabled = useTerminalStore((s) => s.isBroadcastEnabled);
  const paneProject = useTerminalStore((s) => s.paneProject);

  const tabIndex = tabs.findIndex((t) => t.id === activeTabId);
  const tab = tabs[tabIndex];
  const panes = tab ? collectPanes(tab.root) : [];
  const paneIndex = panes.findIndex((p) => p.id === tab?.activePaneId);
  const activePane = panes[paneIndex];
  const totalPanes = tabs.reduce((sum, t) => sum + collectPanes(t.root).length, 0);

  const size = useTransientSize(activePane?.id);

  return (
    <footer className="flex h-7 shrink-0 items-center justify-between gap-4 bg-chrome px-3.5 font-mono text-[11px] text-ink-3">
      <div className="flex min-w-0 items-center gap-3">
        {isBroadcastEnabled && (
          <button
            type="button"
            onClick={actions.toggleBroadcast}
            title={`Desactivar broadcast  ${shortcutLabel("toggleBroadcast")}`}
            className="flex h-[18px] shrink-0 items-center gap-1.5 rounded-sm bg-signal px-1.5 font-semibold uppercase tracking-[0.06em] text-on-accent"
          >
            <Radio size={11} strokeWidth={2.25} aria-hidden="true" />
            Broadcast · {totalPanes} paneles
          </button>
        )}

        {activePane && (
          <span className="flex min-w-0 items-center gap-2">
            <Lamp state="on" />
            <span className="truncate text-ink-2">{paneDisplayName(activePane, paneProject[activePane.id])}</span>
            {panes.length > 1 && (
              <span className="shrink-0 tabular-nums">
                panel {paneIndex + 1}/{panes.length}
              </span>
            )}
          </span>
        )}
      </div>

      <div className="flex shrink-0 items-center gap-3 tabular-nums">
        {activePane && <CommandStatus paneId={activePane.id} />}
        {size && (
          <span title="Columnas × filas" className="text-ink-2">
            {size}
          </span>
        )}
        <AgentsStatus />
        {tabs.length > 1 && <span title={`Pestaña ${tabIndex + 1} de ${tabs.length}`}>{tabIndex + 1}/{tabs.length}</span>}
      </div>
    </footer>
  );
};

/** Columnas × filas solo mientras cambian (al redimensionar): el resto del tiempo es ruido. */
function useTransientSize(paneId: string | undefined): string | null {
  const size = useSyncExternalStore(terminalManager.subscribeSize, () => terminalManager.getSize(paneId));
  const [visible, setVisible] = useState(false);
  const previous = useRef({ paneId, size });
  useEffect(() => {
    const before = previous.current;
    previous.current = { paneId, size };
    // Cambiar de panel no es redimensionar.
    if (before.paneId !== paneId || before.size === size || !before.size) return;
    setVisible(true);
    const timer = setTimeout(() => setVisible(false), 1400);
    return () => clearTimeout(timer);
  }, [paneId, size]);
  return visible && size ? size : null;
}

/** «2 trabajando · 1 te necesita · $1.20»: el estado de todos los agentes sin abrir nada. */
const AgentsStatus: React.FC = () => {
  const tabs = useTerminalStore((s) => s.tabs);
  const activity = useTerminalStore((s) => s.agentActivity);
  const attention = useTerminalStore((s) => s.attention);
  const status = useTerminalStore((s) => s.agentStatus);
  const approvals = useApprovalStore((s) => s.requests);
  const summary = agentSummary(tabs, activity, attention, status, approvals);
  if (!summary.agents) return null;

  const onClick = () => (summary.waiting ? actions.focusNextAttention() : useUiStore.getState().setMissionOpen(true));
  const title = summary.waiting
    ? `Ir al agente que te necesita  ${shortcutLabel("nextAttention")}`
    : `Mission Control  ${shortcutLabel("missionControl")}`;

  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      className={cn(
        "-mx-1 flex h-[18px] items-center gap-2 rounded-sm px-1 transition-colors duration-150",
        summary.waiting ? "bg-accent text-on-accent hover:opacity-90" : "hover:bg-hover hover:text-ink-2",
      )}
    >
      {summary.waiting > 0 && <span className="font-semibold">{summary.waiting} te necesita{summary.waiting === 1 ? "" : "n"}</span>}
      {summary.working > 0 && (
        <span className={cn("flex items-center gap-1.5", !summary.waiting && "text-accent")}>
          {!summary.waiting && <Lamp state="on" />}
          {summary.working} trabajando
        </span>
      )}
      {!summary.waiting && !summary.working && (
        <span>
          {summary.agents} agente{summary.agents === 1 ? "" : "s"}
        </span>
      )}
      {summary.costUsd !== null && <span title="Costo sumado de las sesiones de Claude">{formatUsd(summary.costUsd)}</span>}
    </button>
  );
};

const subscribeTracker = (paneId: string) => (listener: () => void) =>
  terminalManager.getTracker(paneId)?.subscribe(listener) ?? (() => {});

/** Último comando del panel activo (integración con la shell). */
const CommandStatus: React.FC<{ paneId: string }> = ({ paneId }) => {
  useSyncExternalStore(
    React.useMemo(() => subscribeTracker(paneId), [paneId]),
    () => terminalManager.getTracker(paneId)?.version ?? 0,
  );
  const record = terminalManager.getTracker(paneId)?.last();
  const running = record && record.endedAt === null;
  const now = useNow(running ? 1000 : 60_000);
  if (!record) return null;

  const name = record.command.split("\n")[0];
  const short = name.length > 32 ? `${name.slice(0, 31)}…` : name;
  // El reloj se refresca cada segundo: recién empezado un comando, "ahora" puede ser anterior al inicio.
  const duration = formatDuration(Math.max(0, (record.endedAt ?? now) - record.startedAt));
  const ok = record.exitCode === 0;
  return (
    <span
      title={`${name} · ${running ? "corriendo" : `código ${record.exitCode ?? "?"}`} · ${duration}`}
      className={cn("flex items-center gap-1.5", running ? "text-accent" : ok ? "text-ink-3" : "text-del")}
    >
      <span aria-hidden="true">{running ? "▪" : ok ? "✓" : "✗"}</span>
      {!running && !ok && <span>{record.exitCode}</span>}
      <span className="max-w-[220px] truncate text-ink-2">{short || "comando"}</span>
      <span>{duration}</span>
    </span>
  );
};
