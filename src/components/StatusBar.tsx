import React, { useSyncExternalStore } from "react";
import { Radio } from "lucide-react";
import { useTerminalStore } from "../store/terminalStore";
import { terminalManager } from "../terminal/TerminalManager";
import { actions } from "../lib/actions";
import { collectPanes } from "../lib/layout";
import { shortcutLabel } from "../lib/shortcuts";
import { Lamp } from "./ui";

/** Solo datos reales. Nada de latencias ni RAM inventadas. */
export const StatusBar: React.FC = () => {
  const tabs = useTerminalStore((s) => s.tabs);
  const activeTabId = useTerminalStore((s) => s.activeTabId);
  const isBroadcastEnabled = useTerminalStore((s) => s.isBroadcastEnabled);

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
            <span className="truncate text-ink-2">{activePane.title}</span>
            {panes.length > 1 && (
              <span className="shrink-0 tabular-nums">
                panel {paneIndex + 1}/{panes.length}
              </span>
            )}
          </span>
        )}
      </div>

      <div className="flex shrink-0 items-center gap-3 tabular-nums">
        {size && <span title="Columnas × filas">{size}</span>}
        <span>
          pestaña {tabIndex + 1}/{tabs.length}
        </span>
      </div>
    </footer>
  );
};
