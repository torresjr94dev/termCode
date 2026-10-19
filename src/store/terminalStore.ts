import { create } from "zustand";
import type {
  AgentKind,
  AgentStatus,
  AgentsInfo,
  PaneNode,
  SplitDirection,
  Tab,
  UsageSnapshot,
} from "../types/layout";
import { FONT_SIZE, terminalManager } from "../terminal/TerminalManager";
import { collectPanes, findOwnerTab, findPane, removePane, replacePane, setSplitRatio } from "../lib/layout";

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
  fontSize: number;
}

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
  fontSize: number;
  usage: UsageSnapshot;
  agents: AgentsInfo | null;
  agentStatus: Record<string, AgentStatus>;
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
  setFontSize: (size: number) => void;
  setUsage: (usage: UsageSnapshot) => void;
  setAgents: (agents: AgentsInfo) => void;
  setAgentStatus: (status: AgentStatus) => void;
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
  fontSize: FONT_SIZE.default,
  usage: { claude: { ...loadingProvider, windows: [] }, codex: { ...loadingProvider, windows: [] } },
  agents: null,
  agentStatus: {},
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
    set((state) => ({
      tabs: state.tabs.map((t) => (t.id === owner.id ? { ...t, root, activePaneId } : t)),
      agentStatus: omit(state.agentStatus, [paneId]),
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

  setFontSize: (size) => {
    const clamped = Math.min(Math.max(Math.round(size), FONT_SIZE.min), FONT_SIZE.max);
    if (clamped === get().fontSize) return;
    terminalManager.setFontSize(clamped);
    set({ fontSize: clamped });
  },

  setUsage: (usage) => set({ usage }),
  setAgents: (agents) => set({ agents }),

  setAgentStatus: (status) => {
    if (!findOwnerTab(get().tabs, status.paneId)) return;
    set((state) => ({ agentStatus: { ...state.agentStatus, [status.paneId]: status } }));
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
    terminalManager.setFontSize(session.fontSize);
    set({
      tabs: session.tabs,
      activeTabId: session.tabs.some((t) => t.id === session.activeTabId)
        ? session.activeTabId
        : session.tabs[0].id,
      isSidebarOpen: session.isSidebarOpen,
      fontSize: session.fontSize,
    });
  },
}));
