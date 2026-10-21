import React from "react";
import { Asterisk, GitBranch, Hexagon, Search, SquareTerminal, X, type LucideIcon } from "lucide-react";
import { useTerminalStore, type PaneProject } from "../store/terminalStore";
import { useApprovalStore } from "../store/approvalStore";
import { useUiStore } from "../store/uiStore";
import { actions, AGENTS, type AgentKind } from "../lib/actions";
import { basename, cn, collectPanes, findPane } from "../lib/layout";
import { paneDisplayName, projectTone, tabDisplayName } from "../lib/identity";
import { IS_MAC, shortcutLabel, tabShortcutLabel } from "../lib/shortcuts";
import { useRunningCommand } from "../terminal/useRunningCommand";
import { terminalManager } from "../terminal/TerminalManager";
import type { PaneNode, Tab } from "../types/layout";
import { Kbd, Lamp, Ring, SectionLabel } from "./ui";
import { LogoMark } from "./Logo";
import { relativeInside, tildify } from "../lib/paths";

/**
 * Barra lateral: arriba buscar/ejecutar, en medio tus sesiones (navegación),
 * abajo abrir algo nuevo (acciones). Cada sesión dice qué es y en qué está,
 * para que dos «Claude Code» no se vean idénticos.
 */
export const Sidebar: React.FC = () => {
  const isOpen = useTerminalStore((s) => s.isSidebarOpen);
  const tabs = useTerminalStore((s) => s.tabs);
  const activeTabId = useTerminalStore((s) => s.activeTabId);

  if (!isOpen) return null;

  return (
    <aside aria-label="Sesiones" className="flex h-full w-64 shrink-0 flex-col bg-chrome">
      {/* Zona de arrastre: aquí viven los semáforos de macOS; la marca, a la derecha (no captura el arrastre). */}
      <div data-tauri-drag-region className={cn("flex shrink-0 items-center justify-end pr-3.5", IS_MAC ? "h-11" : "h-9")}>
        <LogoMark title="termCode" className="pointer-events-none h-3.5 w-auto text-ink-2" />
      </div>

      <div className="px-2.5 pb-3">
        <button
          type="button"
          onClick={() => useUiStore.getState().setPaletteOpen(true)}
          className="glass-pill flex h-8 w-full items-center gap-2 rounded-[10px] px-2.5 text-left text-[12.5px] text-ink-3 transition-colors duration-150 hover:text-ink-2"
        >
          <Search size={13} strokeWidth={1.9} aria-hidden="true" />
          <span className="flex-1">Buscar o ejecutar…</span>
          <Kbd>{shortcutLabel("palette")}</Kbd>
        </button>
      </div>

      <nav aria-label="Pestañas abiertas" className="flex min-h-0 flex-1 flex-col overflow-y-auto px-2 pb-3">
        <SectionLabel aside={tabs.length}>Sesiones</SectionLabel>
        <ul className="flex flex-col gap-0.5">
          {tabs.map((tab, index) => (
            <SessionItem key={tab.id} tab={tab} index={index} active={tab.id === activeTabId} />
          ))}
        </ul>
      </nav>

      <Launcher />
    </aside>
  );
};

/* ------------------------------------------------------------------ */
/* Sesión (pestaña) y sus paneles                                      */
/* ------------------------------------------------------------------ */

const SessionItem: React.FC<{ tab: Tab; index: number; active: boolean }> = ({ tab, index, active }) => {
  const paneProject = useTerminalStore((s) => s.paneProject);
  const attention = useTerminalStore((s) => s.attention);
  const setActiveTab = useTerminalStore((s) => s.setActiveTab);
  const panes = collectPanes(tab.root);
  const lead = findPane(tab.root, tab.activePaneId) ?? panes[0];
  const label = tabDisplayName(tab, paneProject);
  const approvals = useApprovalStore((s) => s.requests);
  const needsAttention = panes.some((p) => p.id in attention || approvals.some((r) => r.paneId === p.id));
  const shortcut = tabShortcutLabel(index);
  const grouped = active && panes.length > 1;

  return (
    <li className={cn("group/session rounded-xl transition-colors duration-150", grouped && "glass-pill pb-1.5")}>
      <div className="relative">
        <button
          type="button"
          aria-current={active ? "page" : undefined}
          title={shortcut ? `${label}  ${shortcut}` : label}
          onClick={() => setActiveTab(tab.id)}
          className={cn(
            "flex w-full items-center gap-2.5 rounded-xl px-2 py-1.5 text-left transition-colors duration-150",
            active ? cn("text-ink", !grouped && "glass-pill") : "text-ink-2 hover:bg-hover hover:text-ink",
          )}
        >
          <SessionIcon pane={lead} project={paneProject[lead.id]} />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[13px] font-medium leading-5">{label}</span>
            <PaneSubtitle pane={lead} project={paneProject[lead.id]} extraPanes={!active && panes.length > 1 ? panes.length : 0} />
          </span>
          <span className="flex shrink-0 items-center gap-1.5 pr-0.5 transition-opacity duration-150 group-hover/session:opacity-0">
            {needsAttention ? <Lamp state="attention" /> : <ContextBadge pane={lead} />}
            {shortcut && !needsAttention && <span className="font-mono text-[10.5px] text-ink-3/80">{shortcut}</span>}
          </span>
        </button>
        <button
          type="button"
          aria-label={`Cerrar ${label}`}
          onClick={() => actions.closeTab(tab.id)}
          className="absolute right-2 top-1/2 grid size-6 -translate-y-1/2 place-items-center rounded-md text-ink-3 opacity-0 transition-opacity duration-150 hover:bg-press hover:text-ink focus-visible:opacity-100 group-hover/session:opacity-100"
        >
          <X size={12} strokeWidth={2} aria-hidden="true" />
        </button>
      </div>

      {grouped && <PaneList tab={tab} panes={panes} />}
    </li>
  );
};

