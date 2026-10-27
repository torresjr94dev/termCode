import React, { useEffect, useMemo, useRef, useState } from "react";
import { Search, X } from "lucide-react";
import { useTerminalStore } from "../store/terminalStore";
import { useUiStore } from "../store/uiStore";
import { terminalManager } from "../terminal/TerminalManager";
import { actions } from "../lib/actions";
import { cn, collectPanes } from "../lib/layout";
import { paneDisplayName, projectTone, tabDisplayName } from "../lib/identity";
import { formatDuration } from "../lib/format";
import { agentStateOf, paneAgent, type AgentState } from "../lib/attention";
import { useNow } from "../lib/useNow";
import { shortcutLabel } from "../lib/shortcuts";
import { useTrafficLights } from "../lib/fullscreen";
import type { AgentKind, PaneNode, Tab } from "../types/layout";
import { AgentGlyph, IconButton, Lamp } from "./ui";

const SNAPSHOT_ROWS = 9;

export const Overview: React.FC<{ onClosed: () => void }> = ({ onClosed }) => {
  const isOpen = useUiStore((s) => s.isOverviewOpen);
  if (!isOpen) return null;
  return <OverviewPanel onClosed={onClosed} />;
};

interface Entry {
  pane: PaneNode;
  tab: Tab;
  tabIndex: number;
  name: string;
  project: string | null;
  tone: string | null;
  cwd: string | null;
}

const OverviewPanel: React.FC<{ onClosed: () => void }> = ({ onClosed }) => {
  const tabs = useTerminalStore((s) => s.tabs);
  const activeTabId = useTerminalStore((s) => s.activeTabId);
  const paneProject = useTerminalStore((s) => s.paneProject);
  const attention = useTerminalStore((s) => s.attention);
  const agentActivity = useTerminalStore((s) => s.agentActivity);
  const setOpen = useUiStore((s) => s.setOverviewOpen);
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState<number | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const gridRef = useRef<HTMLDivElement | null>(null);
  // Miniaturas vivas: se releen cada segundo mientras la vista está abierta.
  const now = useNow(1000);
  const lightsGap = useTrafficLights();

  const entries = useMemo<Entry[]>(
    () =>
      tabs.flatMap((tab, tabIndex) =>
        collectPanes(tab.root).map((pane) => {
          const project = paneProject[pane.id];
          return {
            pane,
            tab,
            tabIndex,
            name: paneDisplayName(pane, project),
            project: project?.name ?? null,
            tone: project ? projectTone(project.root ?? project.cwd) : null,
            cwd: project?.cwd ?? pane.cwd ?? null,
          };
        }),
      ),
    [tabs, paneProject],
  );

  const q = query.trim().toLowerCase();
  const visible = q
    ? entries.filter((e) =>
        [e.name, e.project, e.cwd, tabDisplayName(e.tab, paneProject)].some((v) => v?.toLowerCase().includes(q)),
      )
    : entries;

  const activeIndex = visible.findIndex((e) => e.tab.id === activeTabId && e.pane.id === e.tab.activePaneId);
  const selected = Math.min(cursor ?? Math.max(activeIndex, 0), Math.max(visible.length - 1, 0));

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    gridRef.current?.querySelector(`[data-index="${selected}"]`)?.scrollIntoView({ block: "nearest" });
  }, [selected]);

  const close = () => {
    setOpen(false);
    onClosed();
  };

  const go = (entry: Entry) => {
    setOpen(false);
    actions.focusPane(entry.tab.id, entry.pane.id);
  };

  /** Columnas reales de la cuadrícula (cambian con el ancho de la ventana). */
  const columns = () => {
    const template = gridRef.current ? getComputedStyle(gridRef.current).gridTemplateColumns : "";
    return Math.max(1, template.split(" ").filter(Boolean).length);
  };

  const move = (delta: number) => setCursor(Math.max(0, Math.min(visible.length - 1, selected + delta)));

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Todos los paneles"
      className="fixed inset-0 z-40 flex animate-fade-in flex-col bg-canvas backdrop-blur-2xl"
    >
      <div data-tauri-drag-region className={cn("flex h-12 shrink-0 items-center gap-3 border-b border-line pr-5", lightsGap ? "pl-[88px]" : "pl-5")}>
        <h2 className="text-[15px] font-semibold text-ink">Paneles</h2>
        <span className="font-mono text-[12px] text-ink-3">
          {entries.length} en {tabs.length} pestaña{tabs.length === 1 ? "" : "s"}
        </span>
        <label className="ml-4 flex h-8 min-w-0 max-w-[360px] flex-1 items-center gap-2 rounded-md border border-line bg-raised px-2.5 focus-within:border-line-strong">
          <Search size={13} strokeWidth={1.75} aria-hidden="true" className="shrink-0 text-ink-3" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setCursor(0);
            }}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.preventDefault();
                close();
              } else if (e.key === "Enter" && visible[selected]) {
                e.preventDefault();
                go(visible[selected]);
              } else if (e.key === "ArrowRight") {
                e.preventDefault();
                move(1);
              } else if (e.key === "ArrowLeft") {
                e.preventDefault();
                move(-1);
              } else if (e.key === "ArrowDown") {
                e.preventDefault();
                move(columns());
              } else if (e.key === "ArrowUp") {
                e.preventDefault();
                move(-columns());
              }
            }}
            aria-label="Filtrar paneles"
            placeholder="Filtrar por nombre, proyecto o carpeta"
            spellCheck={false}
            className="h-full min-w-0 flex-1 bg-transparent text-[12.5px] text-ink outline-none placeholder:text-ink-3"
          />
        </label>
        <span className="flex-1" />
        <span className="hidden font-mono text-[11px] text-ink-3 md:inline">flechas · ↵ ir</span>
        <IconButton icon={X} label="Cerrar" shortcut={`esc · ${shortcutLabel("overview")}`} onClick={close} />
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
        {!visible.length && <p className="mt-16 text-center text-[13px] text-ink-3">Ningún panel coincide con «{query}».</p>}
        <div ref={gridRef} role="listbox" aria-label="Paneles" className="grid grid-cols-[repeat(auto-fill,minmax(300px,1fr))] gap-3">
          {visible.map((entry, i) => (
            <PaneCard
              key={entry.pane.id}
              entry={entry}
              index={i}
              selected={i === selected}
              current={entry.tab.id === activeTabId && entry.pane.id === entry.tab.activePaneId}
              attention={entry.pane.id in attention}
              agent={paneAgent(entry.pane, agentActivity[entry.pane.id])}
              agentState={agentStateOf(agentActivity[entry.pane.id], attention[entry.pane.id])}
              now={now}
              onHover={() => i !== selected && setCursor(i)}
              onGo={() => go(entry)}
            />
          ))}
        </div>
      </div>
    </div>
  );
};

