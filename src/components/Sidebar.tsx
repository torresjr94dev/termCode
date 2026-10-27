import React, { useEffect } from "react";
import {
  Asterisk,
  ChevronDown,
  Columns2,
  Folder,
  GitBranch,
  Hexagon,
  Pencil,
  Pin,
  PinOff,
  Plus,
  Search,
  Server,
  SquareTerminal,
  Trash2,
  X,
  type LucideIcon,
} from "lucide-react";
import { liveAgent, usePaneAgent, useTerminalStore, type PaneProject } from "../store/terminalStore";
import { useApprovalStore } from "../store/approvalStore";
import { useProjectStore } from "../store/projectStore";
import { placesToShow, useSidebarStore, type SidebarSection } from "../store/sidebarStore";
import { useUiStore } from "../store/uiStore";
import { actions, AGENTS, type AgentKind } from "../lib/actions";
import { basename, cn, collectPanes, findPane } from "../lib/layout";
import { paneDisplayName, projectTone, shortCommand, tabDisplayName } from "../lib/identity";
import { formatDuration } from "../lib/format";
import { agentStateOf } from "../lib/attention";
import { parentDir } from "../lib/cd";
import { shortcutLabel, tabShortcutLabel } from "../lib/shortcuts";
import { useLastCommand } from "../terminal/useRunningCommand";
import { terminalManager } from "../terminal/TerminalManager";
import type { PaneNode, Tab } from "../types/layout";
import { Kbd, Lamp, Ring, SectionLabel, toneFor } from "./ui";
import { LogoMark } from "./Logo";
import { SystemPanel } from "./SystemMonitor";
import { PortChips } from "./PortChips";
import { relativeInside, tildify } from "../lib/paths";
import { ipc } from "../lib/ipc";
import { describeServer, sshAliasCommand, sshServerCommand } from "../lib/ssh";

/** Carpetas recientes a la vista (las fijadas se muestran todas). */
const PLACES_SHOWN = 5;

/**
 * Barra lateral: arriba buscar/ejecutar; en medio tus sesiones, cada una con
 * su carpeta, su rama y lo último que pasó; abajo tus carpetas, el sistema y
 * abrir algo nuevo. Las secciones de abajo se pliegan y lo recuerdan.
 */
