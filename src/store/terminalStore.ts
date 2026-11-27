import { create } from "zustand";
import type {
  AgentActivity,
  AgentKind,
  AgentSessionRef,
  AgentStatus,
  AgentsInfo,
  PaneNode,
  PaneShell,
  ShellInfo,
  SplitDirection,
  Tab,
  TabGroup,
  UsageSnapshot,
} from "../types/layout";
import { terminalManager } from "../terminal/TerminalManager";
import { collectPanes, equalize, findOwnerTab, findPane, movePane, removePane, replacePane, setSplitRatio, type DropZone } from "../lib/layout";
import { paneAgent } from "../lib/attention";
import * as grouping from "../lib/tabGroups";

let nextId = 1;
export const genId = (prefix: string) => `${prefix}-${Date.now().toString(36)}-${nextId++}`;

export interface PaneSpec {
  title?: string;
  cwd?: string;
  command?: string;
  /** Otra shell que la tuya (zsh, bash, fish, pwsh…). */
  shell?: PaneShell;
  /** Servidor SSH al que se conecta el panel (su nombre). */
  ssh?: string;
  agentType?: AgentKind | null;
}

export interface PaneProject {
  cwd: string;
  /** Nombre del repo que contiene `cwd`, o la carpeta si no hay repo. */
  name: string;
  /** Raíz del repo (null fuera de git): da el color estable del proyecto. */
  root: string | null;
}

export interface Attention {
  kind: string;
  message: string;
  at: number;
}

export interface PersistedSession {
  version: 1;
  tabs: Tab[];
  /** Grupos de pestañas (falta en sesiones de versiones anteriores). */
  groups?: TabGroup[];
  activeTabId: string;
  isSidebarOpen: boolean;
  /** Panel de proyecto abierto o plegado en su riel (falta en sesiones de versiones anteriores). */
  isProjectOpen?: boolean;
  /** Pestañas del visor (sin su contenido: vuelven limpias, leídas del disco). */
  fileTabs?: Array<{ root: string; path: string; markdown?: "preview" | "split" | "source" }>;
  /** Visor junto a las terminales y su ancho. */
  viewerDock?: { docked: boolean; width: number };
}

/** Lo necesario para reabrir algo cerrado (⌘⇧T): la shell ya murió, la carpeta no. */
export interface ClosedEntry {
  title: string;
  cwds: string[];
}

const MAX_CLOSED = 12;
/** Alto inicial de la shell acoplada: el agente sigue siendo lo principal. */
const DRAWER_RATIO = 0.35;

const loadingProvider = {
  status: "loading",
  plan: null,
  authMode: null,
  source: null,
  fetchedAt: null,
  windows: [],
  tokens24h: null,
  tokensByHour: null,
  message: null,
} as const;

function newPane(spec: PaneSpec = {}): PaneNode {
  return {
    id: genId("pane"),
    type: "pane",
    terminalId: genId("term"),
    title: spec.title ?? "zsh",
    cwd: spec.cwd,
    command: spec.command,
    ...(spec.shell && !spec.command ? { shell: spec.shell } : {}),
    ...(spec.ssh ? { ssh: spec.ssh } : {}),
    agentType: spec.agentType ?? null,
  };
}

function newTab(spec: PaneSpec = {}, title = "Terminal"): Tab {
  const pane = newPane(spec);
  return { id: genId("tab"), title, root: pane, activePaneId: pane.id };
}

/** Terminales de las shells acopladas de esos paneles (mueren con su panel). */
function drawerIds(panes: Array<PaneNode | undefined>): string[] {
  return panes.flatMap((p) => (p?.drawer ? [p.drawer.id] : []));
}

/** El panel que lleva esa shell acoplada, si lo hay. */
export function findDrawerOwner(tabs: Tab[], drawerId: string): PaneNode | undefined {
  for (const tab of tabs) {
    const pane = collectPanes(tab.root).find((p) => p.drawer?.id === drawerId);
    if (pane) return pane;
  }
  return undefined;
}

