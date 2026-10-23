import React from "react";
import { ArrowUpRight } from "lucide-react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useTerminalStore } from "../store/terminalStore";
import { useUiStore } from "../store/uiStore";
import { IS_TAURI } from "../lib/ipc";
import { cn } from "../lib/layout";

const NO_PORTS: number[] = [];

/** Abre `http://localhost:<puerto>` en tu navegador. */
export function openPort(port: number) {
  const url = `http://localhost:${port}`;
  if (!IS_TAURI) {
    window.open(url, "_blank", "noopener,noreferrer");
    return;
  }
  openUrl(url).catch(() => useUiStore.getState().showToast(`No se pudo abrir ${url}.`, "error"));
}

/**
 * Los puertos en escucha de un panel (lo que levantó: `npm run dev`, un
 * servidor de Python…), cada uno abre su página con un clic. Sin puertos, nada.
 */
export const PortChips: React.FC<{
  paneId: string;
  max?: number;
  className?: string;
  /** Dentro de un `@container`: solo aparece con espacio (≥ @sm). */
  responsive?: boolean;
}> = ({ paneId, max = 3, className, responsive }) => {
  const ports = useTerminalStore((s) => s.panePorts[paneId] ?? NO_PORTS);
  if (!ports.length) return null;
  const shown = ports.slice(0, max);
  return (
    <span className={cn("min-w-0 items-center gap-1", responsive ? "hidden @sm:flex" : "flex", className)}>
      {shown.map((port) => (
        <button
          key={port}
          type="button"
          onClick={(e) => {
            // Dentro de una fila clicable (la sesión de la barra lateral): solo el puerto.
            e.stopPropagation();
            openPort(port);
          }}
          title={`Abrir http://localhost:${port}`}
          className="flex h-[18px] shrink-0 items-center gap-0.5 rounded-full border border-accent/35 px-1.5 font-mono text-[10.5px] tabular-nums text-accent transition-colors duration-150 hover:bg-accent/10 focus-visible:outline-2 focus-visible:outline-accent"
        >
          :{port}
          <ArrowUpRight size={10} strokeWidth={2.25} aria-hidden="true" />
        </button>
      ))}
      {ports.length > shown.length && (
        <span title={ports.slice(max).map((p) => `:${p}`).join(" ")} className="font-mono text-[10.5px] text-ink-3">
          +{ports.length - shown.length}
        </span>
      )}
    </span>
  );
};