export const Sidebar: React.FC = () => {
  const isOpen = useTerminalStore((s) => s.isSidebarOpen);
  const tabs = useTerminalStore((s) => s.tabs);
  const activeTabId = useTerminalStore((s) => s.activeTabId);

  if (!isOpen) return null;

  return (
    <aside aria-label="Sesiones" className="flex h-full w-64 shrink-0 flex-col bg-chrome">
      {/* Zona de arrastre a la altura del header (es parte de la barra de título): aquí
          viven los semáforos de macOS; la marca, a la derecha (no captura el arrastre). */}
      <div data-tauri-drag-region className="flex h-11 shrink-0 items-center justify-end pr-3.5">
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

      <nav aria-label="Pestañas abiertas" className="flex min-h-16 flex-1 flex-col overflow-y-auto px-2 pb-2">
        <SectionLabel aside={tabs.length}>Sesiones</SectionLabel>
        <ul className="flex flex-col gap-0.5">
          {tabs.map((tab, index) => (
            <SessionItem key={tab.id} tab={tab} index={index} active={tab.id === activeTabId} />
          ))}
        </ul>
      </nav>

      <PlacesSection />
      <ServersSection />
      <CollapsibleSection id="system" title="Sistema">
        {(open) => <SystemPanel active={open} />}
      </CollapsibleSection>
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
  const project = paneProject[lead.id];

  return (
    <li className={cn("group/session rounded-xl transition-colors duration-150", grouped && "glass-pill pb-1.5")}>
      <div className="relative">
        <button
          type="button"
          aria-current={active ? "page" : undefined}
          title={shortcut ? `${label}  ${shortcut}` : label}
          onClick={() => setActiveTab(tab.id)}
          className={cn(
            "flex w-full items-start gap-2.5 rounded-xl px-2 py-1.5 text-left transition-colors duration-150",
            active ? cn("text-ink", !grouped && "glass-pill") : "text-ink-2 hover:bg-hover hover:text-ink",
          )}
        >
          <SessionIcon pane={lead} project={project} />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[13px] font-medium leading-5">{label}</span>
            <PaneWhere pane={lead} project={project} />
            <PaneActivity pane={lead} extraPanes={!active && panes.length > 1 ? panes.length : 0} />
            <ContextLine pane={lead} />
          </span>
          <span className="flex shrink-0 items-center gap-1.5 pr-0.5 pt-0.5 transition-opacity duration-150 group-hover/session:opacity-0">
            {needsAttention && <Lamp state="attention" />}
            {shortcut && !needsAttention && <span className="font-mono text-[10.5px] text-ink-3/80">{shortcut}</span>}
          </span>
        </button>
        <button
          type="button"
          aria-label={`Cerrar ${label}`}
          onClick={() => actions.closeTab(tab.id)}
          className="absolute right-2 top-2 grid size-6 place-items-center rounded-md text-ink-3 opacity-0 transition-opacity duration-150 hover:bg-press hover:text-ink focus-visible:opacity-100 group-hover/session:opacity-100"
        >
          <X size={12} strokeWidth={2} aria-hidden="true" />
        </button>
      </div>

      {/* Fuera del botón de la sesión (un botón no puede ir dentro de otro). */}
      <PortChips paneId={lead.id} className="-mt-0.5 pb-1.5 pl-[46px] pr-2" />
      {grouped && <PaneList tab={tab} panes={panes} />}
    </li>
  );
};

/** Paneles de la pestaña activa, cada uno con su carpeta (dos «Claude Code» dejan de verse iguales). */
const PaneList: React.FC<{ tab: Tab; panes: PaneNode[] }> = ({ tab, panes }) => {
  const paneProject = useTerminalStore((s) => s.paneProject);
  const agentActivity = useTerminalStore((s) => s.agentActivity);
  const runningAgent = useTerminalStore((s) => s.runningAgent);
  const attention = useTerminalStore((s) => s.attention);
  const approvals = useApprovalStore((s) => s.requests);
  return (
    <ul aria-label="Paneles" className="mx-1.5 mt-0.5 flex flex-col gap-px">
      {panes.map((pane) => {
        const focused = pane.id === tab.activePaneId;
        const cwd = paneProject[pane.id]?.cwd ?? pane.cwd;
        const agent = liveAgent({ agentActivity, runningAgent }, pane);
        const Icon = agent === "codex" ? Hexagon : agent === "claude" ? Asterisk : SquareTerminal;
        return (
          <li key={pane.id}>
            <button
              type="button"
              onClick={() => actions.focusPane(tab.id, pane.id)}
              title={cwd ?? undefined}
              className={cn(
                "flex h-7 w-full items-center gap-2 rounded-lg px-2 text-left transition-colors duration-150",
                focused ? "bg-hover text-ink" : "text-ink-3 hover:bg-hover hover:text-ink-2",
              )}
            >
              <Icon size={12.5} strokeWidth={1.9} aria-hidden="true" className={cn("shrink-0", agent && "text-accent")} />
              <span className="min-w-0 shrink truncate text-[12.5px]">{paneDisplayName(pane, paneProject[pane.id])}</span>
              {cwd && <span className="min-w-0 flex-1 truncate font-mono text-[10.5px] text-ink-3">{basename(cwd)}</span>}
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
  const agent = usePaneAgent(pane);
  const Icon = agent === "codex" ? Hexagon : agent === "claude" ? Asterisk : pane.ssh ? Server : SquareTerminal;
  return (
    <span
      className={cn(
        "relative mt-0.5 grid size-7 shrink-0 place-items-center rounded-[9px]",
        agent ? "bg-accent/12 text-accent" : "bg-hover text-ink-3",
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

/**
 * Dónde está parado el panel, siempre (también los agentes): el repo y la
 * subcarpeta, o la carpeta con `~`, y la rama si se conoce.
 */
const PaneWhere: React.FC<{ pane: PaneNode; project?: PaneProject }> = ({ pane, project }) => {
  const cwd = project?.cwd ?? pane.cwd;
  // La rama la sabe el panel de proyecto (sigue al panel activo): vale para todos los del mismo repo.
  const branch = useProjectStore((s) => (project?.root && s.repo?.root === project.root ? s.status?.branch : null));
  if (!cwd) return null;
  const text = where(cwd, project);
  return (
    <span title={branch ? `${cwd}  ·  ${branch}` : cwd} className="flex min-w-0 items-center gap-1 font-mono text-[10.5px] leading-4 text-ink-3">
      <Folder size={10} strokeWidth={2} aria-hidden="true" className="shrink-0 opacity-80" />
      <span className="min-w-0 truncate">{text}</span>
      {branch && (
        <span className="flex min-w-0 shrink-[2] items-center gap-0.5">
          <GitBranch size={10} strokeWidth={2} aria-hidden="true" className="shrink-0 opacity-80" />
          <span className="truncate">{branch}</span>
        </span>
      )}
    </span>
  );
};

/** Qué hace: el agente (trabajando, te necesita) o el último comando de la shell, con su resultado. */
const PaneActivity: React.FC<{ pane: PaneNode; extraPanes: number }> = ({ pane, extraPanes }) => {
  const activity = useTerminalStore((s) => s.agentActivity[pane.id]);
  const attention = useTerminalStore((s) => s.attention[pane.id]);
  const waiting = useApprovalStore((s) => s.requests.some((r) => r.paneId === pane.id));
  const last = useLastCommand(pane.id);
  const agent = usePaneAgent(pane);

  let text: string | null = null;
  let tone = "text-ink-3";
  if (agent) {
    const state = agentStateOf(activity, attention, waiting);
    if (state === "needs-input") {
      text = waiting ? "Espera tu permiso" : "Te necesita";
      tone = "text-warn";
    } else if (state === "working" && activity) {
      text = activity.detail || "Trabajando…";
      tone = "text-accent";
    } else {
      text = "Esperando instrucciones";
    }
  } else if (last?.command) {
    const command = shortCommand(last.command.split("\n")[0], 4);
    if (last.endedAt === null) {
      text = `▸ ${command}`;
      tone = "text-ink-2";
    } else {
      const ok = last.exitCode === 0;
      text = `${ok ? "✓" : `✗ ${last.exitCode ?? "?"}`} ${command} · ${formatDuration(last.endedAt - last.startedAt)}`;
      tone = ok ? "text-ink-3" : "text-del";
    }
  }
  const prefix = extraPanes ? `${extraPanes} paneles · ` : "";
  if (!text && !prefix) return null;
  return (
    <span title={`${prefix}${text ?? ""}`} className={cn("block truncate font-mono text-[10.5px] leading-4", tone)}>
      {prefix}
      {text}
    </span>
  );
};

/** El repo si lo hay; si no, la carpeta con `~`. */
function where(cwd: string, project?: PaneProject): string {
  const inside = project?.root ? relativeInside(cwd, project.root) : null;
  if (project && inside !== null) return inside ? `${project.name} / ${inside}` : project.name;
  return tildify(cwd, terminalManager.getHome());
}

/** Contexto que le queda al agente: barra de lo usado y cuánto queda, escrito. */
const ContextLine: React.FC<{ pane: PaneNode }> = ({ pane }) => {
  const status = useTerminalStore((s) => s.agentStatus[pane.id]);
  const agent = usePaneAgent(pane);
  if (!agent || status?.contextPercent == null) return null;
  const used = Math.min(Math.max(status.contextPercent, 0), 100);
  const tone = toneFor(used);
  return (
    <span title={`Contexto: ${Math.round(used)} % usado, queda ${Math.round(100 - used)} %`} className="mt-1 flex items-center gap-2">
      <span className="h-[3px] min-w-0 flex-1 overflow-hidden rounded-full bg-line">
        <span
          className={cn("block h-full rounded-full transition-[width] duration-500", tone === "alert" ? "bg-signal" : tone === "warn" ? "bg-warn" : "bg-accent")}
          style={{ width: `${used}%` }}
        />
      </span>
      <span className={cn("shrink-0 font-mono text-[10px] tabular-nums", tone === "alert" ? "text-signal" : tone === "warn" ? "text-warn" : "text-ink-3")}>
        {Math.round(100 - used)}% libre
      </span>
    </span>
  );
};

/** Contexto del agente en la lista compacta de paneles: el anillo se llena con lo usado, el número es lo que queda. */
const ContextBadge: React.FC<{ pane: PaneNode }> = ({ pane }) => {
  const status = useTerminalStore((s) => s.agentStatus[pane.id]);
  const agent = usePaneAgent(pane);
  if (!agent || status?.contextPercent == null) return null;
  const free = Math.round(100 - status.contextPercent);
  return (
    <span title={`Contexto: queda ${free} %`} className="flex shrink-0 items-center gap-1 font-mono text-[10.5px] tabular-nums text-ink-3">
      <Ring value={status.contextPercent} size={12} stroke={2} />
      {free}%
    </span>
  );
};

/* ------------------------------------------------------------------ */
/* Secciones plegables                                                 */
/* ------------------------------------------------------------------ */

const CollapsibleSection: React.FC<{
  id: SidebarSection;
  title: string;
  aside?: React.ReactNode;
  children: (open: boolean) => React.ReactNode;
}> = ({ id, title, aside, children }) => {
  const collapsed = useSidebarStore((s) => Boolean(s.collapsed[id]));
  const toggle = useSidebarStore((s) => s.toggleSection);
  return (
    <section aria-label={title} className="shrink-0 border-t border-line px-2 pb-2 pt-1.5">
      <div className="flex h-6 items-center gap-1">
        <button
          type="button"
          aria-expanded={!collapsed}
          onClick={() => toggle(id)}
          className="flex h-full min-w-0 flex-1 items-center gap-1 rounded-md px-1 text-[10.5px] font-semibold uppercase tracking-[0.08em] text-ink-3 transition-colors duration-150 hover:text-ink-2"
        >
          <ChevronDown size={11} strokeWidth={2.25} aria-hidden="true" className={cn("transition-transform duration-150", collapsed && "-rotate-90")} />
          <span className="flex-1 text-left">{title}</span>
        </button>
        {aside}
      </div>
      {!collapsed && <div className="pt-0.5">{children(true)}</div>}
    </section>
  );
};

/* ------------------------------------------------------------------ */
/* Carpetas recientes y fijadas                                        */
/* ------------------------------------------------------------------ */

const PlacesSection: React.FC = () => {
  const recent = useSidebarStore((s) => s.recent);
  const pinned = useSidebarStore((s) => s.pinned);
  const places = placesToShow({ recent, pinned }, PLACES_SHOWN);
  return (
    <CollapsibleSection id="places" title="Carpetas">
      {() =>
        places.length ? (
          <ul className="flex flex-col gap-px">
            {places.map((place) => (
              <PlaceRow key={place.path} path={place.path} pinned={place.pinned} />
            ))}
          </ul>
        ) : (
          <p className="px-2 py-1 text-[11.5px] leading-4 text-ink-3">Aquí aparecen las carpetas donde trabajas, para volver en un clic.</p>
        )
      }
    </CollapsibleSection>
  );
};

const PlaceRow: React.FC<{ path: string; pinned: boolean }> = ({ path, pinned }) => {
  const togglePin = useSidebarStore((s) => s.togglePin);
  const agents = useTerminalStore((s) => s.agents);
  const parent = parentDir(path);
  const installed = (agent: AgentKind) => !agents || Boolean(agents[agent]);
  const open: Array<{ icon: LucideIcon; label: string; run: () => void; accent?: boolean; hidden?: boolean }> = [
    { icon: SquareTerminal, label: "Shell aquí, en pestaña nueva", run: () => actions.openHere("shell", path) },
    { icon: Asterisk, label: `${AGENTS.claude.title} aquí`, run: () => actions.openHere("claude", path), accent: true, hidden: !installed("claude") },
    { icon: Hexagon, label: `${AGENTS.codex.title} aquí`, run: () => actions.openHere("codex", path), accent: true, hidden: !installed("codex") },
  ];
  // Las acciones entran en la fila (no flotan encima): al pasar el cursor la ruta del
  // padre cede su sitio y el nombre se recorta, nunca queda tapado.
  return (
    <li className="group/place flex h-7 items-center rounded-lg transition-colors duration-150 hover:bg-hover focus-within:bg-hover">
      <button
        type="button"
        onClick={() => void actions.cdTo(path)}
        title={`${path}\nClic: ir ahí (cd en la terminal activa)`}
        className="flex h-full min-w-0 flex-1 items-center gap-2 rounded-lg pl-2 pr-1 text-left"
      >
        <Folder size={12.5} strokeWidth={1.9} aria-hidden="true" className={cn("shrink-0", pinned ? "text-accent" : "text-ink-3")} />
        <span className="min-w-0 shrink truncate text-[12.5px] text-ink-2">{basename(path)}</span>
        {parent && (
          <span className="min-w-0 flex-1 truncate font-mono text-[10.5px] text-ink-3 group-focus-within/place:hidden group-hover/place:hidden">
            {tildify(parent, terminalManager.getHome())}
          </span>
        )}
      </button>
      <span className="hidden shrink-0 items-center pr-0.5 group-focus-within/place:flex group-hover/place:flex">
        {open
          .filter((o) => !o.hidden)
          .map(({ icon: Icon, label, run, accent }) => (
            <button
              key={label}
              type="button"
              aria-label={label}
              title={label}
              onClick={run}
              className="grid size-6 place-items-center rounded-md text-ink-3 transition-colors duration-150 hover:bg-press hover:text-ink"
            >
              <Icon size={12} strokeWidth={2} aria-hidden="true" className={accent ? "text-accent/80" : undefined} />
            </button>
          ))}
        <button
          type="button"
          aria-label={pinned ? `Quitar ${basename(path)} de fijadas` : `Fijar ${basename(path)}`}
          title={pinned ? "Quitar de fijadas" : "Fijar arriba"}
          onClick={() => togglePin(path)}
          className="grid size-6 place-items-center rounded-md text-ink-3 transition-colors duration-150 hover:bg-press hover:text-ink"
        >
          {pinned ? <PinOff size={12} strokeWidth={2} aria-hidden="true" /> : <Pin size={12} strokeWidth={2} aria-hidden="true" />}
        </button>
      </span>
    </li>
  );
};

/* ------------------------------------------------------------------ */
/* Servidores SSH                                                      */
/* ------------------------------------------------------------------ */

/** Los de tu ~/.ssh/config y los que agregaste aquí: un clic abre una pestaña conectada. */
const ServersSection: React.FC = () => {
  const hosts = useSidebarStore((s) => s.sshHosts);
  const servers = useSidebarStore((s) => s.servers);
  const removeServer = useSidebarStore((s) => s.removeServer);
  const count = hosts.length + servers.length;

  // Al desplegar se relee ~/.ssh/config (pudiste agregar un Host desde la terminal).
  const collapsed = useSidebarStore((s) => Boolean(s.collapsed.servers));
  useEffect(() => {
    if (!collapsed) void ipc.sshHosts().then((list) => list && useSidebarStore.getState().setSshHosts(list));
  }, [collapsed]);

  const add = (
    <button
      type="button"
      aria-label="Agregar servidor SSH"
      title="Agregar servidor SSH"
      onClick={() => useUiStore.getState().setSshDialog({})}
      className="grid size-6 shrink-0 place-items-center rounded-md text-ink-3 transition-colors duration-150 hover:bg-press hover:text-ink focus-visible:outline-2 focus-visible:outline-accent"
    >
      <Plus size={12} strokeWidth={2.25} aria-hidden="true" />
    </button>
  );

  return (
    <CollapsibleSection id="servers" title="Servidores" aside={add}>
      {() =>
        count ? (
          <ul className="flex max-h-44 flex-col gap-px overflow-y-auto">
            {servers.map((server) => (
              <ServerRow
                key={server.id}
                name={server.name}
                detail={describeServer(server.user || null, server.host, server.port)}
                command={sshServerCommand(server)}
                onEdit={() => useUiStore.getState().setSshDialog({ id: server.id })}
                onRemove={() =>
                  useUiStore.getState().askConfirm({
                    title: `¿Quitar ${server.name}?`,
                    body: "Solo se borra de termCode; el servidor y tus llaves no se tocan.",
                    confirmLabel: "Quitar",
                    onConfirm: () => removeServer(server.id),
                  })
                }
              />
            ))}
            {hosts.map((host) => (
              <ServerRow
                key={`config-${host.alias}`}
                name={host.alias}
                detail={describeServer(host.user, host.hostName ?? host.alias, host.port)}
                command={sshAliasCommand(host.alias)}
                fromConfig
              />
            ))}
          </ul>
        ) : (
          <p className="px-2 py-1 text-[11.5px] leading-4 text-ink-3">Agrega un servidor con + o define un Host en ~/.ssh/config.</p>
        )
      }
    </CollapsibleSection>
  );
};

const ServerRow: React.FC<{
  name: string;
  detail: string;
  command: string | null;
  fromConfig?: boolean;
  onEdit?: () => void;
  onRemove?: () => void;
}> = ({ name, detail, command, fromConfig, onEdit, onRemove }) => {
  const extra: Array<{ icon: LucideIcon; label: string; run: () => void; danger?: boolean }> = [
    { icon: Columns2, label: `Conectar a ${name} junto al panel`, run: () => actions.connectSsh(name, command, "split") },
    ...(onEdit ? [{ icon: Pencil, label: `Editar ${name}`, run: onEdit }] : []),
    ...(onRemove ? [{ icon: Trash2, label: `Quitar ${name}`, run: onRemove, danger: true }] : []),
  ];
  return (
    <li className="group/server flex h-7 items-center rounded-lg transition-colors duration-150 hover:bg-hover focus-within:bg-hover">
      <button
        type="button"
        onClick={() => actions.connectSsh(name, command)}
        title={`${detail}${fromConfig ? "\nDe tu ~/.ssh/config" : ""}\nClic: conectar en una pestaña nueva`}
        className="flex h-full min-w-0 flex-1 items-center gap-2 rounded-lg pl-2 pr-1 text-left"
      >
        <Server size={12.5} strokeWidth={1.9} aria-hidden="true" className="shrink-0 text-ink-3" />
        <span className="min-w-0 shrink truncate text-[12.5px] text-ink-2">{name}</span>
        <span className="min-w-0 flex-1 truncate font-mono text-[10.5px] text-ink-3 group-focus-within/server:hidden group-hover/server:hidden">
          {detail}
        </span>
      </button>
      <span className="hidden shrink-0 items-center pr-0.5 group-focus-within/server:flex group-hover/server:flex">
        {extra.map(({ icon: Icon, label, run, danger }) => (
          <button
            key={label}
            type="button"
            aria-label={label}
            title={label}
            onClick={run}
            className={cn(
              "grid size-6 place-items-center rounded-md text-ink-3 transition-colors duration-150 hover:bg-press",
              danger ? "hover:text-signal" : "hover:text-ink",
            )}
          >
            <Icon size={12} strokeWidth={2} aria-hidden="true" />
          </button>
        ))}
      </span>
    </li>
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
    <div className="shrink-0 border-t border-line px-2.5 pb-3 pt-2">
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

/** Compacto: ícono y nombre en una fila, para dejar el alto a las sesiones. */
const LaunchTile: React.FC<LaunchTileProps> = ({ icon: Icon, label, title, accent, unavailable, onClick, worktree }) => (
  <div className="group/tile relative">
    <button
      type="button"
      onClick={onClick}
      disabled={unavailable}
      title={title}
      className="flex h-8 w-full items-center justify-center gap-1.5 rounded-[10px] border border-line text-[11.5px] text-ink-2 transition-colors duration-150 hover:border-line-strong hover:bg-hover hover:text-ink disabled:cursor-not-allowed disabled:opacity-45"
    >
      <Icon size={13} strokeWidth={1.9} aria-hidden="true" className={accent && !unavailable ? "text-accent" : "text-ink-3"} />
      {label}
    </button>
    {worktree && !unavailable && (
      <button
        type="button"
        aria-label={worktree.label}
        title={worktree.label}
        onClick={worktree.onClick}
        className="absolute -right-1 -top-1 grid size-[18px] place-items-center rounded-full border border-line bg-chrome text-ink-3 opacity-0 transition-opacity duration-150 hover:text-accent focus-visible:opacity-100 group-hover/tile:opacity-100"
      >
        <GitBranch size={10} strokeWidth={2} aria-hidden="true" />
      </button>
    )}
  </div>
);
