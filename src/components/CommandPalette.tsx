import React, { useEffect, useId, useMemo, useRef, useState } from "react";
import {
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  FolderTree,
  Maximize2,
  Palette,
  Settings2,
  StretchHorizontal,
  Undo2,
  LayoutGrid,
  Eye,
  GitCommitHorizontal,
  GitPullRequestArrow,
  History,
  Sparkles,
  Asterisk,
  Columns2,
  Gauge,
  GitBranch,
  Hexagon,
  PanelLeft,
  Plus,
  Radio,
  RefreshCw,
  RotateCcw,
  Rows2,
  Send,
  SquareTerminal,
  TextSearch,
  X,
  ZoomIn,
  ZoomOut,
  type LucideIcon,
} from "lucide-react";
import { useTerminalStore } from "../store/terminalStore";
import { actions, AGENTS } from "../lib/actions";
import { commit, generateCommitMessage, openProject, pull, push, reviewAgent } from "../lib/project";
import { useUiStore } from "../store/uiStore";
import { collectPanes as panesOf } from "../lib/layout";
import { useProjectStore } from "../store/projectStore";
import { useSettingsStore } from "../store/settingsStore";
import { cn, tabLabel } from "../lib/layout";
import { shortcutLabel, tabShortcutLabel, type ShortcutId } from "../lib/shortcuts";
import { Kbd } from "./ui";

interface Command {
  id: string;
  group: string;
  title: string;
  hint?: string;
  icon: LucideIcon;
  shortcut?: string;
  run: () => unknown;
}

interface CommandPaletteProps {
  isOpen: boolean;
  onClose: () => void;
}

const normalize = (text: string) =>
  text.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase();

const sc = (id: ShortcutId) => shortcutLabel(id);

export const CommandPalette: React.FC<CommandPaletteProps> = ({ isOpen, onClose }) => {
  if (!isOpen) return null;
  return <PaletteDialog onClose={onClose} />;
};

