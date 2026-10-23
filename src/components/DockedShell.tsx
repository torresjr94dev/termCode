import React, { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { ChevronDown, ChevronUp, SquareTerminal, X } from "lucide-react";
import { useTerminalStore } from "../store/terminalStore";
import { terminalManager } from "../terminal/TerminalManager";
import { useRunningCommand } from "../terminal/useRunningCommand";
import { cn } from "../lib/layout";
import { tildify } from "../lib/paths";
import { shortcutLabel } from "../lib/shortcuts";
import { shortCommand } from "../lib/identity";
import type { PaneDrawer, PaneNode } from "../types/layout";
import { IconButton } from "./ui";
import { PortChips } from "./PortChips";
import { ShellStartup, useWatchedShell } from "./ShellStartup";

/** Carpeta en vivo de la shell acoplada (OSC 7), con re-render al cambiar. */
function useShellCwd(id: string): string | null {
  const subscribe = React.useCallback(
    (listener: () => void) => terminalManager.getTracker(id)?.subscribe(listener) ?? (() => {}),
    [id],
  );
  return useSyncExternalStore(subscribe, () => terminalManager.knownCwd(id));
}

/**
 * Una shell acoplada abajo del agente, en su carpeta: correr tests o ver git
 * sin dividir el panel ni perder de vista al agente. Plegada queda una barra
 * (la shell sigue viva); cerrarla termina su proceso.
 */
export const DockedShell: React.FC<{
  pane: PaneNode;
  drawer: PaneDrawer;
  /** Columna del panel: la altura se mide contra ella al arrastrar. */
  hostRef: React.RefObject<HTMLDivElement | null>;
}> = ({ pane, drawer, hostRef }) => {
  const termRef = useRef<HTMLDivElement | null>(null);
  const project = useTerminalStore((s) => s.paneProject[pane.id]);
  const toggleDrawer = useTerminalStore((s) => s.toggleDrawer);
  const closeDrawer = useTerminalStore((s) => s.closeDrawer);
  const setDrawerRatio = useTerminalStore((s) => s.setDrawerRatio);
  const [dragging, setDragging] = useState(false);
  const liveCwd = useShellCwd(drawer.id);
  const running = useRunningCommand(drawer.id);
  // Arranca donde está el agente; después manda lo que diga la shell (cd).
  const [startCwd] = useState(() => project?.cwd ?? pane.cwd);
  const cwd = liveCwd ?? startCwd;
  const watchedShell = useWatchedShell({});

  useEffect(() => {
    const node = termRef.current;
    if (!drawer.open || !node) return;
    terminalManager.attach(drawer.id, node, { cwd: startCwd, welcome: false });
    const observer = new ResizeObserver(() => terminalManager.fit(drawer.id));
    observer.observe(node);
    return () => observer.disconnect();
  }, [drawer.id, drawer.open, startCwd]);

  const startDrag = (e: React.PointerEvent<HTMLDivElement>) => {
    const host = hostRef.current;
    if (e.button !== 0 || !host) return;
    e.preventDefault();
    const handle = e.currentTarget;
    const rect = host.getBoundingClientRect();
    handle.setPointerCapture(e.pointerId);
    setDragging(true);
    let frame = 0;
    const onMove = (ev: PointerEvent) => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => setDrawerRatio(pane.id, (rect.bottom - ev.clientY) / rect.height));
    };
    const onEnd = () => {
      cancelAnimationFrame(frame);
      setDragging(false);
      handle.removeEventListener("pointermove", onMove);
      handle.removeEventListener("pointerup", onEnd);
      handle.removeEventListener("pointercancel", onEnd);
    };
    handle.addEventListener("pointermove", onMove);
    handle.addEventListener("pointerup", onEnd);
    handle.addEventListener("pointercancel", onEnd);
  };

  const header = (
    <div className="flex h-7 shrink-0 items-center gap-2 pl-3 pr-1">
      <SquareTerminal size={12.5} strokeWidth={1.9} aria-hidden="true" className="shrink-0 text-ink-3" />
      <span className="shrink-0 text-[12px] font-medium text-ink-2">Terminal</span>
      {cwd && (
        <span title={cwd} className="min-w-0 shrink truncate font-mono text-[11px] text-ink-3">
          {tildify(cwd, terminalManager.getHome())}
        </span>
      )}
      {running && <span className="min-w-0 shrink-[2] truncate font-mono text-[11px] text-accent">▸ {shortCommand(running, 3)}</span>}
      <PortChips paneId={drawer.id} max={2} />
      <span className="flex-1" />
      <IconButton
        icon={drawer.open ? ChevronDown : ChevronUp}
        label={drawer.open ? "Plegar la terminal" : "Mostrar la terminal"}
        shortcut={shortcutLabel("agentShell")}
        size="sm"
        onClick={() => {
          toggleDrawer(pane.id);
          // Plegada, el teclado vuelve al agente; desplegada, a la shell.
          requestAnimationFrame(() => terminalManager.focus(drawer.open ? pane.id : drawer.id));
        }}
      />
      <IconButton
        icon={X}
        tone="danger"
        label="Cerrar la terminal (termina su proceso)"
        size="sm"
        onClick={() => {
          closeDrawer(pane.id);
          terminalManager.focus(pane.id);
        }}
      />
    </div>
  );

  if (!drawer.open) {
    return (
      <div data-drawer className="shrink-0 border-t border-line bg-chrome/60">
        {header}
      </div>
    );
  }

  return (
    <>
      <div
        role="separator"
        tabIndex={0}
        aria-label="Redimensionar la terminal acoplada"
        aria-orientation="horizontal"
        aria-valuemin={15}
        aria-valuemax={75}
        aria-valuenow={Math.round(drawer.ratio * 100)}
        data-dragging={dragging || undefined}
        onPointerDown={startDrag}
        onKeyDown={(e) => {
          if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
          e.preventDefault();
          setDrawerRatio(pane.id, drawer.ratio + (e.key === "ArrowUp" ? 0.05 : -0.05));
        }}
        // Encima del borde, sin abrir un hueco dentro del panel.
        className="divider z-10 -my-1"
      />
      <section
        data-drawer
        aria-label="Terminal acoplada"
        className={cn("flex min-h-0 flex-col border-t border-line bg-canvas", dragging && "select-none")}
        style={{ flex: `${drawer.ratio} 1 0px` }}
      >
        <div className="bg-chrome/60">{header}</div>
        <div className="relative min-h-0 flex-1">
          <div ref={termRef} className="absolute inset-0 overflow-hidden" />
          {watchedShell && <ShellStartup id={drawer.id} shellName={watchedShell} />}
        </div>
      </section>
    </>
  );
};
