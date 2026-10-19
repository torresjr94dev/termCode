import { create } from "zustand";
import { Tab, LayoutNode, PaneNode, SplitDirection, AIUsageState } from "../types/layout";
import { terminalManager } from "../terminal/TerminalManager";
import { findPane } from "../lib/layout";

let nextId = 2;
const genId = (prefix = "pane") => `${prefix}-${Date.now()}-${nextId++}`;

function findAndReplaceNode(
  root: LayoutNode,
  targetId: string,
  transform: (node: PaneNode) => LayoutNode
): LayoutNode {
  if (root.type === "pane") {
    if (root.id === targetId) {
      return transform(root);
    }
    return root;
  }

  return {
    ...root,
    first: findAndReplaceNode(root.first, targetId, transform),
    second: findAndReplaceNode(root.second, targetId, transform),
  };
}

function removeNode(root: LayoutNode, targetId: string): LayoutNode | null {
  if (root.type === "pane") {
    return root.id === targetId ? null : root;
  }

  if (root.first.type === "pane" && root.first.id === targetId) {
    return root.second;
  }
  if (root.second.type === "pane" && root.second.id === targetId) {
    return root.first;
  }

  const newFirst = removeNode(root.first, targetId);
  if (!newFirst) return root.second;

  const newSecond = removeNode(root.second, targetId);
  if (!newSecond) return root.first;

  return {
    ...root,
    first: newFirst,
    second: newSecond,
  };
}

function getAllPaneIds(root: LayoutNode): string[] {
  if (root.type === "pane") return [root.id];
  return [...getAllPaneIds(root.first), ...getAllPaneIds(root.second)];
}

function updateRatioInTree(root: LayoutNode, splitId: string, ratio: number): LayoutNode {
  if (root.type === "pane") return root;
  if (root.id === splitId) {
    return { ...root, ratio: Math.min(Math.max(ratio, 0.15), 0.85) };
  }
  return {
    ...root,
    first: updateRatioInTree(root.first, splitId, ratio),
    second: updateRatioInTree(root.second, splitId, ratio),
  };
}

function updateTitleInTree(root: LayoutNode, paneId: string, title: string): LayoutNode {
  if (root.type === "pane") {
    return root.id === paneId ? { ...root, title } : root;
  }
  return {
    ...root,
    first: updateTitleInTree(root.first, paneId, title),
    second: updateTitleInTree(root.second, paneId, title),
  };
}

interface TerminalState {
  tabs: Tab[];
  activeTabId: string;
  isBroadcastEnabled: boolean;
  isUsageDrawerOpen: boolean;
  isSidebarOpen: boolean;
  aiUsage: AIUsageState;

  // Actions
  createTab: (title?: string, opts?: { initialCommand?: string; agentType?: "claude" | "codex" }) => void;
  closeTab: (tabId: string) => void;
  setActiveTab: (tabId: string) => void;
  splitPane: (
    targetPaneId: string,
    direction: SplitDirection,
    opts?: { title?: string; agentType?: "claude" | "codex"; initialCommand?: string }
  ) => void;
  closePane: (paneId: string) => void;
  setActivePane: (paneId: string, opts?: { focus?: boolean }) => void;
  updateSplitRatio: (splitId: string, ratio: number) => void;
  updatePaneTitle: (paneId: string, title: string) => void;
  toggleBroadcast: () => void;
  toggleUsageDrawer: () => void;
  toggleSidebar: () => void;
  updateAIUsage: (usage: Partial<AIUsageState>) => void;
}

const initialPaneId = "pane-1";
const initialTerminalId = "term-1";
const initialTabId = "tab-1";

