import React, { useSyncExternalStore } from "react";
import { Radio } from "lucide-react";
import { useTerminalStore } from "../store/terminalStore";
import { terminalManager } from "../terminal/TerminalManager";
import { actions } from "../lib/actions";
import { cn, collectPanes } from "../lib/layout";
import { formatDuration } from "../lib/format";
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

  const size = useSyncExternalStore(terminalManager.subscribeSize, () =>
    terminalManager.getSize(activePane?.id),
  );

  return (
    <footer className="flex h-6 shrink-0 items-center justify-between gap-4 border-t border-line bg-chrome px-3 font-mono text-[11px] text-ink-3">
      <div className="flex min-w-0 items-center gap-3">
        {isBroadcastEnabled && (
          <button
            type="button"
            onClick={actions.toggleBroadcast}
            title={`Desactivar broadcast  ${shortcutLabel("toggleBroadcast")}`}
            className="flex h-[18px] shrink-0 items-center gap-1.5 rounded-sm bg-signal px-1.5 font-semibold uppercase tracking-[0.06em] text-on-amber"
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
        {size && <span title="Columnas × filas">{size}</span>}
        <span>
          pestaña {tabIndex + 1}/{tabs.length}
        </span>
      </div>
    </footer>
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
      className={cn("flex items-center gap-1.5", running ? "text-amber" : ok ? "text-ink-3" : "text-del")}
    >
      <span aria-hidden="true">{running ? "▪" : ok ? "✓" : "✗"}</span>
      {!running && !ok && <span>{record.exitCode}</span>}
      <span className="max-w-[220px] truncate text-ink-2">{short || "comando"}</span>
      <span>{duration}</span>
    </span>
  );
};