const PaletteDialog: React.FC<{ onClose: () => void }> = ({ onClose }) => {
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const listId = useId();

  const tabs = useTerminalStore((s) => s.tabs);
  const activeTabId = useTerminalStore((s) => s.activeTabId);
  const isBroadcastEnabled = useTerminalStore((s) => s.isBroadcastEnabled);
  const isSidebarOpen = useTerminalStore((s) => s.isSidebarOpen);
  const fontSize = useSettingsStore((s) => s.settings.fontSize);
  const currentTheme = useSettingsStore((s) => s.settings.theme);
  const agents = useTerminalStore((s) => s.agents);
  const repo = useProjectStore((s) => s.repo);

  const commands = useMemo<Command[]>(
    () => [
      { id: "new-tab", group: "Sesión", title: "Nueva pestaña", icon: Plus, shortcut: sc("newTab"), run: actions.newTab },
      { id: "split-right", group: "Sesión", title: "Dividir a la derecha", icon: Columns2, shortcut: sc("splitRight"), run: actions.splitRight },
      { id: "split-down", group: "Sesión", title: "Dividir hacia abajo", icon: Rows2, shortcut: sc("splitDown"), run: actions.splitDown },
      { id: "next-pane", group: "Sesión", title: "Panel siguiente", icon: ArrowRight, shortcut: sc("nextPane"), run: () => actions.focusPaneOffset(1) },
      { id: "prev-pane", group: "Sesión", title: "Panel anterior", icon: ArrowLeft, shortcut: sc("prevPane"), run: () => actions.focusPaneOffset(-1) },
      { id: "close-pane", group: "Sesión", title: "Cerrar panel", icon: X, shortcut: sc("closePane"), run: () => actions.closePane() },
      { id: "find", group: "Sesión", title: "Buscar en el terminal", icon: TextSearch, shortcut: sc("find"), run: actions.toggleFind },

      ...(["claude", "codex"] as const).flatMap<Command>((agent) => {
        const icon = agent === "claude" ? Asterisk : Hexagon;
        const missing = agents ? !agents[agent] : false;
        const hint = missing ? "no instalado" : undefined;
        const name = AGENTS[agent].title;
        return [
          { id: `${agent}-split`, group: "Agentes", title: `${name} junto al panel`, hint: hint ?? "dividir", icon, run: () => actions.openAgentInSplit(agent) },
          { id: `${agent}-tab`, group: "Agentes", title: `${name} en pestaña nueva`, hint, icon, run: () => actions.openAgentInTab(agent) },
          { id: `${agent}-worktree`, group: "Agentes", title: `${name} en un worktree nuevo`, hint: hint ?? "rama propia", icon: GitBranch, run: () => actions.openAgentInWorktree(agent) },
        ];
      }),
      { id: "mission", group: "Agentes", title: "Mission Control de agentes", icon: LayoutGrid, shortcut: sc("missionControl"), run: () => useUiStore.getState().setMissionOpen(true) },
      { id: "review-agent", group: "Agentes", title: "Revisar cambios del agente", hint: "desde tu último mensaje", icon: Eye, run: () => void reviewNearestAgent() },
      { id: "send-selection", group: "Agentes", title: "Enviar selección al agente", hint: "pega el texto seleccionado", icon: Send, run: actions.sendSelectionToAgent },

      ...(repo
        ? ([
            { id: "git-changes", group: "Git", title: "Ver cambios", hint: repo.name, icon: GitBranch, shortcut: sc("projectChanges"), run: () => openProject("changes") },
            { id: "git-history", group: "Git", title: "Ver historial", icon: History, run: () => openProject("history") },
            { id: "git-ai-message", group: "Git", title: "Mensaje de commit con IA", hint: "cambios preparados", icon: Sparkles, run: () => { openProject("changes"); void generateCommitMessage(); } },
            { id: "git-commit", group: "Git", title: "Hacer commit", icon: GitCommitHorizontal, run: () => { openProject("changes"); void commit(); } },
            { id: "git-push", group: "Git", title: "Push", icon: ArrowUp, run: () => void push() },
            { id: "git-pull", group: "Git", title: "Pull", hint: "--ff-only", icon: ArrowDown, run: () => void pull() },
            { id: "git-pr", group: "Git", title: "Crear pull request", icon: GitPullRequestArrow, run: () => useProjectStore.getState().set({ isPrDialogOpen: true }) },
          ] satisfies Command[])
        : []),
      { id: "files", group: "Proyecto", title: "Explorar archivos", icon: FolderTree, shortcut: sc("projectFiles"), run: () => openProject("files") },

      { id: "settings", group: "Vista", title: "Ajustes", icon: Settings2, shortcut: sc("settings"), run: actions.openSettings },
      { id: "zoom", group: "Vista", title: "Maximizar / restaurar panel", icon: Maximize2, shortcut: sc("zoomPane"), run: actions.toggleZoom },
      { id: "equalize", group: "Vista", title: "Igualar tamaño de paneles", icon: StretchHorizontal, run: actions.equalizeSplits },
      { id: "reopen", group: "Sesión", title: "Reabrir lo último cerrado", icon: Undo2, shortcut: sc("reopenClosed"), run: actions.reopenClosed },
      { id: "prev-command", group: "Sesión", title: "Comando anterior", icon: ArrowUp, shortcut: sc("prevCommand"), run: () => actions.jumpCommand(-1) },
      { id: "next-command", group: "Sesión", title: "Comando siguiente", icon: ArrowDown, shortcut: sc("nextCommand"), run: () => actions.jumpCommand(1) },
      ...(["fosforo", "fosforo-verde", "papel"] as const).map<Command>((theme) => ({
        id: `theme-${theme}`,
        group: "Vista",
        title: `Tema: ${theme === "fosforo" ? "Fósforo" : theme === "fosforo-verde" ? "Fósforo verde" : "Papel"}`,
        hint: theme === currentTheme ? "actual" : undefined,
        icon: Palette,
        run: () => useSettingsStore.getState().update({ theme }),
      })),
      { id: "sidebar", group: "Vista", title: isSidebarOpen ? "Ocultar sesiones" : "Mostrar sesiones", icon: PanelLeft, shortcut: sc("toggleSidebar"), run: actions.toggleSidebar },
      { id: "usage", group: "Vista", title: "Cuotas de IA", hint: "Claude · Codex", icon: Gauge, shortcut: sc("toggleUsage"), run: actions.toggleUsage },
      { id: "usage-refresh", group: "Vista", title: "Actualizar cuotas", icon: RefreshCw, run: actions.refreshUsage },
      { id: "font-bigger", group: "Vista", title: "Aumentar letra", hint: `${fontSize} px`, icon: ZoomIn, shortcut: sc("fontBigger"), run: actions.fontBigger },
      { id: "font-smaller", group: "Vista", title: "Reducir letra", hint: `${fontSize} px`, icon: ZoomOut, shortcut: sc("fontSmaller"), run: actions.fontSmaller },
      { id: "font-reset", group: "Vista", title: "Tamaño de letra original", icon: RotateCcw, shortcut: sc("fontReset"), run: actions.fontReset },
      {
        id: "broadcast",
        group: "Vista",
        title: isBroadcastEnabled ? "Desactivar broadcast" : "Activar broadcast",
        hint: "escribir en todos los paneles",
        icon: Radio,
        shortcut: sc("toggleBroadcast"),
        run: actions.toggleBroadcast,
      },

      ...tabs.map<Command>((tab, index) => ({
        id: `tab-${tab.id}`,
        group: "Pestañas",
        title: tabLabel(tab),
        hint: tab.id === activeTabId ? "actual" : undefined,
        icon: SquareTerminal,
        shortcut: tabShortcutLabel(index),
        run: () => actions.goToTab(index),
      })),
    ],
    [tabs, activeTabId, isBroadcastEnabled, isSidebarOpen, fontSize, agents, repo, currentTheme],
  );

  const filtered = useMemo(() => {
    const terms = normalize(query).split(/\s+/).filter(Boolean);
    if (!terms.length) return commands;
    return commands.filter((cmd) => {
      const haystack = normalize(`${cmd.title} ${cmd.group} ${cmd.hint ?? ""}`);
      return terms.every((term) => haystack.includes(term));
    });
  }, [commands, query]);

  const activeIndex = Math.min(selected, Math.max(filtered.length - 1, 0));
  const optionId = (index: number) => `${listId}-opt-${index}`;

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    listRef.current
      ?.querySelector<HTMLElement>(`[data-index="${activeIndex}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [activeIndex]);

  const execute = (cmd: Command | undefined) => {
    if (!cmd) return;
    onClose();
    cmd.run();
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    const count = filtered.length;
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        if (count) setSelected((activeIndex + 1) % count);
        break;
      case "ArrowUp":
        e.preventDefault();
        if (count) setSelected((activeIndex - 1 + count) % count);
        break;
      case "Enter":
        e.preventDefault();
        execute(filtered[activeIndex]);
        break;
      case "Escape":
        e.preventDefault();
        onClose();
        break;
    }
  };

  let lastGroup = "";

  return (
    <div
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      className="fixed inset-0 z-50 flex animate-fade-in items-start justify-center bg-canvas/60 px-4 pt-[14vh]"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Paleta de comandos"
        className="flex w-full max-w-[560px] animate-pop-in flex-col overflow-hidden rounded-lg border border-line-strong bg-raised shadow-[0_24px_64px_-12px_rgb(0_0_0/0.7)]"
      >
        <div className="flex h-12 items-center gap-3 border-b border-line px-4">
          <span className="font-mono text-[15px] text-amber" aria-hidden="true">
            ›
          </span>
          <input
            ref={inputRef}
            type="text"
            role="combobox"
            aria-expanded="true"
            aria-controls={listId}
            aria-activedescendant={filtered.length ? optionId(activeIndex) : undefined}
            aria-autocomplete="list"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setSelected(0);
            }}
            onKeyDown={handleKeyDown}
            placeholder="Escribe un comando, agente o pestaña…"
            spellCheck={false}
            autoComplete="off"
            className="h-full min-w-0 flex-1 select-text bg-transparent text-[14px] text-ink outline-none placeholder:text-ink-3"
          />
          <Kbd>esc</Kbd>
        </div>

        <div ref={listRef} id={listId} role="listbox" aria-label="Comandos" className="max-h-[min(400px,55vh)] overflow-y-auto p-1.5">
          {filtered.length === 0 ? (
            <p className="px-3 py-8 text-center text-[13px] text-ink-3">
              Nada coincide con «{query}».
            </p>
          ) : (
            filtered.map((cmd, index) => {
              const Icon = cmd.icon;
              const isSelected = index === activeIndex;
              const showGroup = cmd.group !== lastGroup;
              lastGroup = cmd.group;

              return (
                <React.Fragment key={cmd.id}>
                  {showGroup && (
                    <div
                      role="presentation"
                      className="px-2.5 pb-1 pt-2.5 font-mono text-[11px] uppercase tracking-[0.08em] text-ink-3 first:pt-1"
                    >
                      {cmd.group}
                    </div>
                  )}
                  <div
                    id={optionId(index)}
                    role="option"
                    aria-selected={isSelected}
                    data-index={index}
                    onMouseMove={() => {
                      if (!isSelected) setSelected(index);
                    }}
                    onClick={() => execute(cmd)}
                    className={cn(
                      "relative flex h-9 cursor-pointer items-center gap-3 rounded-md px-2.5",
                      isSelected ? "bg-hover text-ink" : "text-ink-2",
                    )}
                  >
                    {isSelected && <span className="absolute inset-y-2 left-0 w-0.5 rounded-full bg-amber" aria-hidden="true" />}
                    <Icon
                      size={15}
                      strokeWidth={1.75}
                      aria-hidden="true"
                      className={cn("shrink-0", isSelected ? "text-amber" : "text-ink-3")}
                    />
                    <span className={cn("min-w-0 truncate text-[13px]", cmd.group === "Pestañas" && "font-mono text-[12px]")}>
                      {cmd.title}
                    </span>
                    {cmd.hint && <span className="shrink-0 truncate text-[12px] text-ink-3">{cmd.hint}</span>}
                    <span className="flex-1" />
                    {cmd.shortcut && <Kbd className={isSelected ? "text-ink-2" : undefined}>{cmd.shortcut}</Kbd>}
                  </div>
                </React.Fragment>
              );
            })
          )}
        </div>

        <div className="flex h-8 items-center gap-4 border-t border-line px-4 text-[11px] text-ink-3">
          <span className="flex items-center gap-1.5">
            <Kbd>↑↓</Kbd> navegar
          </span>
          <span className="flex items-center gap-1.5">
            <Kbd>↵</Kbd> ejecutar
          </span>
          <span className="flex items-center gap-1.5">
            <Kbd>esc</Kbd> cerrar
          </span>
        </div>
      </div>
    </div>
  );
};

/** Revisa el agente del panel activo o, si no es un agente, el primero de la pestaña. */
async function reviewNearestAgent() {
  const { tabs, activeTabId } = useTerminalStore.getState();
  const tab = tabs.find((t) => t.id === activeTabId);
  const panes = tab ? panesOf(tab.root) : [];
  const agent = panes.find((p) => p.id === tab?.activePaneId && p.agentType) ?? panes.find((p) => p.agentType);
  if (!agent) {
    useUiStore.getState().showToast("No hay un agente en esta pestaña.");
    return;
  }
  await reviewAgent(agent.id, "turn");
}