/**
 * La pestaña activa nunca queda escondida en un grupo plegado: si lo está, el
 * grupo se despliega (⌘3, la barra lateral o un aviso pueden llevarte ahí).
 */
function revealActive(groups: TabGroup[], tabs: Tab[], activeTabId: string): TabGroup[] {
  const groupId = tabs.find((t) => t.id === activeTabId)?.groupId;
  if (!groupId || !groups.some((g) => g.id === groupId && g.collapsed)) return groups;
  return groups.map((g) => (g.id === groupId ? { ...g, collapsed: false } : g));
}

function newGroup(groups: TabGroup[]): TabGroup {
  return { id: genId("group"), name: "", color: grouping.nextGroupColor(groups), collapsed: false };
}

function omit<T>(record: Record<string, T>, keys: string[]): Record<string, T> {
  if (!keys.some((k) => k in record)) return record;
  const next = { ...record };
  for (const key of keys) delete next[key];
  return next;
}

interface TerminalState {
  tabs: Tab[];
  groups: TabGroup[];
  activeTabId: string;
  isBroadcastEnabled: boolean;
  isUsageDrawerOpen: boolean;
  isSidebarOpen: boolean;
  usage: UsageSnapshot;
  closed: ClosedEntry[];
  agents: AgentsInfo | null;
  /** Shells instaladas (null hasta preguntar al sistema). */
  shells: ShellInfo[] | null;
  agentStatus: Record<string, AgentStatus>;
  agentActivity: Record<string, AgentActivity>;
  /** Agente escrito a mano que corre ahora en una shell (lo dice su integración: `claude`, `codex`). */
  runningAgent: Record<string, AgentKind>;
  /** Carpeta y proyecto (repo o carpeta) de cada panel, según la shell (OSC 7). */
  paneProject: Record<string, PaneProject>;
  /** Puertos TCP en escucha de cada panel o shell acoplada (servidores de desarrollo). */
  panePorts: Record<string, number[]>;
  attention: Record<string, Attention>;

  createTab: (spec?: PaneSpec) => void;
  closeTab: (tabId: string) => void;
  setActiveTab: (tabId: string) => void;
  splitPane: (targetPaneId: string, direction: SplitDirection, spec?: PaneSpec) => void;
  /**
   * Lleva un panel junto a otro de su misma pestaña (`center`: se intercambian).
   * Es el mismo proceso en otro sitio: nada se reinicia.
   */
  movePane: (sourceId: string, targetId: string, zone: DropZone) => void;
  closePane: (paneId: string) => void;
  setActivePane: (paneId: string, opts?: { focus?: boolean }) => void;
  updateSplitRatio: (splitId: string, ratio: number) => void;
  updatePaneTitle: (paneId: string, title: string) => void;
  toggleBroadcast: () => void;
  toggleUsageDrawer: () => void;
  toggleSidebar: () => void;
  renameTab: (tabId: string, title: string) => void;
  moveTab: (from: number, to: number) => void;
  /** Suelta una pestaña arrastrada. Devuelve el grupo nuevo, si nació uno. */
  dropTab: (tabId: string, drop: grouping.TabDrop) => string | null;
  moveGroup: (groupId: string, beforeTabId: string | null) => void;
  /** Grupo nuevo con esa pestaña. Devuelve su id. */
  groupTab: (tabId: string) => string | null;
  joinGroup: (tabId: string, groupId: string) => void;
  leaveGroup: (tabId: string) => void;
  ungroup: (groupId: string) => void;
  updateGroup: (groupId: string, patch: Partial<Pick<TabGroup, "name" | "color">>) => void;
  /**
   * Pliega o despliega. Plegar el grupo de la pestaña activa pasa a la de al
   * lado; si el grupo es todo lo que hay, no se pliega (devuelve false).
   */
  setGroupCollapsed: (groupId: string, collapsed: boolean) => boolean;
  toggleZoom: (paneId?: string) => void;
  equalizeSplits: () => void;
  rememberClosed: (entry: ClosedEntry) => void;
  popClosed: () => ClosedEntry | undefined;
  setUsage: (usage: UsageSnapshot) => void;
  setAgents: (agents: AgentsInfo) => void;
  setShells: (shells: ShellInfo[]) => void;
  setAgentStatus: (status: AgentStatus) => void;
  /** El agente del panel se fue: su modelo y su contexto ya no son de nadie. */
  clearAgentStatus: (paneId: string) => void;
  setRunningAgent: (paneId: string, agent: AgentKind | null) => void;
  setAgentActivity: (activity: AgentActivity) => void;
  /** El programa del panel se fue (OSC 7501 `clear` o volvió el prompt de la shell). */
  clearAgentActivity: (paneId: string) => void;
  setPaneProject: (paneId: string, project: PaneProject) => void;
  setPanePorts: (ports: Record<string, number[]>) => void;
  setAttention: (paneId: string, attention: Attention | null) => void;
  /** El agente del panel reportó su sesión: se guarda con el layout para poder reanudarla. */
  setAgentSession: (paneId: string, session: AgentSessionRef) => void;
  /** Abre, pliega o despliega la shell acoplada del panel (la crea la primera vez). */
  toggleDrawer: (paneId: string, open?: boolean) => void;
  setDrawerRatio: (paneId: string, ratio: number) => void;
  /** Cierra la shell acoplada (y su proceso). */
  closeDrawer: (paneId: string) => void;
  /** Cambia un panel por otro nuevo (otro proceso) en el mismo sitio. Devuelve el id nuevo. */
  replacePane: (paneId: string, spec: PaneSpec) => string | null;
  dismissResumable: (paneId: string) => void;
  hydrate: (session: PersistedSession) => void;
}

