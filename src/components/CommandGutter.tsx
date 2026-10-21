import React, { useEffect, useRef, useState } from "react";
import { Copy, CornerDownLeft, RotateCcw, Send, TextQuote } from "lucide-react";
import { terminalManager } from "../terminal/TerminalManager";
import type { CommandRecord } from "../terminal/commands";
import { actions } from "../lib/actions";
import { formatDuration } from "../lib/format";
import { cn } from "../lib/layout";
import { useUiStore } from "../store/uiStore";
import { useNow } from "../lib/useNow";
import { shortcutLabel } from "../lib/shortcuts";

interface Placed {
  record: CommandRecord;
  top: number;
  height: number;
}

/** Recalcula posiciones al desplazar, redimensionar o al aparecer comandos (1 vez por frame). */
function usePlacedCommands(paneId: string, hostRef: React.RefObject<HTMLDivElement | null>): Placed[] {
  const [placed, setPlaced] = useState<Placed[]>([]);

  useEffect(() => {
    const term = terminalManager.getTerminal(paneId);
    const tracker = terminalManager.getTracker(paneId);
    if (!term || !tracker) return;

    let frame = 0;
    const measure = () => {
      const screen = term.element?.querySelector<HTMLElement>(".xterm-screen");
      if (!screen || !term.rows) return;
      const host = hostRef.current?.parentElement;
      if (!host) return;
      const cell = screen.clientHeight / term.rows;
      // Medido en pantalla: incluye el padding del terminal sea quien sea el padre posicionado.
      const offset = screen.getBoundingClientRect().top - host.getBoundingClientRect().top;
      const viewportY = term.buffer.active.viewportY;
      const next: Placed[] = [];
      for (const record of tracker.records) {
        const row = tracker.anchorLine(record) - viewportY;
        if (row < 0 || row >= term.rows) continue;
        next.push({ record, top: offset + row * cell, height: cell });
      }
      setPlaced(next);
    };
    const schedule = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(measure);
    };
    const subs = [term.onScroll(schedule), term.onResize(schedule), term.onRender(schedule)];
    const unsubscribe = tracker.subscribe(schedule);
    schedule();
    return () => {
      cancelAnimationFrame(frame);
      subs.forEach((s) => s.dispose());
      unsubscribe();
    };
  }, [paneId, hostRef]);

  return placed;
}

function stateOf(record: CommandRecord): "running" | "ok" | "failed" {
  if (record.endedAt === null) return "running";
  return record.exitCode === 0 ? "ok" : "failed";
}

/** Marcas de comando en el margen izquierdo del terminal (integración con la shell). */
export const CommandGutter: React.FC<{ paneId: string }> = ({ paneId }) => {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const placed = usePlacedCommands(paneId, hostRef);
  const [openId, setOpenId] = useState<number | null>(null);
  const open = placed.find((p) => p.record.id === openId);

  return (
    <div ref={hostRef} className="pointer-events-none absolute inset-y-0 left-0 z-10 w-3">
      {placed.map(({ record, top, height }) => {
        const state = stateOf(record);
        return (
          <button
            key={record.id}
            type="button"
            aria-label={`Comando: ${record.command || "(sin texto)"}`}
            title={record.command}
            onClick={() => setOpenId(openId === record.id ? null : record.id)}
            style={{ top: top + (height - 7) / 2 }}
            className="pointer-events-auto absolute left-[3px] grid size-[7px] place-items-center"
          >
            <span
              className={cn(
                "size-[6px] rounded-[1px] transition-transform duration-150 hover:scale-150",
                state === "running" && "animate-pulse bg-accent",
                state === "ok" && "bg-add/70",
                state === "failed" && "bg-del",
              )}
            />
          </button>
        );
      })}
      {open && <CommandCard paneId={paneId} placed={open} onClose={() => setOpenId(null)} />}
    </div>
  );
};

const CommandCard: React.FC<{ paneId: string; placed: Placed; onClose: () => void }> = ({ paneId, placed, onClose }) => {
  const { record, top } = placed;
  const now = useNow(1000);
  const toast = useUiStore((s) => s.showToast);
  const state = stateOf(record);
  const duration = Math.max(0, (record.endedAt ?? now) - record.startedAt);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const copy = async (text: string, what: string) => {
    try {
      await navigator.clipboard.writeText(text);
      toast(`${what} copiado.`);
    } catch {
      toast("No se pudo copiar.", "error");
    }
    onClose();
  };
  const output = () => terminalManager.getTracker(paneId)?.output(record) ?? "";

  const items: Array<{ icon: typeof Copy; label: string; run: () => void; disabled?: boolean }> = [
    { icon: Copy, label: "Copiar comando", run: () => void copy(record.command, "Comando"), disabled: !record.command },
    { icon: TextQuote, label: "Copiar salida", run: () => void copy(output(), "Salida") },
    {
      icon: RotateCcw,
      label: "Repetir",
      run: () => {
        terminalManager.run(paneId, record.command);
        onClose();
      },
      disabled: !record.command || state === "running",
    },
    {
      icon: Send,
      label: "Enviar salida al agente",
      run: () => {
        actions.sendTextToAgent(`$ ${record.command}\n${output()}`);
        onClose();
      },
    },
  ];

  return (
    <div
      role="dialog"
      aria-label="Detalle del comando"
      style={{ top: Math.max(4, top - 8) }}
      className="pointer-events-auto absolute left-4 z-20 w-[320px] animate-pop-in overflow-hidden rounded-md border border-[var(--glass-border)] glass"
    >
      <div className="border-b border-line px-3 py-2">
        <p className="select-text break-all font-mono text-[12px] text-ink">{record.command || "(comando sin texto)"}</p>
        <p className="mt-1 flex flex-wrap gap-x-2 font-mono text-[11px] text-ink-3">
          <span className={cn(state === "ok" && "text-add", state === "failed" && "text-del", state === "running" && "text-accent")}>
            {state === "running" ? "corriendo" : state === "ok" ? "✓ código 0" : `✗ código ${record.exitCode ?? "?"}`}
          </span>
          <span>{formatDuration(duration)}</span>
          {record.cwd && <span className="truncate">{record.cwd}</span>}
        </p>
      </div>
      <ul className="p-1">
        {items.map(({ icon: Icon, label, run, disabled }) => (
          <li key={label}>
            <button
              type="button"
              disabled={disabled}
              onClick={run}
              className="flex h-7 w-full items-center gap-2 rounded px-2 text-left text-[12px] text-ink-2 hover:bg-hover hover:text-ink disabled:opacity-40"
            >
              <Icon size={13} strokeWidth={1.75} aria-hidden="true" className="text-ink-3" />
              {label}
            </button>
          </li>
        ))}
      </ul>
      <p className="flex items-center gap-1.5 border-t border-line px-3 py-1.5 text-[11px] text-ink-3">
        <CornerDownLeft size={11} aria-hidden="true" /> {shortcutLabel("prevCommand")} / {shortcutLabel("nextCommand")} salta entre comandos
      </p>
    </div>
  );
};
