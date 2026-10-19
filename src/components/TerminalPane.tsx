import React, { useEffect, useRef } from "react";
import { Columns2, Maximize2, Minimize2, Rows2, X } from "lucide-react";
import type { PaneNode } from "../types/layout";
import { terminalManager } from "../terminal/TerminalManager";
import { useTerminalStore } from "../store/terminalStore";
import { useUiStore } from "../store/uiStore";
import { actions } from "../lib/actions";
import { cn } from "../lib/layout";
import { formatUsd } from "../lib/format";
import { shortcutLabel } from "../lib/shortcuts";
import { FindBar } from "./FindBar";
import { CommandGutter } from "./CommandGutter";
import { useSettingsStore } from "../store/settingsStore";
import { AgentGlyph, IconButton, Lamp } from "./ui";

interface TerminalPaneProps {
  pane: PaneNode;
  isActive: boolean;
  /** Con un solo panel de shell no hay barra: todo el espacio es para el terminal. */
  isSplit: boolean;
  /** Mostrado maximizado dentro de su pestaña (⌘⇧↵). */
  isZoomed?: boolean;
}

export const TerminalPane: React.FC<TerminalPaneProps> = ({ pane, isActive, isSplit, isZoomed = false }) => {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const setActivePane = useTerminalStore((s) => s.setActivePane);
  const status = useTerminalStore((s) => s.agentStatus[pane.id]);
  const hasAttention = useTerminalStore((s) => pane.id in s.attention);
  const isFindOpen = useUiStore((s) => s.findPaneId === pane.id);
  const isDropTarget = useUiStore((s) => s.dropPaneId === pane.id);
  const dimInactive = useSettingsStore((s) => s.settings.dimInactivePanes);
  const toggleZoom = useTerminalStore((s) => s.toggleZoom);

  // El spawn solo usa cwd/command la primera vez: cambios posteriores no relanzan nada.
  const spawnSpec = useRef({ cwd: pane.cwd, command: pane.command });
  useEffect(() => {
    if (containerRef.current) terminalManager.attach(pane.id, containerRef.current, spawnSpec.current);
  }, [pane.id]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const observer = new ResizeObserver(() => terminalManager.fit(pane.id));
    observer.observe(container);
    return () => observer.disconnect();
  }, [pane.id]);

  const showHeader = isSplit || isZoomed || Boolean(pane.agentType);
  const dimmed = dimInactive && isSplit && !isActive;

  /** Los botones actúan sobre *este* panel, no sobre el que estaba activo. */
  const onThisPane = (action: () => unknown) => () => {
    setActivePane(pane.id, { focus: false });
    void action();
  };

  return (
    <section
      aria-label={`Terminal ${pane.title}`}
      data-pane-id={pane.id}
      // El foco del textarea de xterm (clic o teclado) marca el panel activo.
      onFocusCapture={() => {
        if (!isActive) setActivePane(pane.id, { focus: false });
      }}
      className="relative flex h-full w-full min-h-0 flex-col bg-canvas"
    >
      {showHeader && (
        <div
          onMouseDown={(e) => {
            if (!(e.target as HTMLElement).closest("button")) setActivePane(pane.id);
          }}
          className={cn(
            "group flex h-7 shrink-0 items-center gap-2 border-b border-line pl-3 pr-1 transition-colors duration-150",
            isActive ? "bg-chrome text-ink" : "bg-canvas text-ink-3",
          )}
        >
          <Lamp state={hasAttention ? "attention" : isActive ? "on" : "off"} />
          <AgentGlyph agentType={pane.agentType} className="shrink-0 opacity-80" />
          <span className="min-w-0 truncate font-mono text-[12px]">{pane.title}</span>

          {status && <AgentReadout model={status.model} context={status.contextPercent} cost={status.costUsd} />}
          {isZoomed && (
            <span className="shrink-0 rounded-sm border border-amber/40 px-1.5 font-mono text-[10.5px] leading-4 text-amber">
              maximizado
            </span>
          )}
          <span className="flex-1" />

          <div className="flex items-center opacity-0 transition-opacity duration-150 focus-within:opacity-100 group-hover:opacity-100">
            {(isSplit || isZoomed) && (
              <IconButton
                size="sm"
                icon={isZoomed ? Minimize2 : Maximize2}
                label={isZoomed ? "Restaurar" : "Maximizar panel"}
                shortcut={shortcutLabel("zoomPane")}
                onClick={() => toggleZoom(pane.id)}
              />
            )}
            <IconButton
              size="sm"
              icon={Columns2}
              label="Dividir a la derecha"
              shortcut={shortcutLabel("splitRight")}
              onClick={onThisPane(actions.splitRight)}
            />
            <IconButton
              size="sm"
              icon={Rows2}
              label="Dividir hacia abajo"
              shortcut={shortcutLabel("splitDown")}
              onClick={onThisPane(actions.splitDown)}
            />
            <IconButton
              size="sm"
              icon={X}
              tone="danger"
              label="Cerrar panel"
              shortcut={shortcutLabel("closePane")}
              onClick={() => actions.closePane(pane.id)}
            />
          </div>
        </div>
      )}

      <div className="relative min-h-0 w-full flex-1">
        <div
          ref={containerRef}
          className={cn(
            "absolute inset-0 overflow-hidden transition-opacity duration-150",
            dimmed && "opacity-55",
          )}
        />
        <CommandGutter paneId={pane.id} />
        {isFindOpen && <FindBar paneId={pane.id} />}
        {isDropTarget && (
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-1 grid place-items-center rounded-md border border-dashed border-amber/70 bg-amber/5"
          >
            <span className="rounded-md bg-raised px-3 py-1.5 text-[12px] text-ink-2 shadow-lg">
              Soltar para pegar la ruta
            </span>
          </div>
        )}
      </div>
    </section>
  );
};

/** `Opus · ctx 37% · $0.42`: lo que el statusLine de Claude reporta para este panel. */
const AgentReadout: React.FC<{ model: string | null; context: number | null; cost: number | null }> = ({
  model,
  context,
  cost,
}) => (
  <span className="flex shrink-0 items-center gap-1.5 font-mono text-[11px] tabular-nums text-ink-3">
    {model && <span>{model}</span>}
    {context !== null && (
      <>
        <span aria-hidden="true">·</span>
        <span
          title="Contexto usado"
          className={context >= 95 ? "text-signal" : context >= 80 ? "text-amber" : undefined}
        >
          ctx {Math.round(context)}%
        </span>
      </>
    )}
    {cost !== null && (
      <>
        <span aria-hidden="true">·</span>
        <span title="Costo de la sesión">{formatUsd(cost)}</span>
      </>
    )}
  </span>
);
