import { useTerminalStore } from "../store/terminalStore";
import { collectPanes } from "./layout";

export type AgentKind = "claude" | "codex";

export const AGENTS: Record<AgentKind, { title: string; command: string; vendor: string }> = {
  claude: { title: "Claude Code", command: "claude", vendor: "Anthropic" },
  codex: { title: "Codex CLI", command: "codex", vendor: "OpenAI" },
};

const state = () => useTerminalStore.getState();

function activeTab() {
  const { tabs, activeTabId } = state();
  return tabs.find((tab) => tab.id === activeTabId);
}

/**
 * Acciones de la app sin dependencias de React: las comparten el teclado,
 * la paleta, la barra lateral y el popover de cuotas.
 */
export const actions = {
  newTab: () => state().createTab(),

  closePane: () => {
    const tab = activeTab();
    if (tab) state().closePane(tab.activePaneId);
  },

  splitRight: () => {
    const tab = activeTab();
    if (tab) state().splitPane(tab.activePaneId, "horizontal");
  },

  splitDown: () => {
    const tab = activeTab();
    if (tab) state().splitPane(tab.activePaneId, "vertical");
  },

  /** Abre el agente a la derecha del panel activo (agente junto a tu shell). */
  openAgentInSplit: (agent: AgentKind) => {
    const tab = activeTab();
    const { title, command } = AGENTS[agent];
    if (tab) {
      state().splitPane(tab.activePaneId, "horizontal", {
        title,
        agentType: agent,
        initialCommand: command,
      });
    } else {
      state().createTab(title, { agentType: agent, initialCommand: command });
    }
  },

  openAgentInTab: (agent: AgentKind) => {
    const { title, command } = AGENTS[agent];
    state().createTab(title, { agentType: agent, initialCommand: command });
  },

  focusPaneOffset: (delta: number) => {
    const tab = activeTab();
    if (!tab) return;
    const panes = collectPanes(tab.root);
    if (panes.length < 2) return;
    const index = panes.findIndex((pane) => pane.id === tab.activePaneId);
    const next = panes[(index + delta + panes.length) % panes.length];
    state().setActivePane(next.id);
  },

  goToTab: (index: number) => {
    const target = state().tabs[index];
    if (target) state().setActiveTab(target.id);
  },

  focusPane: (tabId: string, paneId: string) => {
    state().setActiveTab(tabId);
    state().setActivePane(paneId);
  },

  toggleSidebar: () => state().toggleSidebar(),
  toggleUsage: () => state().toggleUsageDrawer(),
  toggleBroadcast: () => state().toggleBroadcast(),
};
