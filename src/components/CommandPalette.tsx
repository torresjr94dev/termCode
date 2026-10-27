import React, { useEffect, useId, useMemo, useRef, useState } from "react";
import { LayoutTemplate, Server, ScrollText,
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  BellRing,
  FolderTree,
  Maximize2,
  Palette,
  Settings2,
  StretchHorizontal,
  Undo2,
  LayoutGrid,
  Eye,
  Archive,
  FileSearch,
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
import { liveAgent, useTerminalStore } from "../store/terminalStore";
import { explainFailure, openOutput } from "../lib/output";
import { describeServer, sshAliasCommand, sshServerCommand } from "../lib/ssh";
import { copyWorkspaceTemplate, openWorkspace } from "../lib/workspace";
import { useSidebarStore } from "../store/sidebarStore";
import { actions, AGENTS } from "../lib/actions";
import { commit, generateCommitMessage, openBranchPicker, openProject, pull, push, reviewAgent, stashPush } from "../lib/project";
import { useUiStore } from "../store/uiStore";
import { collectPanes as panesOf } from "../lib/layout";
import { useProjectStore } from "../store/projectStore";
import { THEME_NAMES, useSettingsStore, type ThemeId } from "../store/settingsStore";
import { cn, tabLabel } from "../lib/layout";
import { shortcutLabel, tabShortcutLabel, type ShortcutId } from "../lib/shortcuts";
import { Kbd, PromptCaret, PromptCursor } from "./ui";

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
  const shells = useTerminalStore((s) => s.shells);
  const sshHosts = useSidebarStore((s) => s.sshHosts);
  const servers = useSidebarStore((s) => s.servers);
  const repo = useProjectStore((s) => s.repo);
  const activePaneId = tabs.find((t) => t.id === activeTabId)?.activePaneId;

  const commands = useMemo<Command[]>(
    () => [
      { id: "new-tab", group: "Sesión", title: "Nueva pestaña", icon: Plus, shortcut: sc("newTab"), run: actions.newTab },
      ...(shells ?? [])
        .filter((shell) => !shell.default)
        .map<Command>((shell) => ({
          id: `shell-${shell.path}`,
          group: "Sesión",
          title: `Nueva pestaña con ${shell.name}`,
          hint: shell.path,
          icon: Plus,
          run: () => void actions.newTabWith(shell),
        })),
      ...servers.map<Command>((server) => ({
        id: `ssh-${server.id}`,
        group: "SSH",
        title: `Conectar a ${server.name}`,
        hint: describeServer(server.user || null, server.host, server.port),
        icon: Server,
        run: () => actions.connectSsh(server.name, sshServerCommand(server)),
      })),
      ...sshHosts.map<Command>((host) => ({
        id: `ssh-config-${host.alias}`,
        group: "SSH",
        title: `Conectar a ${host.alias}`,
        hint: describeServer(host.user, host.hostName ?? host.alias, host.port),
        icon: Server,
        run: () => actions.connectSsh(host.alias, sshAliasCommand(host.alias)),
      })),
      { id: "ssh-add", group: "SSH", title: "Agregar servidor SSH…", icon: Server, run: () => useUiStore.getState().setSshDialog({}) },
      { id: "split-right", group: "Sesión", title: "Dividir a la derecha", icon: Columns2, shortcut: sc("splitRight"), run: actions.splitRight },
      { id: "split-down", group: "Sesión", title: "Dividir hacia abajo", icon: Rows2, shortcut: sc("splitDown"), run: actions.splitDown },
      { id: "next-pane", group: "Sesión", title: "Panel siguiente", icon: ArrowRight, shortcut: sc("nextPane"), run: () => actions.focusPaneOffset(1) },
      { id: "prev-pane", group: "Sesión", title: "Panel anterior", icon: ArrowLeft, shortcut: sc("prevPane"), run: () => actions.focusPaneOffset(-1) },
      { id: "close-pane", group: "Sesión", title: "Cerrar panel", icon: X, shortcut: sc("closePane"), run: () => actions.closePane() },
      { id: "find", group: "Sesión", title: "Buscar en el terminal", icon: TextSearch, shortcut: sc("find"), run: actions.toggleFind },
      { id: "output", group: "Sesión", title: "Ver salida del último comando", hint: "completa, con búsqueda", icon: ScrollText, run: () => activePaneId && openOutput(activePaneId) },
      { id: "explain", group: "Agentes", title: "Explicar el último error", hint: "comando y salida al agente", icon: Sparkles, run: () => activePaneId && explainFailure(activePaneId) },

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
      { id: "next-attention", group: "Agentes", title: "Ir al que te necesita", hint: "permisos y preguntas primero", icon: BellRing, shortcut: sc("nextAttention"), run: actions.focusNextAttention },
      { id: "mission", group: "Agentes", title: "Mission Control de agentes", icon: LayoutGrid, shortcut: sc("missionControl"), run: () => useUiStore.getState().setMissionOpen(true) },
      { id: "review-agent", group: "Agentes", title: "Revisar cambios del agente", hint: "desde tu último mensaje", icon: Eye, run: () => void reviewNearestAgent() },
      { id: "send-selection", group: "Agentes", title: "Enviar selección al agente", hint: "pega el texto seleccionado", icon: Send, run: actions.sendSelectionToAgent },

      { id: "workspace-open", group: "Proyecto", title: "Abrir workspace del proyecto", hint: ".termcode.json", icon: LayoutTemplate, run: () => void openWorkspace() },
      { id: "workspace-template", group: "Proyecto", title: "Copiar plantilla de .termcode.json", hint: "paneles del proyecto ya armados", icon: LayoutTemplate, run: () => void copyWorkspaceTemplate() },
      { id: "find-file", group: "Proyecto", title: "Buscar archivo…", icon: FileSearch, shortcut: sc("fileFinder"), run: () => useUiStore.getState().setFinderOpen(true) },

      ...(repo
        ? ([
            { id: "git-switch", group: "Git", title: "Cambiar de rama…", hint: "o crear una", icon: GitBranch, shortcut: sc("switchBranch"), run: openBranchPicker },
            { id: "git-stash", group: "Git", title: "Guardar cambios en el stash", hint: "archivos nuevos incluidos", icon: Archive, run: () => void stashPush() },
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
      { id: "overview", group: "Vista", title: "Ver todos los paneles", hint: "miniaturas en vivo", icon: LayoutGrid, shortcut: sc("overview"), run: () => useUiStore.getState().setOverviewOpen(true) },
      { id: "zoom", group: "Vista", title: "Maximizar / restaurar panel", icon: Maximize2, shortcut: sc("zoomPane"), run: actions.toggleZoom },
      { id: "equalize", group: "Vista", title: "Igualar tamaño de paneles", icon: StretchHorizontal, run: actions.equalizeSplits },
      { id: "reopen", group: "Sesión", title: "Reabrir lo último cerrado", icon: Undo2, shortcut: sc("reopenClosed"), run: actions.reopenClosed },
      { id: "prev-command", group: "Sesión", title: "Comando anterior", icon: ArrowUp, shortcut: sc("prevCommand"), run: () => actions.jumpCommand(-1) },
      { id: "next-command", group: "Sesión", title: "Comando siguiente", icon: ArrowDown, shortcut: sc("nextCommand"), run: () => actions.jumpCommand(1) },
      ...(Object.keys(THEME_NAMES) as ThemeId[]).map<Command>((theme) => ({
        id: `theme-${theme}`,
        group: "Vista",
        title: `Tema: ${THEME_NAMES[theme]}`,
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
    [tabs, activeTabId, activePaneId, isBroadcastEnabled, isSidebarOpen, fontSize, agents, shells, sshHosts, servers, repo, currentTheme],
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
        className="flex w-full max-w-[560px] animate-pop-in flex-col overflow-hidden rounded-lg border border-[var(--glass-border)] glass"
      >
        <div className="flex h-12 items-center gap-3 border-b border-line px-4">
          <span className="font-mono text-[15px] text-accent" aria-hidden="true">
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

        <div ref={listRef} id={listId} role="listbox" aria-label="Comandos" className="relative max-h-[min(400px,55vh)] overflow-y-auto p-1.5">
          {filtered.length > 0 && <PromptCursor index={activeIndex} layoutKey={filtered} />}
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
                      className="pb-1 pl-7 pr-2.5 pt-2.5 font-mono text-[11px] uppercase tracking-[0.08em] text-ink-3 first:pt-1"
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
                      "relative flex h-9 cursor-pointer items-center gap-3 rounded-md pl-7 pr-2.5 transition-colors duration-150",
                      isSelected ? "text-ink" : "text-ink-2",
                    )}
                  >
                    <Icon
                      size={15}
                      strokeWidth={1.75}
                      aria-hidden="true"
                      className={cn("shrink-0", isSelected ? "text-accent" : "text-ink-3")}
                    />
                    <span className="prompt-slot flex min-w-0 text-[13px]">
                      <span className={cn("truncate text-[13px]", cmd.group === "Pestañas" && "font-mono text-[12px]")}>{cmd.title}</span>
                      {isSelected && <PromptCaret />}
                    </span>
                    {cmd.hint && <span className="-ml-1 shrink-0 truncate text-[12px] text-ink-3">{cmd.hint}</span>}
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
  const store = useTerminalStore.getState();
  const tab = store.tabs.find((t) => t.id === store.activeTabId);
  const panes = tab ? panesOf(tab.root) : [];
  const isAgent = (p: (typeof panes)[number]) => liveAgent(store, p) !== null;
  const agent = panes.find((p) => p.id === tab?.activePaneId && isAgent(p)) ?? panes.find(isAgent);
  if (!agent) {
    useUiStore.getState().showToast("No hay un agente en esta pestaña.");
    return;
  }
  await reviewAgent(agent.id, "turn");
}
