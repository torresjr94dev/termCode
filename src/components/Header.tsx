import React, { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Asterisk, GitBranch, Hexagon, Maximize2, PanelLeft, Plus, Search, X } from "lucide-react";
import { useTerminalStore } from "../store/terminalStore";
import { useProjectStore } from "../store/projectStore";
import { openProject } from "../lib/project";
import { actions } from "../lib/actions";
import { cn, collectPanes, findPane } from "../lib/layout";
import { projectTone, shortCommand, tabDisplayName } from "../lib/identity";
import { useRunningCommand } from "../terminal/useRunningCommand";
import { IS_MAC, shortcutLabel, tabShortcutLabel } from "../lib/shortcuts";
import type { ProviderUsage, Tab } from "../types/layout";
import { terminalManager } from "../terminal/TerminalManager";
import { AgentGlyph, IconButton, Kbd, Lamp } from "./ui";

interface HeaderProps {
  onOpenPalette: () => void;
}

export const Header: React.FC<HeaderProps> = ({ onOpenPalette }) => {
  const tabs = useTerminalStore((s) => s.tabs);
  const activeTabId = useTerminalStore((s) => s.activeTabId);
  const isSidebarOpen = useTerminalStore((s) => s.isSidebarOpen);
  const setActiveTab = useTerminalStore((s) => s.setActiveTab);
  const attention = useTerminalStore((s) => s.attention);
  const moveTab = useTerminalStore((s) => s.moveTab);
  const listRef = useRef<HTMLUListElement | null>(null);
  const [drag, setDrag] = useState<{ from: number; to: number; dragging: boolean } | null>(null);

  /** Arrastrar una pestaña la reordena (umbral de 5 px para no robar clics). */
  const startDrag = (from: number, e: React.PointerEvent) => {
    if (e.button !== 0) return;
    const startX = e.clientX;
    let state = { from, to: from, dragging: false };
    setDrag(state);
    const onMove = (ev: PointerEvent) => {
      if (!state.dragging && Math.abs(ev.clientX - startX) < 5) return;
      const items = [...(listRef.current?.querySelectorAll<HTMLElement>("li[data-index]") ?? [])];
      const to = items.findIndex((el) => {
        const r = el.getBoundingClientRect();
        return ev.clientX < r.left + r.width / 2;
      });
      state = { from, to: to === -1 ? items.length - 1 : to > from ? to - 1 : to, dragging: true };
      setDrag(state);
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      if (state.dragging && state.to !== state.from) moveTab(state.from, state.to);
      setDrag(null);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  const canClose = tabs.length > 1;

  return (
    <header
      data-tauri-drag-region
      className="relative z-20 flex h-10 shrink-0 items-stretch bg-chrome pr-2 after:absolute after:inset-x-0 after:bottom-0 after:h-px after:bg-line"
    >
      {/* Hueco para los semáforos de macOS (solo cuando la barra lateral no los aloja) */}
      {IS_MAC && !isSidebarOpen && <div data-tauri-drag-region className="w-[84px] shrink-0" />}

      <div className={cn("flex items-center", !(IS_MAC && !isSidebarOpen) && "pl-2")}>
        <IconButton
          icon={PanelLeft}
          label={isSidebarOpen ? "Ocultar sesiones" : "Mostrar sesiones"}
          shortcut={shortcutLabel("toggleSidebar")}
          pressed={isSidebarOpen}
          onClick={actions.toggleSidebar}
        />
      </div>

      <nav aria-label="Pestañas" className="ml-2 flex min-w-0 items-end">
        <ul ref={listRef} data-tauri-drag-region className="scrollbar-none flex min-w-0 items-end gap-0.5 overflow-x-auto">
          {tabs.map((tab, index) => (
            <TabItem
              key={tab.id}
              tab={tab}
              index={index}
              isActive={tab.id === activeTabId}
              canClose={canClose}
              needsAttention={collectPanes(tab.root).some((p) => p.id in attention)}
              dropMarker={drag?.dragging && drag.to === index ? (drag.to > drag.from ? "after" : drag.to < drag.from ? "before" : null) : null}
              isDragged={Boolean(drag?.dragging && drag.from === index)}
              onPointerDownTab={(e) => startDrag(index, e)}
              onSelect={() => setActiveTab(tab.id)}
            />
          ))}
        </ul>

        <div className="flex h-[31px] items-center pl-1">
          <IconButton icon={Plus} label="Nueva pestaña" shortcut={shortcutLabel("newTab")} onClick={actions.newTab} />
        </div>
      </nav>

      <div data-tauri-drag-region className="min-w-4 flex-1" />

      <div className="flex items-center gap-1.5">
        <BranchButton />
        <UsageButton />
        <button
          type="button"
          onClick={onOpenPalette}
          title={`Comandos  ${shortcutLabel("palette")}`}
          className="flex h-7 items-center gap-2 rounded-md border border-line px-2.5 text-ink-2 transition-colors duration-150 hover:border-line-strong hover:bg-hover hover:text-ink"
        >
          <Search size={13} strokeWidth={1.75} aria-hidden="true" />
          <span className="hidden text-[12px] md:inline">Comandos</span>
          <Kbd>{shortcutLabel("palette")}</Kbd>
        </button>
      </div>
    </header>
  );
};

/** Lectura principal de un proveedor para el botón: la ventana de sesión. */
function headline(provider: ProviderUsage): { text: string; critical: boolean; spoken: string } {
  if (provider.authMode === "api-key") return { text: "API", critical: false, spoken: "API key" };
  const session = provider.windows.find((w) => w.kind === "session") ?? provider.windows[0];
  if (!session) {
    const text = provider.status === "loading" ? "…" : "—";
    return { text, critical: false, spoken: provider.status === "loading" ? "cargando" : "sin datos" };
  }
  const pct = Math.round(session.usedPercent);
  return { text: `${pct}%`, critical: pct >= 85, spoken: `${pct}%` };
}

const UsageButton: React.FC = () => {
  const usage = useTerminalStore((s) => s.usage);
  const isOpen = useTerminalStore((s) => s.isUsageDrawerOpen);

  const readings = [
    { icon: Asterisk, name: "Claude", ...headline(usage.claude) },
    { icon: Hexagon, name: "Codex", ...headline(usage.codex) },
  ];

  return (
    <button
      type="button"
      onClick={actions.toggleUsage}
      aria-expanded={isOpen}
      aria-haspopup="dialog"
      aria-label={`Cuotas de IA: ${readings.map((r) => `${r.name} ${r.spoken}`).join(", ")}`}
      title={`Cuotas de IA  ${shortcutLabel("toggleUsage")}`}
      className={cn(
        "flex h-7 items-center gap-3 rounded-md border px-2.5 font-mono text-[12px] tabular-nums transition-colors duration-150",
        isOpen
          ? "border-line-strong bg-press text-ink"
          : "border-line text-ink-2 hover:border-line-strong hover:bg-hover hover:text-ink",
      )}
    >
      {readings.map(({ icon: Icon, name, text, critical }) => (
        <span key={name} className="flex items-center gap-1.5">
          <Icon size={13} strokeWidth={1.75} aria-hidden="true" className="text-ink-3" />
          <span className={critical ? "text-signal" : undefined}>{text}</span>
        </span>
      ))}
    </button>
  );
};

/** Rama del repo donde está el panel activo; abre la vista de cambios. */
const BranchButton: React.FC = () => {
  const repo = useProjectStore((s) => s.repo);
  const status = useProjectStore((s) => s.status);
  const isOpen = useProjectStore((s) => s.isOpen && s.tab === "changes");
  if (!repo || !status) return null;

  const branch = status.branch ?? (status.head ? `@${status.head.slice(0, 7)}` : "sin commits");
  const changes = status.changes.length;
  const sync = [status.ahead ? `↑${status.ahead}` : "", status.behind ? `↓${status.behind}` : ""].filter(Boolean).join(" ");

  return (
    <button
      type="button"
      onClick={() => openProject("changes")}
      aria-pressed={isOpen}
      aria-label={`Rama ${branch}${changes ? `, ${changes} cambios` : ""}`}
      title={`${repo.name} · ${branch}  ${shortcutLabel("projectChanges")}`}
      className={cn(
        "flex h-7 max-w-[220px] items-center gap-1.5 rounded-md border px-2.5 font-mono text-[12px] transition-colors duration-150",
        isOpen
          ? "border-line-strong bg-press text-ink"
          : "border-line text-ink-2 hover:border-line-strong hover:bg-hover hover:text-ink",
      )}
    >
      <GitBranch size={13} strokeWidth={1.75} aria-hidden="true" className="shrink-0 text-ink-3" />
      <span className="truncate">{branch}</span>
      {changes > 0 && <span className="shrink-0 tabular-nums text-amber">●{changes}</span>}
      {sync && <span className="shrink-0 tabular-nums text-ink-3">{sync}</span>}
    </button>
  );
};

interface TabItemProps {
  tab: Tab;
  index: number;
  isActive: boolean;
  canClose: boolean;
  needsAttention: boolean;
  dropMarker: "before" | "after" | null;
  isDragged: boolean;
  onPointerDownTab: (e: React.PointerEvent) => void;
  onSelect: () => void;
}

/** Progreso que reporta el programa del panel activo (OSC 9;4). */
function useTabProgress(paneId: string): { state: number; value: number } {
  const snapshot = useSyncExternalStore(terminalManager.subscribeProgress, () => {
    const p = terminalManager.getProgress(paneId);
    return `${p.state}:${p.value}`;
  });
  const [state, value] = snapshot.split(":").map(Number);
  return { state, value };
}

const TabItem: React.FC<TabItemProps> = ({
  tab,
  index,
  isActive,
  canClose,
  needsAttention,
  dropMarker,
  isDragged,
  onPointerDownTab,
  onSelect,
}) => {
  const renameTab = useTerminalStore((s) => s.renameTab);
  const paneProject = useTerminalStore((s) => s.paneProject);
  const [editing, setEditing] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const label = tabDisplayName(tab, paneProject);
  const project = paneProject[tab.activePaneId];
  const running = useRunningCommand(tab.activePaneId);
  // Si el nombre ya es el comando (p. ej. el título que puso vim), no se repite.
  const runningHint = running && !label.startsWith(running.split(" ")[0]) ? shortCommand(running, 2) : null;
  const agentType = findPane(tab.root, tab.activePaneId)?.agentType;
  const hint = tabShortcutLabel(index);
  const progress = useTabProgress(tab.activePaneId);

  useEffect(() => {
    if (editing) inputRef.current?.select();
  }, [editing]);

  const finish = (save: boolean) => {
    if (save) renameTab(tab.id, inputRef.current?.value ?? "");
    setEditing(false);
  };

  return (
    <li
      data-index={index}
      onPointerDown={(e) => {
        if (!editing && !(e.target as HTMLElement).closest("[data-no-drag]")) onPointerDownTab(e);
      }}
      className={cn(
        "group relative flex h-[31px] shrink-0 items-center rounded-t-md border-x border-t transition-colors duration-150",
        isActive ? "z-10 border-line bg-canvas text-ink" : "border-transparent text-ink-3 hover:bg-hover/60 hover:text-ink-2",
        isDragged && "opacity-50",
      )}
    >
      {dropMarker && (
        <span
          aria-hidden="true"
          className={cn("absolute inset-y-1 w-0.5 rounded-full bg-amber", dropMarker === "before" ? "-left-1" : "-right-1")}
        />
      )}
      {/* Franja del proyecto: mismo color para todas las pestañas del mismo repo. */}
      {project && (
        <span
          aria-hidden="true"
          title={project.name}
          className={cn(
            "pointer-events-none absolute inset-x-2.5 top-0 h-[2px] rounded-b-full",
            projectTone(project.root ?? project.cwd),
            isActive ? "opacity-90" : "opacity-45",
          )}
        />
      )}
      {editing ? (
        <input
          ref={inputRef}
          data-no-drag
          defaultValue={tab.customTitle ?? label}
          aria-label="Nombre de la pestaña"
          onBlur={() => finish(true)}
          onKeyDown={(e) => {
            if (e.key === "Enter") finish(true);
            else if (e.key === "Escape") finish(false);
          }}
          className="ml-2 h-6 w-40 select-text rounded border border-line-strong bg-raised px-1.5 font-mono text-[12px] text-ink outline-none"
        />
      ) : (
        <button
          type="button"
          aria-current={isActive ? "page" : undefined}
          title={`${label}${project ? ` · ${project.cwd}` : ""}${running ? ` · corriendo: ${running}` : ""}${hint ? `  ${hint}` : ""} · doble clic para renombrar`}
          onClick={onSelect}
          onDoubleClick={() => setEditing(true)}
          onAuxClick={(e) => {
            if (e.button === 1 && canClose) actions.closeTab(tab.id);
          }}
          className="flex h-full min-w-0 items-center gap-2 pl-3 pr-1 outline-offset-[-2px]"
        >
          {needsAttention ? (
            <Lamp state="attention" />
          ) : (
            <span className={cn("font-mono text-[11px] tabular-nums", isActive ? "text-amber" : "text-ink-3")}>{index + 1}</span>
          )}
          <AgentGlyph agentType={agentType} className="shrink-0 opacity-80" />
          <span className="max-w-[180px] truncate font-mono text-[12px]">{label}</span>
          {runningHint && <span className="max-w-[110px] shrink-0 truncate font-mono text-[11px] text-ink-3">{runningHint}</span>}
          {tab.zoomedPaneId && (
            <Maximize2 size={11} strokeWidth={2} aria-label="Panel maximizado" className="shrink-0 text-amber" />
          )}
        </button>
      )}

      {canClose ? (
        <button
          type="button"
          data-no-drag
          aria-label={`Cerrar pestaña ${label}`}
          onClick={() => actions.closeTab(tab.id)}
          className={cn(
            "mr-1.5 grid size-5 place-items-center rounded text-ink-3 transition-opacity duration-150 hover:bg-press hover:text-ink focus-visible:opacity-100",
            isActive ? "opacity-100" : "opacity-0 group-hover:opacity-100",
          )}
        >
          <X size={12} strokeWidth={2} aria-hidden="true" />
        </button>
      ) : (
        <span className="w-2" />
      )}

      {progress.state !== 0 && (
        <span
          role="progressbar"
          aria-label="Progreso"
          aria-valuenow={progress.state === 3 ? undefined : progress.value}
          className="absolute inset-x-2 bottom-0.5 h-[2px] overflow-hidden rounded-full bg-line"
        >
          <span
            className={cn(
              "block h-full rounded-full transition-[width] duration-300",
              progress.state === 2 ? "bg-signal" : progress.state === 4 ? "bg-ink-3" : "bg-amber",
              progress.state === 3 && "w-1/3 animate-[indeterminate_1.2s_ease-in-out_infinite]",
            )}
            style={progress.state === 3 ? undefined : { width: `${Math.max(2, progress.value)}%` }}
          />
        </span>
      )}
    </li>
  );
};
