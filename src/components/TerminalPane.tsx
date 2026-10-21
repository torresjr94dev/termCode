import React, { useEffect, useRef } from "react";
import { Columns2, History, Maximize2, Minimize2, Rows2, X } from "lucide-react";
import type { PaneNode, ResumableAgent } from "../types/layout";
import { terminalManager } from "../terminal/TerminalManager";
import { useTerminalStore } from "../store/terminalStore";
import { useUiStore } from "../store/uiStore";
import { actions, AGENTS } from "../lib/actions";
import { cn } from "../lib/layout";
import { formatAgo, formatUsd } from "../lib/format";
import { useNow } from "../lib/useNow";
import { cleanTitle } from "../lib/identity";
import { shortcutLabel } from "../lib/shortcuts";
import { FindBar } from "./FindBar";
import { CommandGutter } from "./CommandGutter";
import { useSettingsStore } from "../store/settingsStore";
import { AgentGlyph, IconButton, Lamp, Ring } from "./ui";

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
  const spawnSpec = useRef({ cwd: pane.cwd, command: pane.command, welcome: pane.welcome });
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
      // Cada panel es una tarjeta sobre el vidrio; con divisiones, el activo lleva un anillo de acento.
      className={cn(
        "relative flex h-full w-full min-h-0 flex-col overflow-hidden rounded-xl border bg-canvas transition-[border-color,box-shadow] duration-200",
        isSplit && isActive
          ? "border-accent/35 shadow-[0_0_0_3px_color-mix(in_oklab,var(--color-accent)_12%,transparent)]"
          : "border-line",
      )}
    >
      {showHeader && (
        <div
          onMouseDown={(e) => {
            if (!(e.target as HTMLElement).closest("button")) setActivePane(pane.id);
          }}
          className={cn(
            "group flex h-8 shrink-0 items-center gap-2 border-b border-line pl-3 pr-1.5 transition-colors duration-150",
            isActive ? "text-ink" : "text-ink-3",
          )}
        >
          <Lamp state={hasAttention ? "attention" : isActive ? "on" : "off"} />
          <AgentGlyph agentType={pane.agentType} className="shrink-0 opacity-80" />
          <span className="min-w-0 truncate text-[12.5px] font-medium">{cleanTitle(pane.title)}</span>

          {status && <AgentReadout model={status.model} context={status.contextPercent} cost={status.costUsd} />}
          {isZoomed && (
            <span className="shrink-0 rounded-full border border-accent/40 px-2 font-mono text-[10.5px] leading-[18px] text-accent">
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

      {pane.resumable && <ResumeBanner paneId={pane.id} resumable={pane.resumable} />}

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
            className="pointer-events-none absolute inset-1 grid place-items-center rounded-md border border-dashed border-accent/70 bg-accent/5"
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

/** Aquí había un agente antes de reiniciar: se retoma con un clic, nunca solo (gastaría cuota). */
const ResumeBanner: React.FC<{ paneId: string; resumable: ResumableAgent }> = ({ paneId, resumable }) => {
  const dismiss = useTerminalStore((s) => s.dismissResumable);
  const now = useNow(60_000);
  const { agent, sessionId, prompt, at } = resumable;
  const label =
    agent === "claude" ? (sessionId ? "Reanudar conversación" : "Abrir de nuevo") : sessionId ? "Reanudar sesión" : "Reanudar la última de esta carpeta";

  return (
    <div
      role="status"
      className="flex shrink-0 items-center gap-2.5 border-b border-accent/30 bg-accent/[0.06] py-1.5 pl-3 pr-1.5 text-[12px]"
    >
      <AgentGlyph agentType={agent} className="shrink-0 text-accent" />
      <span className="flex min-w-0 flex-1 items-baseline gap-2">
        <span className="shrink-0 text-ink-2">
          Aquí había <span className="text-ink">{AGENTS[agent].title}</span>
        </span>
        {prompt && (
          <span className="min-w-0 truncate font-mono text-[11.5px] text-ink-3" title={prompt}>
            «{prompt}»
          </span>
        )}
        {at && <span className="shrink-0 font-mono text-[11px] text-ink-3">{formatAgo(at, now)}</span>}
      </span>
      <button
        type="button"
        onClick={() => void actions.resumeAgent(paneId)}
        className="flex h-6 shrink-0 items-center gap-1.5 rounded-md bg-accent px-2 font-medium text-on-accent transition-opacity duration-150 hover:opacity-90"
      >
        <History size={12} strokeWidth={2} aria-hidden="true" />
        {label}
      </button>
      <IconButton size="sm" icon={X} label="Descartar aviso" onClick={() => dismiss(paneId)} />
    </div>
  );
};

/** Lo que el statusLine de Claude reporta para este panel: modelo, contexto (anillo) y costo. */
const AgentReadout: React.FC<{ model: string | null; context: number | null; cost: number | null }> = ({
  model,
  context,
  cost,
}) => (
  <span className="flex min-w-0 shrink items-center gap-1.5 font-mono text-[11px] tabular-nums text-ink-3">
    {model && <span className="min-w-0 truncate rounded-full bg-hover px-2 leading-[18px] text-ink-2">{model}</span>}
    {context !== null && (
      <span title={`Contexto usado: ${Math.round(context)} %`} className="flex shrink-0 items-center gap-1 rounded-full bg-hover pl-1 pr-2 leading-[18px]">
        <Ring value={context} size={13} stroke={2} />
        <span className={context >= 90 ? "text-signal" : context >= 75 ? "text-warn" : undefined}>{Math.round(context)}%</span>
      </span>
    )}
    {cost !== null && (
      <span title="Costo de la sesión" className="shrink-0 rounded-full bg-hover px-2 leading-[18px]">
        {formatUsd(cost)}
      </span>
    )}
  </span>
);