export const useTerminalStore = create<TerminalState>((set, get) => ({
  tabs: [
    {
      id: initialTabId,
      title: "Terminal 1",
      root: {
        id: initialPaneId,
        type: "pane",
        terminalId: initialTerminalId,
        title: "zsh",
      },
      activePaneId: initialPaneId,
    },
  ],
  activeTabId: initialTabId,
  isBroadcastEnabled: false,
  isUsageDrawerOpen: false,
  isSidebarOpen: false,

  aiUsage: {
    claude: {
      planType: "Team",
      fiveHour: {
        usedPercent: 32,
        resetsAt: "en 2h 45m",
      },
      sevenDay: {
        usedPercent: 54,
        resetsAt: "en 3 días",
      },
    },
    chatgpt: {
      planType: "Plus / Pro",
      primary5h: {
        usedPercent: 41,
        resetsAt: "en 1h 20m",
      },
      secondaryWeekly: {
        usedPercent: 68,
        resetsAt: "en 4 días",
      },
    },
  },

  createTab: (title, opts) => {
    const newTabId = genId("tab");
    const newPaneId = genId("pane");
    const newTermId = genId("term");

    const newTab: Tab = {
      id: newTabId,
      title: title ?? `Terminal ${get().tabs.length + 1}`,
      root: {
        id: newPaneId,
        type: "pane",
        terminalId: newTermId,
        title: opts?.agentType ? (opts.agentType === "claude" ? "Claude Code" : "Codex CLI") : "zsh",
        initialCommand: opts?.initialCommand,
        agentType: opts?.agentType,
      },
      activePaneId: newPaneId,
    };

    set((state) => ({
      tabs: [...state.tabs, newTab],
      activeTabId: newTabId,
    }));
  },

  closeTab: (tabId) => {
    const { tabs, activeTabId } = get();
    if (tabs.length <= 1) return; // Keep at least one tab

    const tabToClose = tabs.find((t) => t.id === tabId);
    if (tabToClose) {
      // Kill all terminals in this tab
      const paneIds = getAllPaneIds(tabToClose.root);
      paneIds.forEach((id) => terminalManager.kill(id));
    }

    const filtered = tabs.filter((t) => t.id !== tabId);
    let newActiveId = activeTabId;
    if (activeTabId === tabId) {
      const idx = tabs.findIndex((t) => t.id === tabId);
      newActiveId = filtered[Math.max(0, idx - 1)].id;
    }

    set({ tabs: filtered, activeTabId: newActiveId });
  },

  setActiveTab: (tabId) => {
    set({ activeTabId: tabId });
  },

  splitPane: (targetPaneId, direction, opts) => {
    const { tabs, activeTabId } = get();
    const currentTab = tabs.find((t) => t.id === activeTabId);
    if (!currentTab) return;

    const newPaneId = genId("pane");
    const newTermId = genId("term");

    const newPane: PaneNode = {
      id: newPaneId,
      type: "pane",
      terminalId: newTermId,
      title: opts?.title ?? (opts?.agentType === "claude" ? "Claude Code" : opts?.agentType === "codex" ? "Codex CLI" : "zsh"),
      initialCommand: opts?.initialCommand,
      agentType: opts?.agentType,
    };

    const newRoot = findAndReplaceNode(currentTab.root, targetPaneId, (oldNode) => ({
      id: genId("split"),
      type: "split",
      direction,
      ratio: 0.5,
      first: oldNode,
      second: newPane,
    }));

    set({
      tabs: tabs.map((t) =>
        t.id === activeTabId
          ? {
              ...t,
              root: newRoot,
              activePaneId: newPaneId,
            }
          : t
      ),
    });

    // Auto-focus new pane after render
    setTimeout(() => {
      terminalManager.focus(newPaneId);
    }, 60);
  },

  closePane: (paneId) => {
    const { tabs, activeTabId } = get();
    const currentTab = tabs.find((t) => t.id === activeTabId);
    if (!currentTab) return;

    terminalManager.kill(paneId);

    const newRoot = removeNode(currentTab.root, paneId);
    if (!newRoot) {
      // If no panes left in this tab, close tab if others exist, or recreate fresh pane
      if (tabs.length > 1) {
        get().closeTab(activeTabId);
      } else {
        const freshPaneId = genId("pane");
        const freshTermId = genId("term");
        set({
          tabs: [
            {
              ...currentTab,
              root: {
                id: freshPaneId,
                type: "pane",
                terminalId: freshTermId,
                title: "zsh",
              },
              activePaneId: freshPaneId,
            },
          ],
        });
      }
      return;
    }

    const remainingPaneIds = getAllPaneIds(newRoot);
    const newActivePaneId = remainingPaneIds[0] ?? "";

    set({
      tabs: tabs.map((t) =>
        t.id === activeTabId
          ? {
              ...t,
              root: newRoot,
              activePaneId: newActivePaneId,
            }
          : t
      ),
    });

    if (newActivePaneId) {
      setTimeout(() => terminalManager.focus(newActivePaneId), 50);
    }
  },

  setActivePane: (paneId, opts) => {
    const { tabs, activeTabId } = get();
    const currentTab = tabs.find((t) => t.id === activeTabId);
    if (currentTab && currentTab.activePaneId !== paneId) {
      set({
        tabs: tabs.map((t) => (t.id === activeTabId ? { ...t, activePaneId: paneId } : t)),
      });
    }
    if (opts?.focus !== false) terminalManager.focus(paneId);
  },

  updateSplitRatio: (splitId, ratio) => {
    const { tabs, activeTabId } = get();
    const currentTab = tabs.find((t) => t.id === activeTabId);
    if (!currentTab) return;

    const newRoot = updateRatioInTree(currentTab.root, splitId, ratio);
    set({
      tabs: tabs.map((t) => (t.id === activeTabId ? { ...t, root: newRoot } : t)),
    });
  },

  updatePaneTitle: (paneId, title) => {
    const { tabs } = get();
    // El título llega por OSC desde cualquier pestaña, no solo la activa.
    const owner = tabs.find((t) => findPane(t.root, paneId));
    if (!owner || findPane(owner.root, paneId)?.title === title) return;

    set({
      tabs: tabs.map((t) =>
        t.id === owner.id ? { ...t, root: updateTitleInTree(t.root, paneId, title) } : t
      ),
    });
  },

  toggleBroadcast: () => {
    set((state) => ({ isBroadcastEnabled: !state.isBroadcastEnabled }));
  },

  toggleUsageDrawer: () => {
    set((state) => ({ isUsageDrawerOpen: !state.isUsageDrawerOpen }));
  },

  toggleSidebar: () => {
    set((state) => ({ isSidebarOpen: !state.isSidebarOpen }));
  },

  updateAIUsage: (usage) => {
    set((state) => ({
      aiUsage: {
        ...state.aiUsage,
        ...usage,
      },
    }));
  },
}));

// Register hooks to terminalManager for keyboard broadcast and pty-exit cleanup
terminalManager.setStoreHooks({
  isBroadcastEnabled: () => useTerminalStore.getState().isBroadcastEnabled,
  onExit: (instanceId) => {
    useTerminalStore.getState().closePane(instanceId);
  },
  onTitle: (instanceId, title) => {
    const trimmed = title.trim();
    if (trimmed) useTerminalStore.getState().updatePaneTitle(instanceId, trimmed);
  },
});