const firstTab = newTab();

export const useTerminalStore = create<TerminalState>((set, get) => ({
  tabs: [firstTab],
  groups: [],
  activeTabId: firstTab.id,
  isBroadcastEnabled: false,
  isUsageDrawerOpen: false,
  isSidebarOpen: false,
  closed: [],
  usage: { claude: { ...loadingProvider, windows: [] }, codex: { ...loadingProvider, windows: [] } },
  agents: null,
  shells: null,
  agentStatus: {},
  agentActivity: {},
  runningAgent: {},
  paneProject: {},
  panePorts: {},
  attention: {},

  createTab: (spec) => {
    const tab = newTab(spec);
    set((state) => ({ tabs: [...state.tabs, tab], activeTabId: tab.id }));
  },

  closeTab: (tabId) => {
    const { tabs, activeTabId } = get();
    const index = tabs.findIndex((t) => t.id === tabId);
    if (index === -1) return;

    const panes = collectPanes(tabs[index].root);
    const paneIds = panes.map((p) => p.id);
    [...paneIds, ...drawerIds(panes)].forEach((id) => terminalManager.kill(id));

    if (tabs.length === 1) {
      // Nunca quedarse sin pestañas: se reemplaza por una nueva.
      const fresh = newTab();
      set((state) => ({
        tabs: [fresh],
        groups: [],
        activeTabId: fresh.id,
        agentStatus: omit(state.agentStatus, paneIds),
        agentActivity: omit(state.agentActivity, paneIds),
        runningAgent: omit(state.runningAgent, paneIds),
        paneProject: omit(state.paneProject, paneIds),
        attention: omit(state.attention, paneIds),
      }));
      return;
    }

    const remaining = grouping.normalizeGroups(
      tabs.filter((t) => t.id !== tabId),
      get().groups,
    );
    const nextActive = activeTabId === tabId ? remaining.tabs[Math.max(0, index - 1)].id : activeTabId;
    set((state) => ({
      tabs: remaining.tabs,
      groups: revealActive(remaining.groups, remaining.tabs, nextActive),
      activeTabId: nextActive,
      agentStatus: omit(state.agentStatus, paneIds),
      agentActivity: omit(state.agentActivity, paneIds),
      runningAgent: omit(state.runningAgent, paneIds),
      paneProject: omit(state.paneProject, paneIds),
      attention: omit(state.attention, paneIds),
    }));
  },

  setActiveTab: (tabId) => {
    const { activeTabId, groups, tabs } = get();
    const visible = revealActive(groups, tabs, tabId);
    if (activeTabId === tabId && visible === groups) return;
    set({ activeTabId: tabId, groups: visible });
  },

  splitPane: (targetPaneId, direction, spec) => {
    const owner = findOwnerTab(get().tabs, targetPaneId);
    if (!owner) return;
    const pane = newPane(spec);
    const root = replacePane(owner.root, targetPaneId, (old) => ({
      id: genId("split"),
      type: "split",
      direction,
      ratio: 0.5,
      first: old,
      second: pane,
    }));
    set((state) => ({
      tabs: state.tabs.map((t) => (t.id === owner.id ? { ...t, root, activePaneId: pane.id } : t)),
    }));
  },

  movePane: (sourceId, targetId, zone) => {
    const { tabs } = get();
    const owner = findOwnerTab(tabs, sourceId);
    if (!owner || !findPane(owner.root, targetId)) return;
    const root = movePane(owner.root, sourceId, targetId, zone, genId("split"));
    if (root === owner.root) return;
    // Lo movido queda activo; uno maximizado ya no tiene sentido en la forma nueva.
    set({ tabs: tabs.map((t) => (t.id === owner.id ? { ...t, root, activePaneId: sourceId, zoomedPaneId: null } : t)) });
  },

  /** Funciona para cualquier pestaña (antes solo miraba la activa). */
  closePane: (paneId) => {
    const { tabs, activeTabId } = get();
    const owner = findOwnerTab(tabs, paneId);
    if (!owner) return;

    const root = removePane(owner.root, paneId);
    if (!root) {
      get().closeTab(owner.id);
      return;
    }

    terminalManager.kill(paneId);
    drawerIds([findPane(owner.root, paneId)]).forEach((id) => terminalManager.kill(id));
    const activePaneId =
      owner.activePaneId === paneId ? (collectPanes(root)[0]?.id ?? "") : owner.activePaneId;
    const zoomedPaneId = owner.zoomedPaneId === paneId || root.type === "pane" ? null : owner.zoomedPaneId;
    set((state) => ({
      tabs: state.tabs.map((t) => (t.id === owner.id ? { ...t, root, activePaneId, zoomedPaneId } : t)),
      agentStatus: omit(state.agentStatus, [paneId]),
      agentActivity: omit(state.agentActivity, [paneId]),
      runningAgent: omit(state.runningAgent, [paneId]),
      paneProject: omit(state.paneProject, [paneId]),
      attention: omit(state.attention, [paneId]),
    }));
    if (owner.id === activeTabId && activePaneId) {
      setTimeout(() => terminalManager.focus(activePaneId), 0);
    }
  },

  setActivePane: (paneId, opts) => {
    const { tabs, activeTabId } = get();
    const current = tabs.find((t) => t.id === activeTabId);
    if (current && findPane(current.root, paneId) && current.activePaneId !== paneId) {
      set({ tabs: tabs.map((t) => (t.id === activeTabId ? { ...t, activePaneId: paneId } : t)) });
    }
    if (opts?.focus !== false) terminalManager.focus(paneId);
  },

  updateSplitRatio: (splitId, ratio) => {
    const { tabs, activeTabId } = get();
    const current = tabs.find((t) => t.id === activeTabId);
    if (!current) return;
    const root = setSplitRatio(current.root, splitId, ratio);
    if (root === current.root) return;
    set({ tabs: tabs.map((t) => (t.id === activeTabId ? { ...t, root } : t)) });
  },

  updatePaneTitle: (paneId, title) => {
    const { tabs } = get();
    // El título llega por OSC desde cualquier pestaña, no solo la activa.
    const owner = findOwnerTab(tabs, paneId);
    if (!owner || findPane(owner.root, paneId)?.title === title) return;
    const root = replacePane(owner.root, paneId, (pane) => ({ ...pane, title }));
    set({ tabs: tabs.map((t) => (t.id === owner.id ? { ...t, root } : t)) });
  },

  toggleBroadcast: () => set((state) => ({ isBroadcastEnabled: !state.isBroadcastEnabled })),
  toggleUsageDrawer: () => set((state) => ({ isUsageDrawerOpen: !state.isUsageDrawerOpen })),
  toggleSidebar: () => set((state) => ({ isSidebarOpen: !state.isSidebarOpen })),

  renameTab: (tabId, title) => {
    const clean = title.trim().slice(0, 60);
    set((state) => ({
      tabs: state.tabs.map((t) => (t.id === tabId ? { ...t, customTitle: clean || undefined } : t)),
    }));
  },

  moveTab: (from, to) => {
    const tabs = [...get().tabs];
    if (from === to || from < 0 || to < 0 || from >= tabs.length || to >= tabs.length) return;
    const [moved] = tabs.splice(from, 1);
    tabs.splice(to, 0, moved);
    commitGrouping(grouping.normalizeGroups(tabs, get().groups));
  },

  dropTab: (tabId, drop) => {
    const { tabs, groups } = get();
    const result = grouping.dropTab({ tabs, groups }, tabId, drop, newGroup);
    commitGrouping(result);
    return result.created;
  },

  moveGroup: (groupId, beforeTabId) => {
    const { tabs, groups } = get();
    commitGrouping(grouping.moveGroup({ tabs, groups }, groupId, beforeTabId));
  },

  groupTab: (tabId) => {
    const { tabs, groups } = get();
    if (!tabs.some((t) => t.id === tabId)) return null;
    const group = newGroup(groups);
    commitGrouping(grouping.groupTab({ tabs, groups }, tabId, group));
    return group.id;
  },

  joinGroup: (tabId, groupId) => {
    const { tabs, groups } = get();
    commitGrouping(grouping.joinGroup({ tabs, groups }, tabId, groupId));
  },

  leaveGroup: (tabId) => {
    const { tabs, groups } = get();
    commitGrouping(grouping.leaveGroup({ tabs, groups }, tabId));
  },

  ungroup: (groupId) => {
    const { tabs, groups } = get();
    commitGrouping(grouping.ungroup({ tabs, groups }, groupId));
  },

  updateGroup: (groupId, patch) => {
    const { groups } = get();
    const current = groups.find((g) => g.id === groupId);
    if (!current) return;
    const name = patch.name === undefined ? current.name : grouping.cleanGroupName(patch.name);
    const color = patch.color && grouping.isGroupColor(patch.color) ? patch.color : current.color;
    if (name === current.name && color === current.color) return;
    set({ groups: groups.map((g) => (g.id === groupId ? { ...g, name, color } : g)) });
  },

  setGroupCollapsed: (groupId, collapsed) => {
    const { tabs, groups, activeTabId } = get();
    const current = groups.find((g) => g.id === groupId);
    if (!current) return false;
    if (current.collapsed === collapsed) return true;
    let nextActive = activeTabId;
    if (collapsed && tabs.find((t) => t.id === activeTabId)?.groupId === groupId) {
      const outside = grouping.tabOutsideGroup(tabs, groupId);
      if (!outside) return false;
      nextActive = outside.id;
    }
    set({ activeTabId: nextActive, groups: groups.map((g) => (g.id === groupId ? { ...g, collapsed } : g)) });
    return true;
  },

  toggleZoom: (paneId) => {
    const { tabs, activeTabId } = get();
    const tab = tabs.find((t) => t.id === activeTabId);
    if (!tab || tab.root.type === "pane") return;
    const target = paneId ?? tab.activePaneId;
    const zoomedPaneId = tab.zoomedPaneId === target ? null : target;
    set({ tabs: tabs.map((t) => (t.id === tab.id ? { ...t, zoomedPaneId, activePaneId: target } : t)) });
    setTimeout(() => terminalManager.focus(target), 0);
  },

  equalizeSplits: () => {
    const { tabs, activeTabId } = get();
    set({ tabs: tabs.map((t) => (t.id === activeTabId ? { ...t, root: equalize(t.root) } : t)) });
  },

  rememberClosed: (entry) => set((state) => ({ closed: [entry, ...state.closed].slice(0, MAX_CLOSED) })),

  popClosed: () => {
    const [entry, ...rest] = get().closed;
    if (entry) set({ closed: rest });
    return entry;
  },

  setUsage: (usage) => set({ usage }),
  setAgents: (agents) => set({ agents }),
  setShells: (shells) => set({ shells }),

  setAgentStatus: (status) => {
    if (!findOwnerTab(get().tabs, status.paneId)) return;
    set((state) => ({ agentStatus: { ...state.agentStatus, [status.paneId]: status } }));
  },

  clearAgentStatus: (paneId) => {
    const { agentStatus } = get();
    if (paneId in agentStatus) set({ agentStatus: omit(agentStatus, [paneId]) });
  },

  setRunningAgent: (paneId, agent) => {
    const { runningAgent, tabs } = get();
    if (runningAgent[paneId] === (agent ?? undefined)) return;
    if (!agent) {
      set({ runningAgent: omit(runningAgent, [paneId]) });
      return;
    }
    // Solo paneles: un `claude` en la shell acoplada no convierte al panel en otro agente.
    if (!findOwnerTab(tabs, paneId)) return;
    set({ runningAgent: { ...runningAgent, [paneId]: agent } });
  },

  setPanePorts: (ports) => {
    // Cada 4 s llega lo mismo: sin cambios no hay re-render.
    if (JSON.stringify(ports) !== JSON.stringify(get().panePorts)) set({ panePorts: ports });
  },

  setAgentActivity: (activity) => {
    if (!findOwnerTab(get().tabs, activity.paneId)) return;
    set((state) => ({ agentActivity: { ...state.agentActivity, [activity.paneId]: activity } }));
  },

  clearAgentActivity: (paneId) => {
    const { agentActivity } = get();
    if (paneId in agentActivity) set({ agentActivity: omit(agentActivity, [paneId]) });
  },

  setPaneProject: (paneId, project) => {
    const current = get().paneProject[paneId];
    if (!findOwnerTab(get().tabs, paneId)) return;
    if (current?.cwd === project.cwd && current.name === project.name && current.root === project.root) return;
    set((state) => ({ paneProject: { ...state.paneProject, [paneId]: project } }));
  },

  setAttention: (paneId, attention) => {
    const { attention: current, tabs } = get();
    if (attention === null) {
      if (paneId in current) set({ attention: omit(current, [paneId]) });
      return;
    }
    if (!findOwnerTab(tabs, paneId)) return;
    set({ attention: { ...current, [paneId]: attention } });
  },

  setAgentSession: (paneId, session) => {
    const { tabs } = get();
    const owner = findOwnerTab(tabs, paneId);
    const pane = owner ? findPane(owner.root, paneId) : undefined;
    if (!owner || !pane?.agentType) return;
    const current = pane.agentSession;
    // El hook de inicio no trae mensaje: se conserva el último conocido de la misma sesión.
    const prompt = session.prompt ?? (current?.id === session.id ? current.prompt : undefined);
    if (current?.id === session.id && current.prompt === prompt) return;
    const root = replacePane(owner.root, paneId, (p) => ({ ...p, agentSession: { ...session, prompt } }));
    set({ tabs: tabs.map((t) => (t.id === owner.id ? { ...t, root } : t)) });
  },

  toggleDrawer: (paneId, open) => {
    const { tabs } = get();
    const owner = findOwnerTab(tabs, paneId);
    const pane = owner ? findPane(owner.root, paneId) : undefined;
    if (!owner || !pane) return;
    const drawer = pane.drawer
      ? { ...pane.drawer, open: open ?? !pane.drawer.open }
      : { id: genId("drawer"), open: true, ratio: DRAWER_RATIO };
    const root = replacePane(owner.root, paneId, (p) => ({ ...p, drawer }));
    set({ tabs: tabs.map((t) => (t.id === owner.id ? { ...t, root } : t)) });
  },

  setDrawerRatio: (paneId, ratio) => {
    const { tabs } = get();
    const owner = findOwnerTab(tabs, paneId);
    const pane = owner ? findPane(owner.root, paneId) : undefined;
    if (!owner || !pane?.drawer) return;
    const clamped = Math.min(Math.max(ratio, 0.15), 0.75);
    const root = replacePane(owner.root, paneId, (p) => ({ ...p, drawer: p.drawer && { ...p.drawer, ratio: clamped } }));
    set({ tabs: tabs.map((t) => (t.id === owner.id ? { ...t, root } : t)) });
  },

  closeDrawer: (paneId) => {
    const { tabs } = get();
    const owner = findOwnerTab(tabs, paneId);
    const pane = owner ? findPane(owner.root, paneId) : undefined;
    if (!owner || !pane?.drawer) return;
    terminalManager.kill(pane.drawer.id);
    const root = replacePane(owner.root, paneId, ({ drawer: _drawer, ...rest }) => rest);
    set({ tabs: tabs.map((t) => (t.id === owner.id ? { ...t, root } : t)) });
  },

  replacePane: (paneId, spec) => {
    const { tabs } = get();
    const owner = findOwnerTab(tabs, paneId);
    if (!owner) return null;
    const fresh = newPane(spec);
    drawerIds([findPane(owner.root, paneId)]).forEach((id) => terminalManager.kill(id));
    const root = replacePane(owner.root, paneId, () => fresh);
    terminalManager.kill(paneId);
    set((state) => ({
      tabs: state.tabs.map((t) =>
        t.id === owner.id
          ? {
              ...t,
              root,
              activePaneId: t.activePaneId === paneId ? fresh.id : t.activePaneId,
              zoomedPaneId: t.zoomedPaneId === paneId ? fresh.id : t.zoomedPaneId,
            }
          : t,
      ),
      agentStatus: omit(state.agentStatus, [paneId]),
      agentActivity: omit(state.agentActivity, [paneId]),
      runningAgent: omit(state.runningAgent, [paneId]),
      paneProject: omit(state.paneProject, [paneId]),
      attention: omit(state.attention, [paneId]),
    }));
    return fresh.id;
  },

  dismissResumable: (paneId) => {
    const { tabs } = get();
    const owner = findOwnerTab(tabs, paneId);
    if (!owner || !findPane(owner.root, paneId)?.resumable) return;
    const root = replacePane(owner.root, paneId, (p) => ({ ...p, resumable: undefined }));
    set({ tabs: tabs.map((t) => (t.id === owner.id ? { ...t, root } : t)) });
  },

  hydrate: (session) => {
    if (!session.tabs.length) return;
    const { tabs, groups } = grouping.normalizeGroups(session.tabs, session.groups ?? []);
    const activeTabId = tabs.some((t) => t.id === session.activeTabId) ? session.activeTabId : tabs[0].id;
    set({
      tabs,
      groups: revealActive(groups, tabs, activeTabId),
      activeTabId,
      isSidebarOpen: session.isSidebarOpen,
    });
  },
}));

/** Aplica un cambio de pestañas/grupos con las invariantes y la activa a la vista. */
function commitGrouping(next: grouping.Grouping) {
  const { tabs, groups, activeTabId } = useTerminalStore.getState();
  const visible = revealActive(next.groups, next.tabs, activeTabId);
  if (next.tabs === tabs && visible === groups) return;
  useTerminalStore.setState({ tabs: next.tabs, groups: visible });
}

/** El agente del panel ahora: lanzado por termCode, anunciado por OSC 7501 o escrito a mano en la shell. */
export function liveAgent(state: Pick<TerminalState, "agentActivity" | "runningAgent">, pane: PaneNode): AgentKind | null {
  return paneAgent(pane, state.agentActivity[pane.id], state.runningAgent[pane.id]);
}

export const usePaneAgent = (pane: PaneNode | undefined): AgentKind | null =>
  useTerminalStore((s) => (pane ? liveAgent(s, pane) : null));