const PaneCard: React.FC<{
  entry: Entry;
  index: number;
  selected: boolean;
  current: boolean;
  attention: boolean;
  agent: AgentKind | null;
  agentState: AgentState;
  now: number;
  onHover: () => void;
  onGo: () => void;
}> = ({ entry, index, selected, current, attention, agent, agentState, now, onHover, onGo }) => {
  const lines = terminalManager.snapshot(entry.pane.id, SNAPSHOT_ROWS);
  const last = terminalManager.getTracker(entry.pane.id)?.last();
  const running = last && last.endedAt === null;
  const command = last?.command.split("\n")[0];

  return (
    <button
      type="button"
      role="option"
      aria-selected={selected}
      data-index={index}
      onMouseMove={onHover}
      onClick={onGo}
      className={cn(
        "flex flex-col overflow-hidden rounded-lg border bg-raised text-left transition-colors duration-150",
        selected ? "border-accent/70" : attention ? "border-accent/40" : "border-line hover:border-line-strong",
      )}
    >
      <span className="flex w-full items-center gap-2 border-b border-line px-3 py-2">
        <span className={cn("font-mono text-[11px] tabular-nums", current ? "text-accent" : "text-ink-3")}>{entry.tabIndex + 1}</span>
        <AgentGlyph agentType={agent} className="shrink-0 text-ink-3" />
        <span className="min-w-0 flex-1 truncate font-mono text-[12.5px] text-ink">{entry.name}</span>
        {attention ? (
          <Lamp state="attention" />
        ) : agentState === "working" || running ? (
          <Lamp state="on" />
        ) : null}
      </span>
      <span className="flex w-full items-center gap-2 px-3 pt-1.5 font-mono text-[11px] text-ink-3">
        {entry.tone && <span aria-hidden="true" className={cn("size-1.5 shrink-0 rounded-full", entry.tone)} />}
        <span className="min-w-0 truncate" title={entry.cwd ?? undefined}>
          {entry.project ?? "—"}
        </span>
        {command && (
          <span
            className={cn(
              "ml-auto flex min-w-0 shrink items-center gap-1",
              running ? "text-accent" : last?.exitCode === 0 ? "text-ink-3" : "text-del",
            )}
          >
            <span aria-hidden="true">{running ? "▪" : last?.exitCode === 0 ? "✓" : "✗"}</span>
            <span className="truncate">{command}</span>
            {running && <span className="shrink-0">{formatDuration(Math.max(0, now - last.startedAt))}</span>}
          </span>
        )}
      </span>
      <pre
        aria-hidden="true"
        className="mx-3 mb-3 mt-2 h-[138px] w-[calc(100%-1.5rem)] overflow-hidden rounded-md border border-line bg-canvas px-2 py-1.5 font-mono text-[10.5px] leading-[15px] text-ink-2"
      >
        {lines.join("\n")}
      </pre>
    </button>
  );
};
