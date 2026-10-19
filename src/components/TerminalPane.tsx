import React, { useEffect, useRef } from "react";
import { Columns2, Rows2, X } from "lucide-react";
import type { PaneNode } from "../types/layout";
import { terminalManager } from "../terminal/TerminalManager";
import { useTerminalStore } from "../store/terminalStore";
import { cn } from "../lib/layout";
import { shortcutLabel } from "../lib/shortcuts";
import { IconButton, Lamp, agentIcon } from "./ui";

interface TerminalPaneProps {
  pane: PaneNode;
  isActive: boolean;
  /** Con un solo panel no hay barra: todo el espacio es para el terminal. */
  isSplit: boolean;
}

export const TerminalPane: React.FC<TerminalPaneProps> = ({ pane, isActive, isSplit }) => {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const splitPane = useTerminalStore((s) => s.splitPane);
  const closePane = useTerminalStore((s) => s.closePane);
  const setActivePane = useTerminalStore((s) => s.setActivePane);

  useEffect(() => {
    if (containerRef.current) {
      terminalManager.attach(pane.id, containerRef.current, {
        initialCommand: pane.initialCommand,
      });
    }
  }, [pane.id, pane.initialCommand]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const observer = new ResizeObserver(() => terminalManager.fit(pane.id));
    observer.observe(container);
    return () => observer.disconnect();
  }, [pane.id]);

  const AgentIcon = agentIcon(pane.agentType);
  const dimmed = isSplit && !isActive;

  return (
    <section
      aria-label={`Terminal ${pane.title}`}
      // El foco del textarea de xterm (clic o teclado) marca el panel activo.
      onFocusCapture={() => {
        if (!isActive) setActivePane(pane.id, { focus: false });
      }}
      className="flex h-full w-full min-h-0 flex-col bg-canvas"
    >
      {isSplit && (
        <div
          onMouseDown={(e) => {
            if (!(e.target as HTMLElement).closest("button")) setActivePane(pane.id);
          }}
          className={cn(
            "group flex h-7 shrink-0 items-center gap-2 border-b border-line pl-3 pr-1 transition-colors duration-150",
            isActive ? "bg-chrome text-ink" : "bg-canvas text-ink-3",
          )}
        >
          <Lamp state={isActive ? "on" : "off"} />
          <AgentIcon size={13} strokeWidth={1.75} aria-hidden="true" className="shrink-0 opacity-80" />
          <span className="min-w-0 flex-1 truncate font-mono text-[12px]">{pane.title}</span>

          <div className="flex items-center opacity-0 transition-opacity duration-150 focus-within:opacity-100 group-hover:opacity-100">
            <IconButton
              size="sm"
              icon={Columns2}
              label="Dividir a la derecha"
              shortcut={shortcutLabel("splitRight")}
              onClick={() => splitPane(pane.id, "horizontal")}
            />
            <IconButton
              size="sm"
              icon={Rows2}
              label="Dividir hacia abajo"
              shortcut={shortcutLabel("splitDown")}
              onClick={() => splitPane(pane.id, "vertical")}
            />
            <IconButton
              size="sm"
              icon={X}
              tone="danger"
              label="Cerrar panel"
              shortcut={shortcutLabel("closePane")}
              onClick={() => closePane(pane.id)}
            />
          </div>
        </div>
      )}

      <div
        ref={containerRef}
        className={cn(
          "relative min-h-0 w-full flex-1 overflow-hidden transition-opacity duration-150",
          dimmed && "opacity-55",
        )}
      />
    </section>
  );
};
