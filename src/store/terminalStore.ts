import { create } from "zustand";
import type {
  AgentActivity,
  AgentKind,
  AgentStatus,
  AgentsInfo,
  PaneNode,
  SplitDirection,
  Tab,
  UsageSnapshot,
} from "../types/layout";
import { terminalManager } from "../terminal/TerminalManager";
import { collectPanes, equalize, findOwnerTab, findPane, removePane, replacePane, setSplitRatio } from "../lib/layout";

let nextId = 1;
export const genId = (prefix: string) => `${prefix}-${Date.now().toString(36)}-${nextId++}`;

export interface PaneSpec {
  title?: string;
  cwd?: string;
  command?: string;
  agentType?: AgentKind | null;
}

export interface Attention {
  kind: string;
  message: string;
  at: number;
}

export interface PersistedSession {
  version: 1;
  tabs: Tab[];
  activeTabId: string;
  isSidebarOpen: boolean;
}

/** Lo necesario para reabrir algo cerrado (⌘⇧T): la shell ya murió, la carpeta no. */
export interface ClosedEntry {
  title: string;
  cwds: string[];
}

const MAX_CLOSED = 12;

const loadingProvider = {
  status: "loading",
  plan: null,
  authMode: null,
  source: null,
  fetchedAt: null,
  windows: [],
  tokens24h: null,
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
    agentType: spec.agentType ?? null,
  };
}

function newTab(spec: PaneSpec = {}, title = "Terminal"): Tab {
  const pane = newPane(spec);
  return { id: genId("tab"), title, root: pane, activePaneId: pane.id };
}

function omit<T extends object>(record: Record<string, T>, keys: string[]): Record<string, T> {
  if (!keys.some((k) => k in record)) return record;
  const next = { ...record };
  for (const key of keys) delete next[key];
  return next;
}

interface TerminalState {
  tabs: Tab[];
  activeTabId: string;
  isBroadcastEnabled: boolean;
  isUsageDrawerOpen: boolean;
  isSidebarOpen: boolean;
  usage: UsageSnapshot;
  closed: ClosedEntry[];
  agents: AgentsInfo | null;
  agentStatus: Record<string, AgentStatus>;
  agentActivity: Record<string, AgentActivity>;
  attention: Record<string, Attention>;

  createTab: (spec?: PaneSpec) => void;
  closeTab: (tabId: string) => void;
  setActiveTab: (tabId: string) => void;
  splitPane: (targetPaneId: string, direction: SplitDirection, spec?: PaneSpec) => void;
  closePane: (paneId: string) => void;
  setActivePane: (paneId: string, opts?: { focus?: boolean }) => void;
  updateSplitRatio: (splitId: string, ratio: number) => void;
  updatePaneTitle: (paneId: string, title: string) => void;
  toggleBroadcast: () => void;
  toggleUsageDrawer: () => void;
  toggleSidebar: () => void;
  renameTab: (tabId: string, title: string) => void;
  moveTab: (from: number, to: number) => void;
  toggleZoom: (paneId?: string) => void;
  equalizeSplits: () => void;
  rememberClosed: (entry: ClosedEntry) => void;
  popClosed: () => ClosedEntry | undefined;
  setUsage: (usage: UsageSnapshot) => void;
  setAgents: (agents: AgentsInfo) => void;
  setAgentStatus: (status: AgentStatus) => void;
  setAgentActivity: (activity: AgentActivity) => void;
  setAttention: (paneId: string, attention: Attention | null) => void;
  hydrate: (session: PersistedSession) => void;
}

const firstTab = newTab();

export const useTerminalStore = create<TerminalState>((set, get) => ({
  tabs: [firstTab],
  activeTabId: firstTab.id,
  isBroadcastEnabled: false,
  isUsageDrawerOpen: false,
  isSidebarOpen: false,
  closed: [],
  usage: { claude: { ...loadingProvider, windows: [] }, codex: { ...loadingProvider, windows: [] } },
  agents: null,
  agentStatus: {},
  agentActivity: {},
  attention: {},

  createTab: (spec) => {
    const tab = newTab(spec);
    set((state) => ({ tabs: [...state.tabs, tab], activeTabId: tab.id }));
  },

  closeTab: (tabId) => {
    const { tabs, activeTabId } = get();
    const index = tabs.findIndex((t) => t.id === tabId);
    if (index === -1) return;

    const paneIds = collectPanes(tabs[index].root).map((p) => p.id);
    paneIds.forEach((id) => terminalManager.kill(id));

    if (tabs.length === 1) {
      // Nunca quedarse sin pestañas: se reemplaza por una nueva.
      const fresh = newTab();
      set((state) => ({
        tabs: [fresh],
        activeTabId: fresh.id,
        agentStatus: omit(state.agentStatus, paneIds),
        agentActivity: omit(state.agentActivity, paneIds),
        attention: omit(state.attention, paneIds),
      }));
      return;
    }

    const remaining = tabs.filter((t) => t.id !== tabId);
    const nextActive = activeTabId === tabId ? remaining[Math.max(0, index - 1)].id : activeTabId;
    set((state) => ({
      tabs: remaining,
      activeTabId: nextActive,
      agentStatus: omit(state.agentStatus, paneIds),
      agentActivity: omit(state.agentActivity, paneIds),
      attention: omit(state.attention, paneIds),
    }));
  },

  setActiveTab: (tabId) => {
    if (get().activeTabId === tabId) return;
    set({ activeTabId: tabId });
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
    const activePaneId =
      owner.activePaneId === paneId ? (collectPanes(root)[0]?.id ?? "") : owner.activePaneId;
    const zoomedPaneId = owner.zoomedPaneId === paneId || root.type === "pane" ? null : owner.zoomedPaneId;
    set((state) => ({
      tabs: state.tabs.map((t) => (t.id === owner.id ? { ...t, root, activePaneId, zoomedPaneId } : t)),
      agentStatus: omit(state.agentStatus, [paneId]),
      agentActivity: omit(state.agentActivity, [paneId]),
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
    set({ tabs });
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

  setAgentStatus: (status) => {
    if (!findOwnerTab(get().tabs, status.paneId)) return;
    set((state) => ({ agentStatus: { ...state.agentStatus, [status.paneId]: status } }));
  },

  setAgentActivity: (activity) => {
    if (!findOwnerTab(get().tabs, activity.paneId)) return;
    set((state) => ({ agentActivity: { ...state.agentActivity, [activity.paneId]: activity } }));
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

  hydrate: (session) => {
    if (!session.tabs.length) return;
    set({
      tabs: session.tabs,
      activeTabId: session.tabs.some((t) => t.id === session.activeTabId)
        ? session.activeTabId
        : session.tabs[0].id,
      isSidebarOpen: session.isSidebarOpen,
    });
  },
}));