/** Paneles de la pestaña activa. Si dos se llaman igual, los distingue su carpeta. */
const PaneList: React.FC<{ tab: Tab; panes: PaneNode[] }> = ({ tab, panes }) => {
  const paneProject = useTerminalStore((s) => s.paneProject);
  const attention = useTerminalStore((s) => s.attention);
  const approvals = useApprovalStore((s) => s.requests);
  const names = panes.map((p) => paneDisplayName(p, paneProject[p.id]));
  return (
    <ul aria-label="Paneles" className="mx-1.5 mt-0.5 flex flex-col gap-px">
      {panes.map((pane, i) => {
        const focused = pane.id === tab.activePaneId;
        const repeated = names.filter((n) => n === names[i]).length > 1;
        const cwd = paneProject[pane.id]?.cwd ?? pane.cwd;
        const Icon = pane.agentType === "codex" ? Hexagon : pane.agentType === "claude" ? Asterisk : SquareTerminal;
        return (
          <li key={pane.id}>
            <button
              type="button"
              onClick={() => actions.focusPane(tab.id, pane.id)}
              className={cn(
                "flex h-7 w-full items-center gap-2 rounded-lg px-2 text-left transition-colors duration-150",
                focused ? "bg-hover text-ink" : "text-ink-3 hover:bg-hover hover:text-ink-2",
              )}
            >
              <Icon size={12.5} strokeWidth={1.9} aria-hidden="true" className={cn("shrink-0", pane.agentType && "text-accent")} />
              <span className="min-w-0 truncate text-[12.5px]">{names[i]}</span>
              {repeated && cwd && <span className="min-w-0 truncate font-mono text-[10.5px] text-ink-3">{basename(cwd)}</span>}
              <span className="flex-1" />
              {/* Te necesita (marca o permiso pendiente): eso manda sobre el contexto. */}
              {pane.id in attention || approvals.some((r) => r.paneId === pane.id) ? <Lamp state="attention" /> : <ContextBadge pane={pane} />}
            </button>
          </li>
        );
      })}
    </ul>
  );
};

/** Ícono de la sesión: el agente o una terminal; el punto es el color estable de su proyecto. */
const SessionIcon: React.FC<{ pane: PaneNode; project?: PaneProject }> = ({ pane, project }) => {
  const Icon = pane.agentType === "codex" ? Hexagon : pane.agentType === "claude" ? Asterisk : SquareTerminal;
  return (
    <span
      className={cn(
        "relative grid size-7 shrink-0 place-items-center rounded-[9px]",
        pane.agentType ? "bg-accent/12 text-accent" : "bg-hover text-ink-3",
      )}
    >
      <Icon size={14} strokeWidth={1.9} aria-hidden="true" />
      {project && (
        <span
          aria-hidden="true"
          title={project.name}
          className={cn("absolute -bottom-0.5 -right-0.5 size-2 rounded-full shadow-[0_0_0_2px_rgb(0_0_0/0.45)]", projectTone(project.root ?? project.cwd))}
        />
      )}
    </span>
  );
};

/** Segunda línea: qué hace el agente o la shell, o dónde está. */
const PaneSubtitle: React.FC<{ pane: PaneNode; project?: PaneProject; extraPanes: number }> = ({ pane, project, extraPanes }) => {
  const activity = useTerminalStore((s) => s.agentActivity[pane.id]);
  const waiting = useApprovalStore((s) => s.requests.some((r) => r.paneId === pane.id));
  const running = useRunningCommand(pane.id);

  let text: string;
  let tone = "text-ink-3";
  if (pane.agentType) {
    if (waiting || activity?.state === "needs-input") {
      text = waiting ? "Espera tu permiso" : "Te necesita";
      tone = "text-warn";
    } else if (activity?.state === "working") {
      text = activity.detail || "Trabajando…";
      tone = "text-accent";
    } else {
      text = "Esperando instrucciones";
    }
  } else if (running) {
    text = `▸ ${running}`;
    tone = "text-ink-2";
  } else {
    text = where(project?.cwd ?? pane.cwd, project);
  }
  const prefix = extraPanes ? `${extraPanes} paneles · ` : "";
  return (
    <span title={`${prefix}${text}`} className={cn("block truncate font-mono text-[10.5px] leading-4", tone)}>
      {prefix}
      {text}
    </span>
  );
};

/** El repo si lo hay; si no, la carpeta con `~`. */
function where(cwd: string | undefined, project?: PaneProject): string {
  const inside = project?.root && cwd ? relativeInside(cwd, project.root) : null;
  if (project && inside !== null) return inside ? `${project.name} / ${inside}` : project.name;
  if (!cwd) return "Terminal";
  return tildify(cwd, terminalManager.getHome());
}

/** Contexto usado por el agente (anillo + %) cuando el statusLine lo reporta. */
const ContextBadge: React.FC<{ pane: PaneNode }> = ({ pane }) => {
  const status = useTerminalStore((s) => s.agentStatus[pane.id]);
  if (!pane.agentType || status?.contextPercent == null) return null;
  const pct = Math.round(status.contextPercent);
  return (
    <span title={`Contexto usado: ${pct} %`} className="flex items-center gap-1 font-mono text-[10.5px] tabular-nums text-ink-3">
      <Ring value={status.contextPercent} size={12} stroke={2} />
      {pct}%
    </span>
  );
};

/* ------------------------------------------------------------------ */
/* Abrir algo nuevo                                                    */
/* ------------------------------------------------------------------ */

const Launcher: React.FC = () => {
  const agents = useTerminalStore((s) => s.agents);
  /** `null` = aún no se sabe (no se marca como ausente hasta comprobarlo). */
  const installed = (agent: AgentKind) => (agents ? Boolean(agents[agent]) : null);
  return (
    <div className="border-t border-line px-2.5 pb-3 pt-2.5">
      <p className="mb-1.5 px-1 text-[10.5px] font-semibold uppercase tracking-[0.08em] text-ink-3">Abrir</p>
      <div className="grid grid-cols-3 gap-1.5">
        <LaunchTile icon={SquareTerminal} label="Shell" title={`Pestaña nueva  ${shortcutLabel("newTab")}`} onClick={actions.newTab} />
        {(["claude", "codex"] as const).map((agent) => (
          <LaunchTile
            key={agent}
            icon={agent === "claude" ? Asterisk : Hexagon}
            label={agent === "claude" ? "Claude" : "Codex"}
            accent
            title={installed(agent) === false ? `${AGENTS[agent].title}: no instalado` : `${AGENTS[agent].title} en pestaña nueva`}
            unavailable={installed(agent) === false}
            onClick={() => actions.openAgentInTab(agent)}
            worktree={{ label: `${AGENTS[agent].title} en un worktree nuevo`, onClick: () => actions.openAgentInWorktree(agent) }}
          />
        ))}
      </div>
    </div>
  );
};

interface LaunchTileProps {
  icon: LucideIcon;
  label: string;
  title: string;
  accent?: boolean;
  unavailable?: boolean;
  onClick: () => void;
  /** Lo mismo, pero en un worktree propio (visible al pasar el cursor). */
  worktree?: { label: string; onClick: () => void };
}

const LaunchTile: React.FC<LaunchTileProps> = ({ icon: Icon, label, title, accent, unavailable, onClick, worktree }) => (
  <div className="group/tile relative">
    <button
      type="button"
      onClick={onClick}
      disabled={unavailable}
      title={title}
      className="flex w-full flex-col items-center gap-1 rounded-xl border border-line py-2 text-[11.5px] text-ink-2 transition-colors duration-150 hover:border-line-strong hover:bg-hover hover:text-ink disabled:cursor-not-allowed disabled:opacity-45"
    >
      <Icon size={15} strokeWidth={1.9} aria-hidden="true" className={accent && !unavailable ? "text-accent" : "text-ink-3"} />
      {label}
    </button>
    {worktree && !unavailable && (
      <button
        type="button"
        aria-label={worktree.label}
        title={worktree.label}
        onClick={worktree.onClick}
        className="absolute right-1 top-1 grid size-5 place-items-center rounded-md text-ink-3 opacity-0 transition-opacity duration-150 hover:bg-press hover:text-accent focus-visible:opacity-100 group-hover/tile:opacity-100"
      >
        <GitBranch size={11} strokeWidth={2} aria-hidden="true" />
      </button>
    )}
  </div>
);
